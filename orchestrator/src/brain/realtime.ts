/**
 * OpenAI Realtime brain — native speech to speech.
 *
 * Audio goes up, audio comes back. There is no STT → LLM → TTS cascade here:
 * a cascade adds three serialisation hops of latency to every turn, and in a
 * meeting that is the difference between a participant and a kiosk. Transcripts
 * arrive as a side channel of the same session and are used for classification,
 * not as the input to a second model.
 *
 * The model is pinned from `config.realtime.model`. Never "latest": a silent
 * model swap moves behaviour and COGS underneath us at the same time.
 *
 * ---------------------------------------------------------------------------
 * API SURFACE CAVEAT
 * ---------------------------------------------------------------------------
 * The Realtime event vocabulary has changed once already (`response.audio.*`
 * became `response.output_audio.*`). Rather than pick one and break on the
 * other, the event handling below accepts both spellings and the endpoint and
 * beta header are overridable by environment. Anything unrecognised is counted
 * and ignored rather than throwing, so a vocabulary addition degrades into
 * missing a feature instead of dropping Lily out of a live meeting.
 * ---------------------------------------------------------------------------
 */

import { WebSocket } from 'ws';

import { classify } from '../classify.js';
import type { Roster } from '../roster.js';
import { errorField, log } from '../util/log.js';
import type { AudioFrame, HeardUtterance, LilyUtterance, SpeechOutput } from '../types.js';
import { reconcile, type ModelIntent } from './route.js';
import {
  BrainUnavailableError,
  type BrainHooks,
  type LilyBrain,
  type SpeakerHint,
} from './types.js';

/** Realtime PCM16 is 24 kHz mono. Adapters resample to whatever the platform wants. */
export const REALTIME_SAMPLE_RATE = 24_000;

export interface RealtimeConfigSlice {
  readonly model: string;
  readonly voice: string;
  readonly inputAudioFormat: 'pcm16';
  readonly outputAudioFormat: 'pcm16';
  readonly turnDetection: {
    readonly type: 'server_vad';
    readonly threshold: number;
    readonly silenceDurationMs: number;
    readonly prefixPaddingMs: number;
  };
  readonly bargeInCutoffMs: number;
}

export interface RealtimeBrainOptions {
  /** From the secrets provider — `lily/<stage>/openai-api-key`. */
  readonly apiKey: string;
  /** `config.realtime`, passed whole so nothing is re-derived here. */
  readonly realtime: RealtimeConfigSlice;
  readonly roster: Roster;
  readonly botDisplayName: string;
  /** Overridable for a proxy or a regional endpoint. */
  readonly endpoint?: string;
  readonly betaHeader?: string;
  /** Test seam. */
  readonly connect?: (url: string, headers: Record<string, string>) => WebSocket;
}

interface PendingRender {
  readonly resolve: (output: SpeechOutput) => void;
  readonly reject: (error: Error) => void;
  readonly chunks: Buffer[];
  readonly text: string;
}

export class RealtimeBrain implements LilyBrain {
  readonly kind = 'realtime' as const;
  readonly requiresAudio = true;

  readonly #options: RealtimeBrainOptions;
  #hooks: BrainHooks | null = null;
  #socket: WebSocket | null = null;
  #ready: Promise<void> | null = null;
  #render: PendingRender | null = null;
  #audioSecSent = 0;
  #closed = false;

  /**
   * The utterance the model is currently reacting to.
   *
   * Tool calls arrive asynchronously and carry no reference to what prompted
   * them, so the most recent completed input transcript is what a tool call is
   * reconciled against.
   */
  #lastHeard: HeardUtterance | null = null;

  /**
   * The platform's own answer to "who is talking", from the adapter.
   *
   * Preferred over `#lastHeard` when attributing a transcript, because it is
   * current rather than historical — and because it is the platform's per-track
   * answer rather than an inference. Null when the adapter could not identify
   * the speaker, which the gate treats as "not a known employee".
   */
  #activeSpeaker: SpeakerHint | null = null;

  constructor(options: RealtimeBrainOptions) {
    if (options.apiKey.trim() === '') {
      throw new BrainUnavailableError(
        'realtime',
        ['LILY_LOCAL_OPENAI_API_KEY — an OpenAI API key with Realtime access'],
        'Set it in .env.local (see .env.example), or run the deterministic brain instead with ' +
          'LILY_BRAIN=text. The text brain runs the identical orchestration logic over typed ' +
          'text and costs nothing.',
      );
    }
    this.#options = options;
  }

  attach(hooks: BrainHooks): void {
    this.#hooks = hooks;
  }

  async start(): Promise<void> {
    const hooks = this.#requireHooks();
    const { realtime } = this.#options;

    const endpoint = this.#options.endpoint ?? 'wss://api.openai.com/v1/realtime';
    const url = `${endpoint}?model=${encodeURIComponent(realtime.model)}`;
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.#options.apiKey}`,
      'openai-beta': this.#options.betaHeader ?? 'realtime=v1',
    };

    const socket = this.#options.connect?.(url, headers) ?? new WebSocket(url, { headers });
    this.#socket = socket;

    this.#ready = new Promise<void>((resolve, reject) => {
      const onOpen = (): void => {
        this.#send({
          type: 'session.update',
          session: {
            modalities: ['audio', 'text'],
            voice: realtime.voice,
            input_audio_format: realtime.inputAudioFormat,
            output_audio_format: realtime.outputAudioFormat,
            input_audio_transcription: { model: 'whisper-1' },
            turn_detection: {
              type: realtime.turnDetection.type,
              threshold: realtime.turnDetection.threshold,
              silence_duration_ms: realtime.turnDetection.silenceDurationMs,
              prefix_padding_ms: realtime.turnDetection.prefixPaddingMs,
            },
            instructions: this.#systemInstructions(),
            tools: TOOLS,
            tool_choice: 'auto',
          },
        });
        resolve();
      };

      socket.on('open', onOpen);
      socket.on('error', (cause: Error) => {
        log.error('realtime.socket_error', { error: errorField(cause) });
        reject(cause);
        this.#failRender(cause);
      });
      socket.on('close', (code: number) => {
        log.warn('realtime.socket_closed', { code });
        this.#failRender(new Error(`Realtime socket closed with code ${code}.`));
      });
      socket.on('message', (raw: Buffer | string) => {
        void this.#onEvent(raw);
      });
    });

    await this.#ready;
    log.info('brain.started', { kind: this.kind, model: realtime.model });
    void hooks;
  }

  // -------------------------------------------------------------------------
  // Input
  // -------------------------------------------------------------------------

  /**
   * A completed utterance.
   *
   * Runs the identical two calls `TextBrain.hear` runs. The model's own opinion
   * arrives separately as a tool call and is reconciled against this result —
   * it never replaces it.
   */
  async hear(utterance: HeardUtterance): Promise<void> {
    const hooks = this.#requireHooks();
    this.#lastHeard = utterance;

    const classification = hooks.classify(utterance);
    await hooks.apply(utterance, classification);
  }

  noteSpeaker(speaker: SpeakerHint | null): void {
    this.#activeSpeaker = speaker;
  }

  async hearAudio(frame: AudioFrame): Promise<void> {
    if (this.#socket === null || this.#closed) return;

    this.#send({
      type: 'input_audio_buffer.append',
      audio: Buffer.from(frame.pcm16).toString('base64'),
    });

    // Metered as it is sent, not at the end: a meeting that crashes mid-call
    // still bills for the audio that was actually streamed.
    const seconds = frame.pcm16.byteLength / 2 / frame.sampleRate;
    this.#audioSecSent += seconds;
    this.#requireHooks().meterAudioSec(seconds);
  }

  // -------------------------------------------------------------------------
  // Output
  // -------------------------------------------------------------------------

  /**
   * Speak an exact line.
   *
   * The words are fixed by the caller, not improvised, because several of them
   * must be exact — a permission prompt repeats a command verbatim, and a
   * paraphrase of "rm -rf ." is a consent failure. The model supplies the voice.
   *
   * Known limitation: this buffers the full utterance before returning, because
   * `MeetingAdapter.speak` takes a complete `SpeechOutput`. Streaming into a
   * platform's audio track needs a streaming variant of that method, which is
   * worth adding when a platform adapter exists that can consume one.
   */
  async render(line: LilyUtterance): Promise<SpeechOutput> {
    const hooks = this.#requireHooks();
    hooks.meterTtsChars(line.text.length);

    if (this.#socket === null || this.#closed) return { kind: 'text', text: line.text };

    return new Promise<SpeechOutput>((resolve, reject) => {
      this.#render = { resolve, reject, chunks: [], text: line.text };

      this.#send({
        type: 'response.create',
        response: {
          modalities: ['audio', 'text'],
          instructions:
            `Say the following out loud, word for word, with nothing added, ` +
            `removed or rephrased:\n\n${line.text}`,
        },
      });
    });
  }

  async bargeIn(): Promise<void> {
    if (this.#socket === null || this.#closed) return;
    this.#send({ type: 'response.cancel' });
    this.#failRender(new Error('Cut off by barge-in.'));
  }

  async stop(): Promise<void> {
    this.#closed = true;
    this.#failRender(new Error('Session stopped.'));
    try {
      this.#socket?.close(1000, 'meeting ended');
    } catch {
      // Already gone.
    }
    this.#socket = null;
    this.#hooks = null;
    log.info('realtime.stopped', { audioSecSent: Math.round(this.#audioSecSent) });
  }

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  async #onEvent(raw: Buffer | string): Promise<void> {
    let event: { type?: string; [key: string]: unknown };
    try {
      event = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8')) as typeof event;
    } catch {
      log.warn('realtime.malformed_event');
      return;
    }

    const type = event['type'];
    if (typeof type !== 'string') return;

    // Both spellings, old and new. See the API surface caveat in the header.
    if (type === 'response.audio.delta' || type === 'response.output_audio.delta') {
      const delta = event['delta'];
      if (typeof delta === 'string' && this.#render !== null) {
        this.#render.chunks.push(Buffer.from(delta, 'base64'));
      }
      return;
    }

    if (type === 'response.done' || type === 'response.completed') {
      this.#completeRender(event);
      return;
    }

    if (type === 'conversation.item.input_audio_transcription.completed') {
      // The session's own transcript of what a participant said. Used to
      // classify and then discarded — never stored, never logged.
      const text = event['transcript'];
      if (typeof text === 'string' && text.trim() !== '') {
        await this.#onTranscript(text);
      }
      return;
    }

    if (
      type === 'response.function_call_arguments.done' ||
      type === 'response.output_item.done'
    ) {
      await this.#onToolCall(event);
      return;
    }

    if (type === 'error') {
      const error = event['error'];
      const message =
        typeof error === 'object' && error !== null && 'message' in error
          ? String((error as { message: unknown }).message).slice(0, 300)
          : 'unknown';
      log.error('realtime.api_error', { message });
      this.#failRender(new Error(message));
      return;
    }

    if (type === 'response.usage' || type === 'rate_limits.updated') {
      const usage = event['usage'];
      if (typeof usage === 'object' && usage !== null && 'output_tokens' in usage) {
        const tokens = Number((usage as { output_tokens: unknown }).output_tokens);
        if (Number.isFinite(tokens)) this.#requireHooks().meterReasoningTokens(tokens);
      }
    }
  }

  /**
   * Turn a recognised transcript into an utterance.
   *
   * Speaker attribution is the honest gap here: the Realtime session does not
   * diarize, so on a real platform the adapter must supply the active speaker
   * (Zoom's SDK reports it per audio frame). Until an audio-capable adapter
   * exists, a transcript with no attributable speaker is classified with a null
   * `employeeId`, which the classifier and the permission gate both treat as
   * "not a known employee" — the safe direction, since nobody's approval can be
   * mistakenly credited.
   */
  async #onTranscript(text: string): Promise<void> {
    // The adapter's live answer first; the last attributed utterance only as a
    // fallback for platforms that cannot report a speaker at all. Both may be
    // absent, and absent stays absent — `employeeId: null` denies, and inventing
    // a plausible speaker to fill the gap is the one thing that must not happen.
    const active = this.#activeSpeaker;
    const previous = this.#lastHeard;
    const utterance: HeardUtterance = {
      participantId: active?.participantId ?? previous?.participantId ?? 'unknown',
      employeeId: active === null ? (previous?.employeeId ?? null) : active.employeeId,
      speakerName: active?.displayName ?? previous?.speakerName ?? 'someone',
      text,
      at: new Date(),
      fromAudio: true,
    };
    await this.hear(utterance);
  }

  async #onToolCall(event: Record<string, unknown>): Promise<void> {
    const intent = parseIntent(event);
    if (intent === null) return;

    const heard = this.#lastHeard;
    if (heard === null) {
      log.warn('brain.tool_call_without_utterance', { intent: intent.kind });
      return;
    }

    const hooks = this.#requireHooks();
    const classification = classify({
      text: heard.text,
      speakerEmployeeId: heard.employeeId,
      roster: this.#options.roster,
      now: heard.at,
    });

    const { classification: reconciled, vetoed } = reconcile(
      classification,
      intent,
      this.#options.roster,
    );

    if (vetoed) return; // Already applied from `hear`; the model added nothing legitimate.
    if (reconciled === classification) return; // No refinement; nothing new to apply.

    await hooks.apply(heard, reconciled);
  }

  // -------------------------------------------------------------------------

  #completeRender(event: Record<string, unknown>): void {
    const pending = this.#render;
    if (pending === null) return;
    this.#render = null;

    const usage = (event['response'] as { usage?: { output_tokens?: number } } | undefined)?.usage;
    if (usage?.output_tokens !== undefined && Number.isFinite(usage.output_tokens)) {
      this.#hooks?.meterReasoningTokens(usage.output_tokens);
    }

    const pcm = Buffer.concat(pending.chunks);
    if (pcm.byteLength === 0) {
      // The model produced no audio. Falling back to text keeps the line in the
      // room rather than losing it to a silent failure.
      pending.resolve({ kind: 'text', text: pending.text });
      return;
    }

    pending.resolve({
      kind: 'audio',
      pcm16: new Uint8Array(pcm),
      sampleRate: REALTIME_SAMPLE_RATE,
      text: pending.text,
    });
  }

  #failRender(cause: Error): void {
    const pending = this.#render;
    if (pending === null) return;
    this.#render = null;
    // Resolving with text rather than rejecting: a synthesis failure should
    // still put the words in front of the room where the adapter can carry them.
    pending.resolve({ kind: 'text', text: pending.text });
    log.warn('realtime.render_degraded', { error: errorField(cause) });
  }

  #send(payload: Record<string, unknown>): void {
    const socket = this.#socket;
    if (socket === null || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify(payload));
  }

  #systemInstructions(): string {
    const people = this.#requireHooks()
      .context()
      .people.map(
        (person) =>
          `- ${person.name} (${person.employeeId}): ${person.jobDescription}. ` +
          `Agent ${person.daemonEnrolled ? 'connected' : 'not connected'}` +
          (person.capabilities.length > 0 ? `; tools: ${person.capabilities.join(', ')}` : ''),
      )
      .join('\n');

    return [
      `You are ${this.#options.botDisplayName}, an AI participant in a live meeting.`,
      '',
      'People in this meeting:',
      people,
      '',
      'Rules you must not break:',
      '- Only act on things addressed to you by name. If someone gives an instruction to a',
      '  person, that is theirs, and you do nothing but stay quiet.',
      '- Never claim to have done something you have not done.',
      '- Keep spoken answers to one or two sentences unless asked for more.',
      '- Do not interrupt. If someone starts speaking while you are, stop.',
      '',
      'Whether an instruction was addressed to you is decided outside this session and your',
      'tool calls are checked against that decision, so guessing in your own favour will be',
      'rejected. Prefer no_action when you are unsure.',
    ].join('\n');
  }

  #requireHooks(): BrainHooks {
    const hooks = this.#hooks;
    if (hooks === null) throw new Error('RealtimeBrain.attach() must be called before use.');
    return hooks;
  }
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    type: 'function',
    name: 'dispatch_to_employee',
    description:
      "Ask a named employee's own coding agent a question about their work. Read-only. " +
      'Use only when someone in the meeting asked that person, or asked you to ask them.',
    parameters: {
      type: 'object',
      properties: {
        employee_id: { type: 'string', description: 'The employee_id from the roster.' },
        question: { type: 'string', description: 'The question, in plain language.' },
      },
      required: ['employee_id', 'question'],
    },
  },
  {
    type: 'function',
    name: 'record_assignment',
    description:
      'Silently record that a person was given work by another person. Does not act, does not ' +
      'speak, does not touch anyone\'s machine. This is the right tool for anything one human ' +
      'said to another human.',
    parameters: {
      type: 'object',
      properties: {
        owner_employee_id: { type: 'string' },
        text: { type: 'string' },
        due: { type: 'string', description: 'YYYY-MM-DD, or omit if no deadline was named.' },
      },
      required: ['owner_employee_id', 'text'],
    },
  },
  {
    type: 'function',
    name: 'no_action',
    description: 'Nothing here is for you. Use this freely; it is the correct answer most of the time.',
    parameters: {
      type: 'object',
      properties: { reason: { type: 'string' } },
      required: ['reason'],
    },
  },
] as const;

function parseIntent(event: Record<string, unknown>): ModelIntent | null {
  const name = typeof event['name'] === 'string' ? event['name'] : null;
  const rawArgs = event['arguments'];
  if (name === null || typeof rawArgs !== 'string') return null;

  let args: Record<string, unknown>;
  try {
    args = JSON.parse(rawArgs) as Record<string, unknown>;
  } catch {
    return null;
  }

  const str = (keyName: string): string | null =>
    typeof args[keyName] === 'string' && args[keyName] !== '' ? (args[keyName] as string) : null;

  switch (name) {
    case 'dispatch_to_employee': {
      const employeeId = str('employee_id');
      const question = str('question');
      if (employeeId === null || question === null) return null;
      return { kind: 'dispatch', employeeId, question, mode: 'read_only' };
    }
    case 'record_assignment': {
      const ownerEmployeeId = str('owner_employee_id');
      const text = str('text');
      if (ownerEmployeeId === null || text === null) return null;
      return { kind: 'record_assignment', ownerEmployeeId, text, due: str('due') };
    }
    case 'no_action':
      return { kind: 'none', reason: str('reason') ?? 'unspecified' };
    default:
      return null;
  }
}

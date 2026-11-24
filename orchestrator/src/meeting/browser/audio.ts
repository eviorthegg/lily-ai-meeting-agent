/**
 * Audio, in both directions, through PulseAudio.
 *
 * ===========================================================================
 * THE TOPOLOGY, AND WHY IT IS TWO SINKS AND NOT ONE
 * ===========================================================================
 *
 *   room audio  ──▶ [ null sink: lily_room_out ] ──▶ .monitor ──▶ parec ──▶ AudioStream
 *   (Chrome's                                                                   │
 *    output)                                                                    ▼
 *                                                                     the Realtime session
 *
 *   Lily's PCM ──▶ pacat ──▶ [ null sink: lily_mic_sink ] ──▶ remap-source ──▶ Chrome's
 *                                                             "lily_mic"        microphone
 *
 * Chrome is told to render into `lily_room_out` and to record from `lily_mic`.
 * The two are kept entirely separate, which is the point: a single loopback
 * would feed Lily's own voice straight back into her ears, and a Realtime
 * session that hears itself talk interrupts itself forever.
 *
 * ===========================================================================
 * WHY NOT `--use-fake-device-for-media-stream`
 * ===========================================================================
 * Because it emits a test tone. It is a WebRTC plumbing test, not an audio
 * injection mechanism, and a bot that joins a meeting and plays a 440Hz beep is
 * worse than one that joins silently. The fake *UI* flag is still wanted —
 * `--use-fake-ui-for-media-stream` auto-grants the microphone and camera
 * permission prompt, which is a prompt nobody is there to click. That one flag
 * grants permission; it does not substitute the device.
 *
 * ===========================================================================
 * WHAT NEVER HAPPENS TO THIS AUDIO
 * ===========================================================================
 * It is not written to disk, not buffered beyond the small realtime window
 * below, and not logged. Frames are counted; their contents never reach a log
 * line. The queue is bounded and drops the *oldest* frames under pressure,
 * because unbounded growth of a meeting's audio in RAM is the same mistake as
 * recording it, only less honest.
 * ===========================================================================
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';

import { errorField, log } from '../../util/log.js';
import type { AudioFrame, AudioStream } from '../../types.js';

/** Realtime PCM16 is 24 kHz mono; PulseAudio resamples so nothing here does. */
export const CAPTURE_SAMPLE_RATE = 24_000;
/** 20 ms. Short enough for barge-in to feel immediate, long enough to be cheap. */
export const FRAME_MS = 20;
export const FRAME_BYTES = (CAPTURE_SAMPLE_RATE / 1000) * FRAME_MS * 2;

/**
 * One second of audio in flight, maximum.
 *
 * If the consumer is more than a second behind on a live meeting, the old
 * frames are worthless — the conversation has moved on. Dropping them is
 * correct; queueing them is how a slow moment becomes a permanent lag.
 */
const MAX_QUEUED_FRAMES = 1000 / FRAME_MS;

export interface PulseNames {
  /** Null sink Chrome renders meeting audio into. */
  readonly outSink: string;
  /** Null sink Lily's speech is played into. */
  readonly micSink: string;
  /** Source remapped from `micSink`, selected as Chrome's default input. */
  readonly micSource: string;
}

export function pulseNamesFor(meetingId: string): PulseNames {
  // Pulse module names must be short and free of punctuation. A meeting id is
  // neither, so it is reduced to a stable suffix rather than used raw.
  const suffix = meetingId.replace(/[^a-zA-Z0-9]/g, '').slice(-12) || 'default';
  return {
    outSink: `lily_out_${suffix}`,
    micSink: `lily_micsink_${suffix}`,
    micSource: `lily_mic_${suffix}`,
  };
}

function pactl(args: readonly string[]): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync('pactl', [...args], { encoding: 'utf8' });
  return {
    ok: result.status === 0,
    stdout: (result.stdout ?? '').trim(),
    stderr: (result.stderr ?? '').trim(),
  };
}

/**
 * The PulseAudio modules for one meeting.
 *
 * Created per meeting rather than baked into the AMI so two orchestrators on
 * one host cannot share a sink and hear each other's meetings. The provisioning
 * script installs PulseAudio and starts the daemon; this loads and unloads the
 * per-meeting modules.
 */
export class PulseTopology {
  readonly names: PulseNames;
  readonly #loaded: number[] = [];
  #ready = false;

  constructor(meetingId: string) {
    this.names = pulseNamesFor(meetingId);
  }

  get ready(): boolean {
    return this.#ready;
  }

  setUp(): void {
    if (this.#ready) return;
    const { outSink, micSink, micSource } = this.names;

    this.#load('module-null-sink', [
      `sink_name=${outSink}`,
      `sink_properties=device.description=${outSink}`,
    ]);
    this.#load('module-null-sink', [
      `sink_name=${micSink}`,
      `sink_properties=device.description=${micSink}`,
    ]);
    // A monitor source is not selectable as a microphone by Chrome on every
    // Pulse version; a remapped source always is.
    this.#load('module-remap-source', [
      `master=${micSink}.monitor`,
      `source_name=${micSource}`,
      `source_properties=device.description=${micSource}`,
    ]);

    // Chrome inherits the defaults, so setting them here is what actually
    // points the browser at these devices. The command-line flags cannot.
    const defaultSink = pactl(['set-default-sink', outSink]);
    const defaultSource = pactl(['set-default-source', micSource]);
    if (!defaultSink.ok || !defaultSource.ok) {
      log.warn('pulse.defaults_not_set', {
        sinkOk: defaultSink.ok,
        sourceOk: defaultSource.ok,
      });
    }

    this.#ready = true;
    log.info('pulse.ready', { outSink, micSink, micSource, modules: this.#loaded.length });
  }

  #load(module: string, args: readonly string[]): void {
    const result = pactl(['load-module', module, ...args]);
    if (!result.ok) {
      throw new Error(
        `pactl load-module ${module} failed: ${result.stderr || 'no stderr'}. ` +
          'Is a PulseAudio daemon running for this user? ' +
          'orchestrator/scripts/provision-browser-host.sh sets one up as a system service.',
      );
    }
    const id = Number(result.stdout.split('\n').pop());
    if (Number.isInteger(id)) this.#loaded.push(id);
  }

  /** Unload in reverse order; the remap source depends on the sink beneath it. */
  tearDown(): void {
    for (const id of [...this.#loaded].reverse()) {
      const result = pactl(['unload-module', String(id)]);
      if (!result.ok) log.warn('pulse.unload_failed', { module: id });
    }
    this.#loaded.length = 0;
    this.#ready = false;
  }
}

// ---------------------------------------------------------------------------
// Capture — Lily hears the room
// ---------------------------------------------------------------------------

export interface CaptureOptions {
  readonly device: string;
  readonly sampleRate: number;
  /** Injected so a test can drive frames without PulseAudio. */
  readonly spawnCapture?: (device: string, sampleRate: number) => ChildProcess;
}

function spawnParec(device: string, sampleRate: number): ChildProcess {
  return spawn(
    'parec',
    [
      '--format=s16le',
      `--rate=${sampleRate}`,
      '--channels=1',
      `--device=${device}`,
      '--raw',
      // Keep Pulse's own buffer small; latency here is latency in the meeting.
      '--latency-msec=20',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
}

/**
 * PCM frames off the room sink's monitor.
 *
 * Implements `AudioStream`, so the session can hand it straight to the brain
 * without knowing a subprocess is involved.
 */
export class MonitorAudioStream implements AudioStream {
  readonly #sampleRate: number;
  readonly #child: ChildProcess;
  readonly #queue: AudioFrame[] = [];
  #partial: Buffer = Buffer.alloc(0);
  #waiting: ((frame: AudioFrame | null) => void) | null = null;
  #closed = false;
  #dropped = 0;
  #framesRead = 0;

  constructor(options: CaptureOptions) {
    this.#sampleRate = options.sampleRate;
    const launch = options.spawnCapture ?? spawnParec;
    this.#child = launch(options.device, options.sampleRate);

    this.#child.stdout?.on('data', (chunk: Buffer) => this.#onChunk(chunk));
    this.#child.stderr?.on('data', () => {
      // parec reports underruns constantly on a loaded host. Not content, but
      // not worth a log line each either.
    });
    this.#child.on('error', (cause) => {
      log.error('audio.capture_failed', { error: errorField(cause) });
      this.close();
    });
    this.#child.on('exit', (code) => {
      if (!this.#closed) log.warn('audio.capture_exited', { code: code ?? -1 });
      this.close();
    });
  }

  get framesRead(): number {
    return this.#framesRead;
  }

  /** Frames thrown away because the consumer fell behind. Diagnostic only. */
  get droppedFrames(): number {
    return this.#dropped;
  }

  #onChunk(chunk: Buffer): void {
    this.#partial = this.#partial.length === 0 ? chunk : Buffer.concat([this.#partial, chunk]);

    while (this.#partial.length >= FRAME_BYTES) {
      const slice = this.#partial.subarray(0, FRAME_BYTES);
      this.#partial = this.#partial.subarray(FRAME_BYTES);

      const frame: AudioFrame = {
        pcm16: new Uint8Array(slice),
        sampleRate: this.#sampleRate,
        at: Date.now(),
      };
      this.#framesRead += 1;
      this.#push(frame);
    }
  }

  #push(frame: AudioFrame): void {
    const waiting = this.#waiting;
    if (waiting !== null) {
      this.#waiting = null;
      waiting(frame);
      return;
    }
    if (this.#queue.length >= MAX_QUEUED_FRAMES) {
      this.#queue.shift();
      this.#dropped += 1;
    }
    this.#queue.push(frame);
  }

  async *[Symbol.asyncIterator](): AsyncIterator<AudioFrame> {
    for (;;) {
      const queued = this.#queue.shift();
      if (queued !== undefined) {
        yield queued;
        continue;
      }
      if (this.#closed) return;

      const next = await new Promise<AudioFrame | null>((resolve) => {
        this.#waiting = resolve;
      });
      if (next === null) return;
      yield next;
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#queue.length = 0;
    this.#partial = Buffer.alloc(0);

    const waiting = this.#waiting;
    this.#waiting = null;
    waiting?.(null);

    try {
      this.#child.kill('SIGTERM');
    } catch {
      // Already gone.
    }
    log.info('audio.capture_closed', { frames: this.#framesRead, dropped: this.#dropped });
  }
}

// ---------------------------------------------------------------------------
// Playback — Lily speaks into the room
// ---------------------------------------------------------------------------

export interface PlaybackOptions {
  readonly device: string;
  readonly sampleRate: number;
  readonly spawnPlayback?: (device: string, sampleRate: number) => ChildProcess;
}

function spawnPacat(device: string, sampleRate: number): ChildProcess {
  return spawn(
    'pacat',
    [
      '--playback',
      '--format=s16le',
      `--rate=${sampleRate}`,
      '--channels=1',
      `--device=${device}`,
      '--raw',
      '--latency-msec=20',
    ],
    { stdio: ['pipe', 'ignore', 'pipe'] },
  );
}

/**
 * Lily's voice into the virtual microphone.
 *
 * `interrupt()` kills the player rather than draining it. That is deliberate:
 * barge-in has to take effect inside `config.realtime.bargeInCutoffMs`, and
 * anything already handed to PulseAudio will otherwise keep playing for as long
 * as its buffer lasts. A process that is dead makes no sound.
 */
export class MicrophonePlayback {
  readonly #options: PlaybackOptions;
  #child: ChildProcess | null = null;
  #closed = false;

  constructor(options: PlaybackOptions) {
    this.#options = options;
  }

  #ensure(): ChildProcess {
    if (this.#child !== null && this.#child.exitCode === null) return this.#child;

    const launch = this.#options.spawnPlayback ?? spawnPacat;
    const child = launch(this.#options.device, this.#options.sampleRate);
    child.on('error', (cause) => {
      log.error('audio.playback_failed', { error: errorField(cause) });
    });
    this.#child = child;
    return child;
  }

  async write(pcm16: Uint8Array): Promise<void> {
    if (this.#closed) return;
    const child = this.#ensure();
    const stdin = child.stdin;
    if (stdin === null) return;

    await new Promise<void>((resolve) => {
      const ok = stdin.write(Buffer.from(pcm16), () => resolve());
      // `write` resolves through its callback either way; the return value only
      // says whether the buffer is above the high-water mark.
      if (!ok) stdin.once('drain', () => undefined);
    });
  }

  /** Stop immediately, dropping anything already buffered. */
  interrupt(): void {
    const child = this.#child;
    this.#child = null;
    if (child === null) return;
    try {
      child.stdin?.end();
      child.kill('SIGKILL');
    } catch {
      // Already gone.
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.interrupt();
  }
}

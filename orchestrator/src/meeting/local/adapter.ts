/**
 * A simulated meeting room, served from the orchestrator.
 *
 * ===========================================================================
 * WHY THIS EXISTS
 * ===========================================================================
 * The real platforms are joined through a browser — see `../browser/` — and
 * that needs a Linux host with Xvfb, PulseAudio and Google Chrome. None of
 * those exist on the Windows development machine, and none of them belongs in
 * a CI run that must not be able to dial into a real meeting.
 *
 * So the room is real and the *platform* is simulated, rather than the other
 * way around. Everything above `MeetingAdapter` — classification, dispatch,
 * the permission gate, turn-taking, wrap-up, metering — is the same code that
 * runs in a Zoom call. What this adapter substitutes is exactly two things:
 * typed text stands in for recognised speech, and an iframe stands in for a
 * video track. Nothing else is faked.
 * ===========================================================================
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';

import { newId } from '../../util/ids.js';
import { log } from '../../util/log.js';
import type { Clock } from '../../util/clock.js';
import { systemClock } from '../../util/clock.js';
import type {
  AudioStream,
  EmployeeProfile,
  HeardUtterance,
  Participant,
  SpeechOutput,
} from '../../types.js';
import {
  MeetingAdapterUnsupportedError,
  type MeetingAdapter,
  type MeetingAdapterCapabilities,
  type MeetingEndReason,
  type MeetingJoinResult,
  type Unsubscribe,
} from '../adapter.js';
import { renderBoardPage, renderRoomPage, type BoardTaskRow } from './page.js';
import {
  ROOM_PROTOCOL_VERSION,
  clientToRoomSchema,
  type RoomDirectoryEntry,
  type RoomParticipantView,
  type RoomTaskView,
  type RoomToClient,
} from './wire.js';

export interface LocalMeetingAdapterOptions {
  readonly meetingId: string;
  /** `config.meeting.botDisplayName`. Rendered in the participant list. */
  readonly botDisplayName: string;
  readonly directory: readonly EmployeeProfile[];
  readonly port?: number;
  readonly host?: string;
  /** Shown in the room header so the demo says which brain is driving. */
  readonly brainKind?: string;
  /** Live view of task memory, for the right rail and the screenshare board. */
  readonly taskView?: () => readonly RoomTaskView[];
  readonly clock?: Clock;
}

interface RoomClient {
  readonly socket: WebSocket;
  participant: Participant | null;
}

const CAPABILITIES: MeetingAdapterCapabilities = {
  // Honest: there is no microphone here. The session reads this and pairs the
  // room with a brain that works over text rather than assuming audio exists.
  audio: false,
  chat: true,
  screenshare: true,
  raiseHand: true,
  mute: true,
  roster: true,
};

export class LocalMeetingAdapter implements MeetingAdapter {
  readonly platform = 'local' as const;
  readonly capabilities = CAPABILITIES;

  readonly #options: LocalMeetingAdapterOptions;
  readonly #clock: Clock;
  readonly #directory: readonly EmployeeProfile[];

  readonly #clients = new Set<RoomClient>();
  readonly #participants = new Map<string, Participant>();

  readonly #onJoin = new Set<(participant: Participant) => void>();
  readonly #onLeave = new Set<(participant: Participant) => void>();
  readonly #onUtterance = new Set<(utterance: HeardUtterance) => void>();
  readonly #onEnd = new Set<(reason: MeetingEndReason) => void>();

  #http: Server | null = null;
  #wss: WebSocketServer | null = null;
  #bot: Participant | null = null;
  #brainKind: string;
  #screenshareUrl: string | null = null;
  #handRaised = false;
  #muted = false;
  #ended = false;

  constructor(options: LocalMeetingAdapterOptions) {
    this.#options = options;
    this.#clock = options.clock ?? systemClock;
    this.#directory = options.directory;
    this.#brainKind = options.brainKind ?? 'text';
  }

  /**
   * Label the room header with the brain that is actually driving.
   *
   * Settable because the brain is chosen after the adapter exists — picking a
   * realtime session depends on this adapter reporting whether it can carry
   * audio at all.
   */
  setBrainKind(kind: string): void {
    this.#brainKind = kind;
  }

  /** The room URL, available after `join()`. */
  get url(): string {
    const address = this.#http?.address();
    if (address === null || address === undefined || typeof address === 'string') {
      return `http://${this.#options.host ?? '127.0.0.1'}:${this.#options.port ?? 0}`;
    }
    const info = address as AddressInfo;
    const host = this.#options.host ?? '127.0.0.1';
    return `http://${host}:${info.port}`;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async join(): Promise<MeetingJoinResult> {
    if (this.#http !== null) throw new Error('LocalMeetingAdapter.join() called twice.');

    const http = createServer((req, res) => {
      this.#handleHttp(req, res);
    });
    const wss = new WebSocketServer({ noServer: true });

    http.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      const path = (req.url ?? '/').split('?')[0];
      if (path !== '/room') {
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (client) => {
        this.#acceptClient(client);
      });
    });

    await new Promise<void>((resolve, reject) => {
      http.once('error', reject);
      http.listen(this.#options.port ?? 0, this.#options.host ?? '127.0.0.1', () => {
        http.removeListener('error', reject);
        resolve();
      });
    });

    this.#http = http;
    this.#wss = wss;

    // Lily is a participant in the list from the moment she is in the room,
    // labelled as an AI. Consent depends on the room being able to see that
    // without being told.
    this.#bot = {
      participantId: newId('bot'),
      displayName: this.#options.botDisplayName,
      employeeId: null,
      isBot: true,
      joinedAt: this.#clock.date(),
    };
    this.#participants.set(this.#bot.participantId, this.#bot);

    log.info('local_room.listening', { meetingId: this.#options.meetingId, url: this.url });

    return {
      meetingId: this.#options.meetingId,
      joinedAt: this.#clock.date(),
      participants: [...this.#participants.values()],
    };
  }

  async leave(reason: MeetingEndReason): Promise<void> {
    if (this.#ended) return;
    this.#ended = true;

    this.#broadcast({ t: 'ended', reason });

    for (const client of this.#clients) {
      try {
        client.socket.close(1000, 'meeting ended');
      } catch {
        // Already gone.
      }
    }
    this.#clients.clear();

    this.#wss?.close();
    const http = this.#http;
    if (http !== null) {
      await new Promise<void>((resolve) => {
        http.close(() => resolve());
        // Sockets kept alive by a browser tab would otherwise hold the process
        // open past the end of the meeting.
        http.closeAllConnections?.();
      });
    }
    this.#http = null;
    this.#wss = null;
    this.#participants.clear();
  }

  // -------------------------------------------------------------------------
  // Output
  // -------------------------------------------------------------------------

  async speak(output: SpeechOutput): Promise<void> {
    const text = output.kind === 'text' ? output.text : output.text;
    if (text === undefined) {
      // An audio-only utterance cannot be rendered in a text room. Failing is
      // correct: silently dropping Lily's speech would look like a hang.
      throw new MeetingAdapterUnsupportedError('local', 'audio-only speech (no text alternative)');
    }

    const bot = this.#bot;
    if (bot === null) return;

    this.#broadcast({ t: 'speaking', on: true });
    this.#broadcast({
      t: 'message',
      id: newId('msg'),
      from: bot.displayName,
      fromEmployeeId: null,
      text,
      at: this.#clock.date().toISOString(),
      isBot: true,
    });
    this.#broadcast({ t: 'speaking', on: false });
  }

  async stopSpeaking(): Promise<void> {
    this.#broadcast({ t: 'speaking', on: false });
  }

  getAudioStream(): AudioStream | null {
    return null; // `capabilities.audio` is false; callers must check it.
  }

  async postChat(message: string): Promise<void> {
    const bot = this.#bot;
    this.#broadcast({
      t: 'message',
      id: newId('msg'),
      from: bot?.displayName ?? this.#options.botDisplayName,
      fromEmployeeId: null,
      text: message,
      at: this.#clock.date().toISOString(),
      isBot: true,
    });
  }

  async startScreenshare(url: string): Promise<void> {
    this.#screenshareUrl = url;
    this.#broadcast({ t: 'screenshare', url });
  }

  async stopScreenshare(): Promise<void> {
    this.#screenshareUrl = null;
    this.#broadcast({ t: 'screenshare', url: null });
  }

  async raiseHand(): Promise<void> {
    this.#handRaised = true;
    this.#broadcast({ t: 'hand', raised: true });
  }

  async lowerHand(): Promise<void> {
    this.#handRaised = false;
    this.#broadcast({ t: 'hand', raised: false });
  }

  async mute(): Promise<void> {
    this.#muted = true;
    this.#broadcast({ t: 'muted', muted: true });
  }

  async unmute(): Promise<void> {
    this.#muted = false;
    this.#broadcast({ t: 'muted', muted: false });
  }

  get handRaised(): boolean {
    return this.#handRaised;
  }

  get muted(): boolean {
    return this.#muted;
  }

  async setStatus(status: { state: string; note?: string } | null): Promise<void> {
    this.#broadcast({
      t: 'status',
      state: status?.state ?? 'idle',
      note: status?.note ?? null,
    });
  }

  /** Push the current task list to every open tab. */
  publishTasks(): void {
    this.#broadcast({ t: 'tasks', tasks: [...(this.#options.taskView?.() ?? [])] });
  }

  async getParticipants(): Promise<readonly Participant[]> {
    return [...this.#participants.values()];
  }

  /** Everyone except Lily. Empty means the room has emptied out. */
  get humanParticipantCount(): number {
    return [...this.#participants.values()].filter((participant) => !participant.isBot).length;
  }

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  onParticipantJoin(handler: (participant: Participant) => void): Unsubscribe {
    this.#onJoin.add(handler);
    return () => this.#onJoin.delete(handler);
  }

  onParticipantLeave(handler: (participant: Participant) => void): Unsubscribe {
    this.#onLeave.add(handler);
    return () => this.#onLeave.delete(handler);
  }

  onUtterance(handler: (utterance: HeardUtterance) => void): Unsubscribe {
    this.#onUtterance.add(handler);
    return () => this.#onUtterance.delete(handler);
  }

  onMeetingEnd(handler: (reason: MeetingEndReason) => void): Unsubscribe {
    this.#onEnd.add(handler);
    return () => this.#onEnd.delete(handler);
  }

  // -------------------------------------------------------------------------
  // HTTP
  // -------------------------------------------------------------------------

  #handleHttp(req: IncomingMessage, res: ServerResponse): void {
    const path = (req.url ?? '/').split('?')[0] ?? '/';

    const send = (status: number, type: string, body: string): void => {
      res.writeHead(status, {
        'content-type': type,
        'cache-control': 'no-store',
        // The page loads nothing from anywhere else, so say so.
        'content-security-policy':
          "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; " +
          "connect-src 'self'; frame-src 'self'; img-src 'self' data:",
      });
      res.end(body);
    };

    if (path === '/' || path === '/index.html') {
      send(
        200,
        'text/html; charset=utf-8',
        renderRoomPage({
          meetingId: this.#options.meetingId,
          botDisplayName: this.#options.botDisplayName,
          brainKind: this.#brainKind,
          platformNote: 'simulated platform',
        }),
      );
      return;
    }

    if (path === '/api/roster') {
      const taken = new Set(
        [...this.#participants.values()]
          .map((participant) => participant.employeeId)
          .filter((id): id is string => id !== null),
      );
      const directory: RoomDirectoryEntry[] = this.#directory.map((profile) => ({
        employeeId: profile.employeeId,
        name: profile.name,
        jobDescription: profile.jobDescription,
        agentKind: profile.agentKind,
        capabilities: [...profile.capabilities],
        daemonEnrolled: profile.daemonEnrolled,
        taken: taken.has(profile.employeeId),
      }));
      send(200, 'application/json', JSON.stringify({ directory }));
      return;
    }

    if (path === '/api/participants') {
      send(200, 'application/json', JSON.stringify(this.#participantViews()));
      return;
    }

    if (path === '/board') {
      const rows: BoardTaskRow[] = [...(this.#options.taskView?.() ?? [])].map((task) => ({
        text: task.text,
        ownerName: task.ownerName,
        status: task.status,
        type: task.type,
        due: task.due,
      }));
      send(200, 'text/html; charset=utf-8', renderBoardPage(this.#options.meetingId, rows));
      return;
    }

    if (path === '/health') {
      send(200, 'application/json', JSON.stringify({ ok: true, meetingId: this.#options.meetingId }));
      return;
    }

    send(404, 'text/plain; charset=utf-8', 'not found');
  }

  // -------------------------------------------------------------------------
  // WebSocket
  // -------------------------------------------------------------------------

  #acceptClient(socket: WebSocket): void {
    const client: RoomClient = { socket, participant: null };
    this.#clients.add(client);

    socket.on('message', (raw: Buffer | string) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8'));
      } catch {
        this.#send(client, { t: 'error', text: 'Malformed message.' });
        return;
      }

      const result = clientToRoomSchema.safeParse(parsed);
      if (!result.success) {
        this.#send(client, { t: 'error', text: 'Message rejected by the room protocol.' });
        return;
      }

      this.#handleClientMessage(client, result.data);
    });

    socket.on('close', () => {
      this.#clients.delete(client);
      this.#dropParticipant(client);
    });

    socket.on('error', () => {
      this.#clients.delete(client);
      this.#dropParticipant(client);
    });
  }

  #handleClientMessage(
    client: RoomClient,
    message: ReturnType<typeof clientToRoomSchema.parse>,
  ): void {
    switch (message.t) {
      case 'join': {
        if (client.participant !== null) return;

        if (message.employeeId !== null) {
          const profile = this.#directory.find(
            (entry) => entry.employeeId === message.employeeId,
          );
          if (profile === undefined) {
            this.#send(client, { t: 'error', text: 'That person is not on this meeting roster.' });
            return;
          }
          const alreadyIn = [...this.#participants.values()].some(
            (participant) => participant.employeeId === message.employeeId,
          );
          if (alreadyIn) {
            this.#send(client, { t: 'error', text: 'Someone is already in the room as that person.' });
            return;
          }
        }

        const participant: Participant = {
          participantId: newId('p'),
          displayName: message.displayName,
          employeeId: message.employeeId,
          isBot: false,
          joinedAt: this.#clock.date(),
        };
        client.participant = participant;
        this.#participants.set(participant.participantId, participant);

        this.#send(client, {
          t: 'welcome',
          v: ROOM_PROTOCOL_VERSION,
          meetingId: this.#options.meetingId,
          botDisplayName: this.#options.botDisplayName,
          you: toView(participant),
          participants: this.#participantViews(),
          tasks: [...(this.#options.taskView?.() ?? [])],
        });

        if (this.#screenshareUrl !== null) {
          this.#send(client, { t: 'screenshare', url: this.#screenshareUrl });
        }

        this.#broadcast({ t: 'participant', action: 'join', participant: toView(participant) });
        for (const handler of this.#onJoin) handler(participant);
        return;
      }

      case 'say': {
        const participant = client.participant;
        if (participant === null) {
          this.#send(client, { t: 'error', text: 'Join the room before speaking.' });
          return;
        }

        // Everyone sees it, exactly as a room hears it.
        this.#broadcast({
          t: 'message',
          id: newId('msg'),
          from: participant.displayName,
          fromEmployeeId: participant.employeeId,
          text: message.text,
          at: this.#clock.date().toISOString(),
          isBot: false,
        });

        const utterance: HeardUtterance = {
          participantId: participant.participantId,
          employeeId: participant.employeeId,
          speakerName: participant.displayName,
          text: message.text,
          at: this.#clock.date(),
          fromAudio: false,
        };
        for (const handler of this.#onUtterance) handler(utterance);
        return;
      }

      case 'leave': {
        this.#dropParticipant(client);
        return;
      }

      case 'end': {
        for (const handler of this.#onEnd) handler('meeting_ended');
        return;
      }
    }
  }

  #dropParticipant(client: RoomClient): void {
    const participant = client.participant;
    if (participant === null) return;

    client.participant = null;
    this.#participants.delete(participant.participantId);
    this.#broadcast({ t: 'participant', action: 'leave', participant: toView(participant) });
    for (const handler of this.#onLeave) handler(participant);
  }

  #participantViews(): RoomParticipantView[] {
    return [...this.#participants.values()].map(toView);
  }

  #send(client: RoomClient, message: RoomToClient): void {
    if (client.socket.readyState !== 1) return;
    try {
      client.socket.send(JSON.stringify(message));
    } catch (cause) {
      log.warn('local_room.send_failed', {
        error: cause instanceof Error ? cause.message.slice(0, 120) : 'unknown',
      });
    }
  }

  #broadcast(message: RoomToClient): void {
    const payload = JSON.stringify(message);
    for (const client of this.#clients) {
      if (client.socket.readyState !== 1) continue;
      try {
        client.socket.send(payload);
      } catch {
        // A dead socket is removed by its own close handler.
      }
    }
  }
}

function toView(participant: Participant): RoomParticipantView {
  return {
    participantId: participant.participantId,
    displayName: participant.displayName,
    employeeId: participant.employeeId,
    isBot: participant.isBot,
    joinedAt: participant.joinedAt.toISOString(),
  };
}

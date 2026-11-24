import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DaemonConnection,
  type ConnectionHandlers,
  type DaemonSocket,
  type SocketFactory,
} from './connection.js';

/**
 * A WebSocket stand-in.
 *
 * `close()` fires the close handler synchronously, which is stricter than the
 * real thing: if the revocation path only avoids reconnecting because of an
 * async gap, these tests catch it.
 */
class FakeSocket implements DaemonSocket {
  readonly sent: string[] = [];
  closedWith: { code?: number; reason?: string } | null = null;

  #open: (() => void) | null = null;
  #message: ((data: string) => void) | null = null;
  #close: ((code: number) => void) | null = null;
  #error: ((error: Error) => void) | null = null;

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    if (this.closedWith !== null) return;
    this.closedWith = { ...(code === undefined ? {} : { code }), ...(reason === undefined ? {} : { reason }) };
    this.#close?.(code ?? 1000);
  }

  onOpen(handler: () => void): void {
    this.#open = handler;
  }
  onMessage(handler: (data: string) => void): void {
    this.#message = handler;
  }
  onClose(handler: (code: number) => void): void {
    this.#close = handler;
  }
  onError(handler: (error: Error) => void): void {
    this.#error = handler;
  }

  emitOpen(): void {
    this.#open?.();
  }
  emitMessage(data: string): void {
    this.#message?.(data);
  }
  emitClose(code = 1006): void {
    this.#close?.(code);
  }
  emitError(error: Error): void {
    this.#error?.(error);
  }

  parsedSends(): Array<{ type: string; payload: Record<string, unknown> }> {
    return this.sent.map((raw) => JSON.parse(raw) as { type: string; payload: Record<string, unknown> });
  }
}

function frame(type: string, payload: unknown): string {
  return JSON.stringify({
    v: 1,
    id: 'test-id',
    type,
    ts: new Date().toISOString(),
    payload,
  });
}

interface Harness {
  readonly connection: DaemonConnection;
  readonly sockets: FakeSocket[];
  readonly handlers: { [K in keyof ConnectionHandlers]: ReturnType<typeof vi.fn> };
  readonly factoryCalls: () => number;
}

function harness(overrides: { dnd?: boolean; onDispatchThrows?: boolean } = {}): Harness {
  const sockets: FakeSocket[] = [];
  const factory: SocketFactory = () => {
    const socket = new FakeSocket();
    sockets.push(socket);
    return socket;
  };

  const handlers = {
    onDispatch: vi.fn(() => {
      if (overrides.onDispatchThrows === true) throw new Error('handler exploded');
    }),
    onPermissionResponse: vi.fn(),
    onCancel: vi.fn(),
    onTokenRotate: vi.fn(async () => undefined),
    onRevoked: vi.fn(),
    onStateChange: vi.fn(),
  };

  const connection = new DaemonConnection({
    wsUrl: 'ws://127.0.0.1:3001',
    employeeId: 'emp_1',
    agentKind: 'claude-code',
    capabilities: ['github', 'google-calendar'],
    daemonVersion: '0.1.0',
    platform: 'win32',
    getToken: async () => 'device-token-value-that-is-long-enough',
    isDnd: () => overrides.dnd ?? false,
    handlers: handlers as unknown as ConnectionHandlers,
    socketFactory: factory,
    heartbeatMs: 1_000,
    backoff: { baseMs: 1_000, maxMs: 30_000, random: () => 1 },
  });

  return { connection, sockets, handlers, factoryCalls: () => sockets.length };
}

/** `start()` awaits the token read before it builds a socket. */
async function started(h: Harness): Promise<FakeSocket> {
  h.connection.start();
  await vi.advanceTimersByTimeAsync(0);
  const socket = h.sockets[0];
  if (socket === undefined) throw new Error('no socket was created');
  socket.emitOpen();
  return socket;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('DaemonConnection — inbound frame validation', () => {
  const malformed: ReadonlyArray<readonly [string, string]> = [
    ['not JSON at all', 'this is not json {{{'],
    ['JSON that is not an object', '"just a string"'],
    ['null', 'null'],
    ['an array', '[1,2,3]'],
    ['an empty object', '{}'],
    ['a wrong protocol version', JSON.stringify({ v: 99, id: 'x', type: 'task.cancel', ts: new Date().toISOString(), payload: { taskId: 't', reason: 'timeout' } })],
    ['an unknown message type', frame('task.explode', { taskId: 't' })],
    ['a known type with a bad payload', frame('task.dispatch', { taskId: 't' })],
    ['a dispatch with an out-of-range deadline', frame('task.dispatch', {
      taskId: 't', meetingId: 'm', text: 'hi', requesterEmployeeId: 'e',
      mode: 'read_only', selfRequested: false, deadlineSec: 99_999,
    })],
    ['a cancel with an unknown reason', frame('task.cancel', { taskId: 't', reason: 'because' })],
    ['a token rotation with a too-short token', frame('token.rotate', { newToken: 'short', rotatesAt: new Date().toISOString() })],
    ['a revocation with an unknown reason', frame('connection.revoked', { reason: 'vibes' })],
  ];

  for (const [label, raw] of malformed) {
    it(`rejects ${label} without crashing`, async () => {
      const h = harness();
      const socket = await started(h);

      expect(() => socket.emitMessage(raw)).not.toThrow();
      const result = h.connection.handleFrame(raw);

      expect(result.ok).toBe(false);
      expect(result.error).toBeTypeOf('string');
    });
  }

  it('never reaches a handler with an invalid frame', async () => {
    const h = harness();
    const socket = await started(h);

    for (const [, raw] of malformed) socket.emitMessage(raw);

    expect(h.handlers.onDispatch).not.toHaveBeenCalled();
    expect(h.handlers.onPermissionResponse).not.toHaveBeenCalled();
    expect(h.handlers.onCancel).not.toHaveBeenCalled();
    expect(h.handlers.onTokenRotate).not.toHaveBeenCalled();
    expect(h.handlers.onRevoked).not.toHaveBeenCalled();
  });

  it('accepts a Buffer as well as a string', async () => {
    const h = harness();
    await started(h);

    const raw = frame('task.cancel', { taskId: 't1', reason: 'meeting_ended' });
    expect(h.connection.handleFrame(Buffer.from(raw, 'utf8')).ok).toBe(true);
    expect(h.handlers.onCancel).toHaveBeenCalledWith({ taskId: 't1', reason: 'meeting_ended' });
  });

  it('recycles the socket after a sustained stream of invalid frames', async () => {
    const h = harness();
    const socket = await started(h);

    for (let i = 0; i < 20; i += 1) socket.emitMessage('garbage');

    expect(socket.closedWith?.code).toBe(1002);
  });

  it('survives a handler that throws', async () => {
    const h = harness({ onDispatchThrows: true });
    const socket = await started(h);

    const dispatch = frame('task.dispatch', {
      taskId: 't1', meetingId: 'm1', text: 'what does the auth module do?',
      requesterEmployeeId: 'emp_1', mode: 'read_only', selfRequested: true, deadlineSec: 60,
    });

    expect(() => socket.emitMessage(dispatch)).not.toThrow();
    // The socket stays usable for the next frame.
    expect(h.connection.handleFrame(frame('task.cancel', { taskId: 't1', reason: 'superseded' })).ok).toBe(true);
  });
});

describe('DaemonConnection — routing', () => {
  it('routes a valid dispatch to the handler', async () => {
    const h = harness();
    const socket = await started(h);

    socket.emitMessage(frame('task.dispatch', {
      taskId: 't1', meetingId: 'm1', text: 'summarise the README',
      requesterEmployeeId: 'emp_1', mode: 'read_only', selfRequested: true, deadlineSec: 120,
    }));

    expect(h.handlers.onDispatch).toHaveBeenCalledTimes(1);
    expect(h.handlers.onDispatch.mock.calls[0]?.[0]).toMatchObject({ taskId: 't1', mode: 'read_only' });
  });

  it('routes a permission response', async () => {
    const h = harness();
    const socket = await started(h);

    socket.emitMessage(frame('permission.response', {
      taskId: 't1', requestId: 'r1', approved: true, reason: 'granted',
    }));

    expect(h.handlers.onPermissionResponse).toHaveBeenCalledWith({
      taskId: 't1', requestId: 'r1', approved: true, reason: 'granted',
    });
  });

  it('persists a rotated token', async () => {
    const h = harness();
    const socket = await started(h);
    const rotatesAt = new Date().toISOString();

    socket.emitMessage(frame('token.rotate', { newToken: 'x'.repeat(48), rotatesAt }));
    await vi.advanceTimersByTimeAsync(0);

    expect(h.handlers.onTokenRotate).toHaveBeenCalledWith({ newToken: 'x'.repeat(48), rotatesAt });
  });
});

describe('DaemonConnection — handshake and heartbeat', () => {
  it('sends daemon.hello as the first frame after connecting', async () => {
    const h = harness();
    const socket = await started(h);

    const first = socket.parsedSends()[0];
    expect(first?.type).toBe('daemon.hello');
    expect(first?.payload).toMatchObject({
      employeeId: 'emp_1',
      agentKind: 'claude-code',
      capabilities: ['github', 'google-calendar'],
      platform: 'win32',
    });
  });

  it('reports DND on every heartbeat so the server converges after a lost toggle', async () => {
    const h = harness({ dnd: true });
    const socket = await started(h);

    await vi.advanceTimersByTimeAsync(3_100);

    const beats = socket.parsedSends().filter((m) => m.type === 'presence.heartbeat');
    expect(beats.length).toBe(3);
    expect(beats.every((b) => b.payload['dnd'] === true)).toBe(true);
  });

  it('stops beating once the socket closes', async () => {
    const h = harness();
    const socket = await started(h);

    await vi.advanceTimersByTimeAsync(1_100);
    const before = socket.parsedSends().length;

    socket.emitClose(1006);
    await vi.advanceTimersByTimeAsync(3_000);

    expect(socket.parsedSends().length).toBe(before);
  });

  it('drops outbound frames while disconnected rather than queueing them', async () => {
    const h = harness();
    const socket = await started(h);
    socket.emitClose(1006);

    expect(h.connection.sendStatus('t1', 'running', 'searching the repo')).toBe(false);
  });
});

describe('DaemonConnection — reconnect', () => {
  it('reconnects after an unexpected close', async () => {
    const h = harness();
    const socket = await started(h);
    expect(h.factoryCalls()).toBe(1);

    socket.emitClose(1006);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(h.factoryCalls()).toBe(2);
  });

  it('backs off exponentially, bounded by the ceiling', async () => {
    const h = harness();
    let socket = await started(h);

    const delays: number[] = [];
    for (let attempt = 0; attempt < 8; attempt += 1) {
      socket.emitClose(1006);

      // Find the smallest whole second that produces the next connection.
      const before = h.factoryCalls();
      let waited = 0;
      while (h.factoryCalls() === before && waited < 60_000) {
        await vi.advanceTimersByTimeAsync(500);
        waited += 500;
      }
      delays.push(waited);

      const next = h.sockets[h.sockets.length - 1];
      if (next === undefined) throw new Error('reconnect never happened');
      socket = next;
    }

    // random() === 1 in the harness, so each delay is the full window.
    expect(delays.every((d) => d <= 30_000)).toBe(true);
    expect(delays[0]).toBeLessThan(delays[3] ?? 0);
    expect(delays[delays.length - 1]).toBe(30_000);
  });

  it('resets the backoff window after a successful connection', async () => {
    const h = harness();
    let socket = await started(h);

    // Two failures push the window out.
    socket.emitClose(1006);
    await vi.advanceTimersByTimeAsync(1_000);
    socket = h.sockets[1] as FakeSocket;
    socket.emitClose(1006);
    await vi.advanceTimersByTimeAsync(2_000);
    socket = h.sockets[2] as FakeSocket;

    // A real connection resets it.
    socket.emitOpen();
    socket.emitClose(1006);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.factoryCalls()).toBe(4);
  });
});

describe('DaemonConnection — revocation', () => {
  it('closes immediately and never retries', async () => {
    const h = harness();
    const socket = await started(h);

    socket.emitMessage(frame('connection.revoked', { reason: 'reuse_detected' }));

    expect(h.handlers.onRevoked).toHaveBeenCalledWith({ reason: 'reuse_detected' });
    expect(socket.closedWith).not.toBeNull();
    expect(h.connection.state).toBe('revoked');

    // Well past any backoff window.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.factoryCalls()).toBe(1);
  });

  it('stays revoked even if start() is called again', async () => {
    const h = harness();
    const socket = await started(h);

    socket.emitMessage(frame('connection.revoked', { reason: 'employee_removed' }));
    h.connection.start();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(h.factoryCalls()).toBe(1);
    expect(h.connection.state).toBe('revoked');
  });

  it('stop() does not retry either, but is a different state from revoked', async () => {
    const h = harness();
    await started(h);

    h.connection.stop();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(h.factoryCalls()).toBe(1);
    expect(h.connection.state).toBe('stopped');
  });
});

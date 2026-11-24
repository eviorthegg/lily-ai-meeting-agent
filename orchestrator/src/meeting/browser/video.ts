/**
 * Lily's camera.
 *
 * ===========================================================================
 * WHY A BOT NEEDS A CAMERA AT ALL
 * ===========================================================================
 * Two reasons, and the first is mechanical rather than cosmetic. Several
 * platforms treat a camera-less participant differently — a smaller tile, a
 * different position in the grid, and on some Zoom and Teams layouts no tile at
 * all until they speak. A participant with no tile is a participant whose
 * active-speaker highlight cannot be read, and that highlight is what the
 * permission gate rests on.
 *
 * The second is consent. A card that says, in the grid, that this participant
 * is an AI and what it is currently doing is the clearest possible statement of
 * both. The name does the legal work; the tile does the human work.
 *
 * ===========================================================================
 * TWO MODES, BECAUSE THEY BUY DIFFERENT THINGS
 * ===========================================================================
 *   `static-file`   `--use-file-for-fake-video-capture=<file.y4m>`. Needs no
 *                   kernel module and no ffmpeg. Chrome loops the file, so the
 *                   card cannot change during the call.
 *
 *                   **This mode costs Lily her microphone.** See the warning
 *                   below; it is not the free fallback it looks like.
 *
 *   `v4l2loopback`  ffmpeg feeds PNG frames into /dev/videoN, which Chrome sees
 *                   as a real webcam. The card is re-rendered whenever
 *                   `setStatus` changes, so the grid shows live work in
 *                   progress. Needs the v4l2loopback kernel module, which needs
 *                   root at provisioning time.
 *
 * The flag for `static-file` has to exist before Chrome launches, so its frame
 * is synthesised here rather than screenshotted — there is no browser yet to
 * screenshot with. That is why it is a coloured card and not a rendered page:
 * an honest limitation of the mode, not an unfinished one.
 *
 * ===========================================================================
 * WHY `static-file` IS NOT THE DEFAULT, MEASURED ON A REAL LINUX HOST
 * ===========================================================================
 * This mode used to be the default, and it produced NO CAMERA AT ALL. Chrome
 * ignores `--use-file-for-fake-video-capture` unless
 * `--use-fake-device-for-media-stream` is passed alongside it. Measured in the
 * shipping container image, requesting `getUserMedia({video:true})`:
 *
 *     no flags                       -> NotFoundError
 *     --use-file-for-fake-video-...  -> NotFoundError      <- what we shipped
 *     both flags together            -> track "card.y4m"   640x360
 *
 * So every meeting joined in this mode joined with zero video devices, while
 * the log cheerfully said `video.static_card_ready`.
 *
 * The obvious repair — add the companion flag — is worse, and that is the
 * important part. `--use-fake-device-for-media-stream` fakes the MICROPHONE
 * too. With it, the enumerated audio inputs are exactly:
 *
 *     ["Fake Default Audio Input", "Fake Audio Input 1", "Fake Audio Input 2"]
 *
 * The PulseAudio source Lily speaks through is gone, replaced by a test tone.
 * A camera bought at the price of Lily's voice is not a trade this product can
 * make, so the flag pair is only ever emitted when a caller asks for
 * `static-file` explicitly, and it warns when it does.
 *
 * `v4l2loopback` is the only mode that yields a real camera AND a real
 * microphone, which is why `resolveVideoMode()` prefers it and falls back to
 * `none` — never silently to `static-file`. Losing the tile is a cosmetic
 * degradation; losing the microphone is a mute bot.
 * ===========================================================================
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { accessSync, constants, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

import { errorField, log } from '../../util/log.js';

export type VideoMode = 'static-file' | 'v4l2loopback' | 'none';

export interface VideoOptions {
  readonly mode: VideoMode;
  readonly width: number;
  readonly height: number;
  /** Only used by `v4l2loopback`. */
  readonly device: string;
  readonly fps: number;
  readonly meetingId: string;
}

/**
 * Bytes to push into ffmpeg before Chrome launches. See `AvatarVideo#prime`.
 *
 * 64KB against a measured failure at 7460 bytes and a measured success at
 * 14920. The margin is deliberate: the exact threshold belongs to ffmpeg, and
 * being under it produces a bot with no camera and no error message.
 */
export const PRIME_BYTES = 65_536;

/** Backstop so a tiny card cannot turn priming into an unbounded loop. */
export const PRIME_FRAME_CAP = 512;

export const DEFAULT_VIDEO: Omit<VideoOptions, 'mode' | 'meetingId'> = {
  width: 640,
  height: 360,
  device: '/dev/video0',
  fps: 5,
};

/** BT.601 full-range, which is what Chrome assumes for a C420mpeg2 y4m. */
function rgbToYuv(r: number, g: number, b: number): { y: number; u: number; v: number } {
  return {
    y: Math.round(0.299 * r + 0.587 * g + 0.114 * b),
    u: Math.round(-0.168736 * r - 0.331264 * g + 0.5 * b + 128),
    v: Math.round(0.5 * r - 0.418688 * g - 0.081312 * b + 128),
  };
}

function clamp8(value: number): number {
  return value < 0 ? 0 : value > 255 ? 255 : value;
}

/**
 * A two-tone card as a looping y4m.
 *
 * Deliberately not a solid colour: a completely flat frame is what a broken
 * capture looks like, and "is the camera working?" is not a question anyone
 * should have to ask mid-meeting.
 */
export function buildStaticY4m(options: {
  width: number;
  height: number;
  background: readonly [number, number, number];
  band: readonly [number, number, number];
  frames: number;
}): Buffer {
  const { width, height, frames } = options;
  // y4m C420 requires even dimensions.
  const w = width - (width % 2);
  const h = height - (height % 2);

  const bg = rgbToYuv(options.background[0], options.background[1], options.background[2]);
  const fg = rgbToYuv(options.band[0], options.band[1], options.band[2]);

  const bandTop = Math.floor(h * 0.62);
  const bandBottom = Math.floor(h * 0.72);

  const ySize = w * h;
  const cSize = (w / 2) * (h / 2);

  const yPlane = Buffer.alloc(ySize);
  const uPlane = Buffer.alloc(cSize);
  const vPlane = Buffer.alloc(cSize);

  for (let row = 0; row < h; row += 1) {
    const inBand = row >= bandTop && row < bandBottom;
    const pixel = inBand ? fg : bg;
    yPlane.fill(clamp8(pixel.y), row * w, row * w + w);
  }
  for (let row = 0; row < h / 2; row += 1) {
    const sourceRow = row * 2;
    const inBand = sourceRow >= bandTop && sourceRow < bandBottom;
    const pixel = inBand ? fg : bg;
    uPlane.fill(clamp8(pixel.u), row * (w / 2), row * (w / 2) + w / 2);
    vPlane.fill(clamp8(pixel.v), row * (w / 2), row * (w / 2) + w / 2);
  }

  const header = Buffer.from(`YUV4MPEG2 W${w} H${h} F25:1 Ip A1:1 C420mpeg2\n`, 'ascii');
  const chunks: Buffer[] = [header];
  for (let i = 0; i < frames; i += 1) {
    chunks.push(Buffer.from('FRAME\n', 'ascii'), yPlane, uPlane, vPlane);
  }
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------------------
// A PNG, with no image library
// ---------------------------------------------------------------------------
// `pushFrame` takes PNGs because the live card is a browser screenshot. The
// priming frame has to be the same format, and it has to exist before there is
// a browser — so it is synthesised. A truecolour PNG with filter 0 on every
// scanline is a header, one deflate stream and two more chunks; pulling in an
// image dependency to produce a two-tone rectangle would be the wrong trade.

const CRC_TABLE = ((): Uint32Array => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) c = (CRC_TABLE[(c ^ byte) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

/** The same two-tone card as {@link buildStaticY4m}, as a PNG. */
export function buildStaticPng(options: {
  width: number;
  height: number;
  background: readonly [number, number, number];
  band: readonly [number, number, number];
}): Buffer {
  const { width: w, height: h } = options;
  const bandTop = Math.floor(h * 0.62);
  const bandBottom = Math.floor(h * 0.72);

  // Each scanline is one filter byte (0 = None) followed by RGB triples.
  const raw = Buffer.alloc(h * (1 + w * 3));
  for (let row = 0; row < h; row += 1) {
    const inBand = row >= bandTop && row < bandBottom;
    const [r, g, b] = inBand ? options.band : options.background;
    const start = row * (1 + w * 3);
    raw[start] = 0;
    for (let col = 0; col < w; col += 1) {
      const at = start + 1 + col * 3;
      raw[at] = r;
      raw[at + 1] = g;
      raw[at + 2] = b;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour RGB
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * The ffmpeg command line that turns pushed PNGs into a webcam.
 *
 * Extracted so the probe flags can be asserted in a unit test. They are the
 * difference between a working camera and none at all, they look like
 * performance tuning, and the failure they prevent shows up nowhere near here —
 * so "someone tidied them away" is a real risk worth a test.
 */
export function buildFfmpegArgs(options: {
  width: number;
  height: number;
  fps: number;
  device: string;
}): readonly string[] {
  return [
    '-loglevel',
    'error',
    // -----------------------------------------------------------------
    // These two are why the camera exists at all. Do not remove them.
    // -----------------------------------------------------------------
    // ffmpeg will not open its output until it has finished probing the input,
    // and by default it waits for a 5MB probe buffer or EOF. This input is a
    // live pipe that never sees EOF, and a 640x360 PNG card is ~1.5KB — so it
    // would sit there probing forever, having never opened /dev/video0.
    // Because the loopback device is loaded with exclusive_caps=1, an unopened
    // output means the capture side stays hidden and Chrome enumerates ZERO
    // cameras on a host that has a working one.
    //
    // Measured on the EC2 test host: same frames, same argv, sole difference
    // these two flags. Without them getUserMedia({video:true}) gives
    // NotFoundError; with them the track is "Lily Camera" 640x360. Pushing
    // more frames does NOT help — 2, 5 and 25 all failed — because the
    // threshold is bytes, not frames.
    '-probesize',
    '32',
    '-analyzeduration',
    '0',
    '-f',
    'image2pipe',
    '-framerate',
    String(options.fps),
    '-i',
    '-',
    '-vf',
    `scale=${options.width}:${options.height}`,
    '-pix_fmt',
    'yuv420p',
    '-f',
    'v4l2',
    options.device,
  ];
}

/**
 * Pick a video mode for this host.
 *
 * The fallback is `none`, never `static-file`. See the header: `static-file`
 * silently trades the microphone for the tile, and a bot nobody can hear is a
 * far worse failure than a bot with no picture. Choosing it has to be a
 * deliberate act, so it is reachable only through the explicit override.
 */
export function resolveVideoMode(device: string = DEFAULT_VIDEO.device): VideoMode {
  const override = process.env['LILY_VIDEO_MODE'];
  if (override === 'v4l2loopback' || override === 'static-file' || override === 'none') {
    return override;
  }
  if (override !== undefined && override !== '') {
    throw new Error(
      `LILY_VIDEO_MODE=${override} is not a video mode. ` +
        'Expected one of: v4l2loopback, static-file, none.',
    );
  }

  try {
    // W_OK, not F_OK: the device node exists inside the container whenever it
    // is passed with --device, but writing to it needs the `video` group. An
    // unwritable device would start ffmpeg only to have it die on the first
    // frame, and the camera would be missing with no obvious reason why.
    accessSync(device, constants.W_OK);
    return 'v4l2loopback';
  } catch {
    log.info('video.no_loopback_device', {
      device,
      mode: 'none',
      detail:
        'No writable v4l2loopback device, so Lily joins without a camera. ' +
        'Set LILY_VIDEO_MODE=static-file only if she does not need to speak.',
    });
    return 'none';
  }
}

/**
 * The camera, whichever mode it is in.
 *
 * `prepare()` runs before Chrome launches and returns the flags Chrome needs;
 * `pushFrame()` does nothing in the modes that cannot accept one, so the caller
 * never branches on mode.
 */
export class AvatarVideo {
  readonly #options: VideoOptions;
  #y4mPath: string | null = null;
  #ffmpeg: ChildProcess | null = null;
  #stopped = false;
  #framesPushed = 0;

  constructor(options: VideoOptions) {
    this.#options = options;
  }

  get mode(): VideoMode {
    return this.#options.mode;
  }

  get framesPushed(): number {
    return this.#framesPushed;
  }

  /** Chrome flags for this mode. Empty for `v4l2loopback` — it is a real device. */
  prepare(): readonly string[] {
    if (this.#options.mode === 'none') return [];

    if (this.#options.mode === 'static-file') {
      const dir = join(tmpdir(), 'lily-avatar');
      mkdirSync(dir, { recursive: true });
      const path = join(dir, `${this.#options.meetingId}.y4m`);
      writeFileSync(
        path,
        buildStaticY4m({
          width: this.#options.width,
          height: this.#options.height,
          // The local room's palette, so Lily looks the same in both places.
          background: [0x12, 0x15, 0x1d],
          band: [0x38, 0xd3, 0xa8],
          frames: 2,
        }),
      );
      this.#y4mPath = path;
      // Both flags, always. The file flag alone is silently inert — see the
      // measurements in the header. And say plainly what it costs, because the
      // symptom (Lily is in the meeting, has a tile, and everything she says
      // comes out as a test tone) does not point back here on its own.
      log.warn('video.static_card_ready', {
        mode: this.#options.mode,
        path,
        microphone:
          'REPLACED by Chrome fake audio input — --use-fake-device-for-media-stream ' +
          'fakes the mic as well as the camera, so Lily cannot be heard in this mode.',
      });
      return [
        '--use-fake-device-for-media-stream',
        `--use-file-for-fake-video-capture=${path}`,
      ];
    }

    this.#startFfmpeg();
    this.#prime();
    return [];
  }

  #startFfmpeg(): void {
    const { width, height, fps, device } = this.#options;
    const child = spawn('ffmpeg', [...buildFfmpegArgs({ width, height, fps, device })], {
      stdio: ['pipe', 'ignore', 'pipe'],
    });

    child.on('error', (cause) => {
      log.error('video.ffmpeg_failed', { device, error: errorField(cause) });
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      log.warn('video.ffmpeg_stderr', { text: chunk.toString('utf8').slice(0, 160) });
    });

    this.#ffmpeg = child;
    log.info('video.loopback_ready', { device, width, height, fps });
  }

  /**
   * Fill the pipe before Chrome launches, so the camera exists when it looks.
   *
   * ---------------------------------------------------------------------
   * Why this is a loop and not a single frame
   * ---------------------------------------------------------------------
   * Two facts combine into a circular dependency:
   *
   *   - v4l2loopback is loaded with exclusive_caps=1, so the capture side is
   *     hidden until something opens the OUTPUT side.
   *   - ffmpeg does not open its output until its filter graph initialises,
   *     which needs a minimum VOLUME of input — not a minimum frame count.
   *
   * and the only other source of frames is a screenshot of a page in a browser
   * that has not launched yet.
   *
   * Measured on the EC2 test host with `-loglevel verbose`, 640x360 card,
   * ~1492 bytes per frame:
   *
   *     5 frames   (7460 B)  -> stream identified, "Output #0" NEVER printed,
   *                             Chrome: NotFoundError
   *    10 frames  (14920 B)  -> "Output #0 ... to '/dev/video0'", frame=1,
   *                             Chrome: track "Lily Camera"
   *
   * so the threshold is somewhere in between, and it is a property of ffmpeg's
   * buffering rather than anything this code controls. {@link PRIME_BYTES} is
   * therefore set well above the highest failing measurement rather than just
   * above it — a card of a different size or an ffmpeg of a different version
   * moves the boundary, and the failure mode is silent.
   *
   * This costs nothing at runtime. ffmpeg is not rate-limited here (no `-re`),
   * so it drains the backlog at about 100x realtime — measured `speed=101x` —
   * and live status frames are not delayed behind it.
   */
  #prime(): void {
    const png = buildStaticPng({
      width: this.#options.width,
      height: this.#options.height,
      // The local room's palette, so Lily looks the same in both places.
      background: [0x12, 0x15, 0x1d],
      band: [0x38, 0xd3, 0xa8],
    });

    let written = 0;
    let frames = 0;
    // The frame cap is a guard, not the mechanism: a pathologically small card
    // should not turn this into an unbounded write loop.
    while (written < PRIME_BYTES && frames < PRIME_FRAME_CAP) {
      this.pushFrame(png);
      written += png.length;
      frames += 1;
    }

    log.info('video.primed', { device: this.#options.device, frames, bytes: written });
  }

  /**
   * Push one rendered frame.
   *
   * A no-op outside `v4l2loopback`, so `setStatus` can call it unconditionally.
   */
  pushFrame(png: Buffer): void {
    if (this.#stopped || this.#options.mode !== 'v4l2loopback') return;
    const stdin = this.#ffmpeg?.stdin;
    if (stdin === null || stdin === undefined) return;
    stdin.write(png);
    this.#framesPushed += 1;
  }

  get staticCardPath(): string | null {
    return this.#y4mPath;
  }

  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    const child = this.#ffmpeg;
    this.#ffmpeg = null;
    if (child === null) return;
    try {
      child.stdin?.end();
      child.kill('SIGTERM');
    } catch {
      // Already gone.
    }
  }
}

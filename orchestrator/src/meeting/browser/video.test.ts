/**
 * Lily's camera.
 *
 * These tests exist because this module shipped a camera that did not work,
 * while logging that it was ready. `--use-file-for-fake-video-capture` is
 * silently inert unless `--use-fake-device-for-media-stream` is passed with it,
 * so `static-file` mode produced a participant with zero video devices and
 * nothing anywhere said so.
 *
 * Measured in the shipping container image on a real Linux host, calling
 * `getUserMedia({video:true})`:
 *
 *     no flags                        -> NotFoundError
 *     --use-file-for-fake-video-...   -> NotFoundError      <- what we shipped
 *     both flags                      -> track "card.y4m"
 *
 * and with both flags the enumerated audio inputs were exactly
 * `["Fake Default Audio Input", "Fake Audio Input 1", "Fake Audio Input 2"]` —
 * the PulseAudio source Lily speaks through, gone.
 *
 * That pair of facts is the whole design: the flags travel together or not at
 * all, and the fallback is `none` rather than a mode that mutes her. The tests
 * below pin both, because the failure they prevent is invisible in a log.
 */

import { afterEach, describe, expect, it } from 'vitest';

import {
  AvatarVideo,
  DEFAULT_VIDEO,
  buildFfmpegArgs,
  buildStaticPng,
  resolveVideoMode,
} from './video.js';

const ORIGINAL_MODE = process.env['LILY_VIDEO_MODE'];

afterEach(() => {
  if (ORIGINAL_MODE === undefined) delete process.env['LILY_VIDEO_MODE'];
  else process.env['LILY_VIDEO_MODE'] = ORIGINAL_MODE;
});

describe('static-file mode emits the flags that actually produce a camera', () => {
  it('never emits the file flag without its companion', () => {
    const video = new AvatarVideo({
      ...DEFAULT_VIDEO,
      mode: 'static-file',
      meetingId: 'flags-together',
    });
    const args = video.prepare();

    const fileFlag = args.find((a) => a.startsWith('--use-file-for-fake-video-capture='));
    expect(fileFlag, 'the file flag should be present in static-file mode').toBeDefined();
    expect(
      args,
      'the file flag is inert alone — Chrome reports NotFoundError without this one',
    ).toContain('--use-fake-device-for-media-stream');

    video.stop();
  });

  it('writes a y4m the flag can actually point at', () => {
    const video = new AvatarVideo({
      ...DEFAULT_VIDEO,
      mode: 'static-file',
      meetingId: 'card-exists',
    });
    const args = video.prepare();
    const path = video.staticCardPath;

    expect(path).not.toBeNull();
    expect(args).toContain(`--use-file-for-fake-video-capture=${path as string}`);

    video.stop();
  });
});

describe('none mode asks Chrome for nothing', () => {
  it('emits no flags at all', () => {
    const video = new AvatarVideo({ ...DEFAULT_VIDEO, mode: 'none', meetingId: 'quiet' });
    expect(video.prepare()).toEqual([]);
    video.stop();
  });
});

describe('resolveVideoMode never silently costs Lily her microphone', () => {
  it('falls back to none, not static-file, when there is no loopback device', () => {
    delete process.env['LILY_VIDEO_MODE'];
    // A path that cannot exist, so the access check fails the way it would on a
    // host without the kernel module.
    expect(resolveVideoMode('/dev/definitely-not-a-video-device')).toBe('none');
  });

  it('honours an explicit override, because static-file has to be deliberate', () => {
    process.env['LILY_VIDEO_MODE'] = 'static-file';
    expect(resolveVideoMode('/dev/definitely-not-a-video-device')).toBe('static-file');
  });

  it('rejects a mode it does not recognise rather than guessing', () => {
    process.env['LILY_VIDEO_MODE'] = 'loopback';
    expect(() => resolveVideoMode()).toThrow(/not a video mode/);
  });
});

describe('the ffmpeg command line keeps the flags that make the camera appear', () => {
  const args = buildFfmpegArgs({ width: 640, height: 360, fps: 5, device: '/dev/video0' });

  it('caps the probe size, or ffmpeg never opens the device', () => {
    // ffmpeg waits for a 5MB probe buffer or EOF before opening its output.
    // pushFrame's pipe never closes and the frames are ~1.5KB, so without this
    // the output is never opened and exclusive_caps=1 keeps the capture side
    // hidden. Chrome then reports NotFoundError on a host with a real camera.
    expect(args).toContain('-probesize');
    expect(args[args.indexOf('-probesize') + 1]).toBe('32');
  });

  it('does not wait to analyse the stream either', () => {
    expect(args).toContain('-analyzeduration');
    expect(args[args.indexOf('-analyzeduration') + 1]).toBe('0');
  });

  it('probe flags precede the input they apply to', () => {
    // ffmpeg scopes these to the next -i. After it they are silently ignored,
    // which would look exactly like the bug they fix.
    expect(args.indexOf('-probesize')).toBeLessThan(args.indexOf('-i'));
    expect(args.indexOf('-analyzeduration')).toBeLessThan(args.indexOf('-i'));
  });

  it('still writes to the requested device', () => {
    expect(args[args.length - 1]).toBe('/dev/video0');
  });
});

describe('the priming PNG', () => {
  it('is a real PNG, because ffmpeg is the one that has to read it', () => {
    const png = buildStaticPng({
      width: 64,
      height: 32,
      background: [0x12, 0x15, 0x1d],
      band: [0x38, 0xd3, 0xa8],
    });

    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(png.subarray(12, 16).toString('ascii')).toBe('IHDR');
    expect(png.readUInt32BE(16)).toBe(64);
    expect(png.readUInt32BE(20)).toBe(32);
    expect(png.subarray(png.length - 8, png.length - 4).toString('ascii')).toBe('IEND');
  });
});

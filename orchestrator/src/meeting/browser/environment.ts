/**
 * The host machinery a browser needs before it is any use in a meeting.
 *
 * Xvfb, PulseAudio and the camera are three separate Linux facilities with
 * three separate failure modes, and the adapter should not be three-quarters
 * process management. They are gathered behind one interface here so that:
 *
 *   - the adapter's `join()` reads as a join sequence rather than as a
 *     provisioning script, and
 *   - a unit test can supply an environment that starts nothing at all, which
 *     is what makes the join state machine and the selector reporting testable
 *     on a laptop with no display server.
 *
 * The null environment is not a mock of a real one. It is the honest answer to
 * "what does this adapter do when there is no audio hardware": no capture
 * stream, speech goes nowhere, and `capabilities.audio` is the caller's problem
 * to have checked.
 */

import { errorField, log } from '../../util/log.js';
import type { AudioStream } from '../../types.js';
import {
  CAPTURE_SAMPLE_RATE,
  MicrophonePlayback,
  MonitorAudioStream,
  PulseTopology,
} from './audio.js';
import { AvatarVideo, DEFAULT_VIDEO, type VideoMode } from './video.js';
import { XvfbDisplay } from './xvfb.js';

export interface MeetingEnvironment {
  /** `:123`, or empty when the browser should use the ambient display. */
  readonly display: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Chrome flags the video mode contributes. Must be read after `start()`. */
  videoArgs(): readonly string[];
  /** Room audio, or null when this environment carries none. */
  captureStream(): AudioStream | null;
  writeSpeech(pcm16: Uint8Array): Promise<void>;
  interruptSpeech(): void;
  /** One rendered avatar frame. Ignored unless the video mode can take one. */
  pushAvatarFrame(png: Buffer): void;
}

export interface LinuxEnvironmentOptions {
  readonly meetingId: string;
  readonly videoMode: VideoMode;
  readonly screen: { readonly width: number; readonly height: number };
}

/** Xvfb + PulseAudio + a camera. The real thing, and Linux only. */
export class LinuxMeetingEnvironment implements MeetingEnvironment {
  readonly #xvfb: XvfbDisplay;
  readonly #pulse: PulseTopology;
  readonly #video: AvatarVideo;
  #capture: MonitorAudioStream | null = null;
  #playback: MicrophonePlayback | null = null;
  #videoArgs: readonly string[] = [];
  #started = false;

  constructor(options: LinuxEnvironmentOptions) {
    this.#xvfb = new XvfbDisplay({
      width: options.screen.width,
      height: options.screen.height,
    });
    this.#pulse = new PulseTopology(options.meetingId);
    this.#video = new AvatarVideo({
      ...DEFAULT_VIDEO,
      mode: options.videoMode,
      meetingId: options.meetingId,
    });
  }

  get display(): string {
    return this.#xvfb.display;
  }

  async start(): Promise<void> {
    if (this.#started) return;
    // Order matters. Chrome reads the Pulse defaults and the DISPLAY at launch,
    // so both have to exist before the browser does.
    await this.#xvfb.start();
    this.#pulse.setUp();
    this.#videoArgs = this.#video.prepare();

    this.#playback = new MicrophonePlayback({
      device: this.#pulse.names.micSink,
      sampleRate: CAPTURE_SAMPLE_RATE,
    });
    this.#started = true;
  }

  videoArgs(): readonly string[] {
    return this.#videoArgs;
  }

  captureStream(): AudioStream | null {
    if (!this.#started) return null;
    // Opened lazily: a meeting where nobody ever asks for audio should not have
    // a `parec` running for its whole duration.
    this.#capture ??= new MonitorAudioStream({
      device: `${this.#pulse.names.outSink}.monitor`,
      sampleRate: CAPTURE_SAMPLE_RATE,
    });
    return this.#capture;
  }

  async writeSpeech(pcm16: Uint8Array): Promise<void> {
    await this.#playback?.write(pcm16);
  }

  interruptSpeech(): void {
    this.#playback?.interrupt();
  }

  pushAvatarFrame(png: Buffer): void {
    this.#video.pushFrame(png);
  }

  async stop(): Promise<void> {
    if (!this.#started) return;
    this.#started = false;

    this.#capture?.close();
    this.#capture = null;
    this.#playback?.close();
    this.#playback = null;
    this.#video.stop();

    try {
      this.#pulse.tearDown();
    } catch (cause) {
      log.warn('pulse.teardown_failed', { error: errorField(cause) });
    }
    await this.#xvfb.stop();
  }
}

/**
 * No display, no audio, no camera.
 *
 * Used by tests, and by nothing else. It is deliberately not silently
 * substituted at runtime: an adapter that quietly ran without audio would look
 * like a bot that had joined and then said nothing.
 */
export class NullMeetingEnvironment implements MeetingEnvironment {
  readonly display = '';
  readonly written: Uint8Array[] = [];
  interrupts = 0;
  frames = 0;

  async start(): Promise<void> {
    // Nothing to start.
  }
  async stop(): Promise<void> {
    // Nothing to stop.
  }
  videoArgs(): readonly string[] {
    return [];
  }
  captureStream(): AudioStream | null {
    return null;
  }
  async writeSpeech(pcm16: Uint8Array): Promise<void> {
    this.written.push(pcm16);
  }
  interruptSpeech(): void {
    this.interrupts += 1;
  }
  pushAvatarFrame(_png: Buffer): void {
    this.frames += 1;
  }
}

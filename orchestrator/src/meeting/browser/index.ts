/**
 * The browser meeting adapter, as a package.
 *
 * Callers want three things — build an adapter, ask whether this host could run
 * one, and pick a driver from a link — and everything else is internal. Import
 * from here rather than from the individual modules.
 */

export { BrowserMeetingAdapter, DEFAULT_TIMEOUTS } from './adapter.js';
export type { BrowserMeetingAdapterOptions } from './adapter.js';

export {
  JoinStalledError,
  SelectorFailureError,
  requireSelector,
} from './driver.js';
export type {
  BrowserDriverId,
  JoinContext,
  PageContext,
  PlatformDriver,
  SelectorEntry,
  SelectorTable,
  StepTimeouts,
} from './driver.js';

export { JoinStateMachine, JoinStateError, isTerminal } from './state.js';
export type { JoinState, JoinStateEntry } from './state.js';

export { SpeakerResolver, SpeakerTracker, cleanDisplayName } from './speaker.js';
export type { ResolvedSpeaker, SpeakerObservation } from './speaker.js';

export {
  browserPreflight,
  findChrome,
  inspectHost,
  systemProbe,
  XvfbDisplay,
} from './xvfb.js';
export type { HostProbe, HostRequirements } from './xvfb.js';

export { LinuxMeetingEnvironment, NullMeetingEnvironment } from './environment.js';
export type { MeetingEnvironment } from './environment.js';

export {
  allDrivers,
  driverById,
  driverForUrl,
  JitsiDriver,
  MeetDriver,
  TeamsDriver,
  ZoomDriver,
  toWebClientUrl,
} from './drivers/index.js';

export type {
  BrowserLauncher,
  BrowserLocator,
  BrowserPage,
  BrowserSession,
  LaunchOptions,
} from './page.js';

export { buildStaticPng, buildStaticY4m, resolveVideoMode } from './video.js';
export type { VideoMode } from './video.js';

export { MeetingSurface, renderAvatarPage } from './surface.js';

/**
 * The driver registry.
 *
 * Order matters only for `driverForUrl`, and only in that Jitsi is asked last:
 * its `matches` is the loosest (a self-hosted Jitsi can live on any hostname),
 * so the platforms with fixed domains get first refusal.
 */

import type { BrowserDriverId, PlatformDriver } from '../driver.js';
import { JitsiDriver } from './jitsi.js';
import { MeetDriver } from './meet.js';
import { TeamsDriver } from './teams.js';
import { ZoomDriver } from './zoom.js';

export { JitsiDriver } from './jitsi.js';
export { MeetDriver } from './meet.js';
export { TeamsDriver } from './teams.js';
export { ZoomDriver, toWebClientUrl } from './zoom.js';
export { runStandardJoin, firstMeaningful } from './common.js';
export type { StandardJoinPlan } from './common.js';

export function allDrivers(): readonly PlatformDriver[] {
  return [new MeetDriver(), new ZoomDriver(), new TeamsDriver(), new JitsiDriver()];
}

export function driverById(id: BrowserDriverId): PlatformDriver {
  switch (id) {
    case 'jitsi':
      return new JitsiDriver();
    case 'meet':
      return new MeetDriver();
    case 'zoom':
      return new ZoomDriver();
    case 'teams':
      return new TeamsDriver();
  }
}

/**
 * Pick a driver from a join link.
 *
 * Returns null rather than guessing. A meeting link nobody recognises should
 * produce "I do not know this platform", not a Jitsi driver pointed at Webex.
 */
export function driverForUrl(url: string): PlatformDriver | null {
  for (const driver of allDrivers()) {
    if (driver.matches(url)) return driver;
  }
  return null;
}

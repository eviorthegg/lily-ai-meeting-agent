/**
 * Reported in `daemon.hello`. Kept as a literal rather than imported from
 * package.json: `rootDir` is ./src, so a JSON import would drag the manifest
 * into the emit tree and change the shape of dist/.
 *
 * Must be bumped together with daemon/package.json.
 */
export const DAEMON_VERSION = '0.1.0';

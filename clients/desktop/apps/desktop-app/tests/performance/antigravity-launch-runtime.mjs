// Placeholder for `antigravity-launch-host.mjs`. `antigravity-launch-run.mjs`
// replaces this module at bundle time with one checkout's shared Antigravity
// runtime, so the host is never meant to run unbundled.
function unbundled() {
  throw new Error('Bundle this host with antigravity-launch-run.mjs.');
}

export const openAntigravityRuntime = unbundled;
export const spawnProviderProcessDirect = unbundled;
/** Present only in checkouts that have the launch check. */
export const verifyAntigravityExecutable = undefined;
export const assertAntigravityExecutableUnchanged = undefined;

// Load the configured logger (jestElectronLog.ts) before a suite runs, so
// electron-log and the electron module it requires are in the registry before
// any suite's own `jest.mock('electron', ...)` factory could run.
import 'electron-log/main.js';

// jsdom implements no layout, so it ships no `Element.prototype.scrollIntoView`.
// Any suite rendering the real shared `ChatTranscript` hits it, because the
// transcript autoscrolls to its bottom sentinel on mount. Stub it here rather
// than making product code defensive about a jsdom gap. Guarded so the
// node-environment suites (which have no `Element`) are unaffected.
if (typeof Element !== 'undefined' && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function scrollIntoView(): void {};
}

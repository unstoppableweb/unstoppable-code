import { removeJestRunDataRoot } from './jest-data-root.mjs';

// Jest globalTeardown: puts back the global config globalSetup replaced and
// removes the unsigned one it wrote, then removes the run's data root with
// every worker's root in it (CAN-6669). Jest runs it whether tests passed or
// failed.
export default function restoreTestGitConfig() {
  const restore = globalThis.canopyRestoreTestGitConfig;
  globalThis.canopyRestoreTestGitConfig = undefined;
  const root = globalThis.canopyJestRunDataRoot;
  globalThis.canopyJestRunDataRoot = undefined;
  try {
    if (typeof restore === 'function') restore();
  } finally {
    if (typeof root === 'string') removeJestRunDataRoot(root);
  }
}

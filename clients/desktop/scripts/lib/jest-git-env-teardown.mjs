// Jest globalTeardown: puts back the global config globalSetup replaced and
// removes the unsigned one it wrote.
export default function restoreTestGitConfig() {
  const restore = globalThis.canopyRestoreTestGitConfig;
  globalThis.canopyRestoreTestGitConfig = undefined;
  if (typeof restore === 'function') restore();
}

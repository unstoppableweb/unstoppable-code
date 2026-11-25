/**
 * Per-platform facts about the pinned Cursor CLI package.
 *
 * The vendor ships structurally different packages per platform, so every
 * platform-dependent name lives here rather than being hard-coded at each call
 * site. Shared with `scripts/update-cursor-runtime-pin.mjs` so the pin script
 * and the installer agree on layout, and kept free of Node imports so it stays
 * importable from pure contexts. Kept import-free so it can be loaded as an
 * ES module by the pin script running under tsx.
 */

// Executable entry points in the pinned macOS archive. Content hashes alone
// cannot detect lost execute permission on the launcher, Node, or the native
// helpers, so these are checked explicitly after extraction.
const DARWIN_EXECUTABLES: readonly string[] = [
  'cursor-agent',
  'node',
  'cursor-agent-sea',
  'cursor-agent-worker-sea',
  'spawn-helper',
  'cursorsandbox',
  'rg',
  'crepectl',
  'cursor-askpass',
];
// The Linux archive has the macOS layout and `cursor-agent` bash launcher,
// minus the macOS-only `spawn-helper`. Its native helpers and addons are
// glibc builds (`*.linux-<arch>-gnu.node`).
const LINUX_EXECUTABLES: readonly string[] = [
  'cursor-agent',
  'node',
  'cursor-agent-sea',
  'cursor-agent-worker-sea',
  'cursorsandbox',
  'rg',
  'crepectl',
  'cursor-askpass',
];
export type CursorRuntimeTargetKey =
  | 'darwin-arm64'
  | 'darwin-x64'
  | 'linux-arm64'
  | 'linux-x64'
  | 'win32-x64'
  | 'win32-arm64';

export interface CursorRuntimeTarget {
  readonly key: CursorRuntimeTargetKey;
  /** Vendor download path segment: `win32` is published as `windows`. */
  readonly os: 'darwin' | 'linux' | 'windows';
  readonly arch: 'arm64' | 'x64';
  readonly archive: 'tar.gz' | 'zip';
  /**
   * Names resolved against the install directory to build the launch argv.
   * macOS runs the `cursor-agent` launcher; Windows ships no such binary and
   * its `.cmd`/`.ps1` wrappers only exec `node.exe index.js`, so Canopy spawns
   * that pair directly and never goes through a shell.
   */
  readonly launch: readonly string[];
  /** Name of the Node runtime used to run the preToolUse approval hook. */
  readonly hookRuntime: string;
  /**
   * Files that must carry the execute bit after extraction. Empty where the
   * archive format carries no Unix mode bits (Windows zips).
   */
  readonly executables: readonly string[];
  /** Files whose presence proves a complete installation. */
  readonly required: readonly string[];
}

const WINDOWS_LAUNCH: readonly string[] = ['node.exe', 'index.js'];

export const CURSOR_RUNTIME_TARGETS: readonly CursorRuntimeTarget[] = [
  {
    key: 'darwin-arm64',
    os: 'darwin',
    arch: 'arm64',
    archive: 'tar.gz',
    launch: ['cursor-agent'],
    hookRuntime: 'node',
    executables: DARWIN_EXECUTABLES,
    required: ['cursor-agent'],
  },
  {
    key: 'darwin-x64',
    os: 'darwin',
    arch: 'x64',
    archive: 'tar.gz',
    launch: ['cursor-agent'],
    hookRuntime: 'node',
    executables: DARWIN_EXECUTABLES,
    required: ['cursor-agent'],
  },
  {
    key: 'linux-arm64',
    os: 'linux',
    arch: 'arm64',
    archive: 'tar.gz',
    launch: ['cursor-agent'],
    hookRuntime: 'node',
    executables: LINUX_EXECUTABLES,
    required: ['cursor-agent'],
  },
  {
    key: 'linux-x64',
    os: 'linux',
    arch: 'x64',
    archive: 'tar.gz',
    launch: ['cursor-agent'],
    hookRuntime: 'node',
    executables: LINUX_EXECUTABLES,
    required: ['cursor-agent'],
  },
  {
    key: 'win32-x64',
    os: 'windows',
    arch: 'x64',
    archive: 'zip',
    launch: WINDOWS_LAUNCH,
    hookRuntime: 'node.exe',
    executables: [],
    required: WINDOWS_LAUNCH,
  },
  {
    key: 'win32-arm64',
    os: 'windows',
    arch: 'arm64',
    archive: 'zip',
    launch: WINDOWS_LAUNCH,
    hookRuntime: 'node.exe',
    executables: [],
    required: WINDOWS_LAUNCH,
  },
];

/** Undefined for any platform whose artifact has not been inspected. */
export function getCursorRuntimeTarget(
  platform: string,
  arch: string,
): CursorRuntimeTarget | undefined {
  return CURSOR_RUNTIME_TARGETS.find(
    (target) => target.key === `${platform}-${arch}`,
  );
}

export function buildCursorArtifactUrl(
  target: CursorRuntimeTarget,
  version: string,
): string {
  return `https://downloads.cursor.com/lab/${version}/${target.os}/${target.arch}/agent-cli-package.${target.archive}`;
}

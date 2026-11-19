// Imported by the build and release scripts under plain Node: no imports.

/**
 * The bundled host entries the daemon serves, staged by `build:core-daemon`
 * beside the executable in `execution-hosts/`. The daemon runs them only
 * through its execution host shell, so every host it launches has a budget.
 * The standalone CLI release and the Linux CLI installer require every one
 * on macOS and Linux (CAN-5631, CAN-5672).
 */
/** The terminal host (CAN-5088); it loads the staged node-pty beside it. */
export const DAEMON_TERMINAL_HOST_ENTRY = 'terminal-host.js';

/** The pipeline host (CAN-5086), bundled from desktop-shared's executor. */
export const DAEMON_PIPELINE_HOST_ENTRY = 'pipeline-host.js';

export const DAEMON_EXECUTION_HOST_ENTRIES = Object.freeze([
  'code-graph-build-host.js',
  'code-graph-read-host.js',
  'code-graph-fingerprint-host.js',
  DAEMON_TERMINAL_HOST_ENTRY,
  DAEMON_PIPELINE_HOST_ENTRY,
]);

/**
 * The packages the code-graph runtime resolves from `node_modules/` beside a
 * standalone executable. The `typescript` package is a wrapper that requires
 * `@typescript/old`, so that package ships too.
 */
export const CODE_GRAPH_RUNTIME_MODULES = Object.freeze([
  'web-tree-sitter',
  'typescript',
  '@typescript/old',
]);

/** The code-graph runtime roots beside the CLI and daemon in a release. */
export const CODE_GRAPH_RUNTIME_ROOTS = Object.freeze([
  'resources/code-graph',
  ...CODE_GRAPH_RUNTIME_MODULES.map((name) => `node_modules/${name}`),
]);

/**
 * The bundled pipeline definitions `build:core-daemon` stages beside the
 * daemon (CAN-5092), as path segments under the executable's directory.
 */
export const DAEMON_BUNDLED_PIPELINES_DIRECTORY = Object.freeze([
  'resources',
  'pipelines',
]);

/** Inert vault payload beside every daemon; delivery does not enable a key slot. */
export const DAEMON_SECRET_PROTECTION_FILE = 'core-secret-protection.node';
export const DAEMON_SECRET_PROTECTION_RECEIPT =
  'core-secret-protection.node.payload.json';
export const DAEMON_SECRET_PROTECTION_MEMBERS = Object.freeze([
  DAEMON_SECRET_PROTECTION_FILE,
  DAEMON_SECRET_PROTECTION_RECEIPT,
]);

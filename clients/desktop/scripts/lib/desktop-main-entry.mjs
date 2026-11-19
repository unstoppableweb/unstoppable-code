// Shapes of the desktop main-process entry files written by the main build.
import { resolve } from 'node:path';
import { build } from 'esbuild';

const LINUX_SAFE_STORAGE_HELPER_FILE = 'linux-safe-storage-helper.cjs';

/**
 * Records the environment main started with before the bundle loads. Main's
 * dependencies load as hoisted `require()` calls ahead of any bundled module,
 * and one changes `process.env` when it loads (the Claude Agent SDK sets
 * NoDefaultCurrentDirectoryInExePath). `getEnhancedEnv()` in
 * packages/execution-engine/src/pipelines/config-paths.ts reads this slot to
 * give children the startup value instead.
 */
const RECORD_STARTUP_ENVIRONMENT = [
  'Object.defineProperty(globalThis, Symbol.for("canopy.startupEnvironment"), {',
  '  value: Object.freeze({ ...process.env }),',
  '});',
].join('\n');

/**
 * Counts writes to `process.env` so `getEnhancedEnv()` (config-paths.ts)
 * copies it once per change instead of once per spawn: each copy of the
 * native object costs about 0.1 ms. Installed before the bundle loads so no
 * dependency keeps a reference that bypasses the count.
 */
const TRACK_ENVIRONMENT_WRITES = [
  '{',
  '  const tracker = { environment: process.env, writes: 0 };',
  '  const counted = (result) => { tracker.writes += 1; return result; };',
  '  tracker.environment = new Proxy(process.env, {',
  '    set: (target, key, value) => counted(Reflect.set(target, key, value)),',
  '    deleteProperty: (target, key) => counted(Reflect.deleteProperty(target, key)),',
  '    defineProperty: (target, key, descriptor) =>',
  '      counted(Reflect.defineProperty(target, key, descriptor)),',
  '  });',
  '  process.env = tracker.environment;',
  '  Object.defineProperty(globalThis, Symbol.for("canopy.environmentWrites"), {',
  '    value: tracker,',
  '  });',
  '}',
].join('\n');

/** Refuse stale Node-mode calls and select helpers before any app bootstrap. */
export function isolatedMainEntrySource(normalSource) {
  return [
    '"use strict";',
    RECORD_STARTUP_ENVIRONMENT,
    TRACK_ENVIRONMENT_WRITES,
    // Exit 2 blocks Claude approvals, but also prevents Stop/SubagentStop from
    // finishing. Only known non-approval hook shapes may return nonblocking 1.
    'if (process.env.ELECTRON_RUN_AS_NODE && (process.argv ?? []).length > 1) {',
    '  const args = process.argv;',
    '  const scriptName = args[1].replaceAll("\\\\", "/").split("/").pop();',
    '  const optionalHook = (args.length === 2 && scriptName === "rtk-hook-wrapper.js") ||',
    '    (args.length === 3 && scriptName.endsWith("-hook-callback.js") &&',
    '      ["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop", "StopFailure",',
    '       "SubagentStart", "SubagentStop", "Notification", "SessionEnd", "PostCompact"].includes(args[2]));',
    '  try {',
    '    require("node:fs").writeSync(2, "Legacy Node-mode invocation refused; restart the terminal or worker.\\n");',
    '  } finally {',
    '    process.exit(optionalHook ? 1 : 2);',
    '  }',
    '} else if ((process.argv ?? []).some((arg) => arg.startsWith("--canopy-linux-diagnostic"))) {',
    '  require("./linux-diagnostics.cjs");',
    '} else if (process.env.CANOPY_LINUX_SAFE_STORAGE_HELPER_MODE === "1") {',
    `  require("./${LINUX_SAFE_STORAGE_HELPER_FILE}");`,
    '} else {',
    normalSource,
    '}',
    '',
  ].join('\n');
}

/** A separate build keeps the helper out of main's inline/bytecode graph. */
export function linuxSafeStorageHelperPlugin({
  entryFile,
  alias,
  define,
  onInputs,
  outputFile = LINUX_SAFE_STORAGE_HELPER_FILE,
}) {
  let outputDir = '';
  return {
    name: `canopy:isolated-${outputFile}`,
    apply: 'build',
    configResolved(config) {
      outputDir = config.build.outDir;
    },
    buildStart() {
      this.addWatchFile(entryFile);
    },
    async writeBundle() {
      const result = await build({
        entryPoints: [entryFile],
        outfile: resolve(outputDir, outputFile),
        bundle: true,
        platform: 'node',
        target: 'node24',
        format: 'cjs',
        external: ['electron', 'node:*'],
        alias,
        define,
        minify: true,
        logLevel: 'warning',
        metafile: true,
      });
      const inputs = Object.keys(result.metafile.inputs).map((input) =>
        resolve(input),
      );
      for (const input of inputs) this.addWatchFile(input);
      onInputs?.(inputs);
    },
  };
}

/**
 * Source of a small main entry that loads the bundle with `require()`.
 *
 * Electron imports its main entry through Node's ESM loader, which keeps the
 * entry's whole source on its CommonJS module object for the life of the
 * process. When the entry is the bundle itself, main holds the bundle's
 * source twice. Bytecode builds already use a small entry; this gives
 * non-bytecode (dev) builds the same shape.
 */
export function mainEntrySource(bundleFile) {
  return isolatedMainEntrySource(`require("./${bundleFile}");`);
}

const TWO_BYTE_PLACEHOLDER = '"\\u200b".repeat(length - 2)';
const ONE_BYTE_PLACEHOLDER = '" ".repeat(length - 2)';

/**
 * Rewrites electron-vite's `bytecode-loader.cjs` to build its placeholder
 * source from spaces instead of U+200B.
 *
 * The loader compiles bytecode against a placeholder string of the original
 * source's length, and V8 keeps that string for the life of the script. V8
 * checks only the length, so a Latin-1 placeholder is accepted, and V8 stores
 * it at one byte per character instead of two.
 */
export function withOneBytePlaceholder(loaderSource) {
  if (loaderSource.includes(ONE_BYTE_PLACEHOLDER)) {
    return loaderSource;
  }
  if (!loaderSource.includes(TWO_BYTE_PLACEHOLDER)) {
    throw new Error(
      'bytecode-loader.cjs no longer builds its placeholder with ' +
        `${TWO_BYTE_PLACEHOLDER}; update scripts/lib/desktop-main-entry.mjs.`,
    );
  }
  return loaderSource.replace(TWO_BYTE_PLACEHOLDER, ONE_BYTE_PLACEHOLDER);
}

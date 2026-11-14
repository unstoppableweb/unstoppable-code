import { buildIdentityDefines } from '../../packages/protocol/src/brand';
import {
  E2E_BUILD_UNITS,
  findE2eBuildInputViolations,
  formatE2eBuildInputViolations,
} from '../../scripts/lib/e2e-build-inputs.mjs';
import type { E2eBuildUnit } from '../../scripts/lib/e2e-build-inputs.mjs';
import { preparePdfWorker } from '../../scripts/public-build/pdf-worker.mjs';
import {
  workspaceBundleGuardPlugin,
  workspaceCommonjsOptions,
} from '../../scripts/lib/desktop-workspace-bundles.mjs';
import {
  mainEntrySource,
  isolatedMainEntrySource,
  linuxSafeStorageHelperPlugin,
  withOneBytePlaceholder,
} from '../../scripts/lib/desktop-main-entry.mjs';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import type { Plugin, UserConfig } from 'vite';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import type { UserConfig as ElectronViteUserConfig } from 'electron-vite';
import { build as esbuildBuild } from 'esbuild';
import {
  rendererManualChunk,
  rendererStartupBoundaryPlugin,
} from './src/main/build/renderer-chunks';
import { rendererOutputPlugins } from './src/main/build/renderer-minification';
import {
  compileRendererReactWorkHook,
  rendererReactWorkHookPlugin,
} from './src/main/build/renderer-react-work-hook';

function pdfWorkerAssetsPlugin(): Plugin {
  return {
    name: 'pdf-worker-assets',
    configResolved(config): void {
      preparePdfWorker({
        destinationDir: resolve(config.publicDir, 'pdf-worker'),
      });
    },
  };
}

interface PkgShape {
  version?: string;
  dependencies?: Record<string, string>;
  'claude-code'?: { version?: string };
  codex?: { version?: string };
  'gh-cli'?: { version?: string };
  rtk?: { version?: string };
  'copilot-cli'?: {
    version: string;
    artifacts: Record<
      string,
      {
        url: string;
        integrity: string;
        archiveBytes: number;
        executableSha256: string;
      }
    >;
  };
  'opencode-cli'?: {
    version: string;
    artifacts: Record<
      string,
      {
        url: string;
        integrity: string;
        archiveBytes: number;
        executableSha256: string;
      }
    >;
  };
  cliproxyapi?: {
    version: string;
    artifacts: Record<
      string,
      {
        url: string;
        archive: 'tgz' | 'zip';
        integrity: string;
        archiveBytes: number;
        executableSha256: string;
      }
    >;
  };
  'cursor-cli'?: {
    version: string;
    artifacts: Record<
      string,
      { url: string; sha256: string; archiveBytes: number; filesSha256: string }
    >;
  };
}

const configDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(configDir, '..', '..');
const webEnvPath = resolve(repoRoot, 'apps/web/.env');
const desktopDevEnvPath = resolve(repoRoot, '.cache/desktop-dev-env.json');
// The renderer watcher also sees files outside its root through workspace
// imports. Test-only changes must not reload the renderer or rebuild main/preload.
const devWatchIgnorePatterns = [
  '**/apps/web/**',
  '**/__tests__/**',
  '**/__mocks__/**',
  '**/test-utils/**',
  '**/tests/**',
  '**/*.{test,spec}.{js,jsx,ts,tsx,mjs,cjs,mts,cts}',
];
const rendererServerOptions: UserConfig['server'] = {
  watch: {
    ignored: devWatchIgnorePatterns,
  },
};

const pkg: PkgShape = JSON.parse(
  readFileSync(resolve(repoRoot, 'package.json'), 'utf-8'),
) as PkgShape;

const selectedBrandId = process.env.CANOPY_BRAND ?? 'canopy';
const skipBrandPrepare = ['1', 'true', 'yes', 'on'].includes(
  (process.env.CANOPY_SKIP_BRAND_PREPARE ?? '').trim().toLowerCase(),
);
if (!skipBrandPrepare) {
  execFileSync(
    process.execPath,
    [
      resolve(repoRoot, 'scripts/brand/prepare-brand.mjs'),
      '--brand',
      selectedBrandId,
      '--all',
    ],
    { cwd: repoRoot, stdio: 'inherit' },
  );
}

interface MaterializedBrand {
  id: string;
  displayName: string;
  cliName: string;
}

function readMaterializedBrand(brandId: string): MaterializedBrand {
  const brandJsonFile = resolve(
    repoRoot,
    '.cache/brand',
    brandId,
    'current-brand.json',
  );
  const brandJson = JSON.parse(
    readFileSync(brandJsonFile, 'utf-8'),
  ) as Partial<MaterializedBrand>;

  if (!brandJson.id || !brandJson.displayName || !brandJson.cliName) {
    throw new Error(`Brand cache missing required fields: ${brandJsonFile}`);
  }

  return {
    id: brandJson.id,
    displayName: brandJson.displayName,
    cliName: brandJson.cliName,
  };
}

const brandRuntime = readMaterializedBrand(selectedBrandId);

const brandDefines = {
  __CANOPY_BRAND_ID__: JSON.stringify(brandRuntime.id),
  __CANOPY_BRAND_DISPLAY_NAME__: JSON.stringify(brandRuntime.displayName),
  __CANOPY_BRAND_CLI_NAME__: JSON.stringify(brandRuntime.cliName),
};

const aliases = {
  '@canopy/protocol': resolve(repoRoot, 'packages/protocol/src'),
  '@canopy/agent-actions': resolve(repoRoot, 'packages/agent-actions/src'),
  '@canopy/mcp-oauth-core': resolve(repoRoot, 'packages/mcp-oauth-core/src'),
  '@canopy/memory-consolidation': resolve(
    repoRoot,
    'packages/memory-consolidation/src',
  ),
  '@canopy/plugin-interop': resolve(repoRoot, 'packages/plugin-interop/src'),
  '@canopy/pipeline-interop': resolve(
    repoRoot,
    'packages/pipeline-interop/src',
  ),
  '@canopy/app-core': resolve(repoRoot, 'packages/app-core/src'),
  '@canopy/ipc-canopy-client': resolve(
    repoRoot,
    'packages/ipc-canopy-client/src',
  ),
  '@canopy/app-state': resolve(repoRoot, 'packages/app-state/src'),
  '@canopy/core-runtime': resolve(repoRoot, 'packages/core-runtime/src'),
  '@canopy/core-platform': resolve(repoRoot, 'packages/core-platform/src'),
  '@canopy/core-transport': resolve(repoRoot, 'packages/core-transport/src'),
  '@canopy/core-client': resolve(repoRoot, 'packages/core-client/src'),
  '@canopy/copilot-recipient': resolve(
    repoRoot,
    'packages/copilot-recipient/src',
  ),
  '@canopy/code-graph': resolve(repoRoot, 'packages/code-graph/src'),
  '@canopy/execution-engine': resolve(
    repoRoot,
    'packages/execution-engine/src',
  ),
  '@canopy/desktop-shared': resolve(repoRoot, 'packages/desktop-shared/src'),
  '@canopy/desktop-instrumentation': resolve(
    repoRoot,
    'packages/desktop-instrumentation/src',
  ),
  '@canopy/ui-shared': resolve(repoRoot, 'packages/ui-shared/src'),
  '@canopy/ui-rich': resolve(repoRoot, 'packages/ui-rich/src'),
  '@canopy/ui-app': resolve(repoRoot, 'packages/ui-app/src'),
  '@canopy/brand/current': resolve(
    repoRoot,
    '.cache/brand',
    brandRuntime.id,
    'desktop-brand.ts',
  ),
};

function readEnvString(name: string, fallback = ''): string {
  const value = process.env[name];
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : fallback;
}

function readEnvBoolean(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === undefined) {
    return fallback;
  }
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function readEnvNumber(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined || value.trim().length === 0) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? Math.min(100, Math.max(0, parsed))
    : fallback;
}

function readEnvCsv(name: string): string[] {
  const value = process.env[name];
  if (value === undefined || value.trim().length === 0) {
    return [];
  }
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function parseDotEnvValue(rawValue: string): string {
  const value = rawValue.trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function readWebDevEnvValues(): Map<string, string> {
  try {
    const text = readFileSync(webEnvPath, 'utf8');
    const values = new Map<string, string>();
    for (const line of text.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!match) {
        continue;
      }
      values.set(match[1], parseDotEnvValue(match[2]));
    }
    return values;
  } catch {
    return new Map();
  }
}

function readLocalWebDevBaseUrl(): string {
  const values = readWebDevEnvValues();
  const betterAuthUrl = values.get('BETTER_AUTH_URL')?.trim();
  if (betterAuthUrl) {
    return betterAuthUrl;
  }

  const port = values.get('PORT')?.trim();
  return port ? `http://localhost:${port}` : '';
}

function readLocalMcpProxyDevPort(): number | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(desktopDevEnvPath, 'utf8'));
  } catch {
    return undefined;
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }

  const rawPort = (parsed as { mcpProxyPort?: unknown }).mcpProxyPort;
  const port =
    typeof rawPort === 'number'
      ? rawPort
      : typeof rawPort === 'string'
        ? Number.parseInt(rawPort.trim(), 10)
        : undefined;
  return typeof port === 'number' &&
    Number.isInteger(port) &&
    port >= 1 &&
    port <= 65535
    ? port
    : undefined;
}

function defineOptionalNumber(value: number | undefined): string {
  return typeof value === 'number' ? JSON.stringify(value) : 'undefined';
}

function formatCanopyCloudBaseUrlLog(value: string, source: string): string {
  return `[desktop dev] CANOPY_CLOUD_BASE_URL=${value || '(not configured)'} (${source})`;
}

function readCanopyCloudBaseUrlForBuild(mode: string): string {
  const cloudBaseUrl = readEnvString('CANOPY_CLOUD_BASE_URL');
  if (cloudBaseUrl) {
    if (mode !== 'production') {
      process.stdout.write(
        `${formatCanopyCloudBaseUrlLog(cloudBaseUrl, 'CANOPY_CLOUD_BASE_URL')}\n`,
      );
    }
    return cloudBaseUrl;
  }

  if (mode === 'production' && !cloudBaseUrl) {
    throw new Error('CANOPY_CLOUD_BASE_URL must be set for production builds.');
  }

  const localWebDevBaseUrl = readLocalWebDevBaseUrl();
  process.stdout.write(
    `${formatCanopyCloudBaseUrlLog(
      localWebDevBaseUrl,
      `${webEnvPath} BETTER_AUTH_URL/PORT fallback`,
    )}\n`,
  );
  return localWebDevBaseUrl;
}

function createDependencyVersionDefines(mode: string): Record<string, string> {
  return {
    __DEP_CLAUDE_CLI__: JSON.stringify(
      pkg['claude-code']?.version ?? 'unknown',
    ),
    __DEP_CLAUDE_SDK__: JSON.stringify(
      pkg.dependencies?.['@anthropic-ai/claude-agent-sdk'] ?? 'unknown',
    ),
    __DEP_CODEX_CLI__: JSON.stringify(pkg.codex?.version ?? 'unknown'),
    __CANOPY_CURSOR_CLI__: JSON.stringify(
      pkg['cursor-cli'] ?? { version: 'unknown', artifacts: {} },
    ),
    __CANOPY_COPILOT_CLI__: JSON.stringify(
      pkg['copilot-cli'] ?? { version: 'unknown', artifacts: {} },
    ),
    __CANOPY_OPENCODE_CLI__: JSON.stringify(
      pkg['opencode-cli'] ?? { version: 'unknown', artifacts: {} },
    ),
    __CANOPY_CLIPROXYAPI__: JSON.stringify(
      pkg.cliproxyapi ?? { version: 'unknown', artifacts: {} },
    ),
    __DEP_GH_CLI__: JSON.stringify(pkg['gh-cli']?.version ?? 'unknown'),
    __DEP_RTK_CLI__: JSON.stringify(pkg.rtk?.version ?? 'unknown'),
    __DEP_OCTOKIT__: JSON.stringify(
      pkg.dependencies?.['@octokit/rest'] ?? 'unknown',
    ),
    __CANOPY_CLOUD_BASE_URL__: JSON.stringify(
      readCanopyCloudBaseUrlForBuild(mode),
    ),
    __CANOPY_RELEASE_FLAVOR__: JSON.stringify(
      readEnvString('CANOPY_RELEASE_FLAVOR', 'stable'),
    ),
    // Per-build UD OAuth environment. Production releases inject `production`;
    // local dev and internal/staging builds default to `staging` so they use
    // the staging UD endpoints. Overridable at runtime via
    // `CANOPY_UD_OAUTH_ENV` in dev.
    __CANOPY_UD_OAUTH_ENV__: JSON.stringify(
      readEnvString(
        'CANOPY_UD_OAUTH_ENV',
        mode === 'production' ? 'production' : 'staging',
      ),
    ),
    __CANOPY_INTERNAL_RELEASE_INDICATOR__: JSON.stringify(
      readEnvString('CANOPY_INTERNAL_RELEASE_INDICATOR'),
    ),
    __CANOPY_UPDATE_BASE_URL__: JSON.stringify(
      readEnvString('CANOPY_UPDATE_BASE_URL'),
    ),
    __CANOPY_SOURCE_BUILD__: JSON.stringify(
      readEnvString('CANOPY_SOURCE_BUILD') === 'true',
    ),
  };
}

function createDesktopInstrumentationDefines(): Record<string, string> {
  return {
    // Release workflows always set CANOPY_VERSION, and electron-builder
    // packages the same value.
    __CANOPY_APP_VERSION__: JSON.stringify(
      readEnvString('CANOPY_VERSION', pkg.version ?? ''),
    ),
    __CANOPY_POSTHOG_ENABLED__: JSON.stringify(
      readEnvBoolean('CANOPY_POSTHOG_ENABLED', false),
    ),
    __CANOPY_POSTHOG_PROJECT_KEY__: JSON.stringify(
      readEnvString('CANOPY_POSTHOG_PROJECT_KEY'),
    ),
    __CANOPY_POSTHOG_HOST__: JSON.stringify(
      readEnvString('CANOPY_POSTHOG_HOST', 'https://us.i.posthog.com'),
    ),
    __CANOPY_POSTHOG_SESSION_REPLAY_SAMPLE_RATE__: JSON.stringify(
      readEnvNumber('CANOPY_POSTHOG_SESSION_REPLAY_SAMPLE_RATE', 0),
    ),
  };
}

const desktopFeatureFlagDefines = {
  __CANOPY_LAUNCHDARKLY_DESKTOP_CLIENT_SIDE_ID__: JSON.stringify(
    readEnvString('LAUNCHDARKLY_DESKTOP_CLIENT_SIDE_ID'),
  ),
};

/**
 * Client secret for Canopy's pre-registered Google "Desktop app" OAuth client
 * (ECW-8473). Google requires it at token exchange even for installed apps,
 * while documenting that in this context the secret "is obviously not treated
 * as a secret". Injected into the Electron main bundle only — the curated MCP
 * catalog must never carry credentials, and neither preload nor the renderer
 * needs this value.
 */
const googleOAuthMainDefines = {
  __CANOPY_GOOGLE_OAUTH_CLIENT_SECRET__: JSON.stringify(
    readEnvString('CANOPY_GOOGLE_OAUTH_CLIENT_SECRET'),
  ),
};

// Keep the build policy independent of the compiler host. Each bundle checks
// the platform exposed by the running app, including Linux.
const ollamaEnabled = readEnvBoolean('CANOPY_OLLAMA_ENABLED', true);

// Build-time gate for UI-automation/E2E-only code paths. Compiled to `false`
// in every normal/production build so the gated mock/redirect/stabilizer
// branches are dead-code-eliminated and cannot be triggered by a runtime
// environment variable. Only an explicit `CANOPY_E2E_BUILD=1` build sets it —
// the strict `=== '1'` check must stay in lockstep with
// scripts/build-builtin-actions.mjs and scripts/build-cli.mjs so a single
// CANOPY_E2E_BUILD value can never produce a split-brain artifact where the
// Electron bundles are mocked but the action/CLI bundles are not.
const isE2eBuild = process.env.CANOPY_E2E_BUILD === '1';
// Performance diagnostics need maps for raw CPU profiles to resolve back to
// application sources. Separate maps do not alter the executed bundle and are
// enabled only for the dedicated E2E performance build.
const performanceSourceMapsEnabled =
  isE2eBuild && process.env.CANOPY_PERFORMANCE_SOURCEMAPS === '1';
const e2eDefineUrl = (name: string): string => {
  const value = isE2eBuild ? readEnvString(name) : '';
  return value ? JSON.stringify(value) : 'undefined';
};
const desktopE2eDefines = {
  __CANOPY_E2E__: JSON.stringify(isE2eBuild),
  __CANOPY_MOCK_LLM_BASE_URL__: e2eDefineUrl('CANOPY_MOCK_LLM_BASE_URL'),
  __CANOPY_LINEAR_API_BASE_URL__: e2eDefineUrl('CANOPY_LINEAR_API_BASE_URL'),
  __CANOPY_POSTHOG_STUB_URL__: e2eDefineUrl('CANOPY_POSTHOG_STUB_URL'),
};

// Release builds set CANOPY_RENDERER_SOURCEMAPS to emit hidden renderer maps
// for the PostHog sourcemap upload; scripts/clean-renderer-sourcemaps.mjs
// removes them before packaging.
const rendererSourceMapsEnabled = readEnvBoolean(
  'CANOPY_RENDERER_SOURCEMAPS',
  false,
);

interface BytecodeFallbackEntry {
  entryFile: string;
  bytecodeFile: string;
  fallbackFile: string;
}

function bytecodeJsFallbackPlugin(entries: BytecodeFallbackEntry[]): Plugin {
  let outputDir = '';

  return {
    name: 'canopy:bytecode-js-fallback',
    apply: 'build',
    enforce: 'post',
    configResolved(config): void {
      outputDir = config.build.outDir;
    },
    writeBundle(): void {
      const loaderPath = resolve(outputDir, 'bytecode-loader.cjs');
      if (existsSync(loaderPath)) {
        writeFileSync(
          loaderPath,
          withOneBytePlaceholder(readFileSync(loaderPath, 'utf8')),
        );
      }
      for (const entry of entries) {
        const entryPath = resolve(outputDir, entry.entryFile);
        const bytecodePath = resolve(outputDir, entry.bytecodeFile);
        const fallbackPath = resolve(outputDir, entry.fallbackFile);
        if (!existsSync(entryPath)) {
          continue;
        }
        if (!existsSync(bytecodePath)) {
          // Dev builds have no bytecode, so the entry is the whole bundle.
          renameSync(entryPath, fallbackPath);
          writeFileSync(entryPath, mainEntrySource(entry.fallbackFile));
          continue;
        }
        if (!existsSync(fallbackPath)) {
          throw new Error(
            `Bytecode fallback file was not emitted: ${fallbackPath}`,
          );
        }

        const code = readFileSync(entryPath, 'utf8');
        const bytecodeRequire = `require("./${entry.bytecodeFile}");`;
        if (!code.includes(bytecodeRequire)) {
          throw new Error(
            `Bytecode entry ${entryPath} does not require ${entry.bytecodeFile}`,
          );
        }
        if (code.includes(entry.fallbackFile)) {
          continue;
        }

        writeFileSync(
          entryPath,
          isolatedMainEntrySource(
            code.replace(
              bytecodeRequire,
              [
                ...(performanceSourceMapsEnabled
                  ? [
                      'if (process.env.CANOPY_PERFORMANCE_PROFILE_PLAIN_JS === "1") {',
                      `  require("./${entry.fallbackFile}");`,
                      '} else {',
                    ]
                  : []),
                'function shouldUseBytecodeFallback(error) {',
                '  const code = error && typeof error === "object" ? error.code : undefined;',
                '  if (code === "MODULE_NOT_FOUND") {',
                `    return error instanceof Error && error.message.includes("./${entry.bytecodeFile}");`,
                '  }',
                '  const message = error instanceof Error ? error.message : String(error);',
                '  return message.includes("Invalid or incompatible cached data") ||',
                '    message.includes("cachedDataRejected") ||',
                '    message.includes("BytecodeBuffer must be a buffer object");',
                '}',
                'try {',
                `  require("./${entry.bytecodeFile}");`,
                '} catch (error) {',
                '  if (!shouldUseBytecodeFallback(error)) {',
                '    throw error;',
                '  }',
                '  if (process.env.CANOPY_BYTECODE_FALLBACK_DEBUG === "1") {',
                '    const message = error instanceof Error ? error.message : String(error);',
                '    process.stderr.write(',
                `      \`Bytecode load failed for ${entry.bytecodeFile}; falling back to ${entry.fallbackFile}: \${message}\\n\`,`,
                '    );',
                '  }',
                `  require("./${entry.fallbackFile}");`,
                '}',
                ...(performanceSourceMapsEnabled ? ['}'] : []),
              ].join('\n'),
            ),
          ),
        );
      }
    },
  };
}

// Standalone utility-process entries. They must remain plain CJS siblings of
// the main bundle so Electron can fork them in dev and packaged builds.
const codeGraphWorkerEntry = resolve(
  repoRoot,
  'apps/desktop-app/src/main/code-graph/build-worker.ts',
);
const codeGraphReadWorkerEntry = resolve(
  repoRoot,
  'apps/desktop-app/src/main/code-graph/read-worker.ts',
);
const codeGraphFingerprintWorkerEntry = resolve(
  repoRoot,
  'apps/desktop-app/src/main/code-graph/fingerprint-worker.ts',
);
const pipelineProcessHostWorkerEntry = resolve(
  repoRoot,
  'apps/desktop-app/src/main/pipelines/process-host-worker.ts',
);
const claudeProcessHostWorkerEntry = resolve(
  repoRoot,
  'apps/desktop-app/src/main/agents/claude-process-host-worker.ts',
);
const providerProcessHostWorkerEntry = resolve(
  repoRoot,
  'apps/desktop-app/src/main/agent-runs/provider-process-host/entry.ts',
);
const codexPluginMaterializationWorkerEntry = resolve(
  repoRoot,
  'apps/desktop-app/src/main/plugins/codex-plugin-materialization-worker.ts',
);
const chatSearchQueryWorkerEntry = resolve(
  repoRoot,
  'apps/desktop-app/src/main/chat-search/query-worker.ts',
);

const chatSearchIndexWorkerEntry = resolve(
  repoRoot,
  'apps/desktop-app/src/main/chat-search/index-worker.ts',
);

const externalProjectsStoreReadWorkerEntry = resolve(
  repoRoot,
  'apps/desktop-app/src/main/external-projects/store-read-worker.ts',
);

const ledgerStorageWorkerEntry = resolve(
  repoRoot,
  'apps/desktop-app/src/main/ledger/storage-worker.ts',
);

const w5CommitLogWorkerEntry = resolve(
  repoRoot,
  'apps/core-daemon/src/w5-commit-log-worker.ts',
);

const localMemoryParseWorkerEntry = resolve(
  repoRoot,
  'apps/desktop-app/src/main/memory/local/parse-worker.ts',
);

const memorySyncMergeWorkerEntry = resolve(
  repoRoot,
  'apps/desktop-app/src/main/memory/sync/merge-worker.ts',
);

const interruptedWorkScanWorkerEntry = resolve(
  repoRoot,
  'apps/desktop-app/src/main/lib/interrupted-work-scan-worker.ts',
);

const archiveIoWorkerEntry = resolve(
  repoRoot,
  'apps/desktop-app/src/main/archive/archive-io-worker.ts',
);

const cursorRuntimeHashWorkerEntry = resolve(
  repoRoot,
  'apps/desktop-app/src/main/cursor/runtime-hash-worker.ts',
);

const openCodeSchemaValidationWorkerEntry = resolve(
  repoRoot,
  'apps/desktop-app/src/main/opencode/schema-validation-worker.ts',
);

// Emits utility workers as standalone plain-CJS bundles beside the main
// bundle. The code-graph worker keeps synchronous graph construction off main;
// the pipeline process host keeps action spawning and output drains off main.
//
// Why a separate esbuild pass instead of a second `main` rollup input:
//   1. The `main` build sets `output.inlineDynamicImports: true` (load-bearing
//      — it keeps the pipeline-executor circular dependency's dynamic import
//      resolving in-module under bytecode). Rollup forbids
//      `inlineDynamicImports` with more than one input, so the worker cannot be
//      added to `main.rollupOptions.input` without dismantling that setting and
//      re-verifying the whole packaged main bundle. Building the worker
//      separately keeps main's proven output byte-for-byte unchanged.
//   2. `utilityProcess.fork` must load a normal JS module. Adding the worker to
//      the main build would route it through this repo's bytecode plugin
//      (`chunkAlias: []` ⇒ transformAllChunks), and electron-vite bytecode
//      chunks "can load without their CommonJS exports intact" (see the main
//      build's `inlineDynamicImports` comment) — an unnecessary risk for a
//      forked entry. This pass emits plain CJS with no bytecode, so the fork
//      loads a normal module in dev and packaged builds alike.
//
// `web-tree-sitter` and `typescript` stay external (never bundled): bundling
// web-tree-sitter breaks its Emscripten env detection (a hard CLAUDE.md
// packaging invariant), and both are already externalized by the main bundle,
// so the forked worker — a sibling in `out/main/` — resolves them from the same
// node_modules. Node builtins are external by default under `platform: 'node'`.
//
// `electron` and the Electron-adjacent packages stay external too, and
// bundling them is *never* correct. The npm `electron` package is a CLI
// launcher stub: its module body runs `getElectronPath()` eagerly at load,
// which checks `existsSync(path.join(__dirname, 'path.txt'))`. Once inlined,
// `__dirname` is the worker's own output dir, so that check can never succeed
// and the stub "downloads Electron" via
// `spawnSync(process.execPath, [path.join(__dirname, 'install.js')])`. Inside a
// utilityProcess `process.execPath` is the Electron Helper binary and
// `install.js` does not exist, so the worker dies at load — before it can
// register a message handler — and in dev Electron boots its default app and
// shows an "Unable to find Electron app" modal. In a real utilityProcess
// `require('electron')` resolves to the process-scoped built-in rather than
// node_modules, so externalizing is also the semantically correct choice for
// any worker that legitimately needs it. `scripts/check-electron-boundary.mjs`
// separately enforces that no worker's module graph reaches Electron at all;
// this external list is the belt to that guard's braces.
const browserProfileInventoryWorkerEntry = resolve(
  repoRoot,
  'apps/desktop-app/src/main/browser/inventory-worker.ts',
);

function utilityWorkerPlugin(define: Record<string, string>): Plugin {
  let resolvedOutDir = '';
  return {
    name: 'canopy:utility-workers',
    apply: 'build',
    configResolved(config): void {
      // The real resolved main outDir (honors the E2E private out root and
      // however electron-vite resolves the root), so the worker always lands
      // beside `index.js` without re-deriving the path.
      resolvedOutDir = config.build.outDir;
    },
    buildStart(): void {
      // Retrigger the main dev-watch build when the worker entry changes so a
      // fresh worker is re-emitted; the entry's imports already live in main's
      // graph and retrigger on their own.
      this.addWatchFile(browserProfileInventoryWorkerEntry);
      this.addWatchFile(codeGraphWorkerEntry);
      this.addWatchFile(codeGraphReadWorkerEntry);
      this.addWatchFile(codeGraphFingerprintWorkerEntry);
      this.addWatchFile(pipelineProcessHostWorkerEntry);
      this.addWatchFile(claudeProcessHostWorkerEntry);
      this.addWatchFile(providerProcessHostWorkerEntry);
      this.addWatchFile(codexPluginMaterializationWorkerEntry);
      this.addWatchFile(chatSearchQueryWorkerEntry);
      this.addWatchFile(chatSearchIndexWorkerEntry);
      this.addWatchFile(externalProjectsStoreReadWorkerEntry);
      this.addWatchFile(ledgerStorageWorkerEntry);
      this.addWatchFile(w5CommitLogWorkerEntry);
      this.addWatchFile(interruptedWorkScanWorkerEntry);
      this.addWatchFile(archiveIoWorkerEntry);
      this.addWatchFile(localMemoryParseWorkerEntry);
      // Import-free by design, so nothing in main's graph retriggers it.
      this.addWatchFile(cursorRuntimeHashWorkerEntry);
      this.addWatchFile(
        resolve(
          repoRoot,
          'apps/desktop-app/src/main/memory/local/document-parser.ts',
        ),
      );
    },
    async writeBundle(): Promise<void> {
      const results = await Promise.all(
        [
          {
            entry: browserProfileInventoryWorkerEntry,
            outfile: 'browser-profile-inventory-worker.js',
          },
          {
            entry: codeGraphWorkerEntry,
            outfile: 'code-graph-build-worker.js',
          },
          {
            entry: codeGraphReadWorkerEntry,
            outfile: 'code-graph-read-worker.js',
          },
          {
            entry: codeGraphFingerprintWorkerEntry,
            outfile: 'code-graph-fingerprint-worker.js',
          },
          {
            entry: pipelineProcessHostWorkerEntry,
            outfile: 'pipeline-process-host-worker.js',
          },
          {
            entry: claudeProcessHostWorkerEntry,
            outfile: 'claude-process-host-worker.js',
          },
          {
            entry: providerProcessHostWorkerEntry,
            outfile: 'provider-process-host-worker.js',
          },
          {
            entry: codexPluginMaterializationWorkerEntry,
            outfile: 'codex-plugin-materialization-worker.js',
          },
          {
            entry: chatSearchQueryWorkerEntry,
            outfile: 'chat-search-query-worker.js',
          },
          {
            entry: chatSearchIndexWorkerEntry,
            outfile: 'chat-search-index-worker.js',
          },
          {
            entry: externalProjectsStoreReadWorkerEntry,
            outfile: 'external-projects-store-read-worker.js',
          },
          {
            entry: ledgerStorageWorkerEntry,
            outfile: 'ledger-storage-worker.js',
          },
          {
            entry: w5CommitLogWorkerEntry,
            outfile: 'w5-commit-log-worker.js',
          },
          {
            entry: localMemoryParseWorkerEntry,
            outfile: 'local-memory-parse-worker.js',
          },
          {
            entry: memorySyncMergeWorkerEntry,
            outfile: 'memory-sync-merge-worker.js',
          },
          {
            entry: interruptedWorkScanWorkerEntry,
            outfile: 'interrupted-work-scan-worker.js',
          },
          {
            entry: archiveIoWorkerEntry,
            outfile: 'archive-io-worker.js',
          },
          {
            entry: cursorRuntimeHashWorkerEntry,
            outfile: 'cursor-runtime-hash-worker.js',
          },
          {
            entry: openCodeSchemaValidationWorkerEntry,
            outfile: 'opencode-schema-validation-worker.js',
          },
        ].map(({ entry, outfile }) =>
          esbuildBuild({
            entryPoints: [entry],
            outfile: resolve(resolvedOutDir, outfile),
            bundle: true,
            platform: 'node',
            target: 'node20',
            format: 'cjs',
            minify: true,
            sourcemap: performanceSourceMapsEnabled,
            logLevel: 'warning',
            // Reuse main's workspace + brand aliases so `@canopy/*` and the
            // materialized brand module resolve identically to the main bundle.
            alias: aliases,
            external: [
              'electron',
              'electron-updater',
              '@electron-toolkit/preload',
              '@electron-toolkit/utils',
              'web-tree-sitter',
              'typescript',
              'node:*',
            ],
            // Reuse main's build-time constants so any `__CANOPY_*`/`__DEP_*`
            // reference that ever reaches the worker graph is inlined the same way.
            define,
            // Workers bundle outside main's module graph; E2E builds report
            // their inputs so the main unit's input scope covers them too.
            metafile: isE2eBuild,
          }),
        ),
      );
      if (isE2eBuild) {
        assertE2eBuildInputs(
          'main',
          results.flatMap((result) =>
            Object.keys(result.metafile?.inputs ?? {}).map((input) =>
              resolve(repoRoot, input),
            ),
          ),
        );
      }
    },
  };
}

type RollupWatchExcludePattern = string | RegExp;

function normalizeArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function ignoreNonAppDevWatchPlugin(): Plugin {
  return {
    name: 'canopy:ignore-non-app-dev-watch',
    config(config): UserConfig | undefined {
      const watch = config.build?.watch;
      if (!watch) {
        return undefined;
      }

      return {
        build: {
          watch: {
            ...watch,
            exclude: [
              ...devWatchIgnorePatterns,
              ...normalizeArray<RollupWatchExcludePattern>(watch.exclude),
            ],
          },
        },
      };
    },
  };
}

// E2E builds are cached per output unit, keyed on the files inside each unit's
// declared input scope (scripts/lib/e2e-build-inputs.mjs). Fail the build when
// a unit read a file outside that scope, so a cached output can never outlive
// a change to something it was built from.
function assertE2eBuildInputs(unit: E2eBuildUnit, ids: string[]): void {
  const violations = findE2eBuildInputViolations(unit, repoRoot, ids);
  if (violations.length > 0) {
    throw new Error(formatE2eBuildInputViolations(unit, violations));
  }
}

function e2eBuildInputGuardPlugins(unit: E2eBuildUnit): Plugin[] {
  if (!isE2eBuild) {
    return [];
  }
  return [
    {
      name: 'canopy:e2e-build-input-guard',
      apply: 'build',
      generateBundle(): void {
        // Watch files cover inputs outside the module graph, such as every
        // file Tailwind scanned for class names.
        assertE2eBuildInputs(unit, [
          ...Array.from(this.getModuleIds()),
          ...this.getWatchFiles(),
        ]);
      },
    },
  ];
}

// scripts/build-e2e.mjs rebuilds only the units whose inputs changed by naming
// them here. Only honored for explicit E2E builds; every other build always
// produces all three targets.
function readE2eBuildTargets(): readonly E2eBuildUnit[] {
  const requested = isE2eBuild ? readEnvCsv('CANOPY_E2E_BUILD_TARGETS') : [];
  if (requested.length === 0) {
    return E2E_BUILD_UNITS;
  }
  const unknown = requested.filter(
    (target) => !E2E_BUILD_UNITS.some((unit) => unit === target),
  );
  if (unknown.length > 0) {
    throw new Error(
      `Unknown CANOPY_E2E_BUILD_TARGETS entries: ${unknown.join(', ')}`,
    );
  }
  return E2E_BUILD_UNITS.filter((unit) => requested.includes(unit));
}

export default defineConfig(({ mode }) => {
  const desktopSidebarShadowEnabled =
    mode === 'development' &&
    readEnvBoolean('CANOPY_DESKTOP_SIDEBAR_SHADOW', false);
  const desktopSharedSidebarEnabled = readEnvBoolean(
    'CANOPY_DESKTOP_SHARED_SIDEBAR',
    false,
  );
  const commonDefines = {
    __CANOPY_COMPILED_RUNTIME__: 'true',
    ...createDependencyVersionDefines(mode),
    ...brandDefines,
    ...buildIdentityDefines(
      brandRuntime.id,
      process.env.CANOPY_RELEASE_FLAVOR ?? 'dev',
      isE2eBuild || process.env.CANOPY_TEST_DATA_OVERRIDES === '1',
    ),
    ...createDesktopInstrumentationDefines(),
    ...desktopFeatureFlagDefines,
    ...desktopE2eDefines,
    __CANOPY_OLLAMA_ENABLED__: JSON.stringify(ollamaEnabled),
    __CANOPY_OLLAMA_PLATFORM__: 'process.platform',
    __CANOPY_DESKTOP_SIDEBAR_SHADOW__: JSON.stringify(
      desktopSidebarShadowEnabled,
    ),
    __CANOPY_DESKTOP_SHARED_SIDEBAR__: JSON.stringify(
      desktopSharedSidebarEnabled,
    ),
    __CANOPY_DEV_MCP_PROXY_PORT__: defineOptionalNumber(
      mode === 'development' ? readLocalMcpProxyDevPort() : undefined,
    ),
  };

  // E2E builds can write to a private output root (default `out/`) so the
  // Playwright suite does not contend with a developer's `pnpm run dev`
  // watch build rewriting `out/` mid-run. Only honored for explicit E2E
  // builds; production/dev builds always use `out/`.
  const e2eOutRoot =
    isE2eBuild && process.env.CANOPY_E2E_OUT_DIR
      ? process.env.CANOPY_E2E_OUT_DIR
      : null;
  const outDirFor = (segment: string): Record<string, unknown> =>
    e2eOutRoot ? { outDir: resolve(repoRoot, e2eOutRoot, segment) } : {};
  const mainPreloadPlugins = [
    ignoreNonAppDevWatchPlugin(),
    // Keep main-process dependencies external to the bytecode-compiled bundle.
    // In particular, electron-log contains class-property arrow handlers that
    // the bytecode Babel transform cannot compile. Runtime dependencies must
    // also be declared in the root package.json because Electron Builder
    // packages from the repository root rather than apps/desktop-app.
    externalizeDepsPlugin(),
  ];

  const targets: ElectronViteUserConfig = {
    main: {
      plugins: [
        ...mainPreloadPlugins,
        workspaceBundleGuardPlugin(),
        ...e2eBuildInputGuardPlugins('main'),
        bytecodeJsFallbackPlugin([
          {
            entryFile: 'index.js',
            bytecodeFile: 'index.jsc',
            fallbackFile: '_index.js',
          },
        ]),
        linuxSafeStorageHelperPlugin({
          entryFile: resolve(
            repoRoot,
            'apps/desktop-app/src/main/lib/linux-safe-storage-helper.ts',
          ),
          alias: aliases,
          define: commonDefines,
          onInputs: (files): void => {
            if (isE2eBuild) assertE2eBuildInputs('main', files);
          },
        }),
        utilityWorkerPlugin(commonDefines),
      ],
      // Main-only on purpose: the first-party Google OAuth client secret is
      // used solely by the main-process MCP OAuth token exchange, so it is not
      // spread into the preload or renderer bundles.
      define: {
        ...commonDefines,
        ...googleOAuthMainDefines,
        __CANOPY_WINDOWS_PROCESS_SOURCE_PATH__: JSON.stringify(
          resolve(repoRoot, '.cache/bin/win32-x64/canopy-process-identity.exe'),
        ),
        // The dev W5 commit-log host's owned-child addon (CAN-5202).
        __CANOPY_OWNED_CHILD_SOURCE_DIR__: JSON.stringify(
          resolve(repoRoot, '.cache/native-owned-child'),
        ),
      },
      resolve: { alias: aliases },
      esbuild: { keepNames: true },
      build: {
        commonjsOptions: workspaceCommonjsOptions,
        bytecode: {
          removeBundleJS: false,
        },
        minify: true,
        sourcemap: performanceSourceMapsEnabled,
        ...outDirFor('main'),
        rollupOptions: {
          input: resolve(repoRoot, 'apps/desktop-app/src/main/index.ts'),
          output: {
            // electron-vite bytecode chunks can load without their CommonJS exports
            // intact. Keep main bytecode as a single module so dynamic helpers
            // still resolve to in-module exports at runtime.
            inlineDynamicImports: true,
          },
        },
      },
    },
    preload: {
      // Electron executes the desktop preload in the renderer process. The
      // electron-vite bytecode entry requires Node's `vm` module there, which
      // Electron explicitly marks unsupported and crash-prone. Keep preload
      // output as ordinary minified CJS; main-process bytecode remains enabled.
      plugins: [
        ...mainPreloadPlugins,
        workspaceBundleGuardPlugin(),
        ...e2eBuildInputGuardPlugins('preload'),
      ],
      define: commonDefines,
      resolve: { alias: aliases },
      build: {
        minify: true,
        sourcemap: performanceSourceMapsEnabled,
        ...outDirFor('preload'),
        rollupOptions: {
          input: {
            index: resolve(repoRoot, 'apps/desktop-app/src/preload/index.ts'),
            'browser-view': resolve(
              repoRoot,
              'apps/desktop-app/src/preload/browser-view.ts',
            ),
            'remote-bridge': resolve(
              repoRoot,
              'apps/desktop-app/src/preload/remote-bridge.ts',
            ),
          },
        },
      },
    },
    renderer: {
      worker: {
        format: 'es',
        plugins: () => [
          ...rendererOutputPlugins(),
          ...e2eBuildInputGuardPlugins('renderer'),
        ],
      },
      plugins: [
        ...e2eBuildInputGuardPlugins('renderer'),
        pdfWorkerAssetsPlugin(),
        // A final per-chunk minification pass that runs after Vite's own
        // output transforms (see renderer-minification.ts).
        ...rendererOutputPlugins(),
        // Each window's startup loads only its own app and no on-demand
        // vendor chunk; the build fails otherwise.
        rendererStartupBoundaryPlugin([
          {
            entryModule: '/src/renderer/src/main-window-entry.tsx',
            forbiddenModules: ['/src/renderer/src/AppAdvisorWindowApp.tsx'],
          },
          {
            entryModule: '/src/renderer/src/app-advisor-entry.tsx',
            forbiddenModules: ['/src/renderer/src/App.tsx'],
          },
        ]),
        // E2E builds inject the React work-counter hook ahead of `react-dom`;
        // every other build fails if its renderer output installs a hook.
        rendererReactWorkHookPlugin({
          e2e: isE2eBuild,
          compileHook: () =>
            compileRendererReactWorkHook(
              resolve(
                repoRoot,
                'apps/desktop-app/src/renderer/src/lib/react-work-hook.ts',
              ),
            ),
        }),
      ],
      root: resolve(repoRoot, 'apps/desktop-app/src/renderer'),
      define: {
        ...commonDefines,
        __CANOPY_OLLAMA_PLATFORM__: 'window.platform',
      },
      server: rendererServerOptions,
      // React's development transform injects this entry after the initial
      // static-import crawl. Without an explicit include, a cold dev launch
      // renders once, discovers the dependency several seconds later, rebuilds
      // the optimizer cache, and reloads the entire Electron renderer.
      optimizeDeps: {
        include: ['react/jsx-dev-runtime'],
      },
      resolve: {
        alias: {
          '@': resolve(repoRoot, 'apps/desktop-app/src/renderer/src'),
          ...aliases,
        },
      },
      build: {
        ...outDirFor('renderer'),
        sourcemap: rendererSourceMapsEnabled
          ? 'hidden'
          : performanceSourceMapsEnabled,
        rollupOptions: {
          // One page per window, so the App Advisor window never loads the
          // main window's app. Page names: src/main/lib/renderer-pages.ts.
          input: {
            index: resolve(
              repoRoot,
              'apps/desktop-app/src/renderer/index.html',
            ),
            'app-advisor': resolve(
              repoRoot,
              'apps/desktop-app/src/renderer/app-advisor.html',
            ),
          },
          output: {
            entryFileNames: 'assets/entry-[hash].js',
            chunkFileNames: 'assets/chunk-[hash].js',
            manualChunks: rendererManualChunk,
          },
        },
      },
    },
  };
  const selectedTargets = readE2eBuildTargets();
  if (!selectedTargets.includes('main')) delete targets.main;
  if (!selectedTargets.includes('preload')) delete targets.preload;
  if (!selectedTargets.includes('renderer')) delete targets.renderer;
  return targets;
});

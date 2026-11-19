#!/usr/bin/env node

/**
 * Builds the core daemon as a standalone executable for the host, in the
 * shape `build:cli` produces: an esbuild CJS bundle, a Node SEA blob, and the
 * blob injected into a copy of this Node binary at dist/core-daemon/<name>.
 * `--targets darwin-arm64,darwin-x64` instead stages it for packaging at
 * .cache/bin/<target>/<name> (CAN-4950), leaving dist/core-daemon untouched. A
 * non-host target gets the matching Node from nodejs.org and a blob without a
 * V8 code cache, which only the host architecture accepts. Signing matches
 * the CLI's local build (ad hoc on macOS). Release signing happens inside the
 * app bundle (CAN-3768 decision 2): scripts/mac-sign.cjs gives the staged
 * daemon entitlements.daemon.mac.plist.
 * Every build stages a Node-ABI node-pty beside the executable as node-pty/
 * (CAN-5068; scripts/lib/daemon-node-pty.mjs), built from source for this
 * Node, and scripts/smoke-daemon-node-pty.mjs probes it. The terminal host
 * entry loads it (CAN-5088).
 * Windows also stages the named-pipe security addon beside the executable as
 * windows-pipe-security.node; the daemon fails closed without it. The packaged
 * Windows smoke (C7b, CAN-3950) exercises that load. `--targets win32-x64`
 * (CAN-4965) stages <name>.exe, the addon and node-pty in .cache/bin/win32-x64,
 * beside the process helper `build:windows-process-identity` built there; MSVC
 * builds the addon and node-pty, so only a win32-x64 host stages it. Release
 * signing covers them with the existing identity; there is no new signer.
 * `--targets linux-x64` or `linux-arm64` (CAN-4966) stages <name>, its
 * node-pty and the W5 worker in .cache/bin/<target> on a host of that target
 * only, since node-pty builds natively. Like the Linux CLI, its base runtime is
 * package.json's pinned, hash-verified `cli-node` distribution, so the build
 * Node must be that version. The app loads the owned-child addon from its CLI
 * copy (`build:cli`), so this stages none.
 * Every packaging target additionally carries the inert native vault addon
 * and its build receipt; host-only development builds may omit it when its
 * prerequisites are unavailable (CAN-5835). CAN-5853 composes present payloads
 * through the authorized native owner; compiled absence leaves the vault unavailable.
 * The SEA refuses NODE_OPTIONS, `--node-options` and SIGUSR1 inspector
 * activation (CLOSED_SEA_RUNTIME); a release build must keep these options.
 * CANOPY_BUILD_ID and CANOPY_RELEASE_FLAVOR define the daemon's own build and
 * launcher flavor (CAN-4504 C-11; read once VA-6b wires them) and are written
 * to <name>.identity.json for the migration-role package check. Without a
 * build ID the daemon is a development build and never migrates.
 * The host build also stages the code-graph runtime with build:cli's own
 * staging (CAN-5072; scripts/lib/code-graph-runtime-staging.mjs): a real
 * resources/code-graph/ directory and real web-tree-sitter, typescript and
 * @typescript/old packages under node_modules/, which a SEA resolves beside its
 * executable, without source maps and, for Linux targets, without source-map
 * directive comments. Beside them, execution-hosts/ holds the bundled host
 * entries the daemon runs in its execution host entry mode (CAN-5085). macOS
 * and Linux packaging targets stage the same runtime and every host entry
 * beside their daemon, which serves terminals (CAN-5088) and the code graph
 * (CAN-5089); Windows stages neither.
 * Every build, host or staged and of any flavor, carries the W5 commit log
 * host (W5b, CAN-5450; CAN-5529) and stages the w5-commit-log-worker.js bundle
 * beside the executable. The daemon composes it only for the W5 host flag,
 * which no launcher passes. Every build also carries the operation ledger and
 * its core.operation module (CAN-5092 S1a), composed only where the compiled
 * ownership rows name the daemon the ledger's writer, which no build does yet.
 * Every build also carries the core.pipeline.definition module and its host
 * (CAN-5092 S1b) but no definitions store: the daemon composes them only
 * where a trusted composition supplies the store and ownership rows naming
 * the daemon the writer, which no build does.
 * On Windows, host and win32-x64 staging builds also
 * stage the owned-child addon beside them as core-owned-child.node, which the
 * worker loads for confined capture reads (CAN-5530).
 * A successful host build last writes <name>.sources.json
 * (scripts/lib/core-daemon-sources.mjs): the hashes of every bundled input,
 * this script's own modules and the staged runtime packages, which dev runs
 * compare to decide whether the daemon is current (GA5, CAN-5540).
 */

import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import {
  assertProcessHelper,
  stageProcessHelper,
} from './lib/windows-process-helper.mjs';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WINDOWS_PIPE_SECURITY_FILE } from '../packages/core-platform/src/endpoints/windows-pipe.ts';
import {
  buildIdentityDefines,
  daemonName,
} from '../packages/protocol/src/brand.ts';
import {
  CODE_GRAPH_RUNTIME_MODULES,
  DAEMON_EXECUTION_HOST_ENTRIES,
  DAEMON_PIPELINE_HOST_ENTRY,
  DAEMON_SECRET_PROTECTION_FILE,
  DAEMON_SECRET_PROTECTION_MEMBERS,
} from '../packages/core-platform/src/execution-host/daemon-payload.ts';
import {
  DAEMON_W5_CONFINEMENT_ADDON_FILE,
  DAEMON_W5_WORKER_FILE,
} from '../apps/core-daemon/src/w5-worker-file.ts';
import { listBrandIds, loadBrand } from './brand/load-brand.mjs';
import { renderBrandedPipelines } from './brand/render-branded-resources.mjs';
import { prepareBrand } from './brand/prepare-brand.mjs';
import {
  readCloudBaseUrlForBundle,
  readLocalOnlyBuildEnv,
} from './lib/local-only-build-env.mjs';
import { SecretProtectionToolchainUnavailable } from './lib/secret-protection-toolchain.mjs';
import { buildSecretProtection } from './build-secret-protection.mjs';
import {
  assertSecretProtectionTarget,
  clearSecretProtection,
  stageSecretProtection,
} from './lib/daemon-secret-protection.mjs';
import {
  createNativeVaultCatalog,
  encodeNativeVaultCatalog,
  assertFinalNativeVaultBytes,
} from './lib/native-vault-catalog.mjs';
import { signNativeVaultBeforePin } from './lib/native-vault-signing.mjs';
import { buildOwnedChild } from './build-owned-child.mjs';
import { buildWindowsPipeSecurity } from './build-windows-pipe-security.mjs';
import {
  parseTargetArgs,
  resolveTargets,
} from './lib/binary-staging-utils.mjs';
import {
  daemonBuildIdentity,
  daemonIdentityDefines,
  daemonIdentityPath,
} from './lib/check-migration-role-package.mjs';
import {
  CLOSED_SEA_RUNTIME,
  assertClosedSeaNode,
  buildSeaBinary,
  generateSeaBlob,
} from './lib/sea-executable.mjs';
import {
  ensureLinuxNodeBinary,
  ensureOfficialNodeBinary,
  getLinuxNodeDistribution,
} from './lib/cli-node-runtime.mjs';
import {
  DAEMON_NODE_PTY_DIRECTORY,
  stageDaemonNodePty,
} from './lib/daemon-node-pty.mjs';
import { bundleDaemonW5Worker } from './lib/core-daemon-w5-host.mjs';
import { stageCodeGraphRuntime } from './lib/code-graph-runtime-staging.mjs';
import { stageDaemonBundledPipelines } from './lib/daemon-bundled-pipelines-staging.mjs';
import {
  coreDaemonFacts,
  daemonSecureDirectoryDefines,
  coreDaemonStaticInputs,
} from './lib/dev-core-daemon.mjs';
import {
  filesUnder,
  metafileInputs,
  scriptInputs,
  sourcesRecordPath,
  writeSourcesRecord,
} from './lib/core-daemon-sources.mjs';

// Inputs changed at or after this instant may be either version in the build.
const startedAtMs = Date.now();

// This Node generates the blob and becomes the daemon's runtime, so its
// version is the artifact's.
assertClosedSeaNode(process.version);

const WINDOWS_STAGING_TARGET = 'win32-x64';
const LINUX_STAGING_TARGETS = new Set(['linux-x64', 'linux-arm64']);
const STAGING_TARGETS = new Set([
  'darwin-arm64',
  'darwin-x64',
  WINDOWS_STAGING_TARGET,
  ...LINUX_STAGING_TARGETS,
]);
const targetArgs = parseTargetArgs(process.argv.slice(2));
if (targetArgs.host)
  throw new Error(
    'The host build takes no arguments; --host is not supported.',
  );
const stagingTargets =
  targetArgs.targets === null
    ? null
    : resolveTargets(targetArgs, 'core daemon', {
        supportedTargets: STAGING_TARGETS,
      });
if (stagingTargets?.length === 0)
  throw new Error('--targets needs at least one core daemon target.');

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rootPackage = createRequire(import.meta.url)(join(root, 'package.json'));
const brand = loadBrand(process.env.CANOPY_BRAND ?? 'canopy');
const identity = daemonBuildIdentity({ brand, version: rootPackage.version });
// Staging builds keep their intermediates apart, so dist/core-daemon (the E2E
// and smoke input) only ever holds a host build.
const outDir = join(
  root,
  ...(stagingTargets
    ? ['.cache', 'core-daemon-staging']
    : ['dist', 'core-daemon']),
);
const bundlePath = join(outDir, 'main.bundle.js');
const blobPath = join(outDir, 'sea-prep.blob');
const target = `${process.platform}-${process.arch}`;
const stagesWindows = stagingTargets?.includes(WINDOWS_STAGING_TARGET) ?? false;
if (stagesWindows && target !== WINDOWS_STAGING_TARGET)
  throw new Error(
    `The ${WINDOWS_STAGING_TARGET} core daemon stages only on a ${WINDOWS_STAGING_TARGET} host, which builds its pipe security addon with MSVC; this host is ${target}.`,
  );
const linuxStagingTargets = (stagingTargets ?? []).filter((stagingTarget) =>
  LINUX_STAGING_TARGETS.has(stagingTarget),
);
for (const linuxTarget of linuxStagingTargets)
  if (linuxTarget !== target)
    throw new Error(
      `The ${linuxTarget} core daemon stages only on a ${linuxTarget} host, which builds its node-pty natively; this host is ${target}.`,
    );
// The pinned runtime also generates the blob, so the code cache matches it.
const linuxDistribution =
  linuxStagingTargets.length > 0
    ? getLinuxNodeDistribution(rootPackage, target)
    : null;
if (linuxDistribution && process.version !== linuxDistribution.version)
  throw new Error(
    `Staging the ${target} core daemon requires Node ${linuxDistribution.version}, its pinned cli-node runtime; current Node is ${process.version}.`,
  );
// The staged daemon runs beside it; fail before bundling when it is stale.
if (stagesWindows) {
  try {
    assertProcessHelper(root);
  } catch (error) {
    throw new Error(
      'Staging the Windows core daemon needs a fresh process helper in .cache/bin/win32-x64; run `pnpm run build:windows-process-identity` first.',
      { cause: error },
    );
  }
}

const executableName = (name, platformTarget) =>
  `${name}${platformTarget.startsWith('win32-') ? '.exe' : ''}`;
const exePath = join(outDir, executableName(daemonName(brand), target));
const stagingDirectory = (stagingTarget) =>
  join(root, '.cache', 'bin', stagingTarget);
const stagedPaths = (stagingTargets ?? []).map((stagingTarget) =>
  join(
    stagingDirectory(stagingTarget),
    executableName(daemonName(brand), stagingTarget),
  ),
);
const stagedPipeSecurity = join(
  stagingDirectory(WINDOWS_STAGING_TARGET),
  WINDOWS_PIPE_SECURITY_FILE,
);
const stagedConfinementAddon = join(
  stagingDirectory(WINDOWS_STAGING_TARGET),
  DAEMON_W5_CONFINEMENT_ADDON_FILE,
);

for (const payloadTarget of stagingTargets ?? [target])
  assertSecretProtectionTarget(payloadTarget);

mkdirSync(outDir, { recursive: true });
clearSecretProtection(outDir);
clearSecretProtection(join(outDir, 'native'));
// A failed build must not leave the previous build's identity behind, nor a
// previously staged daemon or addon for verification to accept. Packaging
// copies the whole staging directory, so every brand's daemon goes: one bundle
// ships one.
rmSync(daemonIdentityPath(exePath), { force: true });
rmSync(sourcesRecordPath(exePath), { force: true });
const daemonNames = stagingTargets
  ? listBrandIds().map((id) => daemonName(loadBrand(id)))
  : [];
for (const stagingTarget of stagingTargets ?? []) {
  clearSecretProtection(stagingDirectory(stagingTarget));
  for (const name of daemonNames) {
    const path = join(
      stagingDirectory(stagingTarget),
      executableName(name, stagingTarget),
    );
    rmSync(path, { force: true });
    rmSync(daemonIdentityPath(path), { force: true });
  }
  rmSync(join(stagingDirectory(stagingTarget), DAEMON_NODE_PTY_DIRECTORY), {
    recursive: true,
    force: true,
  });
  rmSync(join(stagingDirectory(stagingTarget), DAEMON_W5_WORKER_FILE), {
    force: true,
  });
}
if (stagesWindows) {
  rmSync(stagedPipeSecurity, { force: true });
  rmSync(stagedConfinementAddon, { force: true });
}
rmSync(join(outDir, DAEMON_NODE_PTY_DIRECTORY), {
  recursive: true,
  force: true,
});
// A failed build must not leave a previous build's worker beside it.
const workerPath = join(outDir, DAEMON_W5_WORKER_FILE);
rmSync(workerPath, { force: true });
// Nor its addon, on a build that stages none. A Windows host build replaces it
// by rename instead: a loaded addon stays mapped, and that rename names the
// holder.
const stagesHostConfinementAddon =
  process.platform === 'win32' && !stagingTargets;
if (!stagesHostConfinementAddon)
  rmSync(join(outDir, DAEMON_W5_CONFINEMENT_ADDON_FILE), { force: true });

// Bundled inputs, resolved from esbuild's working directory.
const bundledInputs = [];
const recordInputs = (result) =>
  bundledInputs.push(...metafileInputs(result.metafile, process.cwd()));

try {
  const secretProtectionDirectory = join(
    root,
    'packages/core-platform/native/secret-protection',
  );
  const secretProtectionInputs = filesUnder(secretProtectionDirectory);
  let secretProtection = null;
  let secretProtectionUnavailable = null;
  try {
    secretProtection = buildSecretProtection({
      out: join(outDir, 'native', DAEMON_SECRET_PROTECTION_FILE),
    });
    if (!secretProtection)
      throw new Error('Native vault addon is unavailable on this host');
  } catch (error) {
    if (
      stagingTargets ||
      !(error instanceof SecretProtectionToolchainUnavailable)
    )
      throw error;
    secretProtectionUnavailable = error.message;
    console.warn(
      `Native vault prerequisite unavailable: ${error.message}; payload was not staged for this host-only development daemon. Packaging still requires it.`,
    );
  }

  if (secretProtection)
    await signNativeVaultBeforePin({
      file: secretProtection,
      root,
      staging: stagingTargets !== null,
    });
  const nativeCatalog = createNativeVaultCatalog({
    file: secretProtection,
    target,
    identity,
    version: rootPackage.version,
  });

  console.log('Bundling core daemon with esbuild…');
  const mainBuild = await build({
    entryPoints: [join(root, 'apps', 'core-daemon', 'src', 'main.ts')],
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'cjs',
    minify: true,
    outfile: bundlePath,
    external: ['node:*'],
    metafile: true,
    define: {
      __CANOPY_COMPILED_RUNTIME__: 'true',
      __CANOPY_NATIVE_ARTIFACT_CATALOG__: JSON.stringify(
        encodeNativeVaultCatalog(nativeCatalog),
      ),
      __CANOPY_DAEMON_BUILD_VERSION__: JSON.stringify(rootPackage.version),
      __CANOPY_DAEMON_BUILD_BRAND_ID__: JSON.stringify(brand.id),
      ...daemonSecureDirectoryDefines({ brand }),
      __CANOPY_DAEMON_BUILD_COWORK_DIR_NAME__: JSON.stringify(
        brand.storage.projectConfigDirNames[0],
      ),
      ...daemonIdentityDefines(identity),
    },
  });
  recordInputs(mainBuild);
  console.log('Bundling the W5 commit log worker…');
  recordInputs(await bundleDaemonW5Worker({ root, outfile: workerPath }));

  const linuxBaseNode = linuxDistribution
    ? await ensureLinuxNodeBinary({
        nodeCacheRoot: join(root, '.cache', 'cli', 'node'),
        distribution: linuxDistribution,
      })
    : null;

  console.log('Generating SEA blob…');
  generateSeaBlob({
    main: bundlePath,
    blobPath,
    configPath: join(outDir, 'sea-config.json'),
    useCodeCache: true,
    ...CLOSED_SEA_RUNTIME,
    ...(linuxBaseNode && { nodeBinaryPath: linuxBaseNode }),
    cwd: root,
  });
  // V8 rejects a code cache from another architecture and warns on stderr at
  // every launch, so a cross-built daemon gets a blob without one.
  const portableBlobPath = join(outDir, 'sea-prep.portable.blob');
  if (stagingTargets?.some((stagingTarget) => stagingTarget !== target)) {
    console.log('Generating portable SEA blob for cross-built targets…');
    generateSeaBlob({
      main: bundlePath,
      blobPath: portableBlobPath,
      configPath: join(outDir, 'sea-config.portable.json'),
      useCodeCache: false,
      ...CLOSED_SEA_RUNTIME,
      cwd: root,
    });
  }

  /**
   * The bundled pipeline definitions the dormant definitions host reads
   * (CAN-5092), rendered with the brand's tokens from the current sources
   * on every build, never from a brand cache. They are platform-neutral, so
   * every target stages them.
   */
  function stageDaemonPipelineDefinitions(targetDir) {
    console.log('Staging the bundled pipeline definitions…');
    const rendered = mkdtempSync(join(tmpdir(), 'core-daemon-pipelines-'));
    try {
      renderBrandedPipelines(brand, join(rendered, 'pipelines'));
      stageDaemonBundledPipelines({
        sourceDir: join(rendered, 'pipelines'),
        targetDir,
      });
    } finally {
      rmSync(rendered, { recursive: true, force: true });
    }
  }

  function stageDaemonCodeGraphRuntime(targetDir, platformTarget) {
    console.log('Staging the code-graph runtime…');
    stageCodeGraphRuntime({ root, targetDir, target: platformTarget });
    for (const required of [
      join('resources', 'code-graph', 'manifest.json'),
      join('resources', 'code-graph', 'runtime', 'web-tree-sitter.wasm'),
      ...CODE_GRAPH_RUNTIME_MODULES.map((name) =>
        join('node_modules', name, 'package.json'),
      ),
    ])
      if (!existsSync(join(targetDir, required)))
        throw new Error(
          `The staged code-graph runtime is missing ${required}.`,
        );
  }

  // Each entry is its own CJS bundle, loaded by the execution host shell on a
  // worker thread. The graph runtime packages stay external and resolve from
  // the staged node_modules/.
  /**
   * The keys and values scripts/build-cli.mjs defines, so the execution
   * engine's executor builds in the pipeline host as it does in the CLI
   * (CAN-5086).
   */
  function pipelineHostDefines() {
    return {
      __CANOPY_COMPILED_RUNTIME__: 'true',
      ...buildIdentityDefines(
        brand.id,
        process.env.CANOPY_RELEASE_FLAVOR ?? 'dev',
        process.env.CANOPY_E2E_BUILD === '1' ||
          process.env.CANOPY_TEST_DATA_OVERRIDES === '1',
      ),
      __CANOPY_CLI_LINUX_ARM64_DEVELOPMENT__: JSON.stringify(
        target === 'linux-arm64' ||
          (stagingTargets ?? []).includes('linux-arm64'),
      ),
      __CANOPY_CLOUD_BASE_URL__: JSON.stringify(
        readCloudBaseUrlForBundle(process.env),
      ),
      // Same parser as electron.vite.config.ts and build-cli.mjs.
      __CANOPY_LOCAL_ONLY__: JSON.stringify(readLocalOnlyBuildEnv(process.env)),
      __CANOPY_RELEASE_FLAVOR__: JSON.stringify(
        process.env.CANOPY_RELEASE_FLAVOR ?? 'stable',
      ),
      __CANOPY_E2E__: JSON.stringify(process.env.CANOPY_E2E_BUILD === '1'),
      __CANOPY_MOCK_LLM_BASE_URL__:
        process.env.CANOPY_E2E_BUILD === '1'
          ? (JSON.stringify(process.env.CANOPY_MOCK_LLM_BASE_URL) ??
            'undefined')
          : 'undefined',
      __CANOPY_LINEAR_API_BASE_URL__:
        process.env.CANOPY_E2E_BUILD === '1'
          ? (JSON.stringify(process.env.CANOPY_LINEAR_API_BASE_URL) ??
            'undefined')
          : 'undefined',
      __CANOPY_CURSOR_CLI__: JSON.stringify(
        rootPackage['cursor-cli'] ?? { version: 'unknown', artifacts: {} },
      ),
      __CANOPY_COPILOT_CLI__: JSON.stringify(
        rootPackage['copilot-cli'] ?? { version: 'unknown', artifacts: {} },
      ),
      __CANOPY_OPENCODE_CLI__: JSON.stringify(
        rootPackage['opencode-cli'] ?? { version: 'unknown', artifacts: {} },
      ),
      __CANOPY_ANTIGRAVITY_CLI__: JSON.stringify(
        rootPackage['antigravity-cli'] ?? { version: 'unknown', artifacts: {} },
      ),
    };
  }

  async function stageExecutionHostEntries(
    targetDir,
    names = DAEMON_EXECUTION_HOST_ENTRIES,
  ) {
    const hostsDir = join(targetDir, 'execution-hosts');
    rmSync(hostsDir, { recursive: true, force: true });
    console.log('Bundling execution host entries…');
    for (const name of names) {
      const pipelineHost = name === DAEMON_PIPELINE_HOST_ENTRY;
      const brandModule = join(
        root,
        '.cache',
        'brand',
        brand.id,
        'desktop-brand.ts',
      );
      if (pipelineHost && !existsSync(brandModule))
        prepareBrand(brand.id, { log: false });
      const hostBuild = await build({
        entryPoints: [
          pipelineHost
            ? join(
                root,
                'packages',
                'execution-engine',
                'src',
                'node',
                'pipelines',
                'daemon-host',
                'entry.ts',
              )
            : join(
                root,
                'apps',
                'core-daemon',
                'src',
                'host-entries',
                name.replace(/\.js$/, '.ts'),
              ),
        ],
        bundle: true,
        platform: 'node',
        target: 'node24',
        format: 'cjs',
        minify: true,
        outfile: join(hostsDir, name),
        external: ['node:*', 'web-tree-sitter', 'typescript'],
        metafile: true,
        alias: {
          '@canopy/copilot-recipient': join(
            root,
            'packages',
            'copilot-recipient',
            'src',
          ),
          '@canopy/code-graph': join(root, 'packages', 'code-graph', 'src'),
          ...(pipelineHost && {
            '@canopy/execution-engine': join(
              root,
              'packages',
              'execution-engine',
              'src',
            ),
            '@canopy/brand/current': brandModule,
          }),
        },
        ...(pipelineHost && {
          tsconfig: join(root, 'tsconfig.base.json'),
          define: pipelineHostDefines(),
        }),
      });
      // The host builds from the execution engine alone (CAN-6173): a
      // desktop-shared module in its bundle is a boundary regression.
      const desktopShared = Object.keys(hostBuild.metafile.inputs).filter(
        (input) => input.split(/[\\/]/).includes('desktop-shared'),
      );
      if (desktopShared.length > 0)
        throw new Error(
          `The ${name} bundle includes desktop-shared modules: ${desktopShared.slice(0, 5).join(', ')}`,
        );
      recordInputs(hostBuild);
    }
  }

  function writeIdentity(executablePath) {
    writeFileSync(
      daemonIdentityPath(executablePath),
      `${JSON.stringify(identity, null, 2)}\n`,
    );
  }

  if (stagingTargets) {
    // Built before the daemon and staged after it, so a failed build of either
    // stages neither.
    const workingAddon = join(
      outDir,
      WINDOWS_STAGING_TARGET,
      WINDOWS_PIPE_SECURITY_FILE,
    );
    const workingConfinementAddon = join(
      outDir,
      WINDOWS_STAGING_TARGET,
      DAEMON_W5_CONFINEMENT_ADDON_FILE,
    );
    if (stagesWindows) {
      console.log('Building the Windows pipe security addon…');
      buildWindowsPipeSecurity({ out: workingAddon });
      console.log('Building the W5 confinement addon…');
      buildOwnedChild({ out: workingConfinementAddon });
    }
    for (const [index, stagingTarget] of stagingTargets.entries()) {
      const stagedPath = stagedPaths[index];
      console.log(`Building staged core daemon for ${stagingTarget}…`);
      const baseNodePath =
        stagingTarget === target
          ? (linuxBaseNode ?? process.execPath)
          : await ensureOfficialNodeBinary({
              nodeCacheRoot: join(root, '.cache', 'cli', 'node'),
              target: stagingTarget,
              label: 'core daemon',
            });
      // Built under its own name outside the packaged directory, then moved:
      // an interrupted build must not leave a plain Node binary (or a partial
      // file) where verification or packaging would pick it up.
      const workingPath = join(
        outDir,
        stagingTarget,
        executableName(daemonName(brand), stagingTarget),
      );
      mkdirSync(dirname(workingPath), { recursive: true });
      mkdirSync(dirname(stagedPath), { recursive: true });
      buildSeaBinary({
        baseNodePath,
        outputPath: workingPath,
        target: stagingTarget,
        blobPath: stagingTarget === target ? blobPath : portableBlobPath,
        cwd: root,
      });
      // Before the daemon moves in: a staged daemon always has its node-pty
      // and W5 worker.
      stageDaemonNodePty({
        root,
        target: stagingTarget,
        destination: join(dirname(stagedPath), DAEMON_NODE_PTY_DIRECTORY),
      });
      cpSync(workerPath, join(dirname(stagedPath), DAEMON_W5_WORKER_FILE));
      stageDaemonPipelineDefinitions(dirname(stagedPath));
      // Daemon terminals and the code graph run on macOS and Linux only
      // (CAN-5088, CAN-5089; CAN-5091). The graph runtime is platform-neutral.
      if (!stagingTarget.startsWith('win32')) {
        stageDaemonCodeGraphRuntime(dirname(stagedPath), stagingTarget);
        await stageExecutionHostEntries(dirname(stagedPath));
      }
      stageSecretProtection({
        source: secretProtection,
        destination: dirname(stagedPath),
        target: stagingTarget,
      });
      renameSync(workingPath, stagedPath);
      writeIdentity(stagedPath);
      assertFinalNativeVaultBytes({
        daemonPath: stagedPath,
        target: stagingTarget,
      });
      console.log(`Staged core daemon ${stagingTarget} at ${stagedPath}`);
    }
    if (stagesWindows) {
      renameSync(workingAddon, stagedPipeSecurity);
      console.log(
        `Staged ${WINDOWS_PIPE_SECURITY_FILE} at ${stagedPipeSecurity}`,
      );
      renameSync(workingConfinementAddon, stagedConfinementAddon);
      console.log(
        `Staged ${DAEMON_W5_CONFINEMENT_ADDON_FILE} at ${stagedConfinementAddon}`,
      );
    }
  } else {
    console.log('Building standalone host daemon…');
    buildSeaBinary({
      baseNodePath: process.execPath,
      outputPath: exePath,
      target,
      blobPath,
      cwd: root,
    });
    if (secretProtection)
      stageSecretProtection({
        source: secretProtection,
        destination: outDir,
        target,
      });
    writeIdentity(exePath);
    if (secretProtection)
      assertFinalNativeVaultBytes({ daemonPath: exePath, target });
    stageDaemonCodeGraphRuntime(outDir, target);
    stageDaemonPipelineDefinitions(outDir);
    await stageExecutionHostEntries(outDir);
    stageDaemonNodePty({
      root,
      target,
      destination: join(outDir, DAEMON_NODE_PTY_DIRECTORY),
    });
  }

  if (process.platform === 'win32' && !stagingTargets) {
    execFileSync(
      process.execPath,
      [join(root, 'scripts/build-windows-process-identity.mjs')],
      { stdio: 'inherit' },
    );
    stageProcessHelper(root, outDir);
    console.log('Building and staging the Windows pipe security addon…');
    buildWindowsPipeSecurity({
      out: join(outDir, WINDOWS_PIPE_SECURITY_FILE),
    });
    console.log('Building and staging the W5 confinement addon…');
    buildOwnedChild({ out: join(outDir, DAEMON_W5_CONFINEMENT_ADDON_FILE) });
  }

  if (!stagingTargets) {
    const record = writeSourcesRecord({
      root,
      artifactPath: exePath,
      facts: coreDaemonFacts({ identity }),
      inputs: [
        ...secretProtectionInputs,
        ...bundledInputs,
        ...(await scriptInputs(root, fileURLToPath(import.meta.url))),
        ...coreDaemonStaticInputs({ root, brandId: brand.id }),
      ],
      inputDirectories: [secretProtectionDirectory],
      secretProtectionUnavailable,
      companions: secretProtection
        ? DAEMON_SECRET_PROTECTION_MEMBERS.map((name) => join(outDir, name))
        : [],
      startedAtMs,
    });
    console.log(
      record.written
        ? `Recorded ${record.inputs} daemon inputs in ${sourcesRecordPath(exePath)}`
        : `${record.changed} changed during the build, so no source record was written; the next dev run rebuilds the daemon.`,
    );
  }

  if (secretProtection)
    console.log(
      `Staged native vault addon ${DAEMON_SECRET_PROTECTION_FILE} and build receipt at ${stagingTargets ? stagingTargets.map(stagingDirectory).join(', ') : outDir}`,
    );

  console.log(
    `Done! Brand: ${brand.id}. Flavor: ${identity.flavor}. Executable: ${stagingTargets ? stagedPaths.join(', ') : exePath}`,
  );
} catch (error) {
  for (const directory of [
    outDir,
    join(outDir, 'native'),
    ...(stagingTargets ?? []).map(stagingDirectory),
  ]) {
    clearSecretProtection(directory);
  }
  for (const path of [exePath, ...stagedPaths]) {
    rmSync(path, { force: true });
    rmSync(daemonIdentityPath(path), { force: true });
    rmSync(sourcesRecordPath(path), { force: true });
  }
  throw error;
}

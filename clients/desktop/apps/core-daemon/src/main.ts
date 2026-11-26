import { homedir } from 'node:os';
import {
  assertHostBuildStorageStartup,
  assertOwnedStorageDirectory,
  canonicalStoragePath,
} from '@canopy/core-platform/build-storage-startup';
import { assertDaemonSecureStorageReady } from '@canopy/core-runtime/node/build-storage-startup';
import { CLOUD_ACCOUNT_AUTHORITY_COMPOSITION_SELECTED } from '@canopy/core-runtime/node/cloud-account/activation';
import {
  compiledBuildIdentity,
  dataDirectoryOverride,
  isDevelopmentOrTestBuild,
} from '@canopy/core-runtime/node/build-identity';
import {
  historicalSecureDataDir,
  resolveSecureDataDir,
  resolveLegacyPatPaths,
  type BrandSecureDirectoryNames,
} from '@canopy/core-runtime/node/secure-data-dir';
import { isSea } from 'node:sea';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { ShutdownReport } from '@canopy/core-runtime';
import {
  WINDOWS_PIPE_SECURITY_FILE,
  PEER_IDENTITY_FILE,
  createPeerIdentityServices,
  WINDOWS_PROCESS_FILE,
  hostPlatformOperatingSystem,
  createPlatformEndpointServices,
  hostPlatformServices,
  createNativeSecretProtectionOwner,
} from '@canopy/core-platform';
import {
  CanopyDaemonUsageError,
  parseCanopyDaemonArguments,
} from './arguments';
import { consumeDaemonHandoff } from './claim-handoff';
import { readDaemonCloudEndpoint } from './cloud-account';
import { startCanopyDaemon } from './daemon';
import {
  setInvalidRemoteDefaultSink,
  type InvalidRemoteDefaultSource,
} from '@canopy/core-runtime/node/git';
import { prepareDaemonMigration } from './migration';
import {
  nodeDaemonLifetimeHost,
  runDaemonLifetime,
  type DaemonLifetime,
  type DaemonOutcome,
} from './lifetime';
import { failureOutcome, listenForStopSignals } from './process-control';
import { daemonExecutionHostEntries } from './execution-hosts';
import { DAEMON_WORKER_READY, readDaemonWorkerHandoff } from './worker-handoff';
import { startCanopyDaemonWorker } from './worker-process';
import { runRequestedCodexMcpLauncher } from './codex-mcp-launcher-entry';
import { runRequestedExecutionHostShell } from '@canopy/core-platform/execution-host/shell';
import { absorbClosedStderr } from './stderr-closure';

declare const __CANOPY_DAEMON_BUILD_VERSION__: string | undefined;
declare const __CANOPY_DAEMON_SECURE_DIR_NAMES__:
  | BrandSecureDirectoryNames
  | undefined;
declare const __CANOPY_DAEMON_BUILD_BRAND_ID__: string | undefined;
declare const __CANOPY_DAEMON_BUILD_COWORK_DIR_NAME__: string | undefined;

declare const __CANOPY_DAEMON_CLOUD_ENDPOINT__: unknown;
declare const __CANOPY_DAEMON_E2E_CLOUD__:
  | { readonly wellKnownNamespace: string; readonly apiNamespace: string }
  | null
  | undefined;

/**
 * An E2E build's per-run Cloud (CAN-6997), as the app's
 * `CANOPY_E2E_CLOUD_BASE_URL` override. Other builds define the constant
 * null, so this is eliminated and the variable is never read.
 */
function e2eCloudEndpoint(): unknown {
  if (
    typeof __CANOPY_DAEMON_E2E_CLOUD__ === 'undefined' ||
    __CANOPY_DAEMON_E2E_CLOUD__ === null
  )
    return null;
  const baseUrl = process.env.CANOPY_E2E_CLOUD_BASE_URL;
  return baseUrl ? { ...__CANOPY_DAEMON_E2E_CLOUD__, baseUrl } : null;
}

declare const __CANOPY_DAEMON_BUILD_ID__: string | undefined;
declare const __CANOPY_DAEMON_BUILD_FLAVOR__: string | undefined;
declare const __CANOPY_DAEMON_BUILD_LAUNCHER_IDENTIFIER__: string | undefined;
declare const __CANOPY_DAEMON_BUILD_SECURE_MODE__: string | undefined;

const EXIT_USAGE = 64;

function shutdownOutcome(report: ShutdownReport): DaemonOutcome {
  const failed = report.phases.filter(({ status }) => status !== 'completed');
  return failed.length > 0
    ? {
        code: 1,
        message: `Shutdown phases did not complete: ${failed.map(({ id }) => id).join(', ')}`,
      }
    : { code: 0, message: '' };
}

/**
 * `--profile worker`: a split core's supervised worker (CAN-5073). It runs
 * until its core's binding ends or a stop signal, and never publishes.
 */
// CAN-7169: a suppressed remote default branch is reported by source only;
// the remote's text never reaches stderr.
function reportInvalidRemoteDefault(source: InvalidRemoteDefaultSource): void {
  process.stderr.write(
    `Suppressed a remote default branch that is not a valid branch name (${source}).\n`,
  );
}

async function runWorker(dataRoot: string): Promise<DaemonOutcome> {
  setInvalidRemoteDefaultSink(reportInvalidRemoteDefault);
  const stops = listenForStopSignals(process);
  const handoff = await readDaemonWorkerHandoff(process.stdin);
  const worker = await startCanopyDaemonWorker({
    dataRoot,
    handoff,
    environment: { ...process.env },
    pipeSecurityModule: join(
      dirname(process.execPath),
      WINDOWS_PIPE_SECURITY_FILE,
    ),
  });
  await new Promise<void>((resolve, reject) =>
    process.stdout.write(DAEMON_WORKER_READY, (error) =>
      error ? reject(error) : resolve(),
    ),
  );
  const reason = await stops.next(worker.disconnected);
  let report: ShutdownReport;
  try {
    report = await worker.stop(reason);
  } finally {
    await worker.seal();
  }
  return shutdownOutcome(report);
}

// Only fixed text reaches stderr; never print stacks, causes, or paths.
async function main(lifetime: DaemonLifetime): Promise<DaemonOutcome> {
  setInvalidRemoteDefaultSink(reportInvalidRemoteDefault);
  let parsed;
  try {
    parsed = parseCanopyDaemonArguments(process.argv.slice(2));
  } catch (error) {
    if (!(error instanceof CanopyDaemonUsageError)) throw error;
    return {
      code: EXIT_USAGE,
      message: `${error.message}\nUsage: --data-root <path> --runtime-mode <prod|rc|dev>`,
    };
  }
  if (typeof __CANOPY_DAEMON_SECURE_DIR_NAMES__ === 'undefined')
    return { code: 1, message: 'Daemon secure directory names unavailable.' };
  // adddup2 clears CLOEXEC: claim before handoff, graph creation or any spawn.
  const buildIdentity = compiledBuildIdentity(
    typeof __CANOPY_DAEMON_BUILD_BRAND_ID__ === 'string'
      ? __CANOPY_DAEMON_BUILD_BRAND_ID__
      : '',
  );
  const dataOverride = dataDirectoryOverride(process.env, 'CANOPY_DATA_DIR');
  const secureOverride = dataDirectoryOverride(
    process.env,
    'CANOPY_SECURE_DATA_DIR',
  );
  if (!dataOverride && !secureOverride) {
    const suppliedHome = homedir();
    const home = canonicalStoragePath(suppliedHome);
    const ordinaryDataRoot = join(
      home,
      `.${buildIdentity.brandId}${buildIdentity.build === 'stable' ? '' : `-${buildIdentity.build}`}`,
    );
    const ordinaryRoot = assertOwnedStorageDirectory(ordinaryDataRoot);
    // Without an explicit override, only dev/test hosts may supply custom argv roots.
    const selectedRootOverride =
      canonicalStoragePath(parsed.dataRoot) !== ordinaryRoot.canonicalPath;
    if (selectedRootOverride) {
      if (!isDevelopmentOrTestBuild())
        throw new Error(
          'Data directory overrides require a dev or test build.',
        );
    } else {
      // Rebase only the trusted HOME prefix; aliases below it remain observable.
      const homeRelativeRoot = relative(suppliedHome, parsed.dataRoot);
      const requestedRoot =
        homeRelativeRoot !== '..' &&
        !homeRelativeRoot.startsWith(`..${sep}`) &&
        !isAbsolute(homeRelativeRoot)
          ? join(home, homeRelativeRoot)
          : parsed.dataRoot;
      assertOwnedStorageDirectory(requestedRoot);
      // The daemon's authority and runtime require the admitted canonical spelling.
      parsed = { ...parsed, dataRoot: ordinaryRoot.canonicalPath };
      assertHostBuildStorageStartup({ home, identity: buildIdentity });
      assertDaemonSecureStorageReady({
        historicalPresent:
          assertOwnedStorageDirectory(
            historicalSecureDataDir(
              home,
              __CANOPY_DAEMON_SECURE_DIR_NAMES__,
              buildIdentity.build,
            ),
          ).kind !== 'missing',
        nestedPresent:
          assertOwnedStorageDirectory(join(parsed.dataRoot, 'secure-storage'))
            .kind !== 'missing',
      });
    }
  }
  if (parsed.profile === 'worker') return runWorker(parsed.dataRoot);
  const os = hostPlatformOperatingSystem();
  if (parsed.w5Recovery) {
    const { recoveryAuth } = await consumeDaemonHandoff({
      env: process.env,
      openStream: () => process.stdin,
    });
    if (!recoveryAuth) throw new Error('Recovery handoff unavailable.');
    const { runDaemonW5Recovery } = await import('./w5-recovery');
    await runDaemonW5Recovery({
      dataRoot: parsed.dataRoot,
      nonce: parsed.w5Recovery,
      auth: recoveryAuth,
      os,
      platformFor: (validateStartupClaim) =>
        hostPlatformServices(
          createPlatformEndpointServices(os, { validateStartupClaim }),
        ),
      buildVersion:
        typeof __CANOPY_DAEMON_BUILD_VERSION__ === 'string'
          ? __CANOPY_DAEMON_BUILD_VERSION__
          : '0.0.0-dev',
    });
    // Exit cold. The desktop still performs capture and permanent bootstrap retirement
    // before its separate ordinary launch; recovery cannot publish readiness.
    return { code: 0, message: '' };
  }
  absorbClosedStderr(process.stderr, os);
  const migration = prepareDaemonMigration({
    requested: parsed.migrationChannel === true,
    os,
    peerIdentity: createPeerIdentityServices({
      os,
      nativePath: join(dirname(process.execPath), PEER_IDENTITY_FILE),
    }),
    build: {
      buildId:
        typeof __CANOPY_DAEMON_BUILD_ID__ === 'string'
          ? __CANOPY_DAEMON_BUILD_ID__
          : '',
      flavor:
        typeof __CANOPY_DAEMON_BUILD_FLAVOR__ === 'string'
          ? __CANOPY_DAEMON_BUILD_FLAVOR__
          : 'development',
      launcherIdentifier:
        typeof __CANOPY_DAEMON_BUILD_LAUNCHER_IDENTIFIER__ === 'string'
          ? __CANOPY_DAEMON_BUILD_LAUNCHER_IDENTIFIER__
          : '',
      secureMode:
        typeof __CANOPY_DAEMON_BUILD_SECURE_MODE__ === 'string'
          ? __CANOPY_DAEMON_BUILD_SECURE_MODE__
          : '',
    },
  });
  if (parsed.migrationChannel && migration.kind !== 'disabled')
    throw new Error('Migration channel unavailable.');
  const { closureReceipt, gitReceipt, ...options } = parsed;
  if (closureReceipt) lifetime.requestClosureReceipt();
  if (gitReceipt) lifetime.requestGitReceipt();
  const stops = listenForStopSignals(process);
  const { claimHandle, ownerSecret } = await consumeDaemonHandoff({
    env: process.env,
    openStream: () => process.stdin,
  });
  const cloudEndpoint = readDaemonCloudEndpoint(
    e2eCloudEndpoint() ??
      (typeof __CANOPY_DAEMON_CLOUD_ENDPOINT__ === 'undefined'
        ? null
        : __CANOPY_DAEMON_CLOUD_ENDPOINT__),
  );
  const daemon = await startCanopyDaemon({
    startupSignal: stops.signal,
    recordStartupSeal: (sealed) => lifetime.recordSeal(sealed),
    nativeProtectionFor: (platform, identity) =>
      createNativeSecretProtectionOwner({
        ...identity,
        ...buildIdentity,
        os: platform.os,
        supervision: platform.supervision,
        secureFiles: platform.secureFiles,
      }),
    ...options,
    secureDataRoot: resolveSecureDataDir({
      dataRoot: options.dataRoot,
      environment: process.env,
    }).path,
    legacyPatPaths: resolveLegacyPatPaths({
      dataRoot: options.dataRoot,
      environment: process.env,
    }),
    githubCredentialIdentity: buildIdentity,
    // Taken after the handoff consumed its marker, so Git children never see it.
    environment: { ...process.env },
    brandId: buildIdentity.brandId,
    coworkManagedDirName:
      typeof __CANOPY_DAEMON_BUILD_COWORK_DIR_NAME__ === 'string'
        ? __CANOPY_DAEMON_BUILD_COWORK_DIR_NAME__
        : '',
    ...(claimHandle && { claimHandle }),
    ...(ownerSecret && { ownerSecret }),
    ...(hostPlatformOperatingSystem() === 'win32' && {
      windowsProcessPath: isSea()
        ? join(dirname(process.execPath), WINDOWS_PROCESS_FILE)
        : resolve(
            import.meta.dirname,
            '../../..',
            '.cache/bin/win32-x64',
            WINDOWS_PROCESS_FILE,
          ),
    }),
    pipeSecurityModule: join(
      dirname(process.execPath),
      WINDOWS_PIPE_SECURITY_FILE,
    ),
    // CAN-5088: terminals in a supervised terminal host (Windows: CAN-5091).
    terminals: {},
    // CAN-5089: code-graph builds and reads in budgeted hosts.
    codeGraph: {},
    // CAN-5087: scripts in owned process trees.
    scripts: true,
    // CAN-5086: workflows in a supervised pipeline host.
    pipelines: {},
    // CAN-6997: composed but inert until account authority activation.
    cloudAccount: {
      cloud: cloudEndpoint,
    },
    buildVersion:
      typeof __CANOPY_DAEMON_BUILD_VERSION__ === 'string'
        ? __CANOPY_DAEMON_BUILD_VERSION__
        : '0.0.0-dev',
  }).finally(() => ownerSecret?.fill(0));
  let e2eCompositionReceipt: string | undefined;
  let e2eReceiptFailure: { readonly error: unknown } | undefined;
  // A lane-only receipt: boolean composition facts, never an endpoint or key.
  if (
    typeof __CANOPY_DAEMON_E2E_CLOUD__ !== 'undefined' &&
    __CANOPY_DAEMON_E2E_CLOUD__ !== null
  ) {
    e2eCompositionReceipt = join(
      options.dataRoot,
      'runtime/e2e-cloud-composition.json',
    );
    try {
      const { writeFile } = await import('node:fs/promises');
      await writeFile(
        e2eCompositionReceipt,
        JSON.stringify({
          selectorReceived: process.env.CANOPY_E2E_DAEMON_CLOUD_ACCOUNT === '1',
          activationSelected: CLOUD_ACCOUNT_AUTHORITY_COMPOSITION_SELECTED,
          cloudEndpointConfigured: cloudEndpoint !== null,
        }),
        { mode: 0o600 },
      );
    } catch (error) {
      // The lane needs the receipt: stop and seal the started daemon below,
      // then fail with the write's error.
      e2eReceiptFailure = { error };
    }
  }
  const reason = e2eReceiptFailure
    ? 'e2e composition receipt failed'
    : await stops.next(daemon.idle);
  let report: ShutdownReport;
  try {
    report = await daemon.stop(reason);
  } finally {
    // seal never rejects, so a failed stop keeps its own error.
    lifetime.recordSeal(await daemon.seal());
    // After the seal, which ends the Git host, so no later selection is missed.
    lifetime.recordGitSelections(daemon.gitSelections());
    // The smoke requires an empty runtime directory after clean shutdown.
    if (e2eCompositionReceipt) {
      const { rm } = await import('node:fs/promises');
      // A partly written receipt is removed too; the write's error stays the
      // one thrown.
      await rm(e2eCompositionReceipt, { force: true }).catch(
        (error: unknown) => {
          if (!e2eReceiptFailure) throw error;
        },
      );
    }
  }
  // A lane-only shutdown receipt beside runtime/, which must end empty: the
  // stop reason and phase statuses only. Best-effort, so it never changes the
  // stop or the exit. Gated on the build constant, so it is eliminated.
  if (
    typeof __CANOPY_DAEMON_E2E_CLOUD__ !== 'undefined' &&
    __CANOPY_DAEMON_E2E_CLOUD__ !== null
  ) {
    try {
      const { writeFile } = await import('node:fs/promises');
      await writeFile(
        join(options.dataRoot, `e2e-daemon-shutdown-${process.pid}.json`),
        JSON.stringify({
          pid: process.pid,
          reason,
          phases: report.phases.map(({ id, status }) => ({ id, status })),
        }),
        { mode: 0o600 },
      );
    } catch {
      // The lane reads a missing receipt as an unproven stop.
    }
  }
  if (e2eReceiptFailure) throw e2eReceiptFailure.error;
  return shutdownOutcome(report);
}

// The daemon also serves two hidden modes that never start a daemon: the
// Codex MCP stdio launcher (CAN-4117), checked first because its stdout is
// an MCP protocol channel, and the execution host entry mode.
const entryArgs = process.argv.slice(2);
if (
  !runRequestedCodexMcpLauncher(entryArgs) &&
  !runRequestedExecutionHostShell(entryArgs, daemonExecutionHostEntries())
)
  void runDaemonLifetime(nodeDaemonLifetimeHost(), main, failureOutcome);

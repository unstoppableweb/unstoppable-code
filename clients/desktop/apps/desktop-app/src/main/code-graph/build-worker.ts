import path from 'node:path';
import {
  executeCodeGraphBuild as executeHostCodeGraphBuild,
  executeCodeGraphEagerSeed as executeHostCodeGraphEagerSeed,
  serveCodeGraphBuildHost,
  type CodeGraphBuildExecutionOptions,
} from '@canopy/code-graph/host/build-host';
import type {
  CodeGraphWorkerBuildRequest,
  CodeGraphWorkerBuildResponse,
  CodeGraphWorkerEagerSeedRequest,
  CodeGraphWorkerEagerSeedResponse,
} from '@canopy/code-graph/host/build-protocol';
import { getGitExecutableCommand } from '@canopy/desktop-shared/lib/git-executable';
import { installDesktopCodeGraphResources } from '@canopy/desktop-shared/node/code-graph/resources';
import { hostOperatingSystem } from '@canopy/core-platform/host-platform';
import { connectExecutionHostChannel } from '@canopy/desktop-shared/node/execution-host/channel';

export {
  executeCodeGraphSummaryRepair,
  executeDeferredCodeGraphDerived,
  type CodeGraphBuildExecutionOptions,
} from '@canopy/code-graph/host/build-host';

const OPEN_FILES_BLOCK_REPLACEMENT = hostOperatingSystem() === 'win32';
// Windows `FlushFileBuffers` refuses a read-only handle.
const FLUSH_REQUIRES_WRITE_HANDLE = hostOperatingSystem() === 'win32';

export function codeGraphWorkerCpuProfileDirectory(
  e2eEnabled = __CANOPY_E2E__,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const directory = env.CANOPY_PERFORMANCE_UTILITY_CPU_PROFILE_DIR?.trim();
  return e2eEnabled && directory && path.isAbsolute(directory)
    ? directory
    : undefined;
}

/** The build host's build, with this host's file replacement behavior. */
export function executeCodeGraphBuild(
  request: CodeGraphWorkerBuildRequest,
  execution?: CodeGraphBuildExecutionOptions,
): Promise<CodeGraphWorkerBuildResponse> {
  return executeHostCodeGraphBuild(request, {
    ...execution,
    openFilesBlockReplacement: OPEN_FILES_BLOCK_REPLACEMENT,
    flushRequiresWriteHandle: FLUSH_REQUIRES_WRITE_HANDLE,
  });
}

/** The build host's eager seed, with this host's file replacement behavior. */
export function executeCodeGraphEagerSeed(
  request: CodeGraphWorkerEagerSeedRequest,
): Promise<CodeGraphWorkerEagerSeedResponse> {
  return executeHostCodeGraphEagerSeed(request, {
    openFilesBlockReplacement: OPEN_FILES_BLOCK_REPLACEMENT,
    flushRequiresWriteHandle: FLUSH_REQUIRES_WRITE_HANDLE,
  });
}

// Only serve when launched as a host. When this module is imported in process
// (Electron main smoke-load, Jest, the in-process parity test) there is no
// channel, so the build functions can be called directly with no side effects.
const channel = connectExecutionHostChannel();
if (channel) {
  installDesktopCodeGraphResources();
  serveCodeGraphBuildHost(channel, {
    openFilesBlockReplacement: OPEN_FILES_BLOCK_REPLACEMENT,
    flushRequiresWriteHandle: FLUSH_REQUIRES_WRITE_HANDLE,
    cpuProfileDirectory: codeGraphWorkerCpuProfileDirectory(),
    gitExecutable: getGitExecutableCommand(process.env),
  });
}

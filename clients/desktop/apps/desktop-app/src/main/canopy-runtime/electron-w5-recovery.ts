import { app } from 'electron';
import { join, resolve } from 'node:path';
import { BRAND } from '@canopy/brand/current';
import { daemonName } from '@canopy/protocol/brand';
import { CoreW5MaintenanceRequestSchema } from '@canopy/protocol/canopy-core';
import { W5BackupRecoveryError } from '@canopy/core-runtime/node/w5/backup';
import { executeW5Recovery } from '@canopy/core-client/node';
import {
  createOwnedChildServices,
  createPlatformEndpointServices,
  hostPlatformOperatingSystem,
  hostPlatformServices,
} from '@canopy/core-platform';
import { getCanopyRuntimeMode } from '@canopy/desktop-shared/canopy-paths';
import {
  getBundledBinDir,
  getEnhancedEnv,
} from '@canopy/desktop-shared/pipelines/config-paths';
import {
  W5MaintenanceDecisionError,
  type W5MaintenanceRequest,
  type W5MaintenanceResult,
} from '@canopy/core-runtime/node/w5/maintenance-types';

/** Native launch adapter only; no canonical writer, bootstrap host or fallback. */
export async function runElectronW5Maintenance(
  dataRoot: string,
  request: W5MaintenanceRequest,
  signal: AbortSignal,
): Promise<W5MaintenanceResult> {
  const os = hostPlatformOperatingSystem();
  if (os === 'win32')
    throw Object.assign(new Error('Recovery is unavailable.'), {
      reason: 'platform-unsupported',
    });
  const platform = hostPlatformServices(createPlatformEndpointServices(os));
  const executable = app.isPackaged
    ? join(getBundledBinDir(), daemonName(BRAND))
    : resolve('dist/core-daemon', daemonName(BRAND));
  const source = getEnhancedEnv();
  const environment = {
    ...platform.supervision.childEnvironment({ source }),
  };
  for (const name of ['CANOPY_DATA_DIR', 'CANOPY_SECURE_DATA_DIR']) {
    const value = source[name]?.trim();
    if (value) environment[name] = resolve(value);
  }
  const children = createOwnedChildServices({
    os,
    nativePath: app.isPackaged
      ? join(process.resourcesPath, 'cli/core-owned-child.node')
      : resolve(
          '.cache/native-owned-child',
          `${os}-${process.arch}`,
          'core-owned-child.node',
        ),
  });
  const reply = await executeW5Recovery({
    dataRoot,
    runtimeMode: app.isPackaged ? getCanopyRuntimeMode() : 'dev',
    executable,
    environment,
    children,
    endpointFor: (name) =>
      platform.endpoints.address({ dataRoot, endpointName: name }).path,
    request: CoreW5MaintenanceRequestSchema.parse(request),
    signal,
  });
  if (reply.state === 'complete') return reply.result;
  if (reply.state === 'recovery-required')
    throw new W5BackupRecoveryError(reply.commitId);
  const failure = Object.assign(new Error('Recovery was refused.'), {
    reason: reply.reason,
    ...(reply.state === 'refused' && reply.decision !== undefined
      ? { decision: reply.decision }
      : {}),
  });
  if (reply.state === 'stopped')
    throw new W5MaintenanceDecisionError(
      reply.results,
      failure,
      reply.diagnosis,
    );
  throw failure;
}

import { randomUUID } from 'node:crypto';
import { app, type IpcMainInvokeEvent } from 'electron';
import { CanopyOperationError } from '@canopy/core-runtime';
import { UPDATE_CHANNEL_FOR_FLAVOR } from '@canopy/core-runtime/update';
import {
  UPDATE_GRANTS,
  type CanopyCallerDescriptor,
  type UpdateRestartPolicy,
} from '@canopy/protocol/canopy-core';
import {
  IPC_CHANNELS,
  type DependencyVersions,
  type TargetUpdateRequest,
  type TargetUpdateVersionListRequest,
  type UpdateState,
} from '@canopy/desktop-shared/types';
import type { DesktopCanopyDispatcher } from '../canopy-runtime/desktop-runtime';
import { registerIpcHandler } from './register';
import type { DesktopIpcCallerResolver } from './file-tree';
import {
  checkForVersion,
  getUpdateState,
  listTargetUpdateVersions,
  reportRendererBusyState,
} from '../updater';
import { getCanopyReleaseFlavor } from '../lib/app-identity';
import { getInternalReleaseIndicatorForDisplay } from '../lib/internal-release-version';
import { isE2eBuild } from '../lib/e2e-gate';

function supportsTargetedUpdates(): boolean {
  const releaseFlavor = getCanopyReleaseFlavor();
  return releaseFlavor === 'internal' || releaseFlavor === 'rc';
}

/**
 * Build-time dependency versions injected by electron.vite.config.ts `define`.
 * These are resolved at compile time from package.json so the packaged app
 * does not need runtime access to that file.
 */
const DEPENDENCY_VERSIONS: DependencyVersions = {
  claudeCli: __DEP_CLAUDE_CLI__,
  claudeSdk: __DEP_CLAUDE_SDK__,
  codexCli: __DEP_CODEX_CLI__,
  ghCli: __DEP_GH_CLI__,
  rtkCli: __DEP_RTK_CLI__,
  octokit: __DEP_OCTOKIT__,
};

type UpdateDispatcher = Pick<DesktopCanopyDispatcher, 'query' | 'instruction'>;

function updateCaller(caller: CanopyCallerDescriptor): CanopyCallerDescriptor {
  return { ...caller, grants: [UPDATE_GRANTS.read, UPDATE_GRANTS.write] };
}

/** Rejects as the updater did: with its own message, which settings show. */
function asUpdaterError(error: unknown): Error {
  if (error instanceof CanopyOperationError) {
    return new Error(error.payload.message);
  }
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * The `update:*` actions project `core.update.*` on the desktop dispatcher,
 * so this computer's own update UI and a computer controlling it reach the
 * same implementation. Exact-version checks, busy reports, versions and the
 * state push stay on the updater directly.
 */
export function createUpdateActions(
  dispatcher: UpdateDispatcher,
  callerDescriptor: CanopyCallerDescriptor,
): {
  check(): Promise<void>;
  download(): Promise<void>;
  apply(restartPolicy: Exclude<UpdateRestartPolicy, 'prompt'>): Promise<void>;
  cancelScheduled(): Promise<void>;
} {
  const caller = updateCaller(callerDescriptor);
  const keyed = <Params extends object>(
    params: Params,
  ): {
    params: Params & { _meta: { idempotencyKey: string } };
    key: string;
  } => {
    const key = randomUUID();
    return { params: { ...params, _meta: { idempotencyKey: key } }, key };
  };
  // A request names the candidate the host found; with none, the updater
  // refuses with its own message.
  const candidate = async (): Promise<string> => {
    const status = await dispatcher.query(
      'core.update.status.get',
      { components: ['desktop'] },
      { caller },
    );
    const desktop = status.components[0];
    if (!desktop)
      throw new Error('This computer reports no desktop update state.');
    return desktop.availableVersion ?? desktop.currentVersion;
  };
  const run = async (action: () => Promise<unknown>): Promise<void> => {
    try {
      await action();
    } catch (error) {
      throw asUpdaterError(error);
    }
  };
  return {
    check: () =>
      run(() => {
        const { params, key } = keyed({
          components: ['desktop'],
          channel: UPDATE_CHANNEL_FOR_FLAVOR[getCanopyReleaseFlavor()],
          requestedVersion: null,
          force: false,
        });
        return dispatcher.instruction('core.update.check', params, {
          caller,
          metadata: { idempotencyKey: key },
        });
      }),
    download: () =>
      run(async () => {
        const { params, key } = keyed({
          component: 'desktop' as const,
          version: await candidate(),
        });
        return dispatcher.instruction('core.update.download', params, {
          caller,
          metadata: { idempotencyKey: key },
        });
      }),
    apply: (restartPolicy) =>
      run(async () => {
        const { params, key } = keyed({
          component: 'desktop' as const,
          version: await candidate(),
          restartPolicy,
        });
        return dispatcher.instruction('core.update.apply', params, {
          caller,
          metadata: { idempotencyKey: key },
        });
      }),
    cancelScheduled: () =>
      run(() =>
        dispatcher.instruction(
          'core.update.apply.cancel',
          { component: 'desktop' },
          { caller },
        ),
      ),
  };
}

export function registerUpdateHandlers(
  dispatcher: UpdateDispatcher,
  resolveCaller: DesktopIpcCallerResolver,
): void {
  const actions = (
    event: IpcMainInvokeEvent,
  ): ReturnType<typeof createUpdateActions> =>
    createUpdateActions(dispatcher, resolveCaller(event));
  registerIpcHandler(IPC_CHANNELS.updateCheck, (event) =>
    actions(event).check(),
  );
  if (supportsTargetedUpdates()) {
    registerIpcHandler(
      IPC_CHANNELS.updateCheckVersion,
      (_event, request: TargetUpdateRequest) => checkForVersion(request),
    );
    registerIpcHandler(
      IPC_CHANNELS.updateListVersions,
      (_event, request?: TargetUpdateVersionListRequest) =>
        listTargetUpdateVersions(request),
    );
  }
  registerIpcHandler(IPC_CHANNELS.updateDownload, (event) =>
    actions(event).download(),
  );
  registerIpcHandler(IPC_CHANNELS.updateInstall, (event) =>
    actions(event).apply('immediate'),
  );
  registerIpcHandler(IPC_CHANNELS.updateSchedule, (event) =>
    actions(event).apply('when_idle'),
  );
  registerIpcHandler(IPC_CHANNELS.updateCancelScheduled, (event) =>
    actions(event).cancelScheduled(),
  );
  registerIpcHandler(
    IPC_CHANNELS.updateReportBusy,
    (_event, busy: boolean): void => {
      reportRendererBusyState(busy);
    },
  );
  registerIpcHandler(IPC_CHANNELS.updateGetVersion, (): string => {
    if (isE2eBuild()) {
      const override = process.env.CANOPY_E2E_APP_VERSION?.trim();
      if (override) return override;
    }
    return getCanopyReleaseFlavor() === 'internal'
      ? getInternalReleaseIndicatorForDisplay(app.getVersion())
      : app.getVersion();
  });
  registerIpcHandler(
    IPC_CHANNELS.updateGetDependencyVersions,
    (): DependencyVersions => DEPENDENCY_VERSIONS,
  );
  registerIpcHandler(
    IPC_CHANNELS.updateGetState,
    (): UpdateState => getUpdateState(),
  );
}

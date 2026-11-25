import {
  CanopyOperationError,
  type CanopyDispatcherHandlerMap,
} from '@canopy/core-runtime';
import {
  SHARED_CONTAINER_READ_ERROR_CODES,
  SharedContainerAcceptanceListResultSchema,
  SharedContainerForkProvenanceGetResultSchema,
  SharedContainerRunGetResultSchema,
} from '@canopy/protocol/canopy-core';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import type { UserEnvironmentEntryView } from '@canopy/desktop-shared/types';
import type { StoredSecretValue } from '@canopy/execution-engine/types/stored-secrets';
import { getFeatureFlagService } from '../feature-flags';
import { listAcceptedSharedContainers } from '../shared-containers/acceptance-store';
import {
  getSharedContainerForkProvenancePath,
  readSharedContainerForkProvenance,
} from '../shared-containers/fork/provenance';
import { SharedContainerRevisionUnavailableError } from '../shared-containers/read/reader';
import {
  readSharedContainerRunStatus,
  SharedContainerNotAcceptedError,
} from '../shared-containers/run-status';
import type { DesktopQueryDefinitions } from './desktop-query-definitions';

/*
 * Registers the recipient-side shared-container reads on the desktop
 * dispatcher (CAN-6501 PR 7) over desktop's acceptance, fork-provenance,
 * replica, run-environment and run-copy stores. The shared-containers IPC
 * channels list-accepted, read-fork-provenance and run-status reach those
 * stores only through here.
 */

type SharedContainerReadName =
  | 'core.sharedContainer.acceptance.list'
  | 'core.sharedContainer.forkProvenance.get'
  | 'core.sharedContainer.run.get';

export interface CoreSharedContainerAdapter {
  queries: Pick<
    CanopyDispatcherHandlerMap<DesktopQueryDefinitions>,
    SharedContainerReadName
  >;
}

function unavailable(message: string): CanopyOperationError {
  return new CanopyOperationError({
    kind: 'capability_unavailable',
    message,
    retry: { kind: 'never' },
  });
}

// Desktop's own gate and messages (ipc/shared-containers.ts).
function assertSharedContainersEnabled(): void {
  if (
    !getFeatureFlagService().isEnabled(
      CLIENT_FEATURE_FLAGS.canopyDesktopSharedContainers.key,
    )
  )
    throw unavailable('Shared containers are disabled.');
}

// The macOS check stays in the IPC run gate, desktop's one platform read for
// it (check:platform-boundary); its refusal crosses as capability_unavailable.
async function assertSharedContainerRunEnabled(): Promise<void> {
  assertSharedContainersEnabled();
  const ipc = await import('../ipc/shared-containers');
  try {
    ipc.assertSharedContainerRunEnabled();
  } catch (error) {
    throw unavailable(
      error instanceof Error
        ? error.message
        : 'Shared-container run is disabled.',
    );
  }
}

/** A refusal the run-status read names, with its page's code and retry. */
function runStatusRefusal(error: unknown): unknown {
  if (error instanceof SharedContainerNotAcceptedError)
    return new CanopyOperationError({
      kind: 'failed_precondition',
      code: SHARED_CONTAINER_READ_ERROR_CODES.NOT_ACCEPTED,
      message: error.message,
      retry: {
        kind: 'after_refresh',
        resource: 'core.sharedContainer.acceptance.list',
      },
    });
  if (error instanceof SharedContainerRevisionUnavailableError)
    return new CanopyOperationError({
      kind: 'failed_precondition',
      code: SHARED_CONTAINER_READ_ERROR_CODES.REVISION_UNAVAILABLE,
      message: error.message,
      retry: {
        kind: 'after_refresh',
        resource: 'core.sharedContainer.replica',
      },
    });
  // Anything else is the dispatcher's redacted internal.
  return error;
}

/**
 * A run-environment entry as it crosses: empty, or its stored-secret
 * reference. A plaintext value is never answered; it fails closed as internal.
 */
function referenceOnly(entry: UserEnvironmentEntryView): {
  key: string;
  value: '' | StoredSecretValue;
  secret?: boolean;
} {
  const { value } = entry;
  if (value === '') return { ...entry, value };
  if (typeof value === 'string')
    throw new Error(
      'A run-environment value is not a stored-secret reference.',
    );
  return { ...entry, value };
}

// Desktop's stores check that these fields are set but cap none of them.
const RunConsentSchema = SharedContainerRunGetResultSchema.pick({
  allowed: true,
  allowedAt: true,
  publisherUserId: true,
});

export function createCoreSharedContainerAdapter(): CoreSharedContainerAdapter {
  return {
    queries: {
      'core.sharedContainer.acceptance.list': async () => {
        assertSharedContainersEnabled();
        // One read backs both, so the ids and the records never disagree.
        // A record past the contract's limits (desktop caps no id length) is
        // skipped, as the store skips other invalid records.
        const records = Object.fromEntries(
          Object.entries(await listAcceptedSharedContainers()).filter(
            ([containerId, record]) =>
              SharedContainerAcceptanceListResultSchema.safeParse({
                containerIds: [containerId],
                records: { [containerId]: record },
              }).success,
          ),
        );
        return { containerIds: Object.keys(records), records };
      },
      'core.sharedContainer.forkProvenance.get': async (params) => {
        assertSharedContainersEnabled();
        const result = {
          provenance: await readSharedContainerForkProvenance(
            getSharedContainerForkProvenancePath(
              params.projectId,
              params.worktreeId,
            ),
          ),
        };
        // A record past the contract's bounds reads as none, so the read
        // still answers; the renderer treats both alike.
        return SharedContainerForkProvenanceGetResultSchema.safeParse(result)
          .success
          ? result
          : { provenance: null };
      },
      'core.sharedContainer.run.get': async (params, context) => {
        await assertSharedContainerRunEnabled();
        let status: Awaited<ReturnType<typeof readSharedContainerRunStatus>>;
        try {
          status = await readSharedContainerRunStatus(params, context.signal);
        } catch (error) {
          throw runStatusRefusal(error);
        }
        const { allowed, allowedAt, publisherUserId, ...rest } = status;
        // Consent that named no publisher would match any publisher, so
        // consent past the contract's bounds answers as not given.
        const consent = RunConsentSchema.safeParse({
          allowed,
          allowedAt,
          publisherUserId,
        }).success
          ? {
              allowed,
              ...(allowedAt === undefined ? {} : { allowedAt }),
              ...(publisherUserId === undefined ? {} : { publisherUserId }),
            }
          : { allowed: false };
        return {
          ...rest,
          ...consent,
          values: status.values.map(referenceOnly),
        };
      },
    },
  };
}

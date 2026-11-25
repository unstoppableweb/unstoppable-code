import {
  CanopyOperationError,
  type CanopyDispatcherHandlerMap,
  type CanopyDispatcherInstructionHandlerMap,
} from '@canopy/core-runtime';
import { KeyedOutcomes } from '@canopy/core-runtime/node/operations';
import type { SaveSharedContainerFileScopeResponse } from '@canopy/desktop-shared/types';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { getFeatureFlagService } from '../feature-flags';
import { isCoworkWorkspace } from '../lib/workspace-registry';
import {
  readSharedContainerFileScope,
  SharedContainerScopeWriteAbandonedError,
} from '../shared-containers/file-scope-store';
import {
  saveSharedContainerFileScope,
  SharedContainerForgedScopePathError,
} from '../shared-containers/file-scope-update';
import { buildSharedContainerSharePreview } from '../shared-containers/share-preview';
import type { DesktopInstructionDefinitions } from './desktop-instruction-definitions';
import type { DesktopQueryDefinitions } from './desktop-query-definitions';

/*
 * Registers the publisher side of a shared container on the desktop
 * dispatcher (CAN-6501 PR 6): core.publication.fileScope.get,
 * fileScope.update and preview.get over desktop's file-scope store and share
 * preview. The shared-containers save-file-scope and preview channels reach
 * them only through here.
 */

export interface CorePublicationSharedContainerAdapter {
  queries: Pick<
    CanopyDispatcherHandlerMap<DesktopQueryDefinitions>,
    'core.publication.fileScope.get' | 'core.publication.preview.get'
  >;
  instructions: Pick<
    CanopyDispatcherInstructionHandlerMap<DesktopInstructionDefinitions>,
    'core.publication.fileScope.update'
  >;
}

// Desktop's own gate and message (ipc/shared-containers.ts).
function assertSharedContainersEnabled(): void {
  if (
    !getFeatureFlagService().isEnabled(
      CLIENT_FEATURE_FLAGS.canopyDesktopSharedContainers.key,
    )
  )
    throw new CanopyOperationError({
      kind: 'capability_unavailable',
      message: 'Shared containers are disabled.',
      retry: { kind: 'never' },
    });
}

function keyReused(): CanopyOperationError {
  return new CanopyOperationError({
    kind: 'conflict',
    message: 'This idempotency key was used with other parameters.',
    retry: { kind: 'never' },
  });
}

export function createCorePublicationSharedContainerAdapter(): CorePublicationSharedContainerAdapter {
  // Only a refusal that offers a retry runs again under its key; a terminal
  // one, and a raw failure the dispatcher reports as internal, replays.
  // shortcut: a count cap, not a byte budget, on retained scopes; CAN-7633 adds the shared size budget.
  const saves = new KeyedOutcomes<SaveSharedContainerFileScopeResponse>({
    reusedError: keyReused,
    max: 16,
    // shortcut: a forgotten outcome also drops its key's params, so the same caller may reuse the key with other params; CAN-7515 keeps them.
    forget: (error): boolean =>
      error instanceof CanopyOperationError &&
      error.payload.retry.kind !== 'never',
  });
  return {
    queries: {
      'core.publication.fileScope.get': async (params) => {
        assertSharedContainersEnabled();
        return {
          fileScope: await readSharedContainerFileScope(
            params.projectId,
            params.worktreeId,
          ),
        };
      },
      'core.publication.preview.get': async (params) => {
        assertSharedContainersEnabled();
        // The IPC projection checks this too; a relay caller reaches only here.
        const expected = isCoworkWorkspace(params.projectId)
          ? 'COWORK_WORK_ENTRY'
          : 'CODE_WORKTREE';
        if (params.containerType !== expected)
          throw new CanopyOperationError({
            kind: 'invalid_argument',
            message: 'containerType does not match project type',
            retry: { kind: 'never' },
          });
        // shortcut: no reply byte budget, so a large preview can pass the relay's 1 MiB reply limit (resource_exhausted); CAN-7665 keeps it under.
        return await buildSharedContainerSharePreview(params);
      },
    },
    instructions: {
      'core.publication.fileScope.update': async (params, context) => {
        assertSharedContainersEnabled();
        return await saves.run(context, params, () =>
          saveSharedContainerFileScope(params, context.signal).catch(
            (error: unknown) => {
              // A save abandoned before its write committed is forgotten, so
              // its key runs again; a committed one stays cached and replays.
              if (error instanceof SharedContainerScopeWriteAbandonedError)
                throw new CanopyOperationError({
                  kind: 'cancelled',
                  message: 'The scope save was abandoned.',
                  retry: { kind: 'same_idempotency_key' },
                });
              if (error instanceof SharedContainerForgedScopePathError)
                throw new CanopyOperationError({
                  kind: 'invalid_argument',
                  message: error.message,
                  retry: { kind: 'never' },
                });
              throw error;
            },
          ),
        );
      },
    },
  };
}

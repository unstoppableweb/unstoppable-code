import path from 'node:path';
import {
  EXTERNAL_PROJECT_PROVIDERS,
  IPC_CHANNELS,
  type ExternalProjectDiscoverRequest,
  type ExternalProjectDiscoverResponse,
  type ExternalProjectImportInviteState,
  type ExternalProjectImportRequest,
  type ExternalProjectImportResponse,
  type ExternalProjectProvider,
  type ExternalProjectProviderPresence,
} from '@canopy/desktop-shared/types';
import { discoverExternalProjects } from '../external-projects/discovery';
import { importExternalProjects } from '../external-projects/import';
import {
  readExternalProjectImportInvite,
  readProviderPresenceByProvider,
} from '../external-projects/invite';
import { markExternalProjectInviteShown } from '../external-projects/ledger';
import { chooseDirectoryForEvent } from '../lib/dialog-window';
import { isRecord } from '../lib/type-guards';
import { validateId } from '../lib/validation';
import { registerIpcHandler } from './register';

/**
 * IPC surface for the bulk Claude/Codex project import (CAN-2439). Discovery
 * and import both run in the main process; the renderer only ever sees
 * candidate summaries and per-item results. See
 * docs/external-project-import.md.
 */

/** Folder-picker roots accepted per scan; each one costs a realpath and a git probe. */
const MAX_CUSTOM_ROOTS = 50;

function normalizeDiscoverRequest(
  request: unknown,
): ExternalProjectDiscoverRequest {
  if (!isRecord(request)) return {};
  const providers = Array.isArray(request.providers)
    ? request.providers.filter(
        (provider): provider is ExternalProjectProvider =>
          EXTERNAL_PROJECT_PROVIDERS.some((known) => known === provider),
      )
    : undefined;
  const customRoots = Array.isArray(request.customRoots)
    ? request.customRoots
        .filter(
          (root): root is string =>
            typeof root === 'string' && path.isAbsolute(root),
        )
        .slice(0, MAX_CUSTOM_ROOTS)
    : undefined;
  return {
    ...(providers ? { providers } : {}),
    ...(customRoots ? { customRoots } : {}),
  };
}

function normalizeImportRequest(
  request: unknown,
): ExternalProjectImportRequest {
  if (!isRecord(request) || typeof request.scanId !== 'string') {
    throw new Error('An import request needs the scan it refers to');
  }
  validateId(request.scanId, 'scanId');
  if (!Array.isArray(request.selections)) {
    throw new Error('An import request needs at least one selected project');
  }
  const selections = request.selections.flatMap((selection) => {
    if (!isRecord(selection) || typeof selection.candidateId !== 'string') {
      return [];
    }
    validateId(selection.candidateId, 'candidateId');
    return [
      {
        candidateId: selection.candidateId,
        importChats: selection.importChats === true,
      },
    ];
  });
  if (selections.length === 0) {
    throw new Error('An import request needs at least one selected project');
  }
  return { scanId: request.scanId, selections };
}

export function registerExternalProjectHandlers(): void {
  registerIpcHandler<[unknown], ExternalProjectDiscoverResponse>(
    IPC_CHANNELS.externalProjectsDiscover,
    (_event, request) =>
      discoverExternalProjects(normalizeDiscoverRequest(request)),
  );

  registerIpcHandler<[unknown], ExternalProjectImportResponse>(
    IPC_CHANNELS.externalProjectsImport,
    (_event, request) =>
      importExternalProjects(normalizeImportRequest(request)),
  );

  registerIpcHandler<[], string | null>(
    IPC_CHANNELS.externalProjectsPickFolder,
    (event) => chooseDirectoryForEvent(event, 'Choose a project folder'),
  );

  registerIpcHandler<[], ExternalProjectImportInviteState>(
    IPC_CHANNELS.externalProjectsReadInvite,
    () => readExternalProjectImportInvite(),
  );

  registerIpcHandler<[], ExternalProjectProviderPresence>(
    IPC_CHANNELS.externalProjectsProviderPresence,
    async () => {
      const providers = await readProviderPresenceByProvider();
      return {
        providerStoresPresent: Object.values(providers).some(Boolean),
        providers,
      };
    },
  );

  registerIpcHandler<[], void>(
    IPC_CHANNELS.externalProjectsAcknowledgeInvite,
    async () => {
      await markExternalProjectInviteShown();
    },
  );
}

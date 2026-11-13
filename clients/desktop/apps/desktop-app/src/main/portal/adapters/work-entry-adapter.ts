import type {
  PortalCommandEnvelope,
  PortalWorkEntryDeletePayload,
  PortalWorkEntryUpdatePayload,
} from '@canopy/protocol/portal';
import {
  deleteWorkEntryMutation,
  updateWorkEntryMutation,
} from '../../lib/work-entry-mutations';
import { resolveCoworkWorkspaceId } from '../../lib/cowork-migration-map';
import { isCoworkWorkspace } from '../../lib/workspace-registry';
import { listWorkEntries } from '../../lib/cowork-work-entries';
import { validateId } from '../../lib/validation';
import { PortalServiceError } from '../../services/portal-service-error';
import type { PortalAdapterContext } from './types';
import { failServiceError, isRecord } from './validation';

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function validatePortalId(value: string, label: string): void {
  try {
    validateId(value, label);
  } catch (error) {
    throw new PortalServiceError(
      'invalid_payload',
      error instanceof Error ? error.message : `Invalid ${label}.`,
    );
  }
}

function readPortalWorkEntryUpdatePayload(
  input: unknown,
): PortalWorkEntryUpdatePayload {
  if (
    !isRecord(input) ||
    !hasOnlyKeys(input, ['projectLocalId', 'entryId', 'title']) ||
    typeof input.projectLocalId !== 'string' ||
    typeof input.entryId !== 'string' ||
    !Object.prototype.hasOwnProperty.call(input, 'title') ||
    (input.title !== null && typeof input.title !== 'string')
  ) {
    throw new PortalServiceError(
      'invalid_payload',
      'Invalid Work Entry update payload.',
    );
  }

  const projectLocalId = input.projectLocalId;
  const entryId = input.entryId;
  const title = input.title;
  validatePortalId(projectLocalId, 'projectLocalId');
  validatePortalId(entryId, 'entryId');
  return {
    projectLocalId,
    entryId,
    title: title === null || title.trim().length === 0 ? null : title,
  };
}

function readPortalWorkEntryDeletePayload(
  input: unknown,
): PortalWorkEntryDeletePayload {
  if (
    !isRecord(input) ||
    !hasOnlyKeys(input, ['projectLocalId', 'entryId', 'archive']) ||
    typeof input.projectLocalId !== 'string' ||
    typeof input.entryId !== 'string' ||
    typeof input.archive !== 'boolean'
  ) {
    throw new PortalServiceError(
      'invalid_payload',
      'Invalid Work Entry delete payload.',
    );
  }

  const projectLocalId = input.projectLocalId;
  const entryId = input.entryId;
  validatePortalId(projectLocalId, 'projectLocalId');
  validatePortalId(entryId, 'entryId');
  return { projectLocalId, entryId, archive: input.archive };
}

async function resolveLiveCoworkEntry(payload: {
  projectLocalId: string;
  entryId: string;
}): Promise<string> {
  const workspaceId = resolveCoworkWorkspaceId(payload.projectLocalId);
  if (!isCoworkWorkspace(workspaceId)) {
    throw new PortalServiceError('not_found', 'Project not found.');
  }
  const entries = await listWorkEntries(workspaceId);
  if (!entries.some((entry) => entry.id === payload.entryId)) {
    throw new PortalServiceError('not_found', 'Work Entry not found.');
  }
  return workspaceId;
}

/** Update a Work Entry through the same mutation lifecycle as its IPC API. */
export async function handlePortalWorkEntryUpdate(
  command: PortalCommandEnvelope<unknown>,
  context: PortalAdapterContext,
): Promise<void> {
  try {
    const payload = readPortalWorkEntryUpdatePayload(command.payload);
    const projectId = await resolveLiveCoworkEntry(payload);
    await updateWorkEntryMutation({
      projectId,
      entryId: payload.entryId,
      title: payload.title,
    });
    context.complete(command);
  } catch (error) {
    failServiceError(command, context, error);
  }
}

/** Delete or archive a Work Entry through the same fenced IPC lifecycle. */
export async function handlePortalWorkEntryDelete(
  command: PortalCommandEnvelope<unknown>,
  context: PortalAdapterContext,
): Promise<void> {
  try {
    const payload = readPortalWorkEntryDeletePayload(command.payload);
    const projectId = await resolveLiveCoworkEntry(payload);
    const result = await deleteWorkEntryMutation({
      projectId,
      entryId: payload.entryId,
      ...(payload.archive ? { lockAfterArchive: true } : {}),
    });
    context.complete(command, result);
  } catch (error) {
    failServiceError(command, context, error);
  }
}

import { readCoworkFolderMissing } from '@canopy/protocol/canopy-core';
import type { PortalCommandEnvelope } from '@canopy/desktop-shared/types';
import type { PortalAdapterContext } from './types';
import {
  isModelGatewayRefusal,
  ModelGatewayRefusedError,
} from '../../lib/model-gateway-refusal';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function requireWorktreeTarget(
  command: PortalCommandEnvelope,
  context: PortalAdapterContext,
): { workspaceLocalId: string; worktreeLocalId: string } | null {
  const target = command.target;
  if (
    !target ||
    typeof target.workspaceLocalId !== 'string' ||
    typeof target.worktreeLocalId !== 'string'
  ) {
    context.fail(
      command,
      'invalid_target',
      'Portal command requires workspaceLocalId and worktreeLocalId target fields.',
    );
    return null;
  }
  return {
    workspaceLocalId: target.workspaceLocalId,
    worktreeLocalId: target.worktreeLocalId,
  };
}

export function requireStandaloneChatTarget(
  command: PortalCommandEnvelope,
  context: PortalAdapterContext,
): { standaloneChatLocalId: string } | null {
  const target = command.target;
  if (!target || typeof target.standaloneChatLocalId !== 'string') {
    context.fail(
      command,
      'invalid_target',
      'Portal command requires standaloneChatLocalId target field.',
    );
    return null;
  }
  return { standaloneChatLocalId: target.standaloneChatLocalId };
}

export function failServiceError(
  command: PortalCommandEnvelope,
  context: PortalAdapterContext,
  error: unknown,
): void {
  const missing = readCoworkFolderMissing(error);
  if (missing) {
    context.fail(command, missing.code, missing.message, false, {
      coworkFolderMissing: missing,
    });
    return;
  }
  // Refused before anything was saved, for a stable reason. The top-level
  // code stays in the closed Portal set; the reason rides in `response`, so
  // the web composer needs no sentence matching (CAN-6701).
  if (isModelGatewayRefusal(error)) {
    context.fail(command, 'invalid_payload', error.message, false, {
      response: { code: error.code, message: error.message },
    });
    return;
  }
  // After saving, the session gate's refusal is a turn failure, mapped as it
  // was before CAN-6701; it never carries the pre-save reason.
  if (error instanceof ModelGatewayRefusedError) {
    context.fail(command, 'execution_failed', error.message, false);
    return;
  }
  if (error instanceof Error) {
    const code: unknown = 'code' in error ? error.code : undefined;
    if (typeof code === 'string') {
      context.fail(command, code, error.message, false);
      return;
    }
  }
  context.fail(
    command,
    'execution_failed',
    error instanceof Error ? error.message : String(error),
    false,
  );
}

import { joinW5RootPresence } from '@canopy/desktop-shared/node/w5-root-presence';
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { acquireW5DesktopDeleteGate } from '@canopy/core-platform/w5-process-file-lock';
import { W5HostCohortRefusedError } from '@canopy/execution-engine/node/w5-host-cohort';

type DesktopW5HostAdmission =
  | { readonly kind: 'admitted' }
  | {
      readonly kind: 'refused';
      readonly message: string;
      readonly error: W5HostCohortRefusedError;
    };
let startup: Promise<DesktopW5HostAdmission> | undefined;
// Presence is process-lifetime, independent of renderer reloads and daemon leases.
const deletionPresence = new Map<string, Promise<{ close(): void }>>();
function property(value: unknown, name: string): unknown {
  return typeof value === 'object' && value !== null
    ? Reflect.get(value, name)
    : undefined;
}
export async function admitDesktopDeletionPresence(
  dataRoot: string,
): Promise<void> {
  const root = await realpath(dataRoot).catch((error: unknown) => {
    if (property(error, 'code') !== 'ENOENT') throw error;
    return resolve(dataRoot);
  });
  let admission = deletionPresence.get(root);
  if (!admission) {
    admission = acquireW5DesktopDeleteGate(root, 'desktop');
    deletionPresence.set(root, admission);
  }
  try {
    await admission;
  } catch (error) {
    if (deletionPresence.get(root) === admission) deletionPresence.delete(root);
    throw error;
  }
}

async function admitRoot(dataRoot: string): Promise<DesktopW5HostAdmission> {
  try {
    await admitDesktopDeletionPresence(dataRoot);
    await joinW5RootPresence(dataRoot, 'electron');
    return { kind: 'admitted' };
  } catch (cause) {
    const error = new W5HostCohortRefusedError('runtime-unavailable', cause);
    return {
      kind: 'refused',
      error,
      message: cause instanceof Error ? cause.message : error.message,
    };
  }
}
/** Permanent deletion/root presence only; no legacy registration or unregistered-writer bypass. */
export function admitDesktopW5Host(
  dataRoot: string,
): Promise<DesktopW5HostAdmission> {
  startup ??= admitRoot(dataRoot);
  return startup;
}

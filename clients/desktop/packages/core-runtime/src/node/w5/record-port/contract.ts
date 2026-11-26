import { isAbsolute, join, relative, sep } from 'node:path';
import type {
  CoreWorkspaceRecordsCaptureResult,
  CoreWorkspaceRecordsCommitParams,
  CoreWorkspaceRecordsCommitResult,
  CoreWorkspaceRecordsFailureDiagnostics,
  CoreWorkspaceRecordsReceipt,
  CoreWorkspaceRecordsReceiptLookup,
  CoreWorkspaceRecordsRecovery,
  CoreWorkspaceRecordsReservationList,
  CoreWorkspaceRecordsReserveParams,
} from '@canopy/protocol/canopy-core';
import type { GuardedStorageNamespace } from '../../../storage';
import {
  isW5CaptureFile,
  isW5CaptureWorkspaceId,
  w5CaptureFileComponents,
  type W5CaptureFile,
  type W5CaptureRequest,
} from '../commit-log/capture-contract';
import type { W5Resource } from '../commit-log/commit-log';

/*
 * The trusted W5 record port (W6g, CAN-5498): the contract between a host's
 * daemon-backed commit-log store and the daemon authority that decides. Wire
 * values name W5 files by target only; each side projects targets onto its
 * own root (DQ-7). Only the opaque payloads `W5RecordPortTransport` names can
 * carry a host path.
 */

const ROOT_FILES: Readonly<Record<string, W5CaptureFile>> = {
  'index.json': { kind: 'index' },
  'index.json.bak': { kind: 'index-backup' },
};
const WORKSPACE_FILES = {
  'workspace.json': 'manifest',
  'worktrees.json': 'worktrees',
} as const;

function isWorkspaceFileName(
  name: string,
): name is keyof typeof WORKSPACE_FILES {
  return Object.prototype.hasOwnProperty.call(WORKSPACE_FILES, name);
}

/** The W5 file `path` names under `root`, or undefined for any other path. */
export function w5RecordTargetFor(
  root: string,
  path: string,
): W5CaptureFile | undefined {
  const rest = relative(root, path);
  if (!rest || isAbsolute(rest)) return undefined;
  const [first = '', name, ...more] = rest.split(sep);
  const file: unknown =
    name === undefined
      ? Object.prototype.hasOwnProperty.call(ROOT_FILES, first)
        ? { ...ROOT_FILES[first] }
        : undefined
      : more.length === 0 && isWorkspaceFileName(name)
        ? { kind: WORKSPACE_FILES[name], workspaceId: first }
        : undefined;
  // Exactly the projected path: no `..`, separator or case alias.
  return isW5CaptureFile(file) && w5RecordPathFor(root, file) === path
    ? file
    : undefined;
}

/**
 * The workspace file `path` names under `root` when its workspace id is
 * outside the capture grammar (capture `unsupported-id`), so no target can
 * name it; undefined for a nameable or any other path.
 */
export function w5UnnameableRecordFor(
  root: string,
  path: string,
): { kind: 'manifest' | 'worktrees'; workspaceId: string } | undefined {
  const rest = relative(root, path);
  if (!rest || isAbsolute(rest)) return undefined;
  const [first = '', name, ...more] = rest.split(sep);
  if (
    name === undefined ||
    more.length > 0 ||
    !isWorkspaceFileName(name) ||
    first === '.' ||
    first === '..' ||
    isW5CaptureWorkspaceId(first)
  )
    return undefined;
  // Exactly the projected path, as `w5RecordTargetFor` requires.
  return join(root, first, name) === path
    ? { kind: WORKSPACE_FILES[name], workspaceId: first }
    : undefined;
}

export function w5RecordPathFor(root: string, target: W5CaptureFile): string {
  return join(root, ...w5CaptureFileComponents(target));
}

export function w5RecordNamespace(
  target: W5CaptureFile,
): GuardedStorageNamespace {
  switch (target.kind) {
    case 'index':
    case 'index-backup':
      return 'workspace_index';
    case 'manifest':
      return 'workspace_manifest';
    case 'worktrees':
      return 'worktree_list';
  }
}

/** The namespace whose file carries `resource`'s revision. */
export function w5ResourceNamespace(
  resource: W5Resource,
): GuardedStorageNamespace {
  switch (resource.kind) {
    case 'workspaces':
      return 'workspace_index';
    case 'workspace':
      return 'workspace_manifest';
    case 'worktrees':
    case 'worktree':
      return 'worktree_list';
  }
}

/**
 * The calls a host's record port makes to its authority. A host composes it
 * over its own client; results are validated again by the port.
 *
 * DQ-7 reading (i): record images, reservation `diagnostics` text and saved
 * keyed outcomes are opaque payloads that only the trusted host adapter builds
 * and reads, so they can name its paths; the authority never resolves or
 * projects one. No health or expose-* decision rides in them: images carry a
 * row's persisted `healthIssue` as record content, and outcome decoders drop
 * it. Revisit if the daemon must read one; see the CAN-5506 behavior inventory.
 */
export interface W5RecordPortTransport {
  capture(
    request: W5CaptureRequest,
    signal?: AbortSignal,
  ): Promise<CoreWorkspaceRecordsCaptureResult>;
  recovery(): Promise<CoreWorkspaceRecordsRecovery>;
  commit(
    request: CoreWorkspaceRecordsCommitParams,
  ): Promise<CoreWorkspaceRecordsCommitResult>;
  /** Keyed admission and reservations (CAN-5506). */
  lookupReceipt(
    receipt: CoreWorkspaceRecordsReceipt,
  ): Promise<CoreWorkspaceRecordsReceiptLookup>;
  listReservations(): Promise<CoreWorkspaceRecordsReservationList>;
  reserve(params: CoreWorkspaceRecordsReserveParams): Promise<void>;
  updateReservationDiagnostics(params: {
    reservationId: string;
    diagnostics: string;
  }): Promise<void>;
  releaseReservation(reservationId: string): Promise<void>;
  markReservationRecoveryRequired(params: {
    reservationId: string;
    diagnostics: CoreWorkspaceRecordsFailureDiagnostics;
  }): Promise<void>;
}

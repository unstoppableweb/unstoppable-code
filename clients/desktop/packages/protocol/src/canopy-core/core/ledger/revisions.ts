import type {
  LedgerAttribution,
  LedgerEntry,
  LedgerMutation,
  LedgerOrigin,
  LedgerScopeRef,
} from './schemas';
import type { LedgerOwnerChange, LedgerStatusChange } from './policy';

/*
 * The shape of an entry revision and the mutation that records it: what a
 * creation starts an entry with, and what a change carries forward. Every
 * Ledger writer builds its revisions with these, so a revision means the
 * same whoever wrote it: the desktop store (`LedgerRepository`) and the web
 * core's cloud writer (CAN-6422). Each writer validates the result with the
 * protocol schemas and stores it its own way.
 */

/** What a new entry is made of, before the writer places it. */
export type LedgerNewEntryFields = Omit<
  LedgerEntry,
  | 'schemaVersion'
  | 'entryId'
  | 'scope'
  | 'createdAt'
  | 'updatedAt'
  | 'revision'
  | 'parentEntryId'
>;

/** A revision's change: each part null when it stays as it was. */
export interface LedgerEntryChange {
  readonly status: LedgerStatusChange | null;
  readonly owner: LedgerOwnerChange | null;
  readonly parent: {
    readonly from: string | null;
    readonly to: string | null;
  } | null;
}

/** The later of two timestamps, so `updatedAt` never moves backwards. */
export function laterLedgerTimestamp(
  candidate: string,
  previous: string,
): string {
  return Date.parse(candidate) >= Date.parse(previous) ? candidate : previous;
}

/** An entry's first revision and the creation that records it. */
export function buildLedgerCreation(input: {
  readonly scope: LedgerScopeRef;
  readonly fields: LedgerNewEntryFields;
  readonly entryId: string;
  readonly mutationId: string;
  readonly createdAt: string;
  readonly parentEntryId: string | undefined;
}): { readonly entry: LedgerEntry; readonly mutation: LedgerMutation } {
  const { fields } = input;
  const entry: LedgerEntry = {
    schemaVersion: 1,
    entryId: input.entryId,
    scope: input.scope,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    revision: 1,
    author: fields.author,
    authorDetails: fields.authorDetails,
    owner: fields.owner,
    type: fields.type,
    title: fields.title,
    content: fields.content,
    highlights: fields.highlights,
    referenceFiles: fields.referenceFiles,
    status: fields.status,
    origin: fields.origin,
    attribution: fields.attribution,
    ...(fields.supersedesEntryId === undefined
      ? {}
      : { supersedesEntryId: fields.supersedesEntryId }),
    ...(input.parentEntryId === undefined
      ? {}
      : { parentEntryId: input.parentEntryId }),
  };
  return {
    entry,
    mutation: {
      mutationId: input.mutationId,
      entryId: entry.entryId,
      kind: 'create',
      revision: 1,
      previousRevision: null,
      occurredAt: input.createdAt,
      status: { from: null, to: entry.status },
      owner: { from: null, to: entry.owner },
      attribution: entry.attribution,
      invocationOrigin: entry.origin,
    },
  };
}

/**
 * The next revision of `previous` under `change`, and the update that
 * records it. `now` is the writer's clock; the revision's time never moves
 * before the previous one's.
 */
export function buildLedgerRevision(input: {
  readonly previous: LedgerEntry;
  readonly change: LedgerEntryChange;
  readonly mutationId: string;
  readonly now: string;
  readonly attribution: LedgerAttribution;
  readonly invocationOrigin: LedgerOrigin;
  readonly leftOpen?: NonNullable<LedgerMutation['leftOpen']>;
}): { readonly entry: LedgerEntry; readonly mutation: LedgerMutation } {
  const { previous, change } = input;
  const updatedAt = laterLedgerTimestamp(input.now, previous.updatedAt);
  const { parentEntryId: previousParent, ...rest } = previous;
  const parentEntryId =
    change.parent === null ? previousParent : (change.parent.to ?? undefined);
  const entry: LedgerEntry = {
    ...rest,
    revision: previous.revision + 1,
    updatedAt,
    status: change.status?.to ?? previous.status,
    owner: change.owner?.to ?? previous.owner,
    ...(parentEntryId === undefined ? {} : { parentEntryId }),
  };
  return {
    entry,
    mutation: {
      mutationId: input.mutationId,
      entryId: entry.entryId,
      kind: 'update',
      revision: entry.revision,
      previousRevision: previous.revision,
      occurredAt: updatedAt,
      ...(change.status === null ? {} : { status: change.status }),
      ...(change.owner === null ? {} : { owner: change.owner }),
      ...(change.parent === null ? {} : { parent: change.parent }),
      ...(input.leftOpen === undefined ? {} : { leftOpen: input.leftOpen }),
      attribution: input.attribution,
      invocationOrigin: input.invocationOrigin,
    },
  };
}

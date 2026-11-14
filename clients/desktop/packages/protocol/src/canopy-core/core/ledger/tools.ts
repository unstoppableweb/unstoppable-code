import { z } from 'zod';

import type { LedgerEntriesSearchResult } from './operations';
import type {
  LedgerActorKind,
  LedgerActorRef,
  LedgerAttributionKind,
  LedgerEntry,
  LedgerEntrySearchItem,
  LedgerEntryType,
  LedgerErrorDetails,
  LedgerFileRef,
  LedgerOwnerCandidatePage,
  LedgerSourceAvailability,
  LedgerStatus,
} from './schemas';
import {
  LedgerAddEntryToolInputSchema,
  LedgerSearchEntriesToolInputSchema,
  LedgerUpdateEntryToolInputSchema,
} from './schemas';

/*
 * The Feed (Agent Ledger) tools as agents see them, defined once for every
 * host that serves them: AddFeedEntry, SearchFeedEntries and UpdateFeedEntry.
 * This module owns their descriptions, their advertised JSON Schemas (derived
 * from the tool input schemas beside it), and the text each call returns:
 * argument errors, receipts, search pages, refusals and the unavailable
 * answer. Desktop's tools runtime (`@canopy/execution-engine`) and the cloud
 * agent-actions surface (`@canopy/agent-actions`) both render through it, so
 * a model sees the same tool on every host (CAN-6313).
 */

/** What a Feed tool call returns to the agent. */
export interface LedgerToolTextResult {
  text: string;
  isError?: boolean;
}

/** JSON data, as a tool's advertised schema is written. */
export type LedgerToolJsonValue =
  | string
  | number
  | boolean
  | null
  | LedgerToolJsonValue[]
  | { [key: string]: LedgerToolJsonValue };

/** The names the descriptions use for a host's Feed tools. */
export interface LedgerToolDescriptionNames {
  /** The product name, such as the brand's display name. */
  readonly appName: string;
  /** SearchFeedEntries' Codex dynamic-tool name, named beside it. */
  readonly searchCodexToolName: string;
}

const LEDGER_PLAN_MODE_TOOL_NOTE =
  'Allowed in Plan mode as bookkeeping; it does not edit files or run commands.';

export function addLedgerEntryToolDescription(
  names: LedgerToolDescriptionNames,
): string {
  return `Add one entry to this chat's Feed, a concise record of noteworthy work for future readers. Plan with one OPERATION per independent work line. Use parentEntryId to put TASKs under operations and subtasks under tasks (operation > task > subtask); ACTION, DECISION and OBSERVATION entries may also sit under an operation or task. Operations are top-level. Use TASK for scoped, multi-step work (default status TODO), ACTION for a significant or unexpected action (default IN_PROGRESS), and DECISION or OBSERVATION for a choice or useful finding (default INFO). Keep the title and content brief; put extensive notes in files and list them in referenceFiles. owner defaults to "self"; to assign another owner, pass { actorId, eligibilityToken } from SearchFeedEntries / ${names.searchCodexToolName} with includeAssignableOwners. Set supersedesEntryId to record a correction to an earlier entry. After an uncertain failure, retry with the same requestKey or search for the entry first. ${names.appName} records the scope, author and time. ${LEDGER_PLAN_MODE_TOOL_NOTE}`;
}

export const SEARCH_LEDGER_ENTRIES_TOOL_DESCRIPTION = `Search this chat's Feed. Filter by query words, entryIds (up to 25), owner or author ("self" or { actorId }), types, statuses, attribution, and created/updated time bounds; sort by created_desc (default) or updated_desc; page with limit (default 30, maximum 100) and cursor. Use parentEntryId for direct children or null for top-level entries, rootEntryId for an entry and its whole subtree, and authorIn for entries by any listed author. At the start of a turn or resumed task, search with owner "self" and statuses TODO, IN_PROGRESS, BLOCKED and NEEDS_REVIEW. Results include each entry's revision for UpdateFeedEntry. Set includeAssignableOwners to also list the owners you can assign, with eligibility tokens (page them with ownersCursor). Read-only.`;

export function updateLedgerEntryToolDescription(
  names: LedgerToolDescriptionNames,
): string {
  return `Change the status, owner and/or parent of an open entry in this chat's Feed that you own. Pass entryId and the expectedRevision you last read. Use parentEntryId to move it in the operation > task > subtask hierarchy or null to make it top-level. Nothing else about an entry can change, and Completed, Failed and Info entries cannot change at all: add a new entry with supersedesEntryId for a correction. Closing an entry with open children requires openChildren: complete, fail or detach; detach moves the open children and their subtrees to top level. If the entry changed since you read it, the current entry is returned instead: reconsider before retrying rather than overwriting. owner accepts "self" or { actorId, eligibilityToken } from SearchFeedEntries / ${names.searchCodexToolName} with includeAssignableOwners; assignment records responsibility and does not start another session. After an uncertain failure, retry with the same requestKey or search first. ${LEDGER_PLAN_MODE_TOOL_NOTE}`;
}

const LEDGER_OWNER_TARGET_DESCRIPTION =
  '"self", or { actorId, eligibilityToken } from SearchFeedEntries with includeAssignableOwners.';
const LEDGER_REQUEST_KEY_DESCRIPTION =
  'Optional retry key (1–128 characters). Reuse it only to retry this same request after an uncertain failure.';

const ADD_LEDGER_ENTRY_PROPERTY_DESCRIPTIONS: Readonly<Record<string, string>> =
  {
    type: 'OPERATION, TASK, ACTION, DECISION or OBSERVATION.',
    parentEntryId:
      'Parent operation or task ID; use the operation > task > subtask hierarchy.',
    title: 'Brief single-line title.',
    content: 'Brief plain-text details.',
    highlights: 'Optional short key points.',
    referenceFiles:
      'Files that hold longer notes: { rootId, path, startLine? } with path relative to the root.',
    status:
      'Initial status. Defaults to TODO for OPERATION and TASK, IN_PROGRESS for ACTION, and INFO for DECISION or OBSERVATION.',
    owner: LEDGER_OWNER_TARGET_DESCRIPTION,
    supersedesEntryId: 'The earlier entry this one corrects.',
    requestKey: LEDGER_REQUEST_KEY_DESCRIPTION,
  };

const SEARCH_LEDGER_ENTRIES_PROPERTY_DESCRIPTIONS: Readonly<
  Record<string, string>
> = {
  query: 'Words that must all match, each by the start of a word.',
  entryIds: 'Exact entry IDs.',
  owner: '"self" or { actorId }.',
  author: '"self" or { actorId }.',
  types: 'Match any of these entry types.',
  statuses: 'Match any of these statuses.',
  attribution: 'Match any of these attribution kinds.',
  createdAfter: 'ISO 8601 lower bound on creation time.',
  createdBefore: 'ISO 8601 upper bound on creation time.',
  updatedAfter: 'ISO 8601 lower bound on the last change.',
  updatedBefore: 'ISO 8601 upper bound on the last change.',
  sort: 'created_desc (default) or updated_desc.',
  limit: 'Entries per page (default 30).',
  cursor: 'nextCursor from the previous page of the same search.',
  includeAssignableOwners:
    'Also list the owners you can assign, with eligibility tokens.',
  ownersCursor: 'owners.nextCursor from the previous owners page.',
  parentEntryId:
    'Find the direct children of this entry; use null for top-level entries.',
  rootEntryId: 'Return this entry and its full subtree.',
  authorIn: 'Match entries authored by any of these actor IDs.',
};

const UPDATE_LEDGER_ENTRY_PROPERTY_DESCRIPTIONS: Readonly<
  Record<string, string>
> = {
  entryId: 'The entry to change.',
  expectedRevision: 'The revision you last read.',
  status: 'New status.',
  owner: LEDGER_OWNER_TARGET_DESCRIPTION,
  parentEntryId:
    'Set the new parent entry ID, or null to move this entry to the top level.',
  openChildren:
    'When closing a parent with open children, choose complete, fail or detach; detach moves them and their subtrees to the top level.',
  requestKey: LEDGER_REQUEST_KEY_DESCRIPTION,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Rebuilds a generated JSON Schema as plain JSON, dropping what only adds
 * noise to a tool prompt: the `$schema` marker, the long UUID regex that
 * accompanies `format: "uuid"`, and safe-integer bounds.
 */
function toAdvisoryJsonSchema(value: unknown): LedgerToolJsonValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) {
    return value.map(
      (item: unknown): LedgerToolJsonValue => toAdvisoryJsonSchema(item),
    );
  }
  if (!isRecord(value)) return null;
  const hasFormat = typeof value.format === 'string';
  const result: { [key: string]: LedgerToolJsonValue } = {};
  for (const [key, member] of Object.entries(value)) {
    if (member === undefined || key === '$schema') continue;
    if (key === 'pattern' && hasFormat) continue;
    if (key === 'maximum' && member === Number.MAX_SAFE_INTEGER) continue;
    if (key === 'minimum' && member === Number.MIN_SAFE_INTEGER) continue;
    result[key] = toAdvisoryJsonSchema(member);
  }
  return result;
}

/**
 * A Feed tool's advertised JSON Schema, derived from its protocol schema.
 * JSON Schema is advisory to the model; the protocol schema stays the
 * authority when the call runs.
 */
function ledgerToolJsonSchema(
  schema: z.ZodType,
  propertyDescriptions: Readonly<Record<string, string>>,
): { [key: string]: LedgerToolJsonValue } {
  const generated = toAdvisoryJsonSchema(
    z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }),
  );
  if (
    generated === null ||
    typeof generated !== 'object' ||
    Array.isArray(generated)
  ) {
    return { type: 'object' };
  }
  const properties = generated.properties;
  if (
    properties === null ||
    typeof properties !== 'object' ||
    Array.isArray(properties)
  ) {
    return generated;
  }
  const described: { [key: string]: LedgerToolJsonValue } = {};
  for (const [name, property] of Object.entries(properties)) {
    const description = propertyDescriptions[name];
    described[name] =
      description !== undefined &&
      property !== null &&
      typeof property === 'object' &&
      !Array.isArray(property)
        ? { ...property, description }
        : property;
  }
  return { ...generated, properties: described };
}

export const ADD_LEDGER_ENTRY_TOOL_JSON_SCHEMA = ledgerToolJsonSchema(
  LedgerAddEntryToolInputSchema,
  ADD_LEDGER_ENTRY_PROPERTY_DESCRIPTIONS,
);

export const SEARCH_LEDGER_ENTRIES_TOOL_JSON_SCHEMA = ledgerToolJsonSchema(
  LedgerSearchEntriesToolInputSchema,
  SEARCH_LEDGER_ENTRIES_PROPERTY_DESCRIPTIONS,
);

export const UPDATE_LEDGER_ENTRY_TOOL_JSON_SCHEMA = ledgerToolJsonSchema(
  LedgerUpdateEntryToolInputSchema,
  UPDATE_LEDGER_ENTRY_PROPERTY_DESCRIPTIONS,
);

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/** Why a session has no usable Feed tools (E05). */
export type LedgerToolsUnavailableReason =
  | 'ledger_disabled'
  | 'agent_recording_off'
  | 'no_ledger_scope'
  | 'ledger_runtime_unavailable'
  | 'session_ended';

/** What the agent is told for each unavailable reason. */
export const LEDGER_TOOLS_UNAVAILABLE_MESSAGES: {
  readonly [Reason in LedgerToolsUnavailableReason]: string;
} = {
  ledger_disabled: 'The Feed is not available. Continue without recording.',
  agent_recording_off:
    '"Agents add to the Feed" is turned off in Settings. Continue without recording.',
  no_ledger_scope: 'This chat has no Feed. Continue without recording.',
  ledger_runtime_unavailable:
    'The Feed is not available right now. Continue without recording.',
  session_ended:
    'The Feed is not available right now. Continue without recording.',
};

/** The result a Feed tool returns when the Feed is unavailable. */
export function ledgerUnavailableResult(
  reason: LedgerToolsUnavailableReason,
): LedgerToolTextResult {
  return {
    text: JSON.stringify({
      ok: false,
      error: {
        code: 'FEED_UNAVAILABLE',
        reason,
        message: LEDGER_TOOLS_UNAVAILABLE_MESSAGES[reason],
      },
    }),
    isError: true,
  };
}

/** The display names argument errors use for each Feed tool. */
export type LedgerToolDisplayName =
  | 'AddFeedEntry'
  | 'SearchFeedEntries'
  | 'UpdateFeedEntry';

export type ParsedLedgerToolArgs<Output> =
  | { readonly success: true; readonly data: Output }
  | { readonly success: false; readonly result: LedgerToolTextResult };

/** Validates a Feed tool's arguments, or the error the agent sees. */
export function parseLedgerToolArgs<Schema extends z.ZodType>(
  schema: Schema,
  rawArgs: unknown,
  toolName: LedgerToolDisplayName,
): ParsedLedgerToolArgs<z.output<Schema>> {
  const parsed = schema.safeParse(rawArgs ?? {});
  if (parsed.success) return { success: true, data: parsed.data };
  const details = parsed.error.issues.slice(0, 5).map((issue): string => {
    const path = issue.path.length > 0 ? issue.path.join('.') : 'input';
    return `${path}: ${issue.message}`;
  });
  return {
    success: false,
    result: {
      text: [
        `Invalid arguments for ${toolName}.`,
        ...details.map((line) => `- ${line}`),
      ].join('\n'),
      isError: true,
    },
  };
}

/** Keeps a tool result well inside provider tool-output limits. */
const MAX_RESULT_CHARACTERS = 40_000;

interface LedgerActorView {
  readonly actorId: string;
  readonly kind: LedgerActorKind;
  readonly isSelf?: true;
}

interface LedgerEntryView {
  readonly entryId: string;
  readonly revision: number;
  readonly type: LedgerEntryType;
  readonly status: LedgerStatus;
  readonly title: string;
  readonly content?: string;
  readonly highlights?: readonly string[];
  readonly referenceFiles?: readonly LedgerFileRef[];
  readonly owner: LedgerActorView;
  readonly author?: LedgerActorView;
  readonly attribution?: LedgerAttributionKind;
  readonly createdAt?: string;
  readonly updatedAt: string;
  readonly supersedesEntryId?: string;
  readonly parentEntryId?: string;
  readonly source?: LedgerSourceAvailability;
}

function projectActor(
  actor: LedgerActorRef,
  selfActorId: string | null,
): LedgerActorView {
  return actor.actorId === selfActorId
    ? { actorId: actor.actorId, kind: actor.kind, isSelf: true }
    : { actorId: actor.actorId, kind: actor.kind };
}

/** A receipt's entry, without the content its author just wrote. */
function projectEntry(
  entry: LedgerEntry,
  selfActorId: string | null,
): LedgerEntryView {
  return {
    entryId: entry.entryId,
    revision: entry.revision,
    type: entry.type,
    status: entry.status,
    title: entry.title,
    owner: projectActor(entry.owner, selfActorId),
    updatedAt: entry.updatedAt,
    ...(entry.supersedesEntryId === undefined
      ? {}
      : { supersedesEntryId: entry.supersedesEntryId }),
    ...(entry.parentEntryId === undefined
      ? {}
      : { parentEntryId: entry.parentEntryId }),
  };
}

function projectSearchItem(
  item: LedgerEntrySearchItem,
  selfActorId: string | null,
): LedgerEntryView {
  return {
    entryId: item.entryId,
    revision: item.revision,
    type: item.type,
    status: item.status,
    title: item.title,
    content: item.content,
    ...(item.highlights.length > 0 ? { highlights: item.highlights } : {}),
    ...(item.referenceFiles.length > 0
      ? { referenceFiles: item.referenceFiles }
      : {}),
    owner: projectActor(item.owner, selfActorId),
    author: projectActor(item.author, selfActorId),
    attribution: item.attributionKind,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    ...(item.supersedesEntryId === undefined
      ? {}
      : { supersedesEntryId: item.supersedesEntryId }),
    ...(item.parentEntryId === undefined
      ? {}
      : { parentEntryId: item.parentEntryId }),
    ...(item.sourceAvailability === 'available'
      ? {}
      : { source: item.sourceAvailability }),
  };
}

interface LedgerOwnerView {
  readonly actorId: string;
  readonly kind: LedgerActorKind;
  readonly displayName: string;
  readonly eligibilityToken: string;
  readonly isSelf: boolean;
}

function projectOwners(page: LedgerOwnerCandidatePage): {
  readonly candidates: readonly LedgerOwnerView[];
  readonly nextCursor: string | null;
} {
  return {
    candidates: page.candidates.map(
      (candidate): LedgerOwnerView => ({
        actorId: candidate.actor.actorId,
        kind: candidate.actor.kind,
        displayName: candidate.displayName,
        eligibilityToken: candidate.eligibilityToken,
        isSelf: candidate.isSelf,
      }),
    ),
    nextCursor: page.nextCursor,
  };
}

/**
 * A committed AddFeedEntry or UpdateFeedEntry: the entry without the content
 * its author just wrote, and an optional hint line after it.
 */
export function ledgerCommandResult(
  receipt: { readonly changed: boolean; readonly entry: LedgerEntry },
  selfActorId: string | null,
  additionalLine?: string,
): LedgerToolTextResult {
  return {
    text: `${JSON.stringify({
      ok: true,
      changed: receipt.changed,
      entry: projectEntry(receipt.entry, selfActorId),
    })}${additionalLine === undefined ? '' : `\n${additionalLine}`}`,
  };
}

/**
 * A bounded search result: entry projections without provenance detail, and
 * the owner page when requested. Entries past the size budget are dropped
 * from the end with a note, and the cursor with them, so nothing is skipped.
 */
export function ledgerSearchResult(
  result: LedgerEntriesSearchResult,
  selfActorId: string | null,
): LedgerToolTextResult {
  const entries = result.entries.map((item) =>
    projectSearchItem(item, selfActorId),
  );
  const owners =
    result.owners === undefined ? undefined : projectOwners(result.owners);
  const render = (shown: readonly LedgerEntryView[], omitted: number): string =>
    JSON.stringify({
      entries: shown,
      nextCursor: omitted > 0 ? null : result.nextCursor,
      hasMore: result.hasMore || omitted > 0,
      watermark: result.watermark,
      ...(omitted > 0
        ? {
            omittedEntries: omitted,
            note: 'Some entries were left out to keep this result small. Repeat the search with a smaller limit to see them.',
          }
        : {}),
      ...(owners === undefined ? {} : { owners }),
    });
  let shown = entries;
  let text = render(shown, 0);
  while (text.length > MAX_RESULT_CHARACTERS && shown.length > 0) {
    shown = shown.slice(0, Math.max(0, Math.floor(shown.length * 0.75)));
    text = render(shown, entries.length - shown.length);
  }
  return { text };
}

/**
 * The hint after a top-level TASK is added: the open operations it could
 * sit under. Undefined when there are none.
 */
export function ledgerOpenOperationsHint(
  operations: readonly { readonly entryId: string; readonly title: string }[],
  hasMore: boolean,
  searchToolName: string,
): string | undefined {
  if (operations.length === 0) return undefined;
  const namedOperations = operations
    .map((entry) => `${JSON.stringify(entry.title)} (${entry.entryId})`)
    .join('; ');
  const more = hasMore ? '; and more' : '';
  return `Open operations in this Feed: ${namedOperations}${more}. Set parentEntryId to one of these IDs if this task belongs under an operation, or use ${searchToolName} to choose.`;
}

function errorResult(
  code: string,
  message: string,
  extra: {
    readonly currentEntry?: LedgerEntryView;
    readonly openChildEntryIds?: readonly string[];
  } = {},
): LedgerToolTextResult {
  return {
    text: JSON.stringify({
      ok: false,
      error: { code, message },
      ...(extra.currentEntry === undefined
        ? {}
        : { currentEntry: extra.currentEntry }),
      ...(extra.openChildEntryIds === undefined
        ? {}
        : { openChildEntryIds: extra.openChildEntryIds }),
    }),
    isError: true,
  };
}

/** Where a failed Feed call ran: a write (with or without a requestKey) or a search. */
export interface LedgerToolFailureSite {
  readonly mode: 'command' | 'query';
  readonly explicitKey: boolean;
}

/**
 * A Feed operation's failure as the tool sees it: the Ledger's typed
 * refusal when it gave one, else the operation error's kind. `null` for a
 * failure that carried neither, whose outcome is unknown.
 */
export interface LedgerToolFailure {
  readonly details: LedgerErrorDetails | null;
  /** The operation error's kind, such as `invalid_argument`. */
  readonly kind: string | null;
}

/**
 * Maps a Feed failure to a short result the model can act on. A command
 * whose outcome is unknown points at a search (or the same requestKey)
 * instead of a blind retry that could duplicate the entry.
 */
export function ledgerFailureResult(
  failure: LedgerToolFailure | null,
  site: LedgerToolFailureSite,
  selfActorId: string | null,
): LedgerToolTextResult {
  const outcomeUnknown =
    site.mode === 'query'
      ? 'The Feed search failed. Try again later.'
      : site.explicitKey
        ? 'The change may or may not have been saved. Retry later with the same requestKey.'
        : 'The change may or may not have been saved. Search for the entry before trying again.';
  if (failure === null) return errorResult('FEED_FAILED', outcomeUnknown);
  const details = failure.details;
  switch (details?.reason) {
    case 'WRITER_UNAVAILABLE':
    case 'UNSUPPORTED_SCHEMA':
      return errorResult(
        details.reason,
        'The Feed is not available right now. Continue without recording.',
      );
    case 'NOT_FOUND':
      return errorResult(
        details.reason,
        "No entry with that ID is in this chat's Feed. Search to find the right entry.",
      );
    case 'FORBIDDEN':
      // `owner` is the one permission an agent can act on; every other
      // field names a binding or scope this chat cannot use.
      return errorResult(
        details.reason,
        details.field === 'owner'
          ? 'Only the current owner of an entry can change it. Leave it to its owner, or ask the user.'
          : 'The Feed is not available to this chat. Continue without recording.',
      );
    case 'TERMINAL_ENTRY':
      return errorResult(
        details.reason,
        'That entry is Completed, Failed or Info and cannot change. To correct it, add a new entry with supersedesEntryId set to it.',
        details.currentEntry === undefined
          ? {}
          : { currentEntry: projectEntry(details.currentEntry, selfActorId) },
      );
    case 'REVISION_CONFLICT': {
      const current = details.currentEntry;
      return errorResult(
        details.reason,
        current === undefined
          ? 'The entry changed since you read it. Search for its current revision and reconsider the change instead of overwriting it.'
          : `The entry changed since you read it and is now at revision ${current.revision}. Reconsider the change against the current entry; if it still applies, retry with expectedRevision ${current.revision}.`,
        current === undefined
          ? {}
          : { currentEntry: projectEntry(current, selfActorId) },
      );
    }
    case 'OWNER_UNAVAILABLE':
      return errorResult(
        details.reason,
        'That owner can no longer be assigned. Search with includeAssignableOwners set to true for current owners and eligibility tokens.',
      );
    case 'PARENT_INVALID':
      return errorResult(
        details.reason,
        'That parent cannot contain this entry. Search the Feed and choose a valid open Operation or Task, or set parentEntryId to null when updating to leave the entry at top level (omit parentEntryId when adding).',
      );
    case 'PARENT_CLOSED':
      return errorResult(
        details.reason,
        'That parent is closed. Search the Feed and choose an open parent, or set parentEntryId to null when updating to detach the entry (omit parentEntryId when adding).',
      );
    case 'OPEN_CHILDREN':
      return errorResult(
        details.reason,
        'This entry has open children. Review openChildEntryIds and retry with openChildren set to "complete", "fail" or "detach".',
        details.openChildEntryIds === undefined
          ? {}
          : { openChildEntryIds: details.openChildEntryIds },
      );
    case 'SCOPE_RETIRED':
      return errorResult(
        details.reason,
        'This Feed no longer accepts changes. Continue without recording.',
      );
    case 'IDEMPOTENCY_KEY_REUSED':
      return errorResult(
        details.reason,
        'That requestKey was already used for a different request. Use a new requestKey; to check the earlier request, search for its entry.',
      );
    case 'CURSOR_EXPIRED':
      return errorResult(
        details.reason,
        `The ${details.field ?? 'cursor'} expired. Repeat the search without it.`,
      );
    case 'INVALID_INPUT':
      return errorResult(
        details.reason,
        details.field === undefined
          ? 'The Feed request is invalid.'
          : `The Feed request is invalid: ${details.field}${details.limit === undefined ? '' : ` (limit ${details.limit})`}.`,
      );
    case 'STORAGE_UNAVAILABLE':
    case 'RATE_LIMITED':
      return errorResult(
        details.reason,
        site.mode === 'query'
          ? 'The Feed is busy or unavailable. Try the search again later.'
          : outcomeUnknown,
      );
    case undefined:
      break;
  }
  switch (failure.kind) {
    case 'invalid_argument':
      return errorResult('INVALID_INPUT', 'The Feed request is invalid.');
    case 'capability_unavailable':
    case 'permission_denied':
    case 'unauthenticated':
      return errorResult(
        'FEED_UNAVAILABLE',
        'The Feed is not available right now. Continue without recording.',
      );
    default:
      return errorResult('FEED_FAILED', outcomeUnknown);
  }
}

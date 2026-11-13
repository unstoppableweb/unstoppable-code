import { buildInjectedToolNamesForBrand } from '@canopy/protocol/brand';
import {
  ADD_LEDGER_ENTRY_TOOL_JSON_SCHEMA,
  LedgerAddEntryToolInputSchema,
  LedgerSearchEntriesToolInputSchema,
  LedgerUpdateEntryToolInputSchema,
  SEARCH_LEDGER_ENTRIES_TOOL_DESCRIPTION,
  SEARCH_LEDGER_ENTRIES_TOOL_JSON_SCHEMA,
  UPDATE_LEDGER_ENTRY_TOOL_JSON_SCHEMA,
  addLedgerEntryToolDescription,
  ledgerCommandResult,
  ledgerFailureResult,
  ledgerOpenOperationsHint,
  ledgerSearchResult,
  ledgerUnavailableResult,
  parseLedgerToolArgs,
  updateLedgerEntryToolDescription,
  type LedgerStatus,
  type LedgerToolFailureSite,
} from '@canopy/protocol/canopy-core';
import type { AgentActionBrand } from '../brand';
import {
  AgentFeedError,
  type AgentFeedCommandResult,
  type AgentFeedPort,
} from '../port/feed-port';
import type { AgentActionCall } from '../surface/family';
import type { AgentActionToolResult, AgentJsonSchema } from './definition';

/*
 * AddFeedEntry, SearchFeedEntries and UpdateFeedEntry on the agent action
 * surface (CAN-6313). Their descriptions, JSON Schemas, argument checks and
 * result text are the protocol's Feed tool contract (`core/ledger/tools.ts`),
 * the one desktop's tools runtime renders through, so the model sees the same
 * tool on every host. The host's `AgentFeedPort` runs the Ledger operations
 * as the calling chat.
 */

export type AgentFeedToolKey =
  | 'add_ledger_entry'
  | 'search_ledger_entries'
  | 'update_ledger_entry';

/** The names the Feed tools' descriptions and hints use. */
function descriptionNames(brand: AgentActionBrand): {
  readonly appName: string;
  readonly searchCodexToolName: string;
} {
  return {
    appName: brand.displayName,
    searchCodexToolName: buildInjectedToolNamesForBrand({
      tools: { namespace: brand.toolNamespace },
    }).codex.searchLedgerEntries,
  };
}

export function feedToolDescription(
  key: AgentFeedToolKey,
  brand: AgentActionBrand,
): string {
  switch (key) {
    case 'add_ledger_entry':
      return addLedgerEntryToolDescription(descriptionNames(brand));
    case 'search_ledger_entries':
      return SEARCH_LEDGER_ENTRIES_TOOL_DESCRIPTION;
    case 'update_ledger_entry':
      return updateLedgerEntryToolDescription(descriptionNames(brand));
  }
}

export function feedToolJsonSchema(key: AgentFeedToolKey): AgentJsonSchema {
  switch (key) {
    case 'add_ledger_entry':
      return ADD_LEDGER_ENTRY_TOOL_JSON_SCHEMA;
    case 'search_ledger_entries':
      return SEARCH_LEDGER_ENTRIES_TOOL_JSON_SCHEMA;
    case 'update_ledger_entry':
      return UPDATE_LEDGER_ENTRY_TOOL_JSON_SCHEMA;
  }
}

/** Open statuses: the ones an owner keeps current. */
const OPEN_LEDGER_STATUSES: readonly LedgerStatus[] = [
  'TODO',
  'IN_PROGRESS',
  'BLOCKED',
  'NEEDS_REVIEW',
];
/** Open operations the hint after a top-level task names. */
const OPEN_OPERATION_HINT_LIMIT = 3;
/** The name the hint tells the agent to search with. */
const SEARCH_TOOL_NAME = 'SearchFeedEntries';

/**
 * A keyed write's key: the model's `requestKey`, which holds across
 * sessions, else the provider invocation, so a redelivered call dedupes
 * while a new call never aliases an earlier receipt. Undefined when the call
 * carries neither; the port then mints a fresh key.
 */
function idempotencyKeyOf(
  requestKey: string | undefined,
  call: AgentActionCall<unknown>,
): string | undefined {
  if (requestKey !== undefined) return `request:${requestKey}`;
  return call.toolUseId !== undefined && call.toolUseId.length > 0
    ? `invocation:${call.toolUseId}`
    : undefined;
}

function failureResult(
  error: unknown,
  site: LedgerToolFailureSite,
): AgentActionToolResult {
  if (!(error instanceof AgentFeedError)) {
    return ledgerFailureResult(null, site, null);
  }
  const { refusal } = error;
  return refusal.kind === 'unavailable'
    ? ledgerUnavailableResult(refusal.reason)
    : ledgerFailureResult(refusal.failure, site, error.selfActorId);
}

/** Names open operations a newly added top-level task could sit under. */
async function openOperationsHint<H>(
  port: AgentFeedPort<H>,
  call: AgentActionCall<H>,
): Promise<string | undefined> {
  if (call.signal?.aborted) return undefined;
  try {
    const { result } = await port.search(
      {
        types: ['OPERATION'],
        statuses: [...OPEN_LEDGER_STATUSES],
        sort: 'updated_desc',
        limit: OPEN_OPERATION_HINT_LIMIT,
      },
      call,
    );
    if (call.signal?.aborted) return undefined;
    return ledgerOpenOperationsHint(
      result.entries,
      result.hasMore,
      SEARCH_TOOL_NAME,
    );
  } catch {
    // The write already committed; a failed or cancelled hint is best effort.
    return undefined;
  }
}

async function runCommand(
  requestKey: string | undefined,
  write: () => Promise<AgentFeedCommandResult>,
  afterSuccess?: () => Promise<string | undefined>,
): Promise<AgentActionToolResult> {
  let committed: AgentFeedCommandResult;
  try {
    committed = await write();
  } catch (error) {
    return failureResult(error, {
      mode: 'command',
      explicitKey: requestKey !== undefined,
    });
  }
  // A follow-up hint must never turn a committed write into a failure.
  const additionalLine =
    afterSuccess === undefined ? undefined : await afterSuccess();
  return ledgerCommandResult(
    committed.receipt,
    committed.selfActorId,
    additionalLine,
  );
}

/** Runs one Feed tool call through the host's Feed port. */
export async function executeFeedTool<H>(
  key: AgentFeedToolKey,
  rawArgs: unknown,
  port: AgentFeedPort<H>,
  call: AgentActionCall<H>,
): Promise<AgentActionToolResult> {
  switch (key) {
    case 'add_ledger_entry': {
      const parsed = parseLedgerToolArgs(
        LedgerAddEntryToolInputSchema,
        rawArgs,
        'AddFeedEntry',
      );
      if (!parsed.success) return parsed.result;
      const { requestKey, ...params } = parsed.data;
      return runCommand(
        requestKey,
        () => port.add(params, idempotencyKeyOf(requestKey, call), call),
        params.type === 'TASK' && params.parentEntryId === undefined
          ? (): Promise<string | undefined> => openOperationsHint(port, call)
          : undefined,
      );
    }
    case 'update_ledger_entry': {
      const parsed = parseLedgerToolArgs(
        LedgerUpdateEntryToolInputSchema,
        rawArgs,
        'UpdateFeedEntry',
      );
      if (!parsed.success) return parsed.result;
      const { requestKey, ...params } = parsed.data;
      return runCommand(requestKey, () =>
        port.update(params, idempotencyKeyOf(requestKey, call), call),
      );
    }
    case 'search_ledger_entries': {
      const parsed = parseLedgerToolArgs(
        LedgerSearchEntriesToolInputSchema,
        rawArgs,
        'SearchFeedEntries',
      );
      if (!parsed.success) return parsed.result;
      try {
        const { result, selfActorId } = await port.search(parsed.data, call);
        return ledgerSearchResult(result, selfActorId);
      } catch (error) {
        return failureResult(error, { mode: 'query', explicitKey: false });
      }
    }
  }
}

import { BRAND } from '@canopy/brand/current';
import {
  ADD_LEDGER_ENTRY_TOOL_JSON_SCHEMA,
  SEARCH_LEDGER_ENTRIES_TOOL_DESCRIPTION,
  SEARCH_LEDGER_ENTRIES_TOOL_JSON_SCHEMA,
  UPDATE_LEDGER_ENTRY_TOOL_JSON_SCHEMA,
  addLedgerEntryToolDescription,
  updateLedgerEntryToolDescription,
} from '@canopy/protocol/canopy-core';
import { CANOPY_INJECTED_TOOL_REGISTRY } from '../../lib/canopy-injected-tools';
import type { JsonValue } from '../codex-runtime/generated/serde_json/JsonValue';
import type { DynamicToolSpec } from '../codex-runtime/generated/v2/DynamicToolSpec';

/*
 * The Feed (Agent Ledger) tools as agents see them: their descriptions and
 * advertised JSON Schemas, and their Codex dynamic tool specs. Shared by
 * every host that serves the tools: Electron main on desktop and the
 * pipeline runner for cloud runs (CAN-6422).
 */

const appName = BRAND.displayName;

// ---------------------------------------------------------------------------
// Agent Ledger tools. The descriptions and advertised JSON Schemas are the
// protocol's (`@canopy/protocol/canopy-core`, `core/ledger/tools.ts`), which
// the cloud agent-actions surface advertises too (CAN-6313); the handler
// validates with the protocol's tool input schemas they are derived from.
// ---------------------------------------------------------------------------

const ledgerToolDescriptionNames = {
  appName,
  searchCodexToolName:
    CANOPY_INJECTED_TOOL_REGISTRY.search_ledger_entries.codexToolName,
};

export const ADD_LEDGER_ENTRY_DESCRIPTION = addLedgerEntryToolDescription(
  ledgerToolDescriptionNames,
);

export const SEARCH_LEDGER_ENTRIES_DESCRIPTION =
  SEARCH_LEDGER_ENTRIES_TOOL_DESCRIPTION;

export const UPDATE_LEDGER_ENTRY_DESCRIPTION = updateLedgerEntryToolDescription(
  ledgerToolDescriptionNames,
);

export const addLedgerEntryJsonSchema: JsonValue =
  ADD_LEDGER_ENTRY_TOOL_JSON_SCHEMA;

export const searchLedgerEntriesJsonSchema: JsonValue =
  SEARCH_LEDGER_ENTRIES_TOOL_JSON_SCHEMA;

export const updateLedgerEntryJsonSchema: JsonValue =
  UPDATE_LEDGER_ENTRY_TOOL_JSON_SCHEMA;

/**
 * AddLedgerEntry, SearchLedgerEntries and UpdateLedgerEntry as Codex dynamic
 * tools, for a thread whose session passed the Ledger exposure gate: a chat
 * or a pipeline agent's attempt.
 */
export function buildLedgerCodexDynamicToolSpecs(): DynamicToolSpec[] {
  return [
    {
      type: 'function',
      name: CANOPY_INJECTED_TOOL_REGISTRY.add_ledger_entry.codexToolName,
      description: ADD_LEDGER_ENTRY_DESCRIPTION,
      inputSchema: addLedgerEntryJsonSchema,
    },
    {
      type: 'function',
      name: CANOPY_INJECTED_TOOL_REGISTRY.search_ledger_entries.codexToolName,
      description: SEARCH_LEDGER_ENTRIES_DESCRIPTION,
      inputSchema: searchLedgerEntriesJsonSchema,
    },
    {
      type: 'function',
      name: CANOPY_INJECTED_TOOL_REGISTRY.update_ledger_entry.codexToolName,
      description: UPDATE_LEDGER_ENTRY_DESCRIPTION,
      inputSchema: updateLedgerEntryJsonSchema,
    },
  ];
}

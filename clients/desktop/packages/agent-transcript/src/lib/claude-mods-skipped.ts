import { isClaudeModsPluginId } from '@canopy/protocol/claude-mods';
import type {
  ClaudeModSkippedReason,
  ClaudeModsSkippedBlock,
  ClaudeModsSkippedEntry,
} from '../types';

const CLAUDE_MODS_SKIPPED_REASONS: readonly ClaudeModSkippedReason[] = [
  'not-admitted',
  'digest-changed',
  'kill-switch',
  'authority-unreadable',
  'inspection-failed',
  'install-list-unreadable',
  'projection-failed',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isClaudeModSkippedReason(
  value: unknown,
): value is ClaudeModSkippedReason {
  return CLAUDE_MODS_SKIPPED_REASONS.some((reason) => reason === value);
}

export function isClaudeModsSkippedEntry(
  value: unknown,
): value is ClaudeModsSkippedEntry {
  return (
    isRecord(value) &&
    isClaudeModsPluginId(value.pluginId) &&
    isClaudeModSkippedReason(value.reason)
  );
}

function areClaudeModsSkippedEntries(value: unknown[]): boolean {
  for (const entry of value) {
    if (!isClaudeModsSkippedEntry(entry)) return false;
  }
  return true;
}

/** Validate the path-free persisted Claude Mods skipped block shape. */
export function isClaudeModsSkippedBlock(
  value: unknown,
): value is ClaudeModsSkippedBlock {
  return (
    isRecord(value) &&
    value.type === 'claude_mods_skipped' &&
    typeof value.timestamp === 'number' &&
    Number.isFinite(value.timestamp) &&
    Array.isArray(value.mods) &&
    value.mods.length > 0 &&
    value.mods.length <= 50 &&
    areClaudeModsSkippedEntries(value.mods) &&
    (value.sourceEventId === undefined ||
      typeof value.sourceEventId === 'string')
  );
}

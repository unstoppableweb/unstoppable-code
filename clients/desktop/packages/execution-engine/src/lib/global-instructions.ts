import { ORCHESTRATOR_LABEL } from '@canopy/protocol';
import type {
  GlobalInstructionHarness,
  GlobalInstructionMode,
  GlobalInstructionsConfig,
  GlobalInstructionsSection,
  GlobalInstructionWorkspaceType,
  ScopedGlobalInstruction,
} from '../types/global-instructions';
import {
  createEmptyGlobalInstructionsConfig,
  createEmptyGlobalInstructionsSection,
  GLOBAL_INSTRUCTION_HARNESSES,
  GLOBAL_INSTRUCTION_MODES,
  GLOBAL_INSTRUCTION_WORKSPACE_TYPES,
} from '../types/global-instructions';

/**
 * Pure resolution + validation logic for the Global Instructions feature
 * (Models settings page). Shared by the Electron main process, the renderer
 * (validation warnings), and builtin pipeline actions running as plain Node
 * subprocesses — keep this module free of Electron, Node, and app imports.
 */

/** Session facts a scoped instruction is matched against. */
export interface GlobalInstructionContext {
  harness: GlobalInstructionHarness;
  model: string;
  /** Present for chat sessions only; pipeline agents have no workspace type. */
  workspaceType?: GlobalInstructionWorkspaceType;
}

export const USER_OVERALL_PREFERENCES_HEADER = '# User Overall Preferences';

/**
 * The narrowing selections form one grouped multi-select, so an instruction
 * applies when the session matches ANY selected option. An item with no
 * selections applies to every session in its section.
 */
export function scopedGlobalInstructionApplies(
  item: ScopedGlobalInstruction,
  context: GlobalInstructionContext,
): boolean {
  const hasScope =
    item.harnesses.length > 0 ||
    item.models.length > 0 ||
    item.workspaceTypes.length > 0;
  if (!hasScope) return true;
  if (item.harnesses.includes(context.harness)) return true;
  if (item.models.includes(context.model)) return true;
  if (
    context.workspaceType !== undefined &&
    item.workspaceTypes.includes(context.workspaceType)
  ) {
    return true;
  }
  return false;
}

/**
 * Construct the effective global instruction text for one session.
 *
 * Items are processed in list order (the user-established priority). The
 * first applicable `replace` item fully overwrites the construction — the
 * overall text and any earlier appends are discarded and no later item is
 * processed. Otherwise the result is the overall text followed by every
 * applicable `append` item in order. Empty-text items are skipped entirely.
 */
export function resolveGlobalInstructions(
  section: GlobalInstructionsSection,
  context: GlobalInstructionContext,
): string {
  const parts: string[] = [];
  const overall = section.overall.trim();
  if (overall) parts.push(overall);
  for (const item of section.scoped) {
    const text = item.text.trim();
    if (!text) continue;
    if (!scopedGlobalInstructionApplies(item, context)) continue;
    if (item.mode === 'replace') return text;
    parts.push(text);
  }
  return parts.join('\n\n');
}

/**
 * Resolve a section into the "User Overall Preferences" system-prompt block
 * injected into newly created agent sessions. Empty string when nothing is
 * configured for the session.
 */
export function buildUserOverallPreferencesBlock(
  section: GlobalInstructionsSection,
  context: GlobalInstructionContext,
): string {
  const text = resolveGlobalInstructions(section, context);
  if (!text) return '';
  return `${USER_OVERALL_PREFERENCES_HEADER}\n\n${text}`;
}

/**
 * Resolve the pipelines-section "User Overall Preferences" block from the
 * serialized section JSON carried on pipeline step environments
 * (`<BRAND>_PREF_GLOBAL_INSTRUCTIONS_PIPELINES`). Tolerates missing or
 * malformed payloads by resolving to an empty block.
 */
export function buildPipelineGlobalInstructionsBlock(
  rawSectionJson: string | undefined,
  context: GlobalInstructionContext,
): string {
  if (!rawSectionJson) return '';
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawSectionJson);
  } catch {
    return '';
  }
  const section = normalizeSection(parsed, { allowWorkspaceTypes: false });
  return buildUserOverallPreferencesBlock(section, context);
}

/**
 * Append the resolved "User Overall Preferences" block to an existing system
 * prompt append. Returns the base unchanged when the block is empty.
 */
export function appendUserOverallPreferencesBlock(
  base: string | undefined,
  block: string,
): string | undefined {
  if (!block) return base;
  const trimmedBase = base?.trim();
  return trimmedBase ? `${trimmedBase}\n\n${block}` : block;
}

// ---------------------------------------------------------------------------
// Overlap validation warnings
// ---------------------------------------------------------------------------

/** Non-blocking warning shown on the scoped item that loses to a replace. */
export interface GlobalInstructionOverlapWarning {
  /** The suppressed (losing) item. */
  itemId: string;
  itemIndex: number;
  /** The replace item that takes priority. */
  winnerId: string;
  winnerIndex: number;
  message: string;
}

interface ExpandedScope {
  matchesAll: boolean;
  harnesses: readonly GlobalInstructionHarness[];
  /** Explicit models plus every model configured for a selected harness. */
  models: readonly string[];
  workspaceTypes: readonly GlobalInstructionWorkspaceType[];
}

function expandScope(
  item: ScopedGlobalInstruction,
  modelsByHarness: Partial<Record<GlobalInstructionHarness, readonly string[]>>,
): ExpandedScope {
  const models = [...item.models];
  for (const harness of item.harnesses) {
    for (const model of modelsByHarness[harness] ?? []) {
      if (!models.includes(model)) models.push(model);
    }
  }
  return {
    matchesAll:
      item.harnesses.length === 0 &&
      item.models.length === 0 &&
      item.workspaceTypes.length === 0,
    harnesses: item.harnesses,
    models,
    workspaceTypes: item.workspaceTypes,
  };
}

function intersect<T>(a: readonly T[], b: readonly T[]): T[] {
  return a.filter((value) => b.includes(value));
}

const WORKSPACE_TYPE_LABELS: Record<GlobalInstructionWorkspaceType, string> = {
  code: 'Code',
  cowork: 'Cowork',
  'app-advisor': ORCHESTRATOR_LABEL,
};

const HARNESS_LABELS: Record<GlobalInstructionHarness, string> = {
  claude: 'Claude',
  codex: 'Codex',
  ollama: 'Ollama',
  cursor: 'Cursor',
  copilot: 'GitHub Copilot',
  antigravity: 'Google',
  opencode: 'OpenCode',
};

function formatList(values: string[], max = 3): string {
  if (values.length <= max) return values.join(', ');
  return `${values.slice(0, max).join(', ')} +${values.length - max} more`;
}

/**
 * Human-readable description of where two expanded scopes overlap, or null
 * when they are disjoint. Sessions match an item on ANY selected option, so a
 * workspace-type selection on one item overlaps a harness/model selection on
 * the other (a single session can satisfy both).
 */
function describeOverlap(a: ExpandedScope, b: ExpandedScope): string | null {
  if (a.matchesAll && b.matchesAll) return 'both apply to all sessions';
  if (a.matchesAll || b.matchesAll) return 'one applies to all sessions';

  const parts: string[] = [];
  const sharedHarnesses = intersect(a.harnesses, b.harnesses);
  if (sharedHarnesses.length > 0) {
    parts.push(
      `harness: ${formatList(sharedHarnesses.map((h) => HARNESS_LABELS[h]))}`,
    );
  }
  const sharedModels = intersect(a.models, b.models);
  if (sharedModels.length > 0) {
    parts.push(`models: ${formatList(sharedModels)}`);
  }
  const sharedWorkspaceTypes = intersect(a.workspaceTypes, b.workspaceTypes);
  if (sharedWorkspaceTypes.length > 0) {
    parts.push(
      `project types: ${formatList(
        sharedWorkspaceTypes.map((w) => WORKSPACE_TYPE_LABELS[w]),
      )}`,
    );
  }
  if (parts.length > 0) return parts.join('; ');

  const aHasModelScope = a.harnesses.length > 0 || a.models.length > 0;
  const bHasModelScope = b.harnesses.length > 0 || b.models.length > 0;
  if (
    (a.workspaceTypes.length > 0 && bHasModelScope) ||
    (b.workspaceTypes.length > 0 && aHasModelScope)
  ) {
    return 'a workspace-type selection on one overlaps the harness/model selection on the other';
  }
  return null;
}

/**
 * Compute non-blocking warnings for scoped items suppressed by a `replace`
 * item wherever both apply. Harness selections are expanded to the models
 * configured for that harness so harness-vs-model overlaps are detected.
 *
 * Priority rules mirror {@link resolveGlobalInstructions}: the earliest
 * applicable replace wins over later replaces, and a replace wins over every
 * overlapping append regardless of order (earlier appends are discarded by
 * the full overwrite; later ones are never processed).
 */
export function computeGlobalInstructionOverlapWarnings(
  section: GlobalInstructionsSection,
  modelsByHarness: Partial<Record<GlobalInstructionHarness, readonly string[]>>,
): GlobalInstructionOverlapWarning[] {
  const scopes = section.scoped.map((item) =>
    expandScope(item, modelsByHarness),
  );
  const effectiveItems = section.scoped.map(
    (item) => item.text.trim().length > 0,
  );
  const warnings: GlobalInstructionOverlapWarning[] = [];

  function hasEarlierEffectiveReplace(
    loserIndex: number,
    candidateWinnerIndex: number,
  ): boolean {
    for (let k = 0; k < candidateWinnerIndex; k += 1) {
      if (!effectiveItems[k]) continue;
      if (section.scoped[k].mode !== 'replace') continue;
      if (!describeOverlap(scopes[k], scopes[loserIndex])) continue;
      if (!describeOverlap(scopes[k], scopes[candidateWinnerIndex])) continue;
      return true;
    }
    return false;
  }

  for (let i = 0; i < section.scoped.length; i += 1) {
    if (!effectiveItems[i]) continue;
    for (let j = i + 1; j < section.scoped.length; j += 1) {
      if (!effectiveItems[j]) continue;
      const earlier = section.scoped[i];
      const later = section.scoped[j];
      if (earlier.mode !== 'replace' && later.mode !== 'replace') continue;

      const overlap = describeOverlap(scopes[i], scopes[j]);
      if (!overlap) continue;

      if (earlier.mode === 'replace') {
        // The earlier replace stops processing first, suppressing the later
        // item (replace or append) wherever both apply.
        warnings.push({
          itemId: later.id,
          itemIndex: j,
          winnerId: earlier.id,
          winnerIndex: i,
          message:
            later.mode === 'replace'
              ? `Replace #${i + 1} takes priority over this Replace wherever both apply (${overlap}); this instruction will not be used there.`
              : `Replace #${i + 1} overrides this instruction wherever both apply (${overlap}).`,
        });
      } else {
        // Earlier append vs later replace: the replace's full overwrite
        // discards the earlier append wherever both apply.
        if (hasEarlierEffectiveReplace(i, j)) continue;
        warnings.push({
          itemId: earlier.id,
          itemIndex: i,
          winnerId: later.id,
          winnerIndex: j,
          message: `Replace #${j + 1} overrides this instruction wherever both apply (${overlap}).`,
        });
      }
    }
  }

  return warnings;
}

// ---------------------------------------------------------------------------
// Persistence normalization
// ---------------------------------------------------------------------------

function isGlobalInstructionMode(
  value: unknown,
): value is GlobalInstructionMode {
  return GLOBAL_INSTRUCTION_MODES.some((mode) => mode === value);
}

function normalizeAllowedArray<T extends string>(
  value: unknown,
  allowed: readonly T[],
): T[] {
  if (!Array.isArray(value)) return [];
  const result: T[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const match = allowed.find((candidate) => candidate === entry);
    if (match === undefined || result.includes(match)) continue;
    result.push(match);
  }
  return result;
}

function normalizeModelArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.length === 0) continue;
    if (result.includes(entry)) continue;
    result.push(entry);
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeScopedInstruction(
  value: unknown,
  options: { allowWorkspaceTypes: boolean },
): ScopedGlobalInstruction | null {
  if (!isRecord(value)) return null;
  const record = value;
  if (typeof record.id !== 'string' || record.id.length === 0) return null;
  return {
    id: record.id,
    text: typeof record.text === 'string' ? record.text : '',
    mode: isGlobalInstructionMode(record.mode) ? record.mode : 'append',
    harnesses: normalizeAllowedArray(
      record.harnesses,
      GLOBAL_INSTRUCTION_HARNESSES,
    ),
    models: normalizeModelArray(record.models),
    workspaceTypes: options.allowWorkspaceTypes
      ? normalizeAllowedArray(
          record.workspaceTypes,
          GLOBAL_INSTRUCTION_WORKSPACE_TYPES,
        )
      : [],
  };
}

function normalizeSection(
  value: unknown,
  options: { allowWorkspaceTypes: boolean },
): GlobalInstructionsSection {
  if (!isRecord(value)) {
    return createEmptyGlobalInstructionsSection();
  }
  const record = value;
  const scopedRaw = Array.isArray(record.scoped) ? record.scoped : [];
  const scoped: ScopedGlobalInstruction[] = [];
  const seenIds = new Set<string>();
  for (const entry of scopedRaw) {
    const normalized = normalizeScopedInstruction(entry, options);
    if (!normalized || seenIds.has(normalized.id)) continue;
    seenIds.add(normalized.id);
    scoped.push(normalized);
  }
  return {
    overall: typeof record.overall === 'string' ? record.overall : '',
    scoped,
  };
}

/** Clamp a persisted (possibly legacy or corrupt) value to a valid config. */
export function normalizeGlobalInstructionsConfig(
  value: unknown,
): GlobalInstructionsConfig {
  if (!isRecord(value)) {
    return createEmptyGlobalInstructionsConfig();
  }
  const record = value;
  return {
    chats: normalizeSection(record.chats, { allowWorkspaceTypes: true }),
    pipelines: normalizeSection(record.pipelines, {
      allowWorkspaceTypes: false,
    }),
  };
}

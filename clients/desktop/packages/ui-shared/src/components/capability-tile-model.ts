import type {
  AgentArtifactChangedField,
  AgentArtifactReceiptV1,
  AutomationRunArtifactReceiptV1,
  CapabilityItemKind,
  CapabilityReferenceArtifactReceiptV1,
} from '@canopy/protocol/agent-artifacts';
import type { StatusGlyphState } from '../lib/status-glyph';
import { WORKFLOW_ITEM_LABEL } from '../lib/workflow-labels';
import { MODEL_PRESET_LABEL } from '../lib/model-preset-labels';

/**
 * Receipts that render as a compact capability tile. Pipeline runs and watched
 * GitHub workflow runs keep their specialized live rows on desktop.
 */
export type CapabilityTileReceipt = Exclude<
  AgentArtifactReceiptV1,
  { kind: 'pipeline_run' } | { kind: 'github_workflow_run' }
>;

export type CapabilityTileIconKind =
  | 'pipeline'
  | 'skill'
  | 'automation'
  | 'agent'
  | 'plugin'
  | 'mcp-server'
  | 'collection';

export type CapabilityTileTone =
  | 'success'
  | 'info'
  | 'warning'
  | 'danger'
  | 'muted';

/**
 * A tile's state. A run or waiting state draws its status glyph in place of
 * the label; availability states such as "Installed" stay as text.
 */
export interface CapabilityTileState {
  label: string;
  tone: CapabilityTileTone;
  glyph?: StatusGlyphState;
  /** A finished run's duration, e.g. "4 s". */
  detail?: string;
}

/**
 * Host-observed state layered over a persisted receipt. `unknown` keeps the
 * snapshot; only a confirmed removal disables the tile.
 */
export interface CapabilityTileLiveState {
  availability?: 'unknown' | 'available' | 'removed';
  /** A newer status for an automation-run receipt, from a matching run. */
  runStatus?: AutomationRunArtifactReceiptV1['status'];
  runDurationMs?: number;
}

/** Everything a {@link CapabilityTile} shows, already worded. */
export interface CapabilityTileModel {
  iconKind: CapabilityTileIconKind;
  /** Short type label, e.g. "Automation run" or "MCP server". */
  kindLabel: string;
  /** What this turn did with the item: "Created", "Found", "Triggered"… */
  operationLabel: string;
  /**
   * Leads the tile's detail line: "Skill" for a found or recommended item,
   * "Created pipeline" when the turn changed it.
   */
  kindPhrase: string;
  name: string;
  /** One-line purpose or configuration summary. */
  summary?: string;
  /** Readable list of changed settings, for updates that report them. */
  changeSummary?: string;
  sourceLabel?: string;
  state?: CapabilityTileState;
  /** Why the agent recommended the item. */
  reason?: string;
  /** The receipt names an unverified external source. */
  external: boolean;
  /** A confirmed removal: the tile keeps its history but cannot open. */
  removed: boolean;
  /** Removal note for tiles whose state still describes their outcome. */
  removedNote?: string;
}

const CREATE_OPERATION =
  /\.(?:create|create_custom|duplicate|share|share_custom)$/i;
const IMPORT_OPERATION = /\.import_shared$/i;

const ITEM_KIND_LABELS: Record<CapabilityItemKind, string> = {
  skill: 'Skill',
  pipeline: WORKFLOW_ITEM_LABEL,
  automation: 'Automation',
  agent: MODEL_PRESET_LABEL,
  plugin: 'Plugin',
  'mcp-server': 'MCP server',
  collection: 'Collection',
};

const CHANGED_FIELD_LABELS: Record<AgentArtifactChangedField, string> = {
  name: 'name',
  description: 'description',
  enabled: 'enabled state',
  schedule: 'schedule',
  action: 'action',
  ifCommand: 'If Command',
  instructions: 'instructions',
  baseModel: 'model',
  pluginSelections: 'plugins',
  content: 'content',
  shareScope: 'sharing',
};

const RUNNING_STATE: CapabilityTileState = {
  label: 'Running',
  tone: 'info',
  glyph: 'running',
};

const RUN_STATUS: Record<
  AutomationRunArtifactReceiptV1['status'],
  CapabilityTileState
> = {
  running: RUNNING_STATE,
  success: { label: 'Succeeded', tone: 'success', glyph: 'done' },
  failure: { label: 'Failed', tone: 'danger', glyph: 'failed' },
  skipped: { label: 'Skipped', tone: 'warning', glyph: 'cancelled' },
  canceled: { label: 'Canceled', tone: 'muted', glyph: 'cancelled' },
  missed: { label: 'Missed', tone: 'warning', glyph: 'cancelled' },
};

const SKIP_REASONS: Record<
  NonNullable<AutomationRunArtifactReceiptV1['skipReason']>,
  string
> = {
  if_command_exit: 'If Command skipped this run',
  idempotency: 'Already ran for this schedule',
  already_running: 'Previous run still in progress',
};

const REFERENCE_STATES: Record<
  CapabilityReferenceArtifactReceiptV1['state'],
  CapabilityTileState | undefined
> = {
  installed: { label: 'Installed', tone: 'muted' },
  available: { label: 'Not installed', tone: 'muted' },
  'needs-auth': { label: 'Needs sign-in', tone: 'warning', glyph: 'needs-you' },
  unknown: undefined,
};

/**
 * Source labels that only say the item is on this machine, which the state
 * already says. Shared, plugin, catalog and external sources stay visible.
 */
const LOCAL_SOURCE_LABELS: ReadonlySet<string> = new Set([
  'Installed',
  'Local',
]);

const MAX_LISTED_CHANGES = 3;

function mutationLabel(operation: string): string {
  if (operation === 'capability_package.analyze') return 'Checked';
  if (IMPORT_OPERATION.test(operation)) return 'Imported';
  return CREATE_OPERATION.test(operation) ? 'Created' : 'Updated';
}

/** "Changed schedule and name", capped so long lists stay one line. */
export function describeCapabilityChangedFields(
  fields: readonly AgentArtifactChangedField[] | undefined,
): string | undefined {
  const labels = [
    ...new Set((fields ?? []).map((field) => CHANGED_FIELD_LABELS[field])),
  ].filter((label): label is string => typeof label === 'string');
  if (labels.length === 0) return undefined;
  const listed = labels.slice(0, MAX_LISTED_CHANGES);
  const remaining = labels.length - listed.length;
  if (remaining > 0) {
    return `Changed ${listed.join(', ')} and ${remaining} more`;
  }
  if (listed.length === 1) return `Changed ${listed[0]}`;
  return `Changed ${listed.slice(0, -1).join(', ')} and ${listed[listed.length - 1]}`;
}

/** "3 s", "2 min 5 s"; undefined for missing or invalid durations. */
export function formatCapabilityRunDuration(
  durationMs: number | undefined,
): string | undefined {
  if (
    durationMs === undefined ||
    !Number.isFinite(durationMs) ||
    durationMs < 0
  ) {
    return undefined;
  }
  const seconds = Math.round(durationMs / 1000);
  if (seconds < 60) return `${Math.max(seconds, durationMs > 0 ? 1 : 0)} s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest > 0 ? `${minutes} min ${rest} s` : `${minutes} min`;
}

/** "Failed · 4 s", or the label alone when there is no duration. */
export function capabilityTileStatusText(state: CapabilityTileState): string {
  return state.detail ? `${state.label} · ${state.detail}` : state.label;
}

/** "Pipeline" → "pipeline"; an acronym such as "MCP server" stays as is. */
function lowerFirstWord(label: string): string {
  return /^[A-Z][a-z]/.test(label)
    ? `${label.charAt(0).toLowerCase()}${label.slice(1)}`
    : label;
}

function joinSummary(...parts: Array<string | undefined>): string | undefined {
  const present = parts.filter(
    (part): part is string => typeof part === 'string' && part.length > 0,
  );
  return present.length > 0 ? present.join(' · ') : undefined;
}

function automationRunModel(
  receipt: AutomationRunArtifactReceiptV1,
  live: CapabilityTileLiveState,
): Omit<CapabilityTileModel, 'external' | 'removed' | 'kindPhrase'> {
  // A terminal receipt never regresses to running from older live data.
  const status =
    live.runStatus &&
    !(receipt.status !== 'running' && live.runStatus === 'running')
      ? live.runStatus
      : receipt.status;
  const durationMs =
    status === receipt.status
      ? (receipt.durationMs ?? live.runDurationMs)
      : live.runDurationMs;
  // A running run has no duration yet, even when stale data carries one.
  const duration =
    status === 'running' ? undefined : formatCapabilityRunDuration(durationMs);
  const trigger =
    receipt.trigger === 'manual'
      ? 'Manual run'
      : receipt.trigger === 'catch_up'
        ? 'Catch-up run'
        : 'Scheduled run';
  return {
    iconKind: 'automation',
    kindLabel: 'Automation run',
    operationLabel: 'Triggered',
    name: receipt.name,
    summary: joinSummary(
      trigger,
      status === 'skipped' && receipt.skipReason
        ? SKIP_REASONS[receipt.skipReason]
        : undefined,
      duration,
    ),
    state: duration
      ? { ...RUN_STATUS[status], detail: duration }
      : RUN_STATUS[status],
  };
}

function baseModel(
  receipt: CapabilityTileReceipt,
  live: CapabilityTileLiveState,
): Omit<CapabilityTileModel, 'external' | 'removed' | 'kindPhrase'> {
  switch (receipt.kind) {
    case 'pipeline':
      return {
        iconKind: 'pipeline',
        kindLabel: WORKFLOW_ITEM_LABEL,
        operationLabel: mutationLabel(receipt.operation),
        name: receipt.name,
        summary:
          receipt.description ||
          `${receipt.jobCount} jobs · ${receipt.stepCount} steps`,
        ...(receipt.enabled
          ? {}
          : { state: { label: 'Disabled', tone: 'muted' as const } }),
      };
    case 'skill':
      return {
        iconKind: 'skill',
        kindLabel: 'Skill',
        operationLabel: mutationLabel(receipt.operation),
        name: receipt.name,
        ...(receipt.description ? { summary: receipt.description } : {}),
        ...(receipt.source === 'shared' ? { sourceLabel: 'Shared' } : {}),
      };
    case 'automation':
      return {
        iconKind: 'automation',
        kindLabel: 'Automation',
        operationLabel: mutationLabel(receipt.operation),
        name: receipt.name,
        summary: joinSummary(
          receipt.enabled ? 'Enabled' : 'Disabled',
          receipt.schedule,
        ),
        ...(receipt.running ? { state: RUNNING_STATE } : {}),
      };
    case 'automation_run':
      return automationRunModel(receipt, live);
    case 'agent':
      return {
        iconKind: 'agent',
        kindLabel: MODEL_PRESET_LABEL,
        operationLabel: mutationLabel(receipt.operation),
        name: receipt.name,
        ...(receipt.description || receipt.model
          ? { summary: receipt.description || receipt.model }
          : {}),
        ...(receipt.source === 'shared' ? { sourceLabel: 'Shared' } : {}),
      };
    case 'capability_reference': {
      const state = REFERENCE_STATES[receipt.state];
      return {
        iconKind: receipt.itemKind,
        kindLabel: ITEM_KIND_LABELS[receipt.itemKind],
        operationLabel:
          receipt.relation === 'recommended' ? 'Recommended' : 'Found',
        name: receipt.name,
        ...(receipt.description ? { summary: receipt.description } : {}),
        ...(LOCAL_SOURCE_LABELS.has(receipt.sourceLabel)
          ? {}
          : { sourceLabel: receipt.sourceLabel }),
        ...(state ? { state } : {}),
        ...(receipt.reason ? { reason: receipt.reason } : {}),
      };
    }
  }
}

/**
 * Word one receipt for the shared capability tile. All tile copy lives here so
 * desktop and web never drift.
 */
export function capabilityTileModel(
  receipt: CapabilityTileReceipt,
  live: CapabilityTileLiveState = {},
): CapabilityTileModel {
  const model = baseModel(receipt, live);
  // A found or recommended item and a run are named by kind alone; a turn
  // that saved the item leads with what it did, e.g. "Updated pipeline".
  const kindPhrase =
    receipt.kind === 'capability_reference' || receipt.kind === 'automation_run'
      ? model.kindLabel
      : `${model.operationLabel} ${lowerFirstWord(model.kindLabel)}`;
  const external =
    receipt.kind === 'capability_reference' &&
    receipt.navigationTarget.kind === 'external_url';
  const removed = live.availability === 'removed';
  const changeSummary =
    receipt.kind === 'capability_reference' || receipt.kind === 'automation_run'
      ? undefined
      : describeCapabilityChangedFields(receipt.changedFields);
  // A run keeps its outcome after its automation is deleted; everything else
  // reports the removal as its state.
  const removedState =
    removed && receipt.kind !== 'automation_run'
      ? { state: { label: 'Removed', tone: 'muted' as const } }
      : {};
  return {
    ...model,
    kindPhrase,
    ...(changeSummary ? { changeSummary } : {}),
    ...removedState,
    ...(removed && receipt.kind === 'automation_run'
      ? { removedNote: 'Automation deleted' }
      : {}),
    external,
    removed,
  };
}

/** True for receipts the shared tile renders. */
export function isCapabilityTileReceipt(
  receipt: AgentArtifactReceiptV1,
): receipt is CapabilityTileReceipt {
  return (
    receipt.kind !== 'pipeline_run' && receipt.kind !== 'github_workflow_run'
  );
}

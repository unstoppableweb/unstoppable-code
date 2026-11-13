// ---------------------------------------------------------------------------
// Automations — shared trigger + automation helpers
// ---------------------------------------------------------------------------
//
// Pure helper module shared by the renderer (validation + next-trigger preview)
// and the main-process trigger scheduler (validation + dispatch). Stays
// dependency-free so it can be imported from both Electron processes and any
// node/jest test environment.
//
// Cron grammar implemented here is the locked-down five-field variant
// documented in the transport plan:
//   * Exactly five fields: minute, hour, day-of-month, month, day-of-week.
//   * Tokens: `*`, `*/N`, `A`, `A-B`, `A-B/N`, and comma-separated
//     combinations of any of the above.
//   * No named tokens (`@daily`, `MON`, `JAN`, …). The grammar is strict.
//   * Numeric ranges:
//       minute        0..59
//       hour          0..23
//       day-of-month  1..31
//       month         1..12
//       day-of-week   0..7  (0 and 7 both mean Sunday)
//   * Day-of-month / day-of-week matching rule mirrors POSIX cron: when both
//     fields are restricted, a moment matches if EITHER field matches;
//     otherwise all fields must match.
//
// DST behavior is inherited from Node's local-time `Date` constructor:
// `getNextCronRun` iterates minute boundaries by building local-time `Date`
// instances and reading their fields back via the `getXxx()` family. That
// means spring-forward gaps are skipped (a wall-clock time that does not
// exist locally never matches) and fall-back overlaps run a wall-clock
// match once per real minute — the resulting `Date` is taken at face value
// by the scheduler, which dedupes downstream by
// `${activity.id}:${scheduledFor}`.

import { ORCHESTRATOR_LABEL } from '@canopy/protocol';
import { validateSharedAutomationTargetRequirement } from '@canopy/protocol/automations';
import type {
  AgentModelConfig,
  AutomationAction,
  AutomationDependencies,
  AutomationIfCommandIdempotencyScope,
  AutomationTrigger,
  ParsedAutomationIfCommandOutput,
  ScheduledActivity,
} from '../types';
import {
  codexSpeedFastMode,
  isCodexSpeed,
  readCodexSpeedRecord,
} from '@canopy/execution-engine/lib/codex-speed';
import {
  APP_ADVISOR_PROJECT_ID,
  THINKING_LEVELS,
  isChatAttachmentPromptKind,
} from '../types';
import { isShareablePluginRef } from '@canopy/execution-engine/plugin-refs';
import {
  automationPipelineTargetError,
  resolveAutomationPipelineTarget,
} from './automation-pipeline-target';
import { isChatTabPluginSelections } from '@canopy/execution-engine/lib/plugin-selections-normalization';
import { brandEnvCandidates } from '@canopy/execution-engine/brand/env';
import { isApprovalMode } from './approval-engine';
import {
  mapConfiguredPromptText,
  validateConfiguredPromptReferences,
} from '@canopy/protocol/configured-prompt-references';
import {
  isPipelineContentHash,
  isPipelinePackageDigest,
  isPipelinePackageIdentifier,
  PIPELINE_PACKAGE_VERSION,
} from '@canopy/protocol/pipelines';
import { SIDEBAR_ITEM_GROUP_NAME_LIMIT } from '@canopy/protocol/sidebar';

// ---------------------------------------------------------------------------
// Cron parsing
// ---------------------------------------------------------------------------

/**
 * Parsed representation of a single cron field — an explicit, sorted list of
 * matching integer values. The field-set retains every legal value in range,
 * even if the source expression used `*`, so matching can stay a simple
 * `Set.has`.
 */
export interface ParsedCronField {
  /** Sorted, deduplicated set of matching integers. */
  values: number[];
  /**
   * Whether the source field was `*` (wildcard) at the top level. POSIX cron
   * uses this to drive the day-of-month / day-of-week OR rule.
   */
  isWildcard: boolean;
}

/** Successfully parsed five-field cron expression. */
export interface ParsedCron {
  minute: ParsedCronField;
  hour: ParsedCronField;
  dayOfMonth: ParsedCronField;
  month: ParsedCronField;
  dayOfWeek: ParsedCronField;
}

interface FieldSpec {
  name: 'minute' | 'hour' | 'dayOfMonth' | 'month' | 'dayOfWeek';
  min: number;
  max: number;
}

const FIELD_SPECS: readonly FieldSpec[] = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'dayOfMonth', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'dayOfWeek', min: 0, max: 7 },
];

/**
 * Parse a five-field cron expression into a {@link ParsedCron} or a structured
 * `{ error }` payload. The error message is plain English so the renderer can
 * surface it inline without additional formatting.
 */
export function parseFiveFieldCron(
  expression: string,
): ParsedCron | { error: string } {
  if (typeof expression !== 'string') {
    return { error: 'Cron expression must be a string.' };
  }
  const trimmed = expression.trim();
  if (trimmed.length === 0) {
    return { error: 'Cron expression must not be empty.' };
  }
  const fields = trimmed.split(/\s+/);
  if (fields.length !== 5) {
    return {
      error: `Cron expression must have exactly 5 fields (got ${fields.length}).`,
    };
  }

  const parsed: Partial<ParsedCron> = {};
  for (let index = 0; index < FIELD_SPECS.length; index++) {
    const spec = FIELD_SPECS[index];
    const fieldSource = fields[index];
    const field = parseCronField(fieldSource, spec);
    if ('error' in field) {
      return {
        error: `Invalid ${humanFieldName(spec.name)} field "${fieldSource}": ${field.error}`,
      };
    }
    parsed[spec.name] = field.field;
  }

  return parsed as ParsedCron;
}

function parseCronField(
  fieldSource: string,
  spec: FieldSpec,
): { field: ParsedCronField } | { error: string } {
  if (fieldSource.length === 0) {
    return { error: 'field is empty.' };
  }
  const segments = fieldSource.split(',');
  const valueSet = new Set<number>();
  let isWildcard = false;

  for (const segment of segments) {
    const result = parseCronSegment(segment, spec);
    if ('error' in result) {
      return { error: result.error };
    }
    if (result.isWildcard && segments.length === 1) {
      isWildcard = true;
    }
    for (const value of result.values) {
      valueSet.add(value);
    }
  }

  // Day-of-week: normalize 7 → 0 (both represent Sunday). After this step
  // matching can treat the field as 0..6.
  if (spec.name === 'dayOfWeek' && valueSet.has(7)) {
    valueSet.delete(7);
    valueSet.add(0);
  }

  if (valueSet.size === 0) {
    return { error: 'field matches no values.' };
  }

  const values = Array.from(valueSet).sort((a, b) => a - b);
  return { field: { values, isWildcard } };
}

interface CronSegmentResult {
  values: number[];
  isWildcard: boolean;
}

function parseCronSegment(
  segment: string,
  spec: FieldSpec,
): CronSegmentResult | { error: string } {
  if (segment.length === 0) {
    return { error: 'empty segment.' };
  }

  // Split off the optional step ("/N").
  let body = segment;
  let step = 1;
  const slashIndex = segment.indexOf('/');
  if (slashIndex !== -1) {
    body = segment.slice(0, slashIndex);
    const stepText = segment.slice(slashIndex + 1);
    if (body !== '*' && !body.includes('-')) {
      return {
        error: 'step syntax is only supported for wildcard or range segments.',
      };
    }
    if (!/^[0-9]+$/.test(stepText)) {
      return { error: `step "${stepText}" must be a positive integer.` };
    }
    const parsedStep = Number.parseInt(stepText, 10);
    if (!Number.isInteger(parsedStep) || parsedStep <= 0) {
      return { error: `step "${stepText}" must be a positive integer.` };
    }
    step = parsedStep;
  }

  let rangeStart: number;
  let rangeEnd: number;
  let isWildcard = false;

  if (body === '*') {
    rangeStart = spec.min;
    rangeEnd = spec.max;
    // Only a bare `*` (no step) is treated as a true wildcard. `*/N`
    // restricts the field — POSIX cron only triggers the day-of-month /
    // day-of-week OR rule for unrestricted fields.
    isWildcard = step === 1;
  } else if (body.includes('-')) {
    const dashIndex = body.indexOf('-');
    const startText = body.slice(0, dashIndex);
    const endText = body.slice(dashIndex + 1);
    if (!/^[0-9]+$/.test(startText) || !/^[0-9]+$/.test(endText)) {
      return { error: `range "${body}" must use numeric bounds.` };
    }
    rangeStart = Number.parseInt(startText, 10);
    rangeEnd = Number.parseInt(endText, 10);
    if (rangeStart > rangeEnd) {
      return {
        error: `range "${body}" must have start ≤ end.`,
      };
    }
  } else {
    if (!/^[0-9]+$/.test(body)) {
      return { error: `value "${body}" must be numeric.` };
    }
    rangeStart = Number.parseInt(body, 10);
    rangeEnd = rangeStart;
  }

  if (rangeStart < spec.min || rangeEnd > spec.max) {
    return {
      error: `values must fall within ${spec.min}..${spec.max} (got ${rangeStart}..${rangeEnd}).`,
    };
  }

  const values: number[] = [];
  for (let value = rangeStart; value <= rangeEnd; value += step) {
    values.push(value);
  }
  return { values, isWildcard };
}

function humanFieldName(name: FieldSpec['name']): string {
  switch (name) {
    case 'minute':
      return 'minute';
    case 'hour':
      return 'hour';
    case 'dayOfMonth':
      return 'day-of-month';
    case 'month':
      return 'month';
    case 'dayOfWeek':
      return 'day-of-week';
  }
}

// ---------------------------------------------------------------------------
// Next-run helpers
// ---------------------------------------------------------------------------

const MAX_LOOKAHEAD_YEARS = 5;
const MINUTE_MS = 60 * 1000;

/**
 * Compute the next moment after `after` that matches `expression`, or `null`
 * when no occurrence exists in the next {@link MAX_LOOKAHEAD_YEARS} years.
 *
 * The implementation steps minute-by-minute through local wall-clock time
 * (via `Date.getXxx()`), which naturally inherits Node's local-timezone DST
 * rules: spring-forward gaps cannot match because the underlying `Date`
 * never reports the missing wall-clock minute, while fall-back overlaps
 * match a single real-time minute (the scheduler is responsible for the
 * second-occurrence dedupe via run keys).
 */
export function getNextCronRun(expression: string, after: Date): Date | null {
  const parsed = parseFiveFieldCron(expression);
  if ('error' in parsed) {
    return null;
  }
  if (!(after instanceof Date) || Number.isNaN(after.getTime())) {
    return null;
  }
  return advanceToNextCronMatch(parsed, after);
}

function advanceToNextCronMatch(parsed: ParsedCron, after: Date): Date | null {
  // Start at the next whole local minute strictly after `after`. We bump the
  // candidate forward to the top of the next minute so the helper never
  // returns the same moment it was given.
  const candidate = new Date(after.getTime());
  candidate.setSeconds(0, 0);
  candidate.setTime(candidate.getTime() + MINUTE_MS);

  const limit =
    candidate.getTime() + MAX_LOOKAHEAD_YEARS * 366 * 24 * 60 * MINUTE_MS;

  while (candidate.getTime() <= limit) {
    if (matchesCronAtLocalTime(parsed, candidate)) {
      return new Date(candidate.getTime());
    }
    candidate.setTime(candidate.getTime() + MINUTE_MS);
  }

  return null;
}

function matchesCronAtLocalTime(parsed: ParsedCron, when: Date): boolean {
  // `getMonth` returns 0..11; cron month uses 1..12.
  const minute = when.getMinutes();
  const hour = when.getHours();
  const dayOfMonth = when.getDate();
  const month = when.getMonth() + 1;
  const dayOfWeek = when.getDay();

  if (!fieldMatches(parsed.minute, minute)) return false;
  if (!fieldMatches(parsed.hour, hour)) return false;
  if (!fieldMatches(parsed.month, month)) return false;

  const domRestricted = !parsed.dayOfMonth.isWildcard;
  const dowRestricted = !parsed.dayOfWeek.isWildcard;
  const domMatch = fieldMatches(parsed.dayOfMonth, dayOfMonth);
  const dowMatch = fieldMatches(parsed.dayOfWeek, dayOfWeek);

  if (domRestricted && dowRestricted) {
    return domMatch || dowMatch;
  }
  return domMatch && dowMatch;
}

function fieldMatches(field: ParsedCronField, value: number): boolean {
  // Day-of-week values are normalized to 0..6 during parsing, so `getDay()`
  // (which returns 0..6) lines up with `field.values` directly.
  return field.values.includes(value);
}

/**
 * Compute the next fire time for an {@link AutomationTrigger}. Mirrors
 * {@link getNextCronRun} for scheduled `cron` triggers; for `one_time`
 * triggers returns the parsed `runAt` if it is strictly after `after`, or
 * `null` otherwise (one-time triggers never repeat).
 */
export function getNextAutomationTriggerRun(
  trigger: AutomationTrigger,
  after: Date,
): Date | null {
  if (trigger.kind === 'cron') {
    return getNextCronRun(trigger.expression, after);
  }
  if (trigger.kind === 'one_time') {
    const runAt = new Date(trigger.runAt);
    if (Number.isNaN(runAt.getTime())) {
      return null;
    }
    if (runAt.getTime() <= after.getTime()) {
      return null;
    }
    return runAt;
  }
  return null;
}

export function getAutomationTriggerLabel(trigger: AutomationTrigger): string {
  switch (trigger.kind) {
    case 'cron':
      return 'Scheduled';
    case 'one_time':
      return 'One-time';
    default:
      return 'Unknown';
  }
}

// ---------------------------------------------------------------------------
// Occurrence enumeration — calendar-view contract
// ---------------------------------------------------------------------------
//
// Shared, in-process contract surface for the Automations "Triggered" calendar
// view. The renderer (consumer) plots every fire time of each automation inside
// a visible window; the expansion of a recurring trigger into concrete dated
// events is a pure, dependency-free helper so it stays importable from the
// renderer and unit-testable in plain Node.
//
// There is no IPC / network boundary here: the "transport" is this synchronous
// shared-library API. The types, signatures, and the exported cap constant
// below are the agreed surface across which the backend plan (producer of the
// real bodies) and the frontend plan (consumer) build independently.

/**
 * A single concrete fire of a {@link ScheduledActivity} at a dated instant.
 *
 * `key` is exactly `` `${activity.id}:${occursAt.getTime()}` ``. The renderer
 * relies on this format to de-dupe enumerated occurrences against past runs,
 * whose key is `` `${run.activityId}:${new Date(run.scheduledFor).getTime()}` ``.
 * Because cron `occursAt` and run `scheduledFor` are both minute-aligned local
 * instants produced by the same cron math, the keys for the same fire collide
 * exactly.
 */
export interface AutomationOccurrence {
  /** `${activity.id}:${occursAt.getTime()}` — stable de-dupe key. */
  key: string;
  /** The owning activity (carried so the renderer can label/colour the event). */
  activity: ScheduledActivity;
  /** Local-time instant at which this occurrence fires. */
  occursAt: Date;
}

/**
 * Options for {@link enumerateAutomationOccurrences}.
 *
 * The window is half-open: an occurrence exactly on `rangeStart` is included;
 * one exactly on `rangeEnd` is excluded.
 */
export interface EnumerateOccurrencesOptions {
  /** Inclusive lower bound of the visible window. */
  rangeStart: Date;
  /** Exclusive upper bound of the visible window (half-open). */
  rangeEnd: Date;
  /**
   * Per-activity cap on enumerated occurrences within the window. Defaults to
   * {@link DEFAULT_MAX_OCCURRENCES_PER_ACTIVITY} when omitted.
   */
  maxOccurrencesPerActivity?: number;
  /** When `true`, activities where `!activity.enabled` are also enumerated. */
  includeDisabled?: boolean;
}

/**
 * Result of {@link enumerateAutomationOccurrences}.
 *
 * `occurrences` are sorted ascending by `occursAt`. `truncated` is the OR of
 * per-activity truncation (any activity that hit `maxOccurrencesPerActivity`
 * within the window); it is informational, not an error.
 */
export interface EnumerateOccurrencesResult {
  occurrences: AutomationOccurrence[];
  truncated: boolean;
}

/**
 * Default per-activity occurrence cap. Public surface: the backend uses this as
 * the default when `EnumerateOccurrencesOptions.maxOccurrencesPerActivity` is
 * omitted, and the frontend may reference it.
 */
export const DEFAULT_MAX_OCCURRENCES_PER_ACTIVITY = 2000;

/**
 * Enumerate every fire time of a single {@link AutomationTrigger} within the
 * half-open window `[rangeStart, rangeEnd)`, up to `maxOccurrences`.
 *
 * Returns the concrete `Date`s (ascending) plus a `truncated` flag set when the
 * cap was reached before the window was exhausted.
 */
export function enumerateAutomationTriggerOccurrences(
  trigger: AutomationTrigger,
  rangeStart: Date,
  rangeEnd: Date,
  maxOccurrences: number,
): { occurrences: Date[]; truncated: boolean } {
  const occurrences: Date[] = [];
  const rangeEndTime = rangeEnd.getTime();
  let cursor = new Date(rangeStart.getTime() - 1);

  while (occurrences.length < maxOccurrences) {
    const next = getNextAutomationTriggerRun(trigger, cursor);
    if (next === null || next.getTime() >= rangeEndTime) {
      return { occurrences, truncated: false };
    }

    occurrences.push(next);
    cursor = next;
  }

  const next = getNextAutomationTriggerRun(trigger, cursor);
  return {
    occurrences,
    truncated: next !== null && next.getTime() < rangeEndTime,
  };
}

/**
 * Enumerate the occurrences of many {@link ScheduledActivity activities} across
 * the half-open window described by `options`, returning a flat, time-sorted
 * list plus an aggregate `truncated` flag.
 *
 * Contract semantics (binding on both the frontend and backend plans):
 * - The trigger for each activity is read from `activity.schedule` (named
 *   `schedule`, not `trigger`, for persisted compatibility).
 * - Activities where `!activity.enabled` are skipped unless
 *   `options.includeDisabled` is set.
 * - Each {@link AutomationOccurrence.key} is
 *   `` `${activity.id}:${occursAt.getTime()}` ``.
 * - `occurrences` are sorted ascending by `occursAt`.
 * - `truncated` is the OR of per-activity truncation.
 */
export function enumerateAutomationOccurrences(
  activities: ScheduledActivity[],
  options: EnumerateOccurrencesOptions,
): EnumerateOccurrencesResult {
  const maxOccurrencesPerActivity =
    options.maxOccurrencesPerActivity ?? DEFAULT_MAX_OCCURRENCES_PER_ACTIVITY;
  const occurrences: AutomationOccurrence[] = [];
  let truncated = false;

  for (const activity of activities) {
    if (!activity.enabled && !options.includeDisabled) {
      continue;
    }

    const result = enumerateAutomationTriggerOccurrences(
      activity.schedule,
      options.rangeStart,
      options.rangeEnd,
      maxOccurrencesPerActivity,
    );

    if (result.truncated) {
      truncated = true;
    }

    for (const occursAt of result.occurrences) {
      occurrences.push({
        key: `${activity.id}:${occursAt.getTime()}`,
        activity,
        occursAt,
      });
    }
  }

  occurrences.sort((left, right) => {
    return left.occursAt.getTime() - right.occursAt.getTime();
  });

  return { occurrences, truncated };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate an {@link AutomationTrigger}-shaped value. Returns `null` on
 * success, or a plain-English error message that callers can render inline.
 *
 * Renderer and main process MUST share this validator so a payload accepted
 * by the form is also accepted by the IPC handler.
 */
export function validateAutomationTrigger(trigger: unknown): string | null {
  if (!isPlainObject(trigger)) {
    return 'Trigger must be an object.';
  }
  if (trigger.timezone !== 'local') {
    return 'Trigger timezone must be "local".';
  }
  if (trigger.kind === 'cron') {
    if (typeof trigger.expression !== 'string') {
      return 'Scheduled trigger expression must be a string.';
    }
    const parsed = parseFiveFieldCron(trigger.expression);
    if ('error' in parsed) {
      return parsed.error;
    }
    if (getNextCronRun(trigger.expression, new Date()) === null) {
      return 'Scheduled trigger has no future runs.';
    }
    return null;
  }
  if (trigger.kind === 'one_time') {
    if (typeof trigger.runAt !== 'string' || trigger.runAt.trim() === '') {
      return 'One-time trigger runAt must be a non-empty ISO string.';
    }
    const runAt = new Date(trigger.runAt);
    if (Number.isNaN(runAt.getTime())) {
      return 'One-time trigger runAt must be a valid ISO date string.';
    }
    return null;
  }
  return `Unknown trigger kind: ${String(trigger.kind)}`;
}

/**
 * Validate an {@link AutomationAction}. Returns `null` on success, or a
 * plain-English error message describing the first failure encountered.
 */
export function validateAutomationAction(action: unknown): string | null {
  if (!isPlainObject(action)) {
    return 'Action must be an object.';
  }
  if (action.sidebarGroupName !== undefined) {
    if (
      action.type !== 'app_advisor_prompt' &&
      action.type !== 'standalone_prompt' &&
      action.type !== 'worktree_prompt'
    ) {
      return 'sidebarGroupName is only supported for prompt automation actions.';
    }
    if (typeof action.sidebarGroupName !== 'string') {
      return 'Prompt action sidebarGroupName, when provided, must be a string.';
    }
    if (
      Array.from(action.sidebarGroupName.trim()).length >
      SIDEBAR_ITEM_GROUP_NAME_LIMIT
    ) {
      return `Prompt action sidebarGroupName must be at most ${SIDEBAR_ITEM_GROUP_NAME_LIMIT} Unicode code points after trimming.`;
    }
  }
  if (typeof action.prompt === 'string') {
    const referencesError = validateConfiguredPromptReferences(
      action.prompt,
      action.promptReferences,
    );
    if (referencesError) return referencesError;
    if (
      action.promptReferences !== undefined &&
      action.fileReferences !== undefined
    ) {
      return 'promptReferences and legacy fileReferences cannot both be written.';
    }
  }
  switch (action.type) {
    case 'app_advisor_prompt':
      if (!isNonEmptyString(action.prompt)) {
        return `${ORCHESTRATOR_LABEL} prompt action requires a non-empty prompt.`;
      }
      if (
        action.approvalMode !== undefined &&
        !isApprovalMode(action.approvalMode)
      ) {
        return `${ORCHESTRATOR_LABEL} prompt action approvalMode, when provided, must be a valid approval mode.`;
      }
      if (action.planMode !== undefined && typeof action.planMode !== 'boolean')
        return `${ORCHESTRATOR_LABEL} prompt action planMode must be a boolean.`;
      if (
        action.workEntryId !== undefined &&
        !isNonEmptyString(action.workEntryId)
      ) {
        return `${ORCHESTRATOR_LABEL} prompt action workEntryId, when provided, must be a non-empty string.`;
      }
      return validateAutomationPromptChatSettings(
        action,
        `${ORCHESTRATOR_LABEL} prompt action`,
      );
    case 'standalone_prompt':
      if (!isNonEmptyString(action.chatProjectId)) {
        return 'Standalone prompt action requires a chatProjectId.';
      }
      if (!isNonEmptyString(action.prompt)) {
        return 'Standalone prompt action requires a non-empty prompt.';
      }
      if (
        action.approvalMode !== undefined &&
        !isApprovalMode(action.approvalMode)
      ) {
        return 'Standalone prompt action approvalMode, when provided, must be a valid approval mode.';
      }
      if (action.planMode !== undefined && typeof action.planMode !== 'boolean')
        return 'Standalone prompt action planMode must be a boolean.';
      if (
        action.workEntryId !== undefined &&
        !isNonEmptyString(action.workEntryId)
      ) {
        return 'Standalone prompt action workEntryId, when provided, must be a non-empty string.';
      }
      return validateAutomationPromptChatSettings(
        action,
        'Standalone prompt action',
      );
    case 'worktree_prompt':
      if (!isNonEmptyString(action.workspaceId)) {
        return 'Worktree prompt action requires a workspaceId.';
      }
      if (
        action.baseWorktreeId !== undefined &&
        !isNonEmptyString(action.baseWorktreeId)
      ) {
        return 'Worktree prompt action baseWorktreeId, when provided, must be a non-empty string.';
      }
      if (
        action.baseBranch !== undefined &&
        !isNonEmptyString(action.baseBranch)
      ) {
        return 'Worktree prompt action baseBranch, when provided, must be a non-empty string.';
      }
      if (
        action.existingBranch !== undefined &&
        !isNonEmptyString(action.existingBranch)
      ) {
        return 'Worktree prompt action existingBranch, when provided, must be a non-empty string.';
      }
      if (
        action.existingWorktreeId !== undefined &&
        !isNonEmptyString(action.existingWorktreeId)
      ) {
        return 'Worktree prompt action existingWorktreeId, when provided, must be a non-empty string.';
      }
      if (
        [
          action.existingWorktreeId,
          action.existingBranch,
          action.baseWorktreeId,
          action.baseBranch,
        ].filter((value) => value !== undefined).length > 1
      ) {
        return 'Worktree prompt action existingWorktreeId, existingBranch, baseWorktreeId, and baseBranch are mutually exclusive.';
      }
      if (!isNonEmptyString(action.prompt)) {
        return 'Worktree prompt action requires a non-empty prompt.';
      }
      {
        const settingsError = validateAutomationPromptChatSettings(
          action,
          'Worktree prompt action',
        );
        if (settingsError) return settingsError;
      }
      if (
        action.planMode !== undefined &&
        typeof action.planMode !== 'boolean'
      ) {
        return 'Worktree prompt action planMode, when provided, must be a boolean.';
      }
      if (
        action.approvalMode !== undefined &&
        !isApprovalMode(action.approvalMode)
      ) {
        return 'Worktree prompt action approvalMode, when provided, must be a valid approval mode.';
      }
      if (
        action.interfaceMode !== undefined &&
        action.interfaceMode !== 'canopy' &&
        action.interfaceMode !== 'claude-code' &&
        action.interfaceMode !== 'auto'
      ) {
        return 'Worktree prompt action interfaceMode, when provided, must be canopy, claude-code, or auto.';
      }
      if (action.purpose !== undefined && action.purpose !== 'scheduled_task') {
        return 'Worktree prompt action purpose, when provided, must be scheduled_task.';
      }
      if (
        action.workspaceName !== undefined &&
        typeof action.workspaceName !== 'string'
      ) {
        return 'Worktree prompt action workspaceName, when provided, must be a string.';
      }
      return null;
    case 'worktree_session_prompt':
      if (!isNonEmptyString(action.workspaceId)) {
        return 'Worktree Session prompt action requires a workspaceId.';
      }
      if (!isNonEmptyString(action.worktreeId)) {
        return 'Worktree Session prompt action requires a worktreeId.';
      }
      if (!isNonEmptyString(action.chatId)) {
        return 'Worktree Session prompt action requires a chatId.';
      }
      if (!isNonEmptyString(action.prompt)) {
        return 'Worktree Session prompt action requires a non-empty prompt.';
      }
      if (action.planMode !== undefined && typeof action.planMode !== 'boolean')
        return 'Worktree Session prompt action planMode must be a boolean.';
      if (
        action.approvalMode !== undefined &&
        !isApprovalMode(action.approvalMode)
      )
        return 'Worktree Session prompt action approvalMode must be valid.';
      {
        const settingsError = validateAutomationPromptChatSettings(
          action,
          'Worktree Session prompt action',
        );
        if (settingsError) return settingsError;
      }
      if (
        action.inputMode !== undefined &&
        action.inputMode !== 'typed' &&
        action.inputMode !== 'voice'
      ) {
        return 'Worktree Session prompt action inputMode, when provided, must be typed or voice.';
      }
      if (
        action.attachmentPaths !== undefined &&
        !isStringArray(action.attachmentPaths)
      ) {
        return 'Worktree Session prompt action attachmentPaths, when provided, must be an array of strings.';
      }
      if (
        action.fileReferences !== undefined &&
        (!Array.isArray(action.fileReferences) ||
          !action.fileReferences.every(isSerializableFileReference))
      ) {
        return 'Worktree Session prompt action fileReferences, when provided, must be an array of file references.';
      }
      if (
        action.attachmentPromptContexts !== undefined &&
        (!Array.isArray(action.attachmentPromptContexts) ||
          !action.attachmentPromptContexts.every(isChatAttachmentPromptContext))
      ) {
        return 'Worktree Session prompt action attachmentPromptContexts, when provided, must be an array of attachment prompt contexts.';
      }
      if (
        action.purpose !== undefined &&
        action.purpose !== 'usage_limit_resume' &&
        action.purpose !== 'scheduled_send'
      ) {
        return 'Worktree Session prompt action purpose, when provided, must be usage_limit_resume or scheduled_send.';
      }
      if (
        action.workspaceName !== undefined &&
        typeof action.workspaceName !== 'string'
      ) {
        return 'Worktree Session prompt action workspaceName, when provided, must be a string.';
      }
      if (
        action.worktreeName !== undefined &&
        typeof action.worktreeName !== 'string'
      ) {
        return 'Worktree Session prompt action worktreeName, when provided, must be a string.';
      }
      if (
        action.chatTitle !== undefined &&
        typeof action.chatTitle !== 'string'
      ) {
        return 'Worktree Session prompt action chatTitle, when provided, must be a string.';
      }
      return null;
    case 'worktree_pipeline': {
      const targetError = automationPipelineTargetError(action);
      if (targetError) return targetError;
      if (!isNonEmptyString(action.pipelineId)) {
        return 'Worktree pipeline action requires a pipelineId.';
      }
      if (
        action.pipelineSource !== undefined &&
        action.pipelineSource !== 'bundled' &&
        action.pipelineSource !== 'user' &&
        action.pipelineSource !== 'project' &&
        action.pipelineSource !== 'shared' &&
        action.pipelineSource !== 'curated'
      ) {
        return 'Worktree pipeline action pipelineSource, when provided, must be bundled, user, project, shared, or curated.';
      }
      if (
        action.baseWorktreeId !== undefined &&
        !isNonEmptyString(action.baseWorktreeId)
      ) {
        return 'Worktree pipeline action baseWorktreeId, when provided, must be a non-empty string.';
      }
      if (
        action.pipelineName !== undefined &&
        typeof action.pipelineName !== 'string'
      ) {
        return 'Worktree pipeline action pipelineName, when provided, must be a string.';
      }
      if (action.repoId !== undefined && !isNonEmptyString(action.repoId)) {
        return 'Worktree pipeline action repoId, when provided, must be a non-empty string.';
      }
      if (
        action.projectPipelineFilename !== undefined &&
        !isNonEmptyString(action.projectPipelineFilename)
      ) {
        return 'Worktree pipeline action projectPipelineFilename, when provided, must be a non-empty string.';
      }
      if (action.sharedPipeline !== undefined) {
        if (
          !isPlainObject(action.sharedPipeline) ||
          !isNonEmptyString(action.sharedPipeline.serverId) ||
          !isNonEmptyString(action.sharedPipeline.remoteId)
        ) {
          return 'Worktree pipeline action sharedPipeline, when provided, must include serverId and remoteId.';
        }
        const installPin = action.sharedPipeline.installPin;
        if (
          installPin !== undefined &&
          (!isPlainObject(installPin) ||
            !isPipelineContentHash(installPin.pipelineContentHash) ||
            (installPin.distributionMode !== 'package' &&
              installPin.distributionMode !== 'definition_only') ||
            (installPin.distributionMode === 'package'
              ? !isPipelinePackageDigest(installPin.packageDigest)
              : installPin.packageDigest !== undefined))
        ) {
          return 'Worktree pipeline action sharedPipeline.installPin must be a valid pipeline install pin.';
        }
      }
      if (action.pipelineSource === 'shared' && !action.sharedPipeline) {
        return 'Worktree pipeline action sharedPipeline is required for shared pipelines.';
      }
      if (action.inputs !== undefined) {
        const inputsError = validateStringRecord(action.inputs, 'inputs');
        if (inputsError) {
          return `Worktree pipeline action ${inputsError}`;
        }
      }
      if (
        action.pluginCollectionPreferences !== undefined &&
        !isPlainObject(action.pluginCollectionPreferences)
      ) {
        return 'Worktree pipeline action pluginCollectionPreferences, when provided, must be an object.';
      }
      if (action.modelAliasPreferences !== undefined) {
        const aliasPreferenceError = validateAutomationModelAliasPreferences(
          action.modelAliasPreferences,
        );
        if (aliasPreferenceError) {
          return `Worktree pipeline action ${aliasPreferenceError}`;
        }
      }
      if (action.modelConfig !== undefined) {
        const modelConfigError = validateAutomationModelConfig(
          action.modelConfig,
          'Worktree pipeline action modelConfig',
        );
        if (modelConfigError) return modelConfigError;
        // Ultra fast is rejected on writes (validateAutomationActionForWrite)
        // and before a run, not here: this validator also gates persisted
        // reads, where rejecting would silently drop the stored automation.
      }
      return null;
    }
    case 'pipeline_execution_resume':
      if (!isNonEmptyString(action.executionId)) {
        return 'Pipeline execution resume action requires an executionId.';
      }
      if (
        !Array.isArray(action.statusReasonIds) ||
        action.statusReasonIds.length === 0 ||
        !action.statusReasonIds.every(isNonEmptyString) ||
        new Set(action.statusReasonIds).size !== action.statusReasonIds.length
      ) {
        return 'Pipeline execution resume action statusReasonIds must be a non-empty unique string array.';
      }
      if (action.provider !== 'claude' && action.provider !== 'codex') {
        return 'Pipeline execution resume action provider must be claude or codex.';
      }
      if (action.purpose !== 'usage_limit_resume') {
        return 'Pipeline execution resume action purpose must be usage_limit_resume.';
      }
      if (!isNonEmptyString(action.pipelineName)) {
        return 'Pipeline execution resume action requires a pipelineName.';
      }
      for (const [name, value] of [
        ['projectId', action.projectId],
        ['worktreeId', action.worktreeId],
        ['workspaceName', action.workspaceName],
        ['worktreeName', action.worktreeName],
      ] as const) {
        if (value !== undefined && typeof value !== 'string') {
          return `Pipeline execution resume action ${name}, when provided, must be a string.`;
        }
      }
      return null;
    default:
      return `Unknown action type: ${String(action.type)}`;
  }
}

function isThinkingLevelValue(value: unknown): boolean {
  return typeof value === 'string' && THINKING_LEVELS.includes(value as never);
}

function validateAutomationPromptChatSettings(
  action: unknown,
  label: string,
): string | null {
  if (!isPlainObject(action)) {
    return `${label} must be an object.`;
  }
  if (action.model !== undefined && !isNonEmptyString(action.model)) {
    return `${label} model, when provided, must be a non-empty string.`;
  }
  if (action.thinking !== undefined && !isThinkingLevelValue(action.thinking)) {
    return `${label} thinking, when provided, must be a valid thinking level.`;
  }
  if (action.modelConfig !== undefined) {
    const modelConfigError = validateAutomationModelConfig(
      action.modelConfig,
      `${label} modelConfig`,
    );
    if (modelConfigError) return modelConfigError;
  }
  if (action.plugins !== undefined) {
    if (!Array.isArray(action.plugins)) {
      return `${label} plugins, when provided, must be an array.`;
    }
    if (!action.plugins.every((plugin) => isShareablePluginRef(plugin))) {
      return `${label} plugins must contain only shareable plugin refs.`;
    }
  }
  if (
    action.pluginSelections !== undefined &&
    !isChatTabPluginSelections(action.pluginSelections)
  ) {
    return `${label} pluginSelections, when provided, must be valid chat plugin selections.`;
  }
  return null;
}

function validateAutomationModelAliasPreferences(
  value: unknown,
): string | null {
  if (!isPlainObject(value)) {
    return 'modelAliasPreferences, when provided, must be an object.';
  }
  for (const [aliasId, rawPreference] of Object.entries(value)) {
    const trimmedAliasId = aliasId.trim();
    if (!trimmedAliasId) {
      return 'modelAliasPreferences keys must be non-empty alias ids.';
    }
    if (!isPlainObject(rawPreference)) {
      return `modelAliasPreferences.${trimmedAliasId} must be an object.`;
    }
    if (rawPreference.mode === 'reset') {
      continue;
    }
    if (rawPreference.mode === 'agent') {
      const agentId =
        typeof rawPreference.agent_id === 'string'
          ? rawPreference.agent_id.trim()
          : '';
      if (!agentId || !agentId.startsWith('agent_model_')) {
        return `modelAliasPreferences.${trimmedAliasId}.agent_id must be an Agent model id.`;
      }
      continue;
    }
    if (rawPreference.mode === 'inline') {
      const base =
        typeof rawPreference.base === 'string' ? rawPreference.base.trim() : '';
      if (!base) {
        return `modelAliasPreferences.${trimmedAliasId}.base must be a non-empty string.`;
      }
      if (
        rawPreference.instructions !== undefined &&
        typeof rawPreference.instructions !== 'string'
      ) {
        return `modelAliasPreferences.${trimmedAliasId}.instructions, when provided, must be a string.`;
      }
      if (
        rawPreference.plugin_collection_id !== undefined &&
        !(
          typeof rawPreference.plugin_collection_id === 'string' &&
          rawPreference.plugin_collection_id.trim().length > 0
        )
      ) {
        return `modelAliasPreferences.${trimmedAliasId}.plugin_collection_id, when provided, must be a non-empty string.`;
      }
      continue;
    }
    return `modelAliasPreferences.${trimmedAliasId}.mode must be inline, agent, or reset.`;
  }
  return null;
}

function validateAutomationModelConfig(
  config: unknown,
  label: string,
): string | null {
  if (!isPlainObject(config)) {
    return `${label}, when provided, must be an object.`;
  }
  if (
    config.thinkingLevel !== undefined &&
    !isThinkingLevelValue(config.thinkingLevel)
  ) {
    return `${label}.thinkingLevel, when provided, must be a valid thinking level.`;
  }
  if (config.fastMode !== undefined && typeof config.fastMode !== 'boolean') {
    return `${label}.fastMode, when provided, must be a boolean.`;
  }
  if (config.speed !== undefined) {
    if (!isCodexSpeed(config.speed)) {
      return `${label}.speed, when provided, must be standard, fast, or ultrafast.`;
    }
    if (
      config.fastMode !== undefined &&
      config.fastMode !== codexSpeedFastMode(config.speed)
    ) {
      return `${label}.fastMode must match its speed.`;
    }
  }
  return null;
}

/**
 * Pipeline runs keep the legacy boolean Fast mode and cannot run Ultra fast.
 * Returns a user-facing rejection for an Ultra fast request (validated at
 * create/update and re-checked before a run starts), never a silent downgrade.
 */
export function automationPipelineSpeedError(
  config: AgentModelConfig | undefined,
): string | null {
  return readCodexSpeedRecord(config) === 'ultrafast'
    ? 'Workflow automations do not support Ultra fast. Choose Regular or Fast.'
    : null;
}

/**
 * Validation for create/update writes: {@link validateAutomationAction} plus
 * write-only policy such as rejecting Ultra fast on pipeline actions. Persisted
 * reads keep using `validateAutomationAction` so stored records are never
 * silently dropped; runs re-check {@link automationPipelineSpeedError}.
 */
export function validateAutomationActionForWrite(
  action: unknown,
): string | null {
  const actionError = validateAutomationAction(action);
  if (actionError) return actionError;
  if (
    isPlainObject(action) &&
    action.type === 'worktree_pipeline' &&
    isPlainObject(action.modelConfig)
  ) {
    return automationPipelineSpeedError({
      speed: isCodexSpeed(action.modelConfig.speed)
        ? action.modelConfig.speed
        : undefined,
      fastMode:
        typeof action.modelConfig.fastMode === 'boolean'
          ? action.modelConfig.fastMode
          : undefined,
    });
  }
  return null;
}

/**
 * Validate a `automations.create` request payload. Returns `null` on
 * success, or the first plain-English validation error encountered.
 *
 * The validator is intentionally strict about strings (non-empty after
 * trim) so renderer and main process reject the same inputs. `enabled`
 * defaults are NOT applied here — the validator only flags
 * structural/data errors.
 */
// Same contract as the app's `validateId` (`main/lib/validation.ts`):
// lowercase alphanumerics and hyphens, starting alphanumeric. Server-side
// shared-resource UUIDs satisfy it. Replicated here because desktop-shared
// cannot import app main modules.
const INSTALLED_FROM_REMOTE_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
// Server-computed content hashes are 64 lowercase hex characters (the same
// contract the web service enforces for savedFrom lineage).
const INSTALLED_FROM_CONTENT_HASH_PATTERN = /^[0-9a-f]{64}$/;
const INSTALLED_FROM_PIPELINE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/** Most pipelines one automation may list as dependencies. */
export const MAX_AUTOMATION_PIPELINE_DEPENDENCIES = 50;
const MAX_AUTOMATION_PIPELINE_DEPENDENCY_ID_CHARS = 1024;

function isParseableTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

export function validateAutomationSharedPipelineReview(
  value: unknown,
): string | null {
  if (value === undefined) return null;
  if (!isPlainObject(value)) {
    return 'Automation sharedPipelineReview, when provided, must be an object.';
  }
  if (!isParseableTimestamp(value.detectedAt)) {
    return 'Automation sharedPipelineReview.detectedAt must be a parseable timestamp.';
  }
  if (!isNonEmptyString(value.remoteId)) {
    return 'Automation sharedPipelineReview.remoteId must be a non-empty string.';
  }
  if (
    value.pipelineName !== undefined &&
    typeof value.pipelineName !== 'string'
  ) {
    return 'Automation sharedPipelineReview.pipelineName, when provided, must be a string.';
  }
  return null;
}

export function normalizeAutomationSharedPipelineReview(
  value: ScheduledActivity['sharedPipelineReview'],
): ScheduledActivity['sharedPipelineReview'] {
  if (!value) return undefined;
  const pipelineName = value.pipelineName?.trim();
  return {
    detectedAt: value.detectedAt,
    remoteId: value.remoteId,
    ...(pipelineName ? { pipelineName } : {}),
  };
}

/**
 * Shape check for {@link AutomationInstalledFromMetadata} on IPC requests:
 * `remoteId` must satisfy the repo id contract, `contentHash` must be a
 * 64-hex server hash, and `installedAt` plus the optional stale/reported
 * stamps must be parseable timestamps.
 */
export function validateAutomationInstalledFrom(value: unknown): string | null {
  if (value === undefined) return null;
  if (!isPlainObject(value)) {
    return 'Automation installedFrom, when provided, must be an object.';
  }
  if (
    !isNonEmptyString(value.remoteId) ||
    !INSTALLED_FROM_REMOTE_ID_PATTERN.test(value.remoteId)
  ) {
    return 'Automation installedFrom.remoteId must be a valid shared resource id.';
  }
  if (
    !isNonEmptyString(value.contentHash) ||
    !INSTALLED_FROM_CONTENT_HASH_PATTERN.test(value.contentHash)
  ) {
    return 'Automation installedFrom.contentHash must be a 64-character hex hash.';
  }
  if (!isParseableTimestamp(value.installedAt)) {
    return 'Automation installedFrom.installedAt must be a parseable timestamp.';
  }
  if (
    value.sourceKind !== undefined &&
    value.sourceKind !== 'shared' &&
    value.sourceKind !== 'public' &&
    value.sourceKind !== 'curated'
  ) {
    return 'Automation installedFrom.sourceKind must be shared, public, or curated.';
  }
  if (
    value.bundledPipelineLocalId !== undefined &&
    (!isNonEmptyString(value.bundledPipelineLocalId) ||
      !INSTALLED_FROM_PIPELINE_ID_PATTERN.test(value.bundledPipelineLocalId))
  ) {
    return 'Automation installedFrom.bundledPipelineLocalId must be a valid local pipeline id.';
  }
  if (
    value.bundledPipelineContentHash !== undefined &&
    (!isNonEmptyString(value.bundledPipelineContentHash) ||
      !INSTALLED_FROM_CONTENT_HASH_PATTERN.test(
        value.bundledPipelineContentHash,
      ))
  ) {
    return 'Automation installedFrom.bundledPipelineContentHash must be a 64-character hex hash.';
  }
  const pipelineDependenciesError = validateInstalledPipelineDependencies(
    value.pipelineDependencies,
  );
  if (pipelineDependenciesError) return pipelineDependenciesError;
  if (
    value.capabilityPackage !== undefined &&
    (!isPlainObject(value.capabilityPackage) ||
      value.capabilityPackage.version !== PIPELINE_PACKAGE_VERSION ||
      !isPipelinePackageDigest(value.capabilityPackage.digest))
  ) {
    return 'Automation installedFrom.capabilityPackage must be a valid package reference.';
  }
  if (
    value.approvedRunCondition !== undefined &&
    (!isNonEmptyString(value.approvedRunCondition) ||
      validateAutomationIfCommand(value.approvedRunCondition) !== null)
  ) {
    return 'Automation installedFrom.approvedRunCondition, when provided, must be a valid run-condition command.';
  }
  for (const key of [
    'staleAt',
    'firstEnableReportedAt',
    'firstSuccessReportedAt',
  ] as const) {
    if (value[key] !== undefined && !isParseableTimestamp(value[key])) {
      return `Automation installedFrom.${key}, when provided, must be a parseable timestamp.`;
    }
  }
  return null;
}

function validateInstalledPipelineDependencies(value: unknown): string | null {
  if (value === undefined) return null;
  const invalid =
    'Automation installedFrom.pipelineDependencies must list { key, localPipelineId, pipelineContentHash } entries.';
  if (
    !Array.isArray(value) ||
    value.length > MAX_AUTOMATION_PIPELINE_DEPENDENCIES
  ) {
    return invalid;
  }
  const entries: unknown[] = value;
  const keys = new Set<string>();
  for (const entry of entries) {
    if (
      !isPlainObject(entry) ||
      !isPipelinePackageIdentifier(entry.key) ||
      !isNonEmptyString(entry.localPipelineId) ||
      !INSTALLED_FROM_PIPELINE_ID_PATTERN.test(entry.localPipelineId) ||
      !isNonEmptyString(entry.pipelineContentHash) ||
      !INSTALLED_FROM_CONTENT_HASH_PATTERN.test(entry.pipelineContentHash)
    ) {
      return invalid;
    }
    if (keys.has(entry.key)) {
      return `Automation installedFrom.pipelineDependencies lists "${entry.key}" more than once.`;
    }
    keys.add(entry.key);
  }
  return null;
}

/**
 * Shape check for {@link AutomationDependencies} on a write. `null` is
 * accepted only when `allowNull` is set (an update clearing the list).
 * Duplicates are allowed here and removed by
 * {@link normalizeAutomationDependencies}.
 */
export function validateAutomationDependencies(
  value: unknown,
  options: { allowNull?: boolean } = {},
): string | null {
  if (value === undefined) return null;
  if (value === null && options.allowNull === true) return null;
  if (!isPlainObject(value) || !Array.isArray(value.pipelines)) {
    return 'Automation dependencies must be an object with a pipelines list.';
  }
  const pipelines: unknown[] = value.pipelines;
  if (pipelines.length > MAX_AUTOMATION_PIPELINE_DEPENDENCIES) {
    return `An automation can list at most ${MAX_AUTOMATION_PIPELINE_DEPENDENCIES} pipelines.`;
  }
  for (const pipeline of pipelines) {
    if (
      !isPlainObject(pipeline) ||
      !isNonEmptyString(pipeline.pipelineId) ||
      pipeline.pipelineId.trim() !== pipeline.pipelineId ||
      pipeline.pipelineId.length >
        MAX_AUTOMATION_PIPELINE_DEPENDENCY_ID_CHARS ||
      (pipeline.source !== 'user' && pipeline.source !== 'project')
    ) {
      return 'Each automation pipeline dependency needs a pipelineId and a source of user or project.';
    }
  }
  return null;
}

/**
 * Canonical stored form of validated dependencies: only the known fields, in
 * first-seen order, deduplicated by `source` + `pipelineId`. Returns
 * `undefined` for an empty list so the activity omits the field.
 */
export function normalizeAutomationDependencies(
  value: AutomationDependencies,
): AutomationDependencies | undefined {
  const seen = new Set<string>();
  const pipelines: AutomationDependencies['pipelines'] = [];
  for (const pipeline of value.pipelines) {
    const identity = `${pipeline.source}:${pipeline.pipelineId}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    pipelines.push({
      pipelineId: pipeline.pipelineId,
      source: pipeline.source,
    });
  }
  return pipelines.length > 0 ? { pipelines } : undefined;
}

export function validateAutomationCreateRequest(input: unknown): string | null {
  if (!isPlainObject(input)) {
    return 'Automation request must be an object.';
  }
  if (!isNonEmptyString(input.name)) {
    return 'Automation name must be a non-empty string.';
  }
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') {
    return 'Automation enabled, when provided, must be a boolean.';
  }
  const scheduleError = validateAutomationTrigger(input.schedule);
  if (scheduleError) return scheduleError;
  const actionError = validateAutomationActionForWrite(input.action);
  if (actionError) return actionError;
  const ifCommandError = validateAutomationIfCommand(input.ifCommand);
  if (ifCommandError) return ifCommandError;
  const installedFromError = validateAutomationInstalledFrom(
    input.installedFrom,
  );
  if (installedFromError) return installedFromError;
  const dependenciesError = validateAutomationDependencies(input.dependencies);
  if (dependenciesError) return dependenciesError;
  // Main parses the owner and checks it against the account.
  if (
    input.executionContext !== undefined &&
    typeof input.executionContext !== 'string'
  ) {
    return 'Automation executionContext, when provided, must be a string.';
  }
  if (input.targetRequirement !== undefined) {
    const result = validateSharedAutomationTargetRequirement(
      input.targetRequirement,
    );
    if (!result.ok) return result.error;
  }
  return null;
}

/**
 * Format a parser-level cron error string for user-facing surfaces. Today
 * this is a thin pass-through that capitalizes the first letter; it exists
 * so the renderer and main process can share a single formatter if the
 * preview rendering grows more nuanced (e.g. localized strings).
 */
export function formatCronValidationError(error: string): string {
  if (typeof error !== 'string' || error.length === 0) return error;
  return error.charAt(0).toUpperCase() + error.slice(1);
}

/**
 * Build a short human-readable label for an {@link AutomationAction}. Used
 * by both the renderer (history rows / form preview) and the main process
 * (log lines / OS notifications) so both surfaces describe the same action
 * with identical text.
 */
export interface AutomationActionNameResolver {
  standaloneChatProjectName?: (chatProjectId: string) => string | undefined;
  workspaceName?: (workspaceId: string) => string | undefined;
  worktreeName?: (
    workspaceId: string,
    worktreeId: string,
  ) => string | undefined;
  chatTitle?: (
    workspaceId: string,
    worktreeId: string,
    chatId: string,
  ) => string | undefined;
}

export type AutomationChatRunMode = 'new_chat' | 'existing_chat';

/**
 * Return the chat run mode expressed by an action, or `undefined` for actions
 * that do not use the automation chat-destination selector.
 *
 * `existing_chat` covers every action that reuses an existing worktree or
 * Work Entry: continuing one of its chats, or opening a new chat in it each
 * run (`existingWorktreeId` / `workEntryId`). Worktree provisioning sources
 * (`baseWorktreeId`, `baseBranch`, `existingBranch`) still create a new
 * worktree, so they deliberately remain in `new_chat` mode.
 */
export function getAutomationChatRunMode(
  action: AutomationAction,
): AutomationChatRunMode | undefined {
  switch (action.type) {
    case 'app_advisor_prompt':
    case 'standalone_prompt':
      return action.workEntryId ? 'existing_chat' : 'new_chat';
    case 'worktree_prompt':
      return action.existingWorktreeId ? 'existing_chat' : 'new_chat';
    case 'worktree_session_prompt':
      return 'existing_chat';
    case 'worktree_pipeline':
    case 'pipeline_execution_resume':
      return undefined;
    default:
      return undefined;
  }
}

/**
 * The existing worktree / Work Entry an `existing_chat` action runs in, keyed
 * like a chat session: the Work Entry id occupies the `worktreeId` slot and
 * App Advisor entries use `APP_ADVISOR_PROJECT_ID`. `chatId` is `''` when each
 * run opens a new chat in the container. `undefined` for every other action.
 */
export interface AutomationExistingChatTarget {
  workspaceId: string;
  worktreeId: string;
  chatId: string;
  workspaceName?: string;
  worktreeName?: string;
  chatTitle?: string;
}

export function getAutomationExistingChatTarget(
  action: AutomationAction,
): AutomationExistingChatTarget | undefined {
  switch (action.type) {
    case 'worktree_session_prompt':
      return {
        workspaceId: action.workspaceId,
        worktreeId: action.worktreeId,
        chatId: action.chatId,
        ...(action.workspaceName
          ? { workspaceName: action.workspaceName }
          : {}),
        ...(action.worktreeName ? { worktreeName: action.worktreeName } : {}),
        ...(action.chatTitle ? { chatTitle: action.chatTitle } : {}),
      };
    case 'worktree_prompt':
      return action.existingWorktreeId
        ? {
            workspaceId: action.workspaceId,
            worktreeId: action.existingWorktreeId,
            chatId: '',
            ...(action.workspaceName
              ? { workspaceName: action.workspaceName }
              : {}),
          }
        : undefined;
    case 'standalone_prompt':
      return action.workEntryId
        ? {
            workspaceId: action.chatProjectId,
            worktreeId: action.workEntryId,
            chatId: '',
          }
        : undefined;
    case 'app_advisor_prompt':
      return action.workEntryId
        ? {
            workspaceId: APP_ADVISOR_PROJECT_ID,
            worktreeId: action.workEntryId,
            chatId: '',
          }
        : undefined;
    case 'worktree_pipeline':
    case 'pipeline_execution_resume':
      return undefined;
  }
}

export function getAutomationChatRunModeLabel(
  mode: AutomationChatRunMode,
): string {
  return mode === 'new_chat' ? 'New chat each run' : 'Existing chat';
}

export function describeAutomationAction(
  action: AutomationAction,
  nameResolver: AutomationActionNameResolver = {},
): string {
  switch (action.type) {
    case 'app_advisor_prompt':
      return `${ORCHESTRATOR_LABEL} prompt: ${truncatePrompt(action.prompt)}`;
    case 'standalone_prompt': {
      const chatProjectName =
        nameResolver.standaloneChatProjectName?.(action.chatProjectId) ??
        action.chatProjectId;
      return `Standalone chat (${chatProjectName}): ${truncatePrompt(action.prompt)}`;
    }
    case 'worktree_prompt': {
      const workspaceName =
        action.workspaceName ??
        nameResolver.workspaceName?.(action.workspaceId) ??
        action.workspaceId;
      return `Worktree chat (${workspaceName}): ${truncatePrompt(action.prompt)}`;
    }
    case 'worktree_session_prompt': {
      const workspaceName =
        action.workspaceName ??
        nameResolver.workspaceName?.(action.workspaceId) ??
        action.workspaceId;
      const worktreeName =
        action.worktreeName ??
        nameResolver.worktreeName?.(action.workspaceId, action.worktreeId) ??
        action.worktreeId;
      const chatTitle =
        action.chatTitle ??
        nameResolver.chatTitle?.(
          action.workspaceId,
          action.worktreeId,
          action.chatId,
        ) ??
        action.chatId;
      return `Existing chat (${workspaceName} / ${worktreeName} / ${chatTitle}): ${truncatePrompt(action.prompt)}`;
    }
    case 'worktree_pipeline': {
      const name = action.pipelineName ?? action.pipelineId;
      const target = resolveAutomationPipelineTarget(action);
      if (target?.kind === 'global') {
        return `Run workflow "${name}" with no project`;
      }
      const workspaceId = target?.workspaceId ?? action.workspaceId ?? '';
      const workspaceName =
        nameResolver.workspaceName?.(workspaceId) ?? workspaceId;
      if (target?.kind === 'task') {
        const taskName =
          nameResolver.worktreeName?.(workspaceId, target.taskId) ??
          target.taskId;
        return `Run workflow "${name}" in ${taskName} on project ${workspaceName}`;
      }
      if (target?.kind === 'project') {
        return `Run workflow "${name}" in the ${workspaceName} project folder`;
      }
      return `Run workflow "${name}" on project ${workspaceName}`;
    }
    case 'pipeline_execution_resume': {
      const provider = action.provider === 'claude' ? 'Claude' : 'Codex';
      return `Resume workflow "${action.pipelineName}" after ${provider} usage reset`;
    }
    default:
      return 'Unknown automation action';
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === 'string')
  );
}

/**
 * Structural guard for a serializable {@link FileReference}
 * (`{ displayPath, absolutePath, repoName? }`). Mirrors the shape in
 * `types.ts` without importing the type so the validator can run in any
 * environment.
 */
function isSerializableFileReference(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  if (typeof value.displayPath !== 'string') return false;
  if (typeof value.absolutePath !== 'string') return false;
  if (value.repoName !== undefined && typeof value.repoName !== 'string') {
    return false;
  }
  return true;
}

/**
 * Structural guard for a {@link ChatAttachmentPromptContext}
 * (`{ attachmentPath, promptKind }`). Kind membership is delegated to the
 * shared `isChatAttachmentPromptKind` predicate so newly added prompt kinds
 * are accepted here automatically.
 */
function isChatAttachmentPromptContext(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  if (typeof value.attachmentPath !== 'string') return false;
  if (!isChatAttachmentPromptKind(value.promptKind)) return false;
  return true;
}

function validateStringRecord(
  value: unknown,
  fieldName: string,
): string | null {
  if (!isPlainObject(value)) {
    return `${fieldName} must be a string record.`;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'string') {
      return `${fieldName}[${key}] must be a string.`;
    }
  }
  return null;
}

function truncatePrompt(prompt: string): string {
  const trimmed = prompt.trim();
  if (trimmed.length <= 80) return trimmed;
  return `${trimmed.slice(0, 77)}...`;
}

// ---------------------------------------------------------------------------
// If Command gate output variable
// ---------------------------------------------------------------------------

/** Env-var suffix for the If Command stdout, brand-prefixed at runtime. */
export const AUTOMATION_IF_CMD_OUTPUT_SUFFIX = 'AUTOMATION_IF_CMD_OUTPUT';

/**
 * Brand-prefixed candidate names for the If Command output variable. Index 0
 * is the canonical brand-prefixed variable; later entries are
 * configured brand fallbacks (mirrors hook env var aliasing).
 */
export const AUTOMATION_IF_CMD_OUTPUT_VAR_NAMES: string[] = brandEnvCandidates(
  AUTOMATION_IF_CMD_OUTPUT_SUFFIX,
);

const AUTOMATION_IF_CMD_OUTPUT_VAR_NAME_SET = new Set<string>(
  AUTOMATION_IF_CMD_OUTPUT_VAR_NAMES,
);

/** Env-var suffix for the If Command stdout idempotency key marker. */
export const AUTOMATION_IF_CMD_IDEMPOTENCY_KEY_SUFFIX = 'IDEMPOTENCY_KEY';

/** Env-var suffix for the If Command stdout idempotency scope marker. */
export const AUTOMATION_IF_CMD_IDEMPOTENCY_SCOPE_SUFFIX = 'IDEMPOTENCY_SCOPE';

/** Maximum stored If Command idempotency key length. */
export const MAX_AUTOMATION_IF_COMMAND_IDEMPOTENCY_KEY_CHARS = 512;

const AUTOMATION_IF_CMD_IDEMPOTENCY_COMPAT_PREFIXES = [
  'CANOPY',
  'UNSTOPPABLE_CODE',
] as const;

function automationIfCommandIdempotencyVarNames(suffix: string): string[] {
  const names = brandEnvCandidates(suffix);
  const seen = new Set(names);
  for (const prefix of AUTOMATION_IF_CMD_IDEMPOTENCY_COMPAT_PREFIXES) {
    const name = `${prefix}_${suffix}`;
    if (seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

/**
 * Brand-prefixed candidate names accepted for the If Command idempotency key.
 * Index 0 is the canonical active-brand name; later entries are compatibility
 * aliases.
 */
export const AUTOMATION_IF_CMD_IDEMPOTENCY_KEY_VAR_NAMES: string[] =
  automationIfCommandIdempotencyVarNames(
    AUTOMATION_IF_CMD_IDEMPOTENCY_KEY_SUFFIX,
  );

/**
 * Brand-prefixed candidate names accepted for the If Command idempotency scope.
 * Index 0 is the canonical active-brand name; later entries are compatibility
 * aliases.
 */
export const AUTOMATION_IF_CMD_IDEMPOTENCY_SCOPE_VAR_NAMES: string[] =
  automationIfCommandIdempotencyVarNames(
    AUTOMATION_IF_CMD_IDEMPOTENCY_SCOPE_SUFFIX,
  );

const AUTOMATION_IF_CMD_IDEMPOTENCY_KEY_VAR_NAME_SET = new Set<string>(
  AUTOMATION_IF_CMD_IDEMPOTENCY_KEY_VAR_NAMES,
);

const AUTOMATION_IF_CMD_IDEMPOTENCY_SCOPE_VAR_NAME_SET = new Set<string>(
  AUTOMATION_IF_CMD_IDEMPOTENCY_SCOPE_VAR_NAMES,
);

/**
 * Insert-variable definitions surfaced under the automation prompt textarea.
 */
export function getAutomationIfCommandVariableDefinitions(): Array<{
  name: string;
  description: string;
}> {
  return [
    {
      name:
        AUTOMATION_IF_CMD_OUTPUT_VAR_NAMES[0] ??
        AUTOMATION_IF_CMD_OUTPUT_SUFFIX,
      description: 'Standard output captured from the activity If Command.',
    },
  ];
}

/** Build the `{{NAME}}` prompt token for an automation variable. */
export function createAutomationPromptVariableToken(name: string): string {
  return `{{${name}}}`;
}

/**
 * Replace `{{CANOPY_AUTOMATION_IF_CMD_OUTPUT}}` (and brand aliases) with the
 * If Command stdout. Unknown `{{...}}` placeholders are left intact so authors
 * can spot typos instead of having them silently expand to empty strings.
 */
export function interpolateAutomationIfCommandOutput(
  text: string,
  output: string,
): string {
  return text.replace(
    /\{\{\s*([A-Z0-9_]+)\s*\}\}/g,
    (match: string, variableName: string): string =>
      AUTOMATION_IF_CMD_OUTPUT_VAR_NAME_SET.has(variableName) ? output : match,
  );
}

/**
 * Return a copy of `action` with its prompt interpolated against the If
 * Command output. Pipeline actions carry no prompt and are returned unchanged.
 */
export function interpolateAutomationActionIfCommandOutput(
  action: AutomationAction,
  output: string,
): AutomationAction {
  switch (action.type) {
    case 'app_advisor_prompt':
    case 'standalone_prompt':
    case 'worktree_prompt':
    case 'worktree_session_prompt': {
      const configured = mapConfiguredPromptText(
        action.prompt,
        action.promptReferences,
        (text) => interpolateAutomationIfCommandOutput(text, output),
      );
      return { ...action, ...configured };
    }
    case 'worktree_pipeline':
    case 'pipeline_execution_resume':
      return action;
  }
}

/**
 * Parse automation control lines from If Command stdout. Lines exactly shaped
 * like a supported brand-prefixed `NAME=value` control marker are removed from
 * the prompt-injected output. Empty or oversized key values are ignored, and
 * invalid/missing scopes default to `self`.
 */
export function parseAutomationIfCommandOutput(
  stdout: string,
): ParsedAutomationIfCommandOutput {
  let idempotencyKey: string | undefined;
  let idempotencyScope: AutomationIfCommandIdempotencyScope = 'self';
  const outputLines: string[] = [];

  for (const line of stdout.split(/\r?\n/)) {
    const marker = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (!marker) {
      outputLines.push(line);
      continue;
    }

    const [, name, rawValue] = marker;
    const value = rawValue.trim();
    if (AUTOMATION_IF_CMD_IDEMPOTENCY_KEY_VAR_NAME_SET.has(name)) {
      if (
        value.length > 0 &&
        value.length <= MAX_AUTOMATION_IF_COMMAND_IDEMPOTENCY_KEY_CHARS
      ) {
        idempotencyKey = value;
      }
      continue;
    }
    if (AUTOMATION_IF_CMD_IDEMPOTENCY_SCOPE_VAR_NAME_SET.has(name)) {
      const normalizedScope = value.toLowerCase();
      if (normalizedScope === 'global' || normalizedScope === 'self') {
        idempotencyScope = normalizedScope;
      }
      continue;
    }

    outputLines.push(line);
  }

  return {
    output: outputLines.join('\n').trim(),
    ...(idempotencyKey ? { idempotencyKey } : {}),
    idempotencyScope,
  };
}

/** Maximum stored If Command length. */
export const MAX_AUTOMATION_IF_COMMAND_CHARS = 20_000;

/**
 * Validate an optional If Command value. Returns an error message string, or
 * `null` when the value is absent/empty or a valid command string.
 */
export function validateAutomationIfCommand(value: unknown): string | null {
  if (value === undefined) return null;
  if (typeof value !== 'string') {
    return 'Automation ifCommand, when provided, must be a string.';
  }
  if (value.length > MAX_AUTOMATION_IF_COMMAND_CHARS) {
    return `Automation ifCommand is too long (max ${MAX_AUTOMATION_IF_COMMAND_CHARS} characters).`;
  }
  return null;
}

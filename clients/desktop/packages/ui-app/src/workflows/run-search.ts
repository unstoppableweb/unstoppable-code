import {
  WORKFLOW_RUN_KIND_LABELS,
  WORKFLOW_RUN_STARTER_LABELS,
  WORKFLOW_RUN_STATUS_LABELS,
  type WorkflowRunKind,
  type WorkflowRunRow,
  type WorkflowRunStarter,
  type WorkflowRunStatus,
  workflowRunWhereLabel,
} from './workflow-run-model';
import { workflowSearchAlias } from '@canopy/ui-shared/lib/workflow-labels';

/**
 * Runs search (CAN-3981): free text plus `status:`, `kind:` and `by:` tokens.
 * A token whose value is not one of the names below matches nothing, so a
 * typo never silently widens the result; the message under the search field
 * names valid values.
 */

const STATUS_TOKENS: Readonly<Record<string, readonly WorkflowRunStatus[]>> = {
  running: ['running'],
  queued: ['queued'],
  waiting: ['waiting'],
  watching: ['watching'],
  active: ['queued', 'running', 'waiting', 'watching'],
  succeeded: ['success', 'fired'],
  success: ['success', 'fired'],
  failed: ['failure', 'delivery-failed'],
  failure: ['failure', 'delivery-failed'],
  skipped: ['skipped'],
  canceled: ['canceled'],
  cancelled: ['canceled'],
  missed: ['missed'],
  fired: ['fired'],
};

/**
 * Kind tokens use the Kind column's words (`Scheduled`, `On demand`); the
 * former names `automation` and `pipeline` stay accepted as aliases but are
 * not offered in the hint (CAN-4651).
 */
const KIND_TOKENS: Readonly<Record<string, WorkflowRunKind>> = {
  scheduled: 'automation',
  schedule: 'automation',
  'on-demand': 'pipeline',
  ondemand: 'pipeline',
  watcher: 'watcher',
  automation: 'automation',
  pipeline: 'pipeline',
};

const STARTER_TOKENS: Readonly<Record<string, WorkflowRunStarter>> = {
  schedule: 'schedule',
  'catch-up': 'catch-up',
  catchup: 'catch-up',
  'run-now': 'run-now',
  runnow: 'run-now',
  automation: 'automation',
  manual: 'manual',
  plan: 'plan-approved',
  'plan-approved': 'plan-approved',
  task: 'task-ready',
  'task-ready': 'task-ready',
  workflow: 'workflow',
  advisor: 'app-advisor',
  'app-advisor': 'app-advisor',
  remote: 'remote-control',
  'remote-control': 'remote-control',
  chat: 'chat',
  hook: 'hook',
};

/** The token values the unknown-token message and the tests name as valid. */
export const RUN_SEARCH_STATUS_VALUES: readonly string[] = [
  'running',
  'waiting',
  'watching',
  'succeeded',
  'failed',
  'skipped',
  'canceled',
  'missed',
];
export const RUN_SEARCH_KIND_VALUES: readonly string[] = [
  'scheduled',
  'on-demand',
  'watcher',
];
export const RUN_SEARCH_STARTER_VALUES: readonly string[] = [
  'schedule',
  'catch-up',
  'run-now',
  'automation',
  'manual',
  'plan',
  'task',
  'advisor',
  'remote',
  'chat',
  'hook',
];

export interface ParsedRunSearch {
  /** Lower-cased free-text terms; every one must match. */
  readonly terms: readonly string[];
  /** One entry per `status:` token: the statuses it accepts. */
  readonly statuses: readonly (readonly WorkflowRunStatus[])[];
  readonly kinds: readonly WorkflowRunKind[];
  readonly starters: readonly WorkflowRunStarter[];
  /** Tokens whose value is not known, as typed (`status:fialed`). */
  readonly unknownTokens: readonly string[];
}

/** The dropdown filters beside the search field. `null` is "any". */
export interface WorkflowRunFilters {
  readonly status: WorkflowRunStatus | null;
  readonly kind: WorkflowRunKind | null;
  readonly starter: WorkflowRunStarter | null;
}

export const EMPTY_WORKFLOW_RUN_FILTERS: WorkflowRunFilters = {
  status: null,
  kind: null,
  starter: null,
};

export function workflowRunFiltersActive(
  query: string,
  filters: WorkflowRunFilters,
): boolean {
  return (
    query.trim() !== '' ||
    filters.status !== null ||
    filters.kind !== null ||
    filters.starter !== null
  );
}

/**
 * A token table's own entry for what the user typed. `constructor` and the
 * like are inherited by every object and are not tokens.
 */
function ownToken<Value>(
  table: Readonly<Record<string, Value>>,
  value: string,
): Value | undefined {
  return Object.prototype.hasOwnProperty.call(table, value)
    ? table[value]
    : undefined;
}

export function parseRunSearch(query: string): ParsedRunSearch {
  const terms: string[] = [];
  const statuses: (readonly WorkflowRunStatus[])[] = [];
  const kinds: WorkflowRunKind[] = [];
  const starters: WorkflowRunStarter[] = [];
  const unknownTokens: string[] = [];
  for (const raw of query.trim().split(/\s+/)) {
    if (raw === '') continue;
    const word = raw.toLowerCase();
    const separator = word.indexOf(':');
    const key = separator > 0 ? word.slice(0, separator) : '';
    const value = separator > 0 ? word.slice(separator + 1) : '';
    if (key === 'status') {
      const match = ownToken(STATUS_TOKENS, value);
      if (match) statuses.push(match);
      else unknownTokens.push(raw);
    } else if (key === 'kind') {
      const match = ownToken(KIND_TOKENS, value);
      if (match) kinds.push(match);
      else unknownTokens.push(raw);
    } else if (key === 'by') {
      const match = ownToken(STARTER_TOKENS, value);
      if (match) starters.push(match);
      else unknownTokens.push(raw);
    } else {
      terms.push(word);
    }
  }
  return { terms, statuses, kinds, starters, unknownTokens };
}

function searchableText(row: WorkflowRunRow): string {
  return [
    row.name,
    row.detail ?? '',
    workflowRunWhereLabel(row),
    WORKFLOW_RUN_KIND_LABELS[row.kind],
    workflowSearchAlias(row.kind) ?? '',
    WORKFLOW_RUN_STATUS_LABELS[row.status],
    row.starter ? WORKFLOW_RUN_STARTER_LABELS[row.starter] : '',
  ]
    .join('\n')
    .toLowerCase();
}

/** Whether one row passes the parsed search. */
export function matchesRunSearch(
  row: WorkflowRunRow,
  search: ParsedRunSearch,
): boolean {
  if (search.unknownTokens.length > 0) return false;
  if (!search.statuses.every((accepted) => accepted.includes(row.status))) {
    return false;
  }
  if (!search.kinds.every((kind) => kind === row.kind)) return false;
  if (!search.starters.every((starter) => starter === row.starter)) {
    return false;
  }
  if (search.terms.length === 0) return true;
  const text = searchableText(row);
  return search.terms.every((term) => text.includes(term));
}

/** Applies the search text and the dropdown filters, keeping row order. */
export function filterWorkflowRunRows(
  rows: readonly WorkflowRunRow[],
  query: string,
  filters: WorkflowRunFilters,
): readonly WorkflowRunRow[] {
  const search = parseRunSearch(query);
  return rows.filter((row) => {
    if (filters.status !== null && row.status !== filters.status) return false;
    if (filters.kind !== null && row.kind !== filters.kind) return false;
    if (filters.starter !== null && row.starter !== filters.starter) {
      return false;
    }
    return matchesRunSearch(row, search);
  });
}

/**
 * The message under the search field. It names the valid values once a token
 * is not recognized, and is `null` otherwise.
 */
export function runSearchHint(query: string): string | null {
  const { unknownTokens } = parseRunSearch(query);
  const first = unknownTokens[0];
  if (first === undefined) return null;
  const key = first.slice(0, first.indexOf(':')).toLowerCase();
  const values =
    key === 'status'
      ? RUN_SEARCH_STATUS_VALUES
      : key === 'kind'
        ? RUN_SEARCH_KIND_VALUES
        : RUN_SEARCH_STARTER_VALUES;
  return `No match for ${first}. Use ${key}: with ${values.join(', ')}.`;
}

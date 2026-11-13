import type { AppError, AppErrorCode } from '@canopy/protocol/app-errors';
import { getModelCatalogProviderLabel } from '@canopy/protocol/models';

export type StandingConditionKind =
  | 'offline'
  | 'session-expired'
  | 'runtime-unreachable'
  | 'sync-paused';

export type StandingConditionRuntime = 'claude' | 'codex' | 'ollama';

export interface StandingConditionAction {
  readonly label: string;
  /** Accessible name while `busy`. */
  readonly busyLabel?: string;
  readonly busy?: boolean;
  readonly onAction: () => void;
}

/** What a host knows before the condition has an episode's recorded error. */
export interface StandingConditionInput {
  readonly id: string;
  readonly kind: StandingConditionKind;
  readonly code: AppErrorCode;
  readonly source?: string;
  readonly networkDependent: boolean;
  /**
   * Still active, but not to be shown or newly reported: for example a probe
   * failure that has to be revalidated after a reconnect. Keeps its episode.
   */
  readonly suppressed?: boolean;
  readonly runtime?: StandingConditionRuntime;
  readonly action?: StandingConditionAction;
}

export interface StandingCondition {
  readonly id: string;
  readonly kind: StandingConditionKind;
  readonly error: AppError;
  readonly networkDependent: boolean;
  readonly runtime?: StandingConditionRuntime;
  readonly action?: StandingConditionAction;
}

/** The identity of one episode. Changing code or source starts a new one. */
export interface StandingConditionSignal {
  readonly id: string;
  readonly code: AppErrorCode;
  readonly source?: string;
  readonly suppressed?: boolean;
}

export const OFFLINE_STANDING_CONDITION: StandingConditionInput = {
  id: 'offline',
  kind: 'offline',
  code: 'external.offline',
  networkDependent: false,
};

const KIND_RANK: Readonly<Record<StandingConditionKind, number>> = {
  offline: 0,
  'session-expired': 1,
  'runtime-unreachable': 2,
  'sync-paused': 3,
};

const RUNTIME_RANK: Readonly<Record<StandingConditionRuntime, number>> = {
  claude: 0,
  codex: 1,
  ollama: 2,
};

function dedupeById<T extends { readonly id: string }>(
  conditions: readonly T[],
): T[] {
  const seen = new Set<string>();
  return conditions.filter((condition) => {
    if (seen.has(condition.id)) return false;
    seen.add(condition.id);
    return true;
  });
}

/** Stable and non-mutating; a duplicate ID keeps its first occurrence. */
export function rankStandingConditions(
  conditions: readonly StandingCondition[],
): StandingCondition[] {
  return dedupeById(conditions).sort(
    (a, b) =>
      KIND_RANK[a.kind] - KIND_RANK[b.kind] ||
      (a.runtime ? RUNTIME_RANK[a.runtime] : 0) -
        (b.runtime ? RUNTIME_RANK[b.runtime] : 0),
  );
}

/** What the banner shows and counts: offline hides network-dependent entries. */
export function visibleStandingConditions(
  conditions: readonly StandingCondition[],
): StandingCondition[] {
  const unique = dedupeById(conditions);
  const offline = unique.some((condition) => condition.kind === 'offline');
  return rankStandingConditions(
    offline
      ? unique.filter((condition) => !condition.networkDependent)
      : unique,
  );
}

/**
 * Applies offline and host suppression before anything is reported, while
 * still naming the suppressed condition: offline is not evidence of recovery,
 * so its existing episode has to survive.
 */
export function selectStandingConditionSignals(
  inputs: readonly StandingConditionInput[],
): StandingConditionSignal[] {
  const unique = dedupeById(inputs);
  const offline = unique.some((input) => input.kind === 'offline');
  return unique.map((input) => ({
    id: input.id,
    code: input.code,
    ...(input.source === undefined ? {} : { source: input.source }),
    suppressed:
      input.suppressed === true || (offline && input.networkDependent),
  }));
}

/** Entries without an error yet wait for the episode effect's next render. */
export function resolveStandingConditions(
  inputs: readonly StandingConditionInput[],
  errors: ReadonlyMap<string, AppError>,
): StandingCondition[] {
  // Read from the inputs: the offline entry itself can still lack its error.
  const unique = dedupeById(inputs);
  const offline = unique.some((input) => input.kind === 'offline');
  return unique.flatMap((input) => {
    const error = errors.get(input.id);
    if (
      !error ||
      error.code !== input.code ||
      error.source !== input.source ||
      input.suppressed === true ||
      (offline && input.networkDependent)
    ) {
      return [];
    }
    return [
      {
        id: input.id,
        kind: input.kind,
        error,
        networkDependent: input.networkDependent,
        ...(input.runtime === undefined ? {} : { runtime: input.runtime }),
        ...(input.action === undefined ? {} : { action: input.action }),
      },
    ];
  });
}

/** The catalog keeps generic copy; a runtime's title names the runtime. */
export function standingConditionTitle(
  condition: Pick<StandingCondition, 'error' | 'runtime'>,
): string {
  return condition.runtime === undefined
    ? condition.error.copy.title
    : `Couldn't reach ${getModelCatalogProviderLabel(condition.runtime)}.`;
}

export function standingConditionCountLabel(remaining: number): string {
  return remaining === 1 ? '1 more issue' : `${String(remaining)} more issues`;
}

import type { ThinkingLevel } from '../thinking';

/** Advisory discovery only; launch always revalidates the exact route and authority. */
export interface DelegationModelChoice {
  readonly modelId: string;
  readonly label: string;
  readonly harnessId: string;
  readonly runtimeKind: string;
  readonly supportedThinkingLevels: readonly ThinkingLevel[];
  readonly capabilities: readonly string[];
  readonly availability: 'available' | 'unavailable' | 'unknown';
  readonly authState: 'ready' | 'required' | 'unknown';
  readonly disabledReason?: string;
}

export interface DelegationModelDiscovery {
  readonly models: readonly DelegationModelChoice[];
  readonly recommendedModelId?: string;
  readonly truncated: boolean;
}

export type ManagedDelegationMode = 'off' | 'explicit-only' | 'proactive';

export function normalizeManagedDelegationMode(
  value: unknown,
): ManagedDelegationMode {
  return value === 'explicit-only' || value === 'proactive' ? value : 'off';
}

export const DEFAULT_MANAGED_DELEGATION_MAX_CONCURRENT = 5;
/**
 * Highest “Maximum concurrent subagents” setting and application-wide cap on
 * concurrently running delegated tasks.
 */
export const MAX_MANAGED_DELEGATION_CONCURRENCY = 64;

export const DEFAULT_MANAGED_DELEGATION_MAX_DEPTH = 1;
export const MAX_MANAGED_DELEGATION_DEPTH = 10;

export function normalizeManagedDelegationMaxDepth(value: unknown): number {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= MAX_MANAGED_DELEGATION_DEPTH
    ? value
    : DEFAULT_MANAGED_DELEGATION_MAX_DEPTH;
}

export function normalizeManagedDelegationMaxConcurrent(
  value: unknown,
): number {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= MAX_MANAGED_DELEGATION_CONCURRENCY
    ? value
    : DEFAULT_MANAGED_DELEGATION_MAX_CONCURRENT;
}

/** Product choices are filtered against measured evidence, never an environment value. */
export const MANAGED_DELEGATION_LIFETIME_LIMIT_CHOICES: readonly number[] = [
  512, 1024, 2048, 4096,
];
export const MAX_MANAGED_DELEGATION_LIFETIME_LIMIT = 512;
export const DEFAULT_MANAGED_DELEGATION_LIFETIME_LIMIT = 512;

/** A test cap exercises the same default selection as a future measured build. */
export function defaultManagedDelegationLifetimeLimit(
  cap: number = MAX_MANAGED_DELEGATION_LIFETIME_LIMIT,
): number {
  return cap >= 1024 ? 1024 : 512;
}
/** Defensive decoding ceilings, independent of admission policy. */
export const DELEGATION_STORAGE_RECORD_LIMIT = 65_536;
export const DELEGATION_STORAGE_ENTRY_LIMIT = 131_072;

export function managedDelegationLifetimeLimitChoices(
  cap: number = MAX_MANAGED_DELEGATION_LIFETIME_LIMIT,
): readonly number[] {
  return MANAGED_DELEGATION_LIFETIME_LIMIT_CHOICES.filter(
    (choice) => choice <= cap && choice <= DELEGATION_STORAGE_RECORD_LIMIT,
  );
}

export function normalizeManagedDelegationLifetimeLimit(
  value: unknown,
  cap: number = MAX_MANAGED_DELEGATION_LIFETIME_LIMIT,
): number {
  const choices = managedDelegationLifetimeLimitChoices(cap);
  return typeof value === 'number' && choices.includes(value)
    ? value
    : defaultManagedDelegationLifetimeLimit(cap);
}

/** Clamp before addition so even a maximum-safe persisted baseline cannot overflow. */
export function managedDelegationEffectiveLifetimeLimit(
  baseline: number,
  setting: number,
  cap: number = MAX_MANAGED_DELEGATION_LIFETIME_LIMIT,
): number {
  const ceiling = Math.min(cap, DELEGATION_STORAGE_RECORD_LIMIT);
  const retained = Math.min(baseline, ceiling);
  return retained + Math.min(setting, ceiling - retained);
}

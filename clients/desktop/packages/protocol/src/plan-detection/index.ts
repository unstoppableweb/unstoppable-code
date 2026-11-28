export type PlanDetectionRuleKind = 'include' | 'exclude';

/**
 * One plan-detection glob rule. `include` rules nominate files as plan
 * documents; `exclude` rules veto them (exclude always wins at match time).
 * `label` is purely organizational. `id` is stable; built-in rule ids must
 * never change once shipped so finer tiers can disable them by id.
 */
export interface PlanDetectionRule {
  id: string;
  label: string;
  kind: PlanDetectionRuleKind;
  pattern: string;
  enabled: boolean;
}

/**
 * Workspace-local tier (machine-specific), stored in `workspace.json` as
 * `planDetection`.
 */
export interface WorkspacePlanDetectionConfig {
  /** Ids of any inherited rule (built-in, global custom, or canopy.json) to disable. */
  disabledRuleIds?: string[];
  customRules?: PlanDetectionRule[];
}

/**
 * Built-in plan-detection rules, structured like `file-indexing.ts`. Ids are
 * stable kebab-case strings; never change a shipped id. A finer tier disables
 * a built-in by adding its id to its disabled set.
 */
export const BUILTIN_PLAN_DETECTION_RULES: readonly PlanDetectionRule[] = [
  {
    id: 'superpowers-specs',
    label: 'Superpowers Specs',
    kind: 'include',
    pattern: 'docs/superpowers/specs/*.md',
    enabled: true,
  },
  {
    id: 'superpowers-designs',
    label: 'Superpowers Designs',
    kind: 'exclude',
    pattern: 'docs/superpowers/specs/*-design.md',
    enabled: true,
  },
  {
    id: 'plan-md',
    label: 'Plan Files',
    kind: 'include',
    pattern: '**/plan.md',
    enabled: true,
  },
] as const;

/**
 * Set of every valid built-in rule id, used by preference normalization to
 * drop unknown entries from a persisted disabled-id list.
 */
export const BUILTIN_PLAN_DETECTION_RULE_IDS: ReadonlySet<string> = new Set(
  BUILTIN_PLAN_DETECTION_RULES.map((rule) => rule.id),
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAbsolutePlanDetectionPattern(pattern: string): boolean {
  return pattern.startsWith('/') || /^[a-zA-Z]:\//.test(pattern);
}

export function normalizePlanDetectionRule(
  value: unknown,
): PlanDetectionRule | null {
  if (!isRecord(value)) {
    return null;
  }
  const pattern =
    typeof value.pattern === 'string'
      ? value.pattern.trim().replace(/\\/g, '/')
      : '';
  const id =
    typeof value.id === 'string' && value.id.trim() ? value.id.trim() : '';
  const label = typeof value.label === 'string' ? value.label.trim() : '';
  const kind =
    value.kind === 'include' || value.kind === 'exclude' ? value.kind : null;
  if (!pattern || !id || !kind) {
    return null;
  }
  if (
    pattern.split('/').includes('..') ||
    isAbsolutePlanDetectionPattern(pattern)
  ) {
    return null;
  }
  return {
    id,
    label: label || id,
    kind,
    pattern,
    enabled: typeof value.enabled === 'boolean' ? value.enabled : true,
  };
}

/** Trimmed, unique, non-empty strings; undefined when none remain. */
function normalizeStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const entries: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'string') {
      continue;
    }
    const normalized = entry.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    entries.push(normalized);
  }
  return entries.length > 0 ? entries : undefined;
}

/**
 * The stored form of a workspace's plan detection configuration: valid rules
 * with unique ids and unique disabled ids; undefined when both are empty.
 */
export function normalizeWorkspacePlanDetection(
  value: unknown,
): WorkspacePlanDetectionConfig | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const disabledRuleIds = normalizeStringList(value.disabledRuleIds);
  const seenIds = new Set<string>();
  const customRules = Array.isArray(value.customRules)
    ? value.customRules.reduce<PlanDetectionRule[]>((acc, entry) => {
        const rule = normalizePlanDetectionRule(entry);
        if (rule !== null && !seenIds.has(rule.id)) {
          seenIds.add(rule.id);
          acc.push(rule);
        }
        return acc;
      }, [])
    : undefined;
  if (!disabledRuleIds?.length && !customRules?.length) {
    return undefined;
  }
  return {
    ...(disabledRuleIds?.length ? { disabledRuleIds } : {}),
    ...(customRules?.length ? { customRules } : {}),
  };
}

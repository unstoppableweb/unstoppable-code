import { BUILTIN_PLAN_DETECTION_RULES } from '@canopy/protocol/plan-detection';
import type {
  CanopyJsonPlanDetection,
  PlanDetectionPreferences,
  PlanDetectionRule,
  WorkspacePlanDetectionConfig,
} from './types';

export {
  BUILTIN_PLAN_DETECTION_RULES,
  BUILTIN_PLAN_DETECTION_RULE_IDS,
  normalizePlanDetectionRule,
} from '@canopy/protocol/plan-detection';

/**
 * Look up a built-in by id. Returns `undefined` if no built-in matches —
 * useful when surfacing migrations or settings UI errors for unknown ids.
 */
export function getBuiltinPlanDetectionRule(
  id: string,
): PlanDetectionRule | undefined {
  return BUILTIN_PLAN_DETECTION_RULES.find((rule) => rule.id === id);
}

export interface ResolvePlanDetectionRulesInput {
  global: PlanDetectionPreferences;
  workspaceLocal?: WorkspacePlanDetectionConfig;
  canopyJson?: CanopyJsonPlanDetection;
}

export interface ResolvedPlanDetectionRules {
  includes: PlanDetectionRule[];
  excludes: PlanDetectionRule[];
}

/**
 * Union the rules from every tier, apply workspace-local per-id disables, keep
 * enabled rules, and split into include/exclude. Exclude always wins at match
 * time (the matcher in the detection service enforces that).
 */
export function resolvePlanDetectionRules(
  input: ResolvePlanDetectionRulesInput,
): ResolvedPlanDetectionRules {
  const { global, workspaceLocal, canopyJson } = input;
  const disabledBuiltins = new Set(global.disabledBuiltinRuleIds);

  const merged = new Map<string, PlanDetectionRule>();
  for (const rule of BUILTIN_PLAN_DETECTION_RULES) {
    if (!disabledBuiltins.has(rule.id)) {
      merged.set(rule.id, rule);
    }
  }
  for (const rule of global.customRules) {
    merged.set(rule.id, rule);
  }
  for (const rule of canopyJson?.rules ?? []) {
    merged.set(rule.id, rule);
  }
  for (const rule of workspaceLocal?.customRules ?? []) {
    merged.set(rule.id, rule);
  }

  const disabledByWorkspace = new Set(workspaceLocal?.disabledRuleIds ?? []);
  const includes: PlanDetectionRule[] = [];
  const excludes: PlanDetectionRule[] = [];
  for (const rule of Array.from(merged.values())) {
    if (!rule.enabled || disabledByWorkspace.has(rule.id)) {
      continue;
    }
    (rule.kind === 'exclude' ? excludes : includes).push(rule);
  }
  return { includes, excludes };
}

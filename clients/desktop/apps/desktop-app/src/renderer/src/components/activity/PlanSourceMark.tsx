import type { JSX } from 'react';
import { PLAN_SOURCE_GLYPHS } from '@/lib/providerUi';
import { PlanSourceMark as SharedPlanSourceMark } from '@canopy/ui-shared/components';

export type PlanSource =
  | 'claude'
  | 'codex'
  | 'ollama'
  | 'cursor'
  | 'copilot'
  | 'antigravity'
  | 'opencode'
  | 'pipeline'
  | 'imported'
  | 'detected';

export function PlanSourceMark({
  source,
  className,
}: {
  source: PlanSource;
  className?: string;
}): JSX.Element {
  return (
    <SharedPlanSourceMark
      source={source}
      className={className}
      icon={PLAN_SOURCE_GLYPHS[source]}
    />
  );
}

'use client';

import type { JSX } from 'react';
import { AI_CREDITS_LABEL } from '@canopy/ui-shared';
import { CoinsIcon } from '@canopy/ui-shared/icons/AppIcons';

/**
 * How a workflow step's last finished attempt was billed (CAN-7256). Declared
 * here rather than imported: `ui-app` must not depend on the execution engine.
 * The engine's `StepBillingRoute` and the Portal's
 * `RemoteControlPipelineStepBillingRoute` carry the same literals, and each mount
 * passes the value straight through so the compiler catches drift.
 */
export type PipelineStepBillingRoute =
  | 'ai_credits'
  | 'model_gateway'
  | 'account_proxy';

export type PipelineStepBillingOwnerKind = 'personal' | 'organization';

export interface PipelineStepBillingLineProps {
  /** Absent when the step ran natively, is still running, or the host has none. */
  readonly route: PipelineStepBillingRoute | undefined;
  /** Absent when the host does not know who owns the run. */
  readonly ownerKind: PipelineStepBillingOwnerKind | undefined;
}

/**
 * One line under a workflow step saying it ran on AI Credits. Shared by the
 * desktop step detail and the Portal run detail; a host with no route passes
 * `undefined` and the line renders nothing. It reflects the step's last
 * finished attempt only.
 */
export function PipelineStepBillingLine({
  route,
  ownerKind,
}: PipelineStepBillingLineProps): JSX.Element | null {
  if (route !== 'ai_credits') return null;
  // Personal runs name the pool they spent. An organization run's payer is
  // chosen by the server per request, so naming the organization pool could
  // be wrong; with no owner kind, claiming "personal" would be a guess. Both
  // use the neutral wording. Single-sentence helper text: no full stop.
  const label =
    ownerKind === 'personal'
      ? `Ran on your personal ${AI_CREDITS_LABEL}`
      : `Ran on ${AI_CREDITS_LABEL}`;
  return (
    <p
      className="flex items-center gap-1 text-2xs fg-secondary"
      data-testid="pipeline-step-billing-line"
    >
      <CoinsIcon size="xs" aria-hidden="true" className="shrink-0" />
      <span>{label}</span>
    </p>
  );
}

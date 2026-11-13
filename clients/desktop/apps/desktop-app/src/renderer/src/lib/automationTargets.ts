/**
 * Renderer-side resolution of the facts the shared automation target policy
 * needs (CAN-3734): the bound project's kind for a session prompt and the
 * scopes of the exact pipeline an automation runs. Results are advisory —
 * main re-resolves both through trusted paths before any write or run.
 */
import * as shared from '@canopy/desktop-shared/lib/automation-share/automation-targets';
import type { AfterReadPort } from '@canopy/desktop-shared/lib/automation-share/port';
import { rendererPipelineReadPort } from './pipelineReadPort';

export {
  pipelineResolutionFromRaw,
  projectTypeToSessionTargetKind,
} from '@canopy/desktop-shared/lib/automation-share/automation-targets';

export function resolveSessionTargetKind(
  ...args: AfterReadPort<Parameters<typeof shared.resolveSessionTargetKind>>
): ReturnType<typeof shared.resolveSessionTargetKind> {
  return shared.resolveSessionTargetKind(rendererPipelineReadPort(), ...args);
}

export function resolveAutomationPipelineScopes(
  ...args: AfterReadPort<
    Parameters<typeof shared.resolveAutomationPipelineScopes>
  >
): ReturnType<typeof shared.resolveAutomationPipelineScopes> {
  return shared.resolveAutomationPipelineScopes(
    rendererPipelineReadPort(),
    ...args,
  );
}

/** Creation must support the requested project kind in the selected context. */
export async function resolveAutomationProjectCreationContexts(): Promise<
  Array<'cowork' | 'worktree'>
> {
  const { context } = await window.api.workspaceContext.get();
  if (context.kind === 'personal') return ['cowork', 'worktree'];
  const [cowork, code] = await Promise.all([
    window.api.chatProject
      .getOrgDefaultCoworkEligibility(context.organizationId)
      .catch(() => 'ineligible'),
    window.api.orgProjects
      .getMemberCodeEligibility(context.organizationId)
      .catch(() => 'ineligible'),
  ]);
  if (cowork !== 'eligible') return [];
  return code === 'eligible' ? ['cowork', 'worktree'] : ['cowork'];
}

import { WORKFLOW_ITEM_LABEL } from '@canopy/ui-shared/lib/workflow-labels';
import { MODEL_PRESET_LABEL } from '@canopy/ui-shared/lib/model-preset-labels';
import type { PublicShareInstalledTarget } from './usePublicShareLanding';

/**
 * Copy for the short notice after a shared resource installs and its result
 * opens (CAN-3710). Automations keep their own Library notice
 * (`automationRevealNotice`), which follows the copy's enabled state.
 */

export type InstallRevealOutcome = 'installed' | 'updated';

const ENTITY_TITLE: Readonly<
  Record<Exclude<PublicShareInstalledTarget['entity'], 'automation'>, string>
> = {
  skill: 'Skill',
  plugin: 'Plugin',
  pipeline: WORKFLOW_ITEM_LABEL,
  agent: MODEL_PRESET_LABEL,
  collection: 'Collection',
  workspace: 'Project',
};

/**
 * The notice after an install. A non-empty `status` from the install (a
 * partial success such as `Collection installed with 2 items unavailable.`)
 * replaces the default, so the user still hears about what did not land.
 */
export function installRevealNotice(
  entity: Exclude<PublicShareInstalledTarget['entity'], 'automation'>,
  outcome: InstallRevealOutcome,
  status = '',
): string {
  if (status.trim() !== '') return status;
  if (entity === 'workspace') return 'Project added.';
  return `${ENTITY_TITLE[entity]} ${outcome}.`;
}

import type { WorkspaceSettingsDataResponse } from '@canopy/desktop-shared/types';
import {
  createEditableScripts,
  toScriptInputMap,
  type EditableScripts,
} from './editableScripts';
import {
  createEditableHooks,
  serializeHooks,
  type EditableHooks,
} from './editableHooks';

function serializeScripts(scripts: EditableScripts): string {
  const payload = toScriptInputMap(scripts);
  const entries = Object.entries(payload).sort((left, right) =>
    left[0].localeCompare(right[0]),
  );
  return JSON.stringify(entries);
}

export function shouldResetProjectSettingsModalState(
  isOpen: boolean,
  wasOpen: boolean,
  previousProjectId: string,
  nextProjectId: string,
): boolean {
  return isOpen && (!wasOpen || previousProjectId !== nextProjectId);
}

export function canSubmitProjectSourceDraft(
  hasLoadedWorkspaceSettingsData: boolean,
  healthData: WorkspaceSettingsDataResponse | null,
): boolean {
  return hasLoadedWorkspaceSettingsData && healthData !== null;
}

export function hasProjectSourceDraft(
  sourceScripts: EditableScripts,
  healthData: WorkspaceSettingsDataResponse | null,
): boolean {
  const manifestScripts = createEditableScripts(healthData?.manifest?.scripts);
  return serializeScripts(sourceScripts) !== serializeScripts(manifestScripts);
}

export function hasProjectSourceHookDraft(
  sourceHooks: EditableHooks,
  healthData: WorkspaceSettingsDataResponse | null,
): boolean {
  const manifestHooks = createEditableHooks(healthData?.manifest?.hooks);
  return serializeHooks(sourceHooks) !== serializeHooks(manifestHooks);
}

/** Tabs callers open project settings on, kept so deep links still land. */
export type ProjectSettingsTab =
  | 'details'
  | 'scripts'
  | 'hooks'
  | 'plan-detection'
  | 'plugins'
  | 'shared-setup'
  | 'environment'
  | 'code-graph'
  | 'start-page'
  | 'danger';

/** The pages in the project settings rail. */
export type ProjectSettingsPageId =
  | 'general'
  | 'scripts'
  | 'plans'
  | 'plugins'
  | 'shared-setup'
  | 'environment'
  | 'start-page'
  | 'code-graph';

/**
 * The page a caller's tab opens on. Scripts and hooks share one page, and
 * removing the project is the last row of General.
 */
export function projectSettingsPageForTab(
  tab: ProjectSettingsTab | undefined,
): ProjectSettingsPageId {
  switch (tab) {
    case 'scripts':
    case 'hooks':
      return 'scripts';
    case 'plan-detection':
      return 'plans';
    case 'plugins':
      return 'plugins';
    case 'shared-setup':
      return 'shared-setup';
    case 'environment':
      return 'environment';
    case 'code-graph':
      return 'code-graph';
    case 'start-page':
      return 'start-page';
    case 'details':
    case 'danger':
    case undefined:
      return 'general';
  }
}

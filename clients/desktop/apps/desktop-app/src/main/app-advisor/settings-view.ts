/**
 * The Orchestrator (App Advisor) settings a remote client edits: one view of
 * the stores the desktop settings modal reads, and one partial patch written
 * through the desktop's canonical stores. Portal's
 * `portal.app_advisor.settings.get`/`save` and the tunneled
 * `app-advisor:settings-view`/`settings-patch` (browser Remote Control,
 * CAN-5985) both run these, so the two transports read and write the same.
 */
import { broadcastPreferencesSynced } from '../lib/preferences-broadcast';
import {
  APP_ADVISOR_PROJECT_ID,
  IPC_CHANNELS,
} from '@canopy/desktop-shared/types';
import {
  buildAppAdvisorProjectAgentAccessOwnerOptions,
  normalizeAppAdvisorProjectAgentAccess,
} from '@canopy/desktop-shared/lib/app-advisor-project-agent-access';
import type {
  RemoteControlAppAdvisorProjectAgentAccess,
  RemoteControlAppAdvisorSettings,
} from '@canopy/protocol/remote-control/shell';
import { trackDetachedWork } from '@canopy/desktop-shared/node/lib/detached-work';
import {
  refreshCatalogAgentDefaults,
  resolveCatalogAgentDefaultModel,
} from '../agents/agent-default-model';
import { ORCHESTRATOR_LABEL } from '@canopy/protocol';
import { THINKING_LEVELS } from '@canopy/protocol/thinking';
import { normalizePluginSelections } from '@canopy/execution-engine/lib/plugin-selections-normalization';
import { MAX_ARCHIVE_RETENTION_DAYS } from '@canopy/desktop-shared/lib/archive-retention';
import { sendToWindow } from '../lib/window-send';
import {
  readAppAdvisorClaudeMd,
  readAppAdvisorWorkspaceSettings,
  saveAppAdvisorClaudeMd,
  saveAppAdvisorWorkspaceSettings,
} from '../lib/app-advisor-workspace';
import { setAppAdvisorProjectAgentAccess } from '../lib/app-advisor-project-agent-access';
import {
  projectPreferencesForRuntime,
  readPreferencesFile,
  updatePreferencesFile,
} from '../lib/preferences-store';
import { getWorkspaceContextService } from '../lib/workspace-context-service';
import { buildProjectedModelCatalog } from '../remote-projection/model-catalog-projection';
import { peekRemoteControlProviderAvailability } from '../auth/provider-auth-state';
import { isRecord } from '../remote-projection/validation';
import type { AppAdvisorToolRuntimeSurfaces } from './runtime';

const APP_ADVISOR_THINKING_LEVELS = new Set<string>(THINKING_LEVELS);

function isAppAdvisorThinkingLevel(
  value: unknown,
): value is (typeof THINKING_LEVELS)[number] {
  return typeof value === 'string' && APP_ADVISOR_THINKING_LEVELS.has(value);
}

function isRemoteControlAppAdvisorProjectAgentAccess(
  value: unknown,
): value is RemoteControlAppAdvisorProjectAgentAccess {
  if (
    !isRecord(value) ||
    (value.mode !== 'enabled' &&
      value.mode !== 'selected-owners' &&
      value.mode !== 'disabled') ||
    !Array.isArray(value.selectedOwners)
  ) {
    return false;
  }
  return value.selectedOwners.every((owner) => {
    if (!isRecord(owner)) return false;
    if (owner.kind === 'personal') return true;
    return (
      owner.kind === 'organization' &&
      typeof owner.organizationId === 'string' &&
      owner.organizationId.trim().length > 0
    );
  });
}

/** The settings the desktop modal shows, read from its backing stores. */
export async function readAppAdvisorSettingsView(): Promise<RemoteControlAppAdvisorSettings> {
  const [{ buildPluginCatalog }, preferences, instructions, settings] =
    await Promise.all([
      import('../services/plugin-catalog-service'),
      readPreferencesFile(),
      readAppAdvisorClaudeMd(),
      readAppAdvisorWorkspaceSettings(),
    ]);
  const pluginCatalog = await buildPluginCatalog();
  const organizations = getWorkspaceContextService().getState().organizations;
  return {
    model: preferences.appAdvisorModel,
    thinkingLevel: preferences.appAdvisorThinkingLevel,
    pluginSelections: preferences.appAdvisorPluginSelections,
    projectAgentAccess: normalizeAppAdvisorProjectAgentAccess(
      preferences.appAdvisorProjectAgentAccess,
    ),
    projectAgentAccessOwnerOptions:
      buildAppAdvisorProjectAgentAccessOwnerOptions(organizations),
    instructions,
    archiveRetentionDays: settings.archiveRetentionDays ?? null,
    autoArchiveDays: settings.autoArchiveDays ?? null,
    // Antigravity is left out on purpose: it cannot run App Advisor turns
    // (the chat summaries and runtime admission exclude it the same way).
    availableModels: buildProjectedModelCatalog(preferences.appAdvisorModel, {
      cursor: true,
      owner: { kind: 'personal' },
      projectId: APP_ADVISOR_PROJECT_ID,
      copilot: true,
      opencode: true,
      agentDefaultModel: await resolveCatalogAgentDefaultModel(
        APP_ADVISOR_PROJECT_ID,
      ),
    }),
    providerAvailability: peekRemoteControlProviderAvailability({
      antigravity: false,
    }),
    pluginCatalog,
    approvalsUpgradeNoticeDismissed:
      preferences.approvalsUpgradeNoticeDismissed,
  };
}

/** A patch the stores refused before anything was written. */
export interface AppAdvisorSettingsPatchRefusal {
  readonly ok: false;
  readonly code: 'invalid_payload';
  readonly error: string;
}

/**
 * Save a partial settings patch through the desktop's canonical stores. An
 * invalid patch is refused whole before any store is written; both desktop
 * windows hear the change, as after the native preferences save.
 */
export async function applyAppAdvisorSettingsPatch(
  payload: unknown,
  surfaces: Pick<
    AppAdvisorToolRuntimeSurfaces,
    'getMainWindow' | 'getAppAdvisorWindow'
  > | null,
): Promise<{ readonly ok: true } | AppAdvisorSettingsPatchRefusal> {
  if (!isRecord(payload)) {
    return {
      ok: false,
      code: 'invalid_payload',
      error: `${ORCHESTRATOR_LABEL} settings save requires an object payload.`,
    };
  }
  const projectAgentAccess =
    payload.projectAgentAccess === undefined
      ? undefined
      : isRemoteControlAppAdvisorProjectAgentAccess(payload.projectAgentAccess)
        ? normalizeAppAdvisorProjectAgentAccess(payload.projectAgentAccess)
        : null;

  if (
    (payload.model !== undefined &&
      (typeof payload.model !== 'string' ||
        payload.model.trim().length === 0 ||
        payload.model.length > 256)) ||
    (payload.thinkingLevel !== undefined &&
      !isAppAdvisorThinkingLevel(payload.thinkingLevel)) ||
    (payload.instructions !== undefined &&
      typeof payload.instructions !== 'string') ||
    (payload.archiveRetentionDays !== undefined &&
      payload.archiveRetentionDays !== null &&
      (typeof payload.archiveRetentionDays !== 'number' ||
        !Number.isInteger(payload.archiveRetentionDays) ||
        payload.archiveRetentionDays < 0 ||
        payload.archiveRetentionDays > MAX_ARCHIVE_RETENTION_DAYS)) ||
    (payload.autoArchiveDays !== undefined &&
      payload.autoArchiveDays !== null &&
      (typeof payload.autoArchiveDays !== 'number' ||
        !Number.isInteger(payload.autoArchiveDays) ||
        payload.autoArchiveDays < 1 ||
        payload.autoArchiveDays > MAX_ARCHIVE_RETENTION_DAYS)) ||
    (payload.pluginSelections !== undefined &&
      !isRecord(payload.pluginSelections)) ||
    (payload.approvalsUpgradeNoticeDismissed !== undefined &&
      typeof payload.approvalsUpgradeNoticeDismissed !== 'boolean') ||
    (payload.projectAgentAccess !== undefined && projectAgentAccess === null)
  ) {
    return {
      ok: false,
      code: 'invalid_payload',
      error: `Invalid ${ORCHESTRATOR_LABEL} settings.`,
    };
  }
  const preferencePatch = {
    ...(typeof payload.model === 'string'
      ? { appAdvisorModel: payload.model }
      : {}),
    ...(isAppAdvisorThinkingLevel(payload.thinkingLevel)
      ? { appAdvisorThinkingLevel: payload.thinkingLevel }
      : {}),
    ...(isRecord(payload.pluginSelections)
      ? {
          appAdvisorPluginSelections: normalizePluginSelections(
            payload.pluginSelections,
          ),
        }
      : {}),
    ...(typeof payload.approvalsUpgradeNoticeDismissed === 'boolean'
      ? {
          approvalsUpgradeNoticeDismissed:
            payload.approvalsUpgradeNoticeDismissed,
        }
      : {}),
    ...(projectAgentAccess !== undefined && projectAgentAccess !== null
      ? { appAdvisorProjectAgentAccess: projectAgentAccess }
      : {}),
  };
  if (Object.keys(preferencePatch).length > 0) {
    // Apply the access cache inside the serialized commit, in the same
    // order as the desktop preferences save.
    const saved = await updatePreferencesFile(
      () => preferencePatch,
      projectAgentAccess
        ? (committed): void =>
            setAppAdvisorProjectAgentAccess(
              committed.appAdvisorProjectAgentAccess,
            )
        : undefined,
    );
    // Keep both desktop windows in sync with a settings change made remotely,
    // matching the native preferences-save broadcast.
    broadcastPreferencesSynced(saved, projectPreferencesForRuntime);
    trackDetachedWork(() =>
      refreshCatalogAgentDefaults(new Set(Object.keys(preferencePatch))).catch(
        () => undefined,
      ),
    );
  }
  if (typeof payload.instructions === 'string') {
    await saveAppAdvisorClaudeMd(payload.instructions);
  }
  if (
    payload.archiveRetentionDays !== undefined ||
    payload.autoArchiveDays !== undefined
  ) {
    const saved = await saveAppAdvisorWorkspaceSettings({
      ...(payload.archiveRetentionDays !== undefined
        ? { archiveRetentionDays: payload.archiveRetentionDays }
        : {}),
      ...(payload.autoArchiveDays !== undefined
        ? { autoArchiveDays: payload.autoArchiveDays }
        : {}),
    });
    sendToWindow(
      surfaces?.getMainWindow() ?? null,
      IPC_CHANNELS.appAdvisorSettingsChanged,
      saved,
    );
    sendToWindow(
      surfaces?.getAppAdvisorWindow() ?? null,
      IPC_CHANNELS.appAdvisorSettingsChanged,
      saved,
    );
  }
  return { ok: true };
}

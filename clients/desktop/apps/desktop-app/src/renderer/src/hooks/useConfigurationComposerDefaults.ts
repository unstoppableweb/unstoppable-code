import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type {
  AgentModelConfig,
  ApprovalMode,
  ChatModel,
  ChatTabPluginSelections,
  PreferencesData,
} from '@canopy/desktop-shared/types';
import {
  APP_ADVISOR_PROJECT_ID,
  getProviderForChatModel,
  pinInheritingAgentModel,
} from '@canopy/desktop-shared/types';
import type { ConfigurationComposerContext } from '@/lib/configurationComposerTargets';
import { useChatStore } from '@/stores/chatStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { APP_ADVISOR_SETTINGS_SAVED_EVENT } from '@/lib/appAdvisorSettingsEvents';
import {
  codexSpeedFastMode,
  readCodexSpeedRecord,
} from '@canopy/execution-engine/lib/codex-speed';
import {
  resolveHomeEffectiveDefaults,
  resolveHomeEffectiveModelSettings,
  resolveHomeSpeed,
} from '@/stores/homeComposerStore';
import {
  getRendererBillingLaneFactsVersion,
  subscribeRendererBillingLaneFacts,
} from '@/stores/billingLaneRuntime';
import {
  getRendererModelFactsVersion,
  subscribeRendererModelFacts,
} from '@/stores/modelPolicyRuntime';

/** Destination defaults for a configuration draft, without subscribing to Home's draft. */
export function useConfigurationComposerDefaults(
  context: ConfigurationComposerContext,
  model: ChatModel | undefined,
  modelConfig: AgentModelConfig | undefined,
  inheritedModel: ChatModel | undefined,
  inheritedModelConfig: AgentModelConfig | undefined,
  inheritedApprovalMode: ApprovalMode | undefined,
): {
  model: ChatModel;
  modelConfig: AgentModelConfig;
  approvalMode: ApprovalMode | undefined;
  selections: ChatTabPluginSelections | undefined;
} {
  const workspaceId =
    context.kind === 'workspace'
      ? context.workspaceId
      : context.kind === 'advisor'
        ? APP_ADVISOR_PROJECT_ID
        : null;
  const [advisorPreferences, setAdvisorPreferences] =
    useState<PreferencesData | null>(null);
  useEffect(() => {
    if (context.kind !== 'advisor') return;
    let active = true;
    const refreshPreferences = (): void => {
      void window.api
        .loadPreferences({ view: 'persisted' })
        .then((preferences) => {
          if (active) setAdvisorPreferences(preferences);
        })
        .catch(() => undefined);
    };
    refreshPreferences();
    const onSaved = (): void => refreshPreferences();
    window.addEventListener(APP_ADVISOR_SETTINGS_SAVED_EVENT, onSaved);
    return (): void => {
      active = false;
      window.removeEventListener(APP_ADVISOR_SETTINGS_SAVED_EVENT, onSaved);
    };
  }, [context.kind]);
  const modelDefaults = useChatStore((state) => state.modelDefaults);
  const approvalDefault = useChatStore((state) =>
    workspaceId ? state.approvalDefaultsCache[workspaceId] : undefined,
  );
  const selections = useProjectsStore((state) =>
    workspaceId
      ? state.projects.find((project) => project.id === workspaceId)
          ?.defaultPluginSelections
      : undefined,
  );
  const laneFactsVersion = useSyncExternalStore(
    subscribeRendererBillingLaneFacts,
    getRendererBillingLaneFactsVersion,
    getRendererBillingLaneFactsVersion,
  );
  const modelFactsVersion = useSyncExternalStore(
    subscribeRendererModelFacts,
    getRendererModelFactsVersion,
    getRendererModelFactsVersion,
  );

  useEffect(() => {
    if (!workspaceId || inheritedApprovalMode || approvalDefault) return;
    if (workspaceId in useChatStore.getState().approvalDefaultsCache) return;
    void useChatStore
      .getState()
      .fetchApprovalDefault(workspaceId)
      .catch(() => undefined);
  }, [workspaceId, inheritedApprovalMode, approvalDefault]);

  return useMemo(() => {
    const defaults = resolveHomeEffectiveDefaults(workspaceId);
    const effectiveModel =
      model ??
      inheritedModel ??
      (context.kind === 'advisor' && !modelDefaults
        ? advisorPreferences?.appAdvisorModel
        : undefined) ??
      defaults.model;
    const inheritedCompatible =
      !model ||
      !inheritedModel ||
      getProviderForChatModel(
        pinInheritingAgentModel(model, defaults.model),
      ) ===
        getProviderForChatModel(
          pinInheritingAgentModel(inheritedModel, defaults.model),
        );
    const resolvedModel = resolveHomeEffectiveModelSettings(
      workspaceId,
      effectiveModel,
      modelConfig?.thinkingLevel ??
        (inheritedCompatible
          ? inheritedModelConfig?.thinkingLevel
          : undefined) ??
        (context.kind === 'advisor' && !modelDefaults
          ? advisorPreferences?.appAdvisorThinkingLevel
          : undefined),
    );
    // Each record resolves on its own (exact speed, then its legacy boolean)
    // before the next one, so a draft's explicit Regular beats an inherited
    // or default Ultra fast.
    const speed = resolveHomeSpeed(resolvedModel.model, {
      speed:
        readCodexSpeedRecord(modelConfig) ??
        (inheritedCompatible
          ? readCodexSpeedRecord(inheritedModelConfig)
          : undefined),
    });
    return {
      model: resolvedModel.model,
      modelConfig: {
        thinkingLevel: resolvedModel.thinkingLevel,
        ...(speed === undefined
          ? {}
          : { speed, fastMode: codexSpeedFastMode(speed) }),
      },
      approvalMode: inheritedApprovalMode ?? approvalDefault,
      selections:
        context.kind === 'advisor'
          ? advisorPreferences?.appAdvisorPluginSelections
          : selections,
    };
    // Resolver reads the subscribed model and runtime facts directly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    workspaceId,
    model,
    modelConfig,
    inheritedModel,
    inheritedModelConfig,
    inheritedApprovalMode,
    approvalDefault,
    selections,
    modelDefaults,
    laneFactsVersion,
    modelFactsVersion,
    context.kind,
    advisorPreferences,
  ]);
}

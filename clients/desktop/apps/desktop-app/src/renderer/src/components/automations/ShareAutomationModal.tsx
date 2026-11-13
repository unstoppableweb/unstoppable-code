import { Fieldset } from '@canopy/ui-shared/components';
import {
  type JSX,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { sharedAutomationActivity } from '@/lib/workflows/stored-automation-activity';
import { unwrapShareOperationResult } from '@/lib/sharing/share-operation-result';
import { Disclosure, Notice } from '@canopy/ui-shared';
import {
  Stack,
  FormField,
  TextArea,
  Heading,
} from '@canopy/ui-shared/components';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { AutomationTargetRequirementLine } from '@canopy/ui-shared/components/AutomationDefinitionSummary';
import { CHAT_LABEL } from '@canopy/protocol';
import type { AutomationSessionTargetKind } from '@canopy/desktop-shared/lib/automation-target';
import {
  resolveAutomationTargetRequirement,
  type AutomationPipelineResolution,
} from '@canopy/pipeline-interop/automation-target';
import { emptyPluginSelections } from '@canopy/execution-engine/lib/plugin-selections-normalization';
import {
  AUTOMATION_SHARE_BLOCK_MESSAGES,
  AUTOMATION_RUN_CONDITION_SHARE_WARNING_MESSAGES,
  AUTOMATION_RUN_CONDITION_SHARE_WARNING_SHORT_LABELS,
  AUTOMATION_SHARE_NOTICE_MESSAGES,
  buildSharedAutomationDocument,
  detectRunConditionShareWarnings,
  type BuildSharedAutomationDocumentOptions,
} from '@canopy/desktop-shared/lib/automation-sharing';
import type {
  AutomationPipelineDependency,
  ScheduledActivity,
} from '@canopy/desktop-shared/types';
import { actionTypeTakesPipelineDependencies } from './form/automationFormState';
import type { ShareablePluginRef } from '@canopy/execution-engine/plugin-refs';
import { hasAnySelections } from '@canopy/desktop-shared/types';
import {
  SHARED_AUTOMATION_PIPELINE_DEPENDENCIES_API_VERSION,
  SHARED_AUTOMATION_PIPELINE_DEPENDENCIES_CAPABILITY,
  SHARED_AUTOMATION_PIPELINE_TARGET_API_VERSION,
  SHARED_AUTOMATION_PIPELINE_TARGET_CAPABILITY,
  SHARED_AUTOMATION_RUN_CONDITION_API_VERSION,
  SHARED_AUTOMATION_RUN_CONDITION_CAPABILITY,
  sharedRunConditionHasHiddenCharacters,
  SHARED_AUTOMATION_TARGET_REQUIREMENT_API_VERSION,
  SHARED_AUTOMATION_TARGET_REQUIREMENT_CAPABILITY,
  MAX_SHARED_AUTOMATION_DESCRIPTION_BYTES,
  automationSharePath,
  type SharedAutomationDetail,
  type TargetContext,
} from '@canopy/protocol/automations';
import type {
  PipelinePackageAnalysisSummary,
  PipelinePackagePackagedPipeline,
  PipelineShareInstallPin,
} from '@canopy/protocol/pipelines';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import { useCanopyCloudAccountState } from '@/hooks/useCanopyCloudAccountState';
import {
  ShareCheckbox,
  ShareConflictError,
  deriveExistingShare,
  existingShareLoadFailure,
  shareOwnerFields,
  type CapabilityPackageAddablePipeline,
  type CapabilityPackageSharePort,
  type ShareDialogLink,
  type ShareResourceDialogState,
  type ShareResourceExtraOptionsContext,
  type ShareResourceOutcome,
  type ShareResourceScope,
  type ShareResourceShareInput,
} from '@canopy/ui-app/sharing';
import { DesktopShareResourceDialog } from '@/components/shared/share/DesktopShareResourceDialog';
import { useUnifiedTableData } from '@/hooks/useUnifiedTableData';
import { deriveShareablePluginsLenient } from '@/lib/agentSharing';
import {
  hashPipelineDocumentYaml,
  loadAutomationPipelineDocument,
  serializePipelineDocument,
  type AutomationPipelineWorktree,
} from '@/lib/pipelineDocument';
import {
  AUTOMATION_PUBLIC_SHARE_CHANGED_EVENT,
  createShareLinkResolver,
  resolveSharedAutomationUrl,
} from '@/lib/share-links';
import {
  missingRemoteShareCanBeRecreated,
  readSharedResourceErrorStatus,
} from '@/lib/sharedResourceErrors';
import { canManagePublicLink } from '@/components/shared/share/canManagePublicLink';
import {
  pipelineResolutionFromRaw,
  resolveAutomationPipelineScopes,
  resolveSessionTargetKind,
} from '@/lib/automationTargets';

const AUTOMATIONS_CRUD_CAPABILITY = 'automations-crud-v1';
const SHARE_SCOPES: readonly ShareResourceScope[] = [
  'team',
  'organization',
  'public',
];
const automationLinks = createShareLinkResolver(
  automationSharePath,
  resolveSharedAutomationUrl,
  'automation',
);
const INSTALLED_ANALYSIS_EXPIRES_AT = '9999-12-31T23:59:59.999Z';
const DESCRIPTION_TOO_LONG_ERROR =
  'Description is too long. Shorten it to 4 KiB or less.';
const TARGET_NARROWING_LABEL = 'Recipients can run it in';
const TARGET_NARROWING_CHOICES: readonly {
  context: TargetContext;
  label: string;
  testId: string;
}[] = [
  {
    context: 'cowork',
    label: `${CHAT_LABEL} projects`,
    testId: 'share-automation-target-cowork',
  },
  {
    context: 'worktree',
    label: 'Code projects',
    testId: 'share-automation-target-worktree',
  },
];
/** Block reasons that only mean a target fact is still being resolved. */
const TARGET_RESOLUTION_REASONS = new Set([
  'session_target_unresolved',
  'pipeline_target_unresolved',
]);

interface ShareAutomationModalProps {
  activity: ScheduledActivity;
  onClose: () => void;
  onOpenAccountSettings: () => void;
  onShared: (detail: SharedAutomationDetail) => void;
}

/**
 * The packaged pipelines that ship: the analysis also lists name-matched
 * suggestions the author left out, which are not in the manifest.
 */
function shippedPackagedPipelines(
  analysis: PipelinePackageAnalysisSummary | null | undefined,
): PipelinePackagePackagedPipeline[] {
  const resources = analysis?.manifest?.resources ?? [];
  return (analysis?.packagedPipelines ?? []).filter((pipeline) =>
    resources.some((resource) => resource.id === pipeline.resourceId),
  );
}

function isReferenceOnlyBuiltIn(ref: ShareablePluginRef): boolean {
  const source = ref.type === 'skill' ? ref.source : ref.marketplace;
  return source.type === 'builtin' || source.type === 'codex-builtin';
}

/** Automation snapshot/package binding around the common share dialog. */
export function ShareAutomationModal({
  activity: listed,
  onClose,
  onOpenAccountSettings,
  onShared,
}: ShareAutomationModalProps): JSX.Element {
  // A converted chat automation shares the workflow it runs (CAN-4551); a
  // converted package install shares the chat action it shows (CAN-5479).
  const activity = useMemo(() => sharedAutomationActivity(listed), [listed]);
  useCurrentUiStateReporter('sharing.automationDialog', {
    open: true,
    activityId: activity.id,
  });
  const api = window.api.automations;
  const [description, setDescription] = useState('');
  // On by default, except when the command may hold a secret: then the
  // sharer opts in before it leaves this machine.
  const [includeRunCondition, setIncludeRunCondition] = useState(
    () =>
      !detectRunConditionShareWarnings(
        activity.ifCommand?.trim() ?? '',
      ).includes('possible_secret'),
  );
  const { account: cloudAccount } = useCanopyCloudAccountState();
  // The dialog replaces its whole form (options included) when the server
  // lacks the required capability, so a v4 default would leave no way back to
  // v3. Without the capability the command stays private, as before v4. This
  // fails closed: until a conclusive account read shows the capability (or if
  // that read fails), the command stays private too.
  const serverAcceptsRunCondition =
    cloudAccount?.capabilities.includes(
      SHARED_AUTOMATION_RUN_CONDITION_CAPABILITY,
    ) === true;
  // v4 validation rejects hidden characters, so such a command stays private
  // rather than failing the whole share.
  const runConditionShareable = !sharedRunConditionHasHiddenCharacters(
    activity.ifCommand?.trim() ?? '',
  );
  const includesRunCondition =
    includeRunCondition && serverAcceptsRunCondition && runConditionShareable;
  // Pipelines travel only in v5 documents. A server whose account read shows
  // it can't publish them gets the pre-v5 shape instead: the action pipeline
  // inline and no prompt dependencies. Until a conclusive read, pipelines are
  // analyzed as usual.
  const serverRejectsPipelineDependencies =
    cloudAccount !== null &&
    !cloudAccount.capabilities.includes(
      SHARED_AUTOMATION_PIPELINE_DEPENDENCIES_CAPABILITY,
    );
  const [remoteDetail, setRemoteDetail] =
    useState<SharedAutomationDetail | null>(null);
  const [remoteLink, setRemoteLink] = useState<ShareDialogLink | null>(null);
  const [remoteMissing, setRemoteMissing] = useState(false);
  const [descriptionLoading, setDescriptionLoading] = useState(
    activity.remote !== undefined,
  );
  const pendingShared = useRef<SharedAutomationDetail | null>(null);
  const { rows, loading: catalogLoading } = useUnifiedTableData({
    includeCollections: true,
    includeMcp: false,
  });

  const pluginSelections =
    'pluginSelections' in activity.action
      ? activity.action.pluginSelections
      : undefined;
  const installedCapabilityPackage = activity.installedFrom?.capabilityPackage;
  const needsPluginResolution =
    pluginSelections !== undefined && hasAnySelections(pluginSelections);
  const promptText =
    'prompt' in activity.action && activity.action.prompt.trim().length > 0
      ? activity.action.prompt
      : undefined;
  const pipelineAction =
    activity.action.type === 'worktree_pipeline' ? activity.action : null;
  const needsCuratedKey = pipelineAction?.pipelineSource === 'curated';
  const [curatedPipelineKey, setCuratedPipelineKey] = useState<
    string | undefined
  >();
  const [pipelineIndexLoaded, setPipelineIndexLoaded] =
    useState(!needsCuratedKey);
  const needsSharedPipelinePin =
    pipelineAction?.pipelineSource === 'shared' &&
    pipelineAction.sharedPipeline?.remoteId !== undefined;
  const [sharedPipelineInstallPin, setSharedPipelineInstallPin] =
    useState<PipelineShareInstallPin | null>(
      pipelineAction?.sharedPipeline?.installPin ?? null,
    );
  const [sharedPipelinePinError, setSharedPipelinePinError] = useState<
    string | null
  >(null);
  const [bundledPipeline, setBundledPipeline] = useState<{
    rawPipeline: string;
    contentHash: string;
  } | null>(null);
  const [resolvedPipelineWorktree, setResolvedPipelineWorktree] =
    useState<AutomationPipelineWorktree | null>(null);
  const [pipelineLoading, setPipelineLoading] = useState(
    needsSharedPipelinePin,
  );
  // CAN-3734: a session prompt shares into the destination its bound project
  // implies, so the project's kind must be resolved before building.
  const sessionAction =
    activity.action.type === 'worktree_session_prompt' ? activity.action : null;
  const [sessionTargetKind, setSessionTargetKind] = useState<
    AutomationSessionTargetKind | undefined
  >();
  const [sessionTargetLoading, setSessionTargetLoading] = useState(
    sessionAction !== null,
  );
  // Pipelines whose bytes are not otherwise loaded (curated, bundled, legacy)
  // still need verified scopes before publication.
  const needsPipelineScopes =
    pipelineAction !== null &&
    pipelineAction.pipelineSource !== 'user' &&
    pipelineAction.pipelineSource !== 'project' &&
    pipelineAction.pipelineSource !== 'shared';
  const [pipelineScopes, setPipelineScopes] = useState<
    AutomationPipelineResolution | undefined
  >();
  const [pipelineScopesLoading, setPipelineScopesLoading] =
    useState(needsPipelineScopes);
  const [declaredTargetContexts, setDeclaredTargetContexts] = useState<
    TargetContext[] | undefined
  >(activity.targetRequirement?.contexts);
  // Public shares carry no file assets, so the analysis must know when the
  // author picks Public. Only that distinction re-runs it.
  const [publicAudience, setPublicAudience] = useState(false);
  const handleDialogStateChange = useCallback(
    (state: ShareResourceDialogState): void => {
      setPublicAudience(state.audience === 'public');
    },
    [],
  );
  // The last analysis main returned, so the document version (and the
  // capability the server needs for it) follows its packaged pipelines.
  const [latestAnalysis, setLatestAnalysis] =
    useState<PipelinePackageAnalysisSummary | null>(null);
  // The stored pipeline list plus pipelines added from this dialog, which
  // are saved with the automation before the analysis runs again.
  const storedPipelineDependencies = activity.dependencies?.pipelines;
  const [addedPipelineDependencies, setAddedPipelineDependencies] = useState<
    AutomationPipelineDependency[]
  >([]);
  const pipelineDependencies = useMemo(() => {
    const merged = [...(storedPipelineDependencies ?? [])];
    for (const added of addedPipelineDependencies) {
      if (
        !merged.some(
          (entry) =>
            entry.pipelineId === added.pipelineId &&
            entry.source === added.source,
        )
      )
        merged.push(added);
    }
    return merged;
  }, [addedPipelineDependencies, storedPipelineDependencies]);
  const offersPipelineAdd =
    installedCapabilityPackage === undefined &&
    !serverRejectsPipelineDependencies &&
    actionTypeTakesPipelineDependencies(activity.action.type);
  const [addablePipelines, setAddablePipelines] = useState<
    CapabilityPackageAddablePipeline[]
  >([]);
  useEffect(() => {
    const listPipelines = window.pipelines?.list?.bind(window.pipelines);
    if (!offersPipelineAdd || !listPipelines) return undefined;
    let cancelled = false;
    void listPipelines()
      .then((result) => {
        if (cancelled) return;
        // A user pipeline's package key is its id.
        setAddablePipelines(
          (result.data ?? [])
            .filter((pipeline) => pipeline.source === 'user')
            .map((pipeline) => ({
              id: pipeline.id,
              key: pipeline.id,
              name: pipeline.name,
            })),
        );
      })
      .catch(() => {
        if (!cancelled) setAddablePipelines([]);
      });
    return (): void => {
      cancelled = true;
    };
  }, [offersPipelineAdd]);
  const addPipelineDependency = useCallback(
    async (pipelineId: string): Promise<void> => {
      const added: AutomationPipelineDependency = {
        pipelineId,
        source: 'user',
      };
      const persisted = await api.update({
        id: activity.id,
        dependencies: { pipelines: [...pipelineDependencies, added] },
      });
      if (!persisted.ok) throw new Error(persisted.error);
      setAddedPipelineDependencies((previous) => [...previous, added]);
    },
    [activity.id, api, pipelineDependencies],
  );
  const pipelineAdd = useMemo(
    () =>
      offersPipelineAdd
        ? { options: addablePipelines, onAdd: addPipelineDependency }
        : undefined,
    [addPipelineDependency, addablePipelines, offersPipelineAdd],
  );

  const loadExistingShare = useCallback(
    async (assertCurrent?: () => void) => {
      if (!activity.remote) {
        setDescriptionLoading(false);
        assertCurrent?.();
        setRemoteDetail(null);
        assertCurrent?.();
        setRemoteLink(null);
        assertCurrent?.();
        setRemoteMissing(false);
        return { status: 'ready' } as const;
      }
      setDescriptionLoading(true);
      assertCurrent?.();
      setRemoteDetail(null);
      assertCurrent?.();
      setRemoteLink(null);
      try {
        const detail = await api.getShared(activity.remote.remoteId);
        assertCurrent?.();
        setRemoteDetail(detail);
        const refreshedLink = await automationLinks.linkFromDetail(detail);

        assertCurrent?.();

        setRemoteLink(refreshedLink);
        setDescription(detail.automation.description);
        if (
          activity.targetRequirement === undefined &&
          !activity.targetRequirementCleared
        )
          setDeclaredTargetContexts(
            detail.automation.targetRequirement?.contexts,
          );
        assertCurrent?.();
        setRemoteMissing(false);
        return { status: 'ready' } as const;
      } catch (error: unknown) {
        const missing =
          readSharedResourceErrorStatus(error) === 404 &&
          (await missingRemoteShareCanBeRecreated(activity.remote?.accountId));
        assertCurrent?.();
        setRemoteMissing(missing);
        return missing
          ? ({ status: 'ready' } as const)
          : existingShareLoadFailure('automation', error);
      } finally {
        setDescriptionLoading(false);
      }
    },
    [
      activity.remote,
      activity.targetRequirement,
      activity.targetRequirementCleared,
      api,
    ],
  );

  useEffect(() => {
    if (!needsCuratedKey || !pipelineAction) {
      setPipelineIndexLoaded(true);
      return undefined;
    }
    let cancelled = false;
    setPipelineIndexLoaded(false);
    void window.pipelines
      .list()
      .then((result) => {
        if (cancelled) return;
        const match = result.data?.find(
          (entry) => entry.id === pipelineAction.pipelineId,
        );
        setCuratedPipelineKey(
          match?.curatedOrigin?.key ?? match?.curatedKey ?? undefined,
        );
      })
      .finally(() => {
        if (!cancelled) setPipelineIndexLoaded(true);
      });
    return (): void => {
      cancelled = true;
    };
  }, [needsCuratedKey, pipelineAction]);

  useEffect(() => {
    const remoteId = pipelineAction?.sharedPipeline?.remoteId;
    if (!needsSharedPipelinePin || !remoteId) return undefined;
    let cancelled = false;
    setPipelineLoading(true);
    setSharedPipelinePinError(null);
    void api
      .resolveSharedPipelineInstallPin({ remoteId })
      .then(async (resolved) => {
        const contentHash = await hashPipelineDocumentYaml(
          resolved.rawPipeline,
        );
        if (cancelled) return;
        setSharedPipelineInstallPin(resolved.installPin);
        setBundledPipeline(
          contentHash
            ? { rawPipeline: resolved.rawPipeline, contentHash }
            : null,
        );
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setSharedPipelinePinError(
          error instanceof Error
            ? error.message
            : 'The shared workflow version could not be pinned.',
        );
      })
      .finally(() => {
        if (!cancelled) setPipelineLoading(false);
      });
    return (): void => {
      cancelled = true;
    };
  }, [api, needsSharedPipelinePin, pipelineAction]);

  const needsLocalPipelineContent =
    pipelineAction?.pipelineSource === 'user' ||
    pipelineAction?.pipelineSource === 'project';
  useEffect(() => {
    if (!needsLocalPipelineContent || !pipelineAction) return undefined;
    let cancelled = false;
    setPipelineLoading(true);
    void loadAutomationPipelineDocument(pipelineAction)
      .then(async (result) => {
        if (!result.data || cancelled) return;
        const rawPipeline =
          result.data.rawContent ??
          serializePipelineDocument(result.data.content);
        const contentHash = await hashPipelineDocumentYaml(rawPipeline);
        if (cancelled) return;
        setResolvedPipelineWorktree(result.worktree ?? null);
        setBundledPipeline(contentHash ? { rawPipeline, contentHash } : null);
      })
      .finally(() => {
        if (!cancelled) setPipelineLoading(false);
      });
    return (): void => {
      cancelled = true;
    };
  }, [needsLocalPipelineContent, pipelineAction]);

  useEffect(() => {
    if (!sessionAction) {
      setSessionTargetLoading(false);
      return undefined;
    }
    let cancelled = false;
    setSessionTargetLoading(true);
    void resolveSessionTargetKind(sessionAction)
      .then((kind) => {
        if (!cancelled) setSessionTargetKind(kind);
      })
      .finally(() => {
        if (!cancelled) setSessionTargetLoading(false);
      });
    return (): void => {
      cancelled = true;
    };
  }, [sessionAction]);

  useEffect(() => {
    if (!needsPipelineScopes || !pipelineAction) {
      setPipelineScopesLoading(false);
      return undefined;
    }
    let cancelled = false;
    setPipelineScopesLoading(true);
    void resolveAutomationPipelineScopes(pipelineAction)
      .then((resolution) => {
        if (!cancelled) setPipelineScopes(resolution);
      })
      .finally(() => {
        if (!cancelled) setPipelineScopesLoading(false);
      });
    return (): void => {
      cancelled = true;
    };
  }, [needsPipelineScopes, pipelineAction]);

  // Contexts the selected pipeline supports on its own, before any author
  // narrowing; drives the narrowing control and the "Runs in" line.
  const pipelineTargetContexts = useMemo((): TargetContext[] | undefined => {
    if (!pipelineAction) return undefined;
    const resolution = bundledPipeline
      ? pipelineResolutionFromRaw(bundledPipeline.rawPipeline)
      : pipelineScopes;
    // Checked against the action's destination, as the shared document is.
    const resolved = resolveAutomationTargetRequirement(
      'worktree_pipeline',
      activity.installedFrom ? activity.targetRequirement : undefined,
      resolution,
      pipelineAction.target?.kind,
    );
    return resolved.status === 'resolved' ? resolved.contexts : undefined;
  }, [
    activity.installedFrom,
    activity.targetRequirement,
    bundledPipeline,
    pipelineAction,
    pipelineScopes,
  ]);

  const packageWorktree = useMemo(():
    | { projectId: string; worktreeId: string; repoId?: string }
    | undefined => {
    if (activity.action.type === 'worktree_session_prompt') {
      return {
        projectId: activity.action.workspaceId,
        worktreeId: activity.action.worktreeId,
      };
    }
    if (activity.action.type !== 'worktree_pipeline') return undefined;
    return (
      resolvedPipelineWorktree ??
      (activity.action.baseWorktreeId && activity.action.workspaceId
        ? {
            projectId: activity.action.workspaceId,
            worktreeId: activity.action.baseWorktreeId,
            ...(activity.action.repoId
              ? { repoId: activity.action.repoId }
              : {}),
          }
        : undefined)
    );
  }, [activity.action, resolvedPipelineWorktree]);

  const waitingOnData =
    descriptionLoading ||
    (needsPluginResolution && catalogLoading) ||
    !pipelineIndexLoaded ||
    pipelineLoading ||
    sessionTargetLoading ||
    pipelineScopesLoading;
  const resolvedPlugins = useMemo(
    () =>
      needsPluginResolution && pluginSelections
        ? deriveShareablePluginsLenient(pluginSelections, rows, {
            packageLocalCapabilities: true,
          })
        : undefined,
    [needsPluginResolution, pluginSelections, rows],
  );
  const baseBuildOptions = useMemo((): BuildSharedAutomationDocumentOptions => {
    return {
      description,
      includeRunCondition: includesRunCondition,
      ...(sessionTargetKind ? { sessionTargetKind } : {}),
      ...(declaredTargetContexts ? { declaredTargetContexts } : {}),
      ...(pipelineScopes ? { pipelineResolution: pipelineScopes } : {}),
      ...(resolvedPlugins ? { resolvedPlugins } : {}),
      ...(curatedPipelineKey ? { curatedPipelineKey } : {}),
      ...(sharedPipelineInstallPin ? { sharedPipelineInstallPin } : {}),
      ...(bundledPipeline
        ? {
            pipelineRawContent: bundledPipeline.rawPipeline,
            pipelineContentHash: bundledPipeline.contentHash,
          }
        : {}),
    };
  }, [
    bundledPipeline,
    curatedPipelineKey,
    declaredTargetContexts,
    description,
    includesRunCondition,
    pipelineScopes,
    resolvedPlugins,
    sessionTargetKind,
    sharedPipelineInstallPin,
  ]);
  const runConditionCommand = activity.ifCommand?.trim() ?? '';
  const runConditionWarnings = useMemo(
    () =>
      runConditionCommand
        ? detectRunConditionShareWarnings(runConditionCommand)
        : [],
    [runConditionCommand],
  );
  const firstRunConditionWarning = runConditionWarnings[0];
  const runConditionMaySecret = firstRunConditionWarning === 'possible_secret';
  const runConditionCollapsedHint = !includesRunCondition
    ? runConditionMaySecret
      ? 'May contain a secret, kept private'
      : 'Run condition kept private'
    : firstRunConditionWarning
      ? AUTOMATION_RUN_CONDITION_SHARE_WARNING_SHORT_LABELS[
          firstRunConditionWarning
        ]
      : null;
  const buildResult = useMemo(
    () => buildSharedAutomationDocument(activity, baseBuildOptions),
    [activity, baseBuildOptions],
  );
  const descriptionError =
    new TextEncoder().encode(description).length >
    MAX_SHARED_AUTOMATION_DESCRIPTION_BYTES
      ? DESCRIPTION_TOO_LONG_ERROR
      : null;
  const packageContentKey = useMemo(
    () => JSON.stringify({ name: activity.name, action: activity.action }),
    [activity.action, activity.name],
  );
  const packagePort = useMemo((): CapabilityPackageSharePort | null => {
    if (waitingOnData) return null;
    if (installedCapabilityPackage) {
      const installedAnalysis: PipelinePackageAnalysisSummary = {
        analysisId: `installed:${installedCapabilityPackage.digest}`,
        state: 'ready',
        pipelineContentHash: '0'.repeat(64),
        blockers: [],
        // Main holds no analysis for an installed package, so this review
        // never expires; an expired one would send Share into a recheck loop.
        expiresAt: INSTALLED_ANALYSIS_EXPIRES_AT,
        manifest: {
          version: 1,
          pipelineContentHash: '0'.repeat(64),
          resources: [
            {
              id: 'installed-capability-package',
              kind: 'pipeline_action',
              displayName: 'Installed capability package',
              sourceLabel: 'installed share',
              sourceVisibility: 'private',
              invocationKeys: [],
              dependencyResourceIds: [],
              trees: [],
            },
          ],
          bindings: [
            {
              jobId: 'automation',
              stepId: 'action',
              resourceIds: ['installed-capability-package'],
            },
          ],
          environmentRequirements: [],
          totalFiles: 0,
          totalBytes: 0,
        },
      };
      return { analyze: () => Promise.resolve(installedAnalysis) };
    }
    return {
      analyze: async ({
        dismissedInvocations,
        dismissedReferences,
        pipelineSelections,
      }): Promise<PipelinePackageAnalysisSummary> => {
        const summary = await api.analyzeCapabilityPackage({
          rawContent: packageContentKey,
          activityId: activity.id,
          selections: pluginSelections ?? emptyPluginSelections(),
          ...(promptText ? { promptText } : {}),
          ...(packageWorktree ? { worktree: packageWorktree } : {}),
          ...(bundledPipeline
            ? { pipelineContent: bundledPipeline.rawPipeline }
            : {}),
          ...(dismissedInvocations !== undefined
            ? { dismissedInvocations: [...dismissedInvocations] }
            : {}),
          ...(dismissedReferences !== undefined
            ? { dismissedReferences: [...dismissedReferences] }
            : {}),
          ...(pipelineSelections !== undefined
            ? { pipelineSelections: [...pipelineSelections] }
            : {}),
          ...(pipelineDependencies.length > 0
            ? { pipelineDependencies: [...pipelineDependencies] }
            : {}),
          ...(publicAudience ? { audience: 'public' as const } : {}),
          ...(serverRejectsPipelineDependencies
            ? { packagePipelines: false }
            : {}),
        });
        setLatestAnalysis(summary);
        return summary;
      },
      cancel: (analysisId) => api.cancelCapabilityPackageAnalysis(analysisId),
    };
  }, [
    activity.id,
    api,
    bundledPipeline,
    installedCapabilityPackage,
    packageContentKey,
    packageWorktree,
    pipelineDependencies,
    pluginSelections,
    promptText,
    publicAudience,
    serverRejectsPipelineDependencies,
    waitingOnData,
  ]);
  const usesPackagedPipelines =
    installedCapabilityPackage === undefined &&
    shippedPackagedPipelines(latestAnalysis).length > 0;

  const share = useCallback(
    async (input: ShareResourceShareInput): Promise<ShareResourceOutcome> => {
      if (!buildResult.ok) {
        throw new Error('This automation cannot be shared yet.');
      }
      if (declaredTargetContexts !== undefined && !activity.installedFrom) {
        const persisted = await api.update({
          id: activity.id,
          targetRequirement: { contexts: declaredTargetContexts },
        });
        if (!persisted.ok) throw new Error(persisted.error);
      }
      const selection = input.packageSelection ?? null;
      let outgoing = buildResult.document;
      let committedPackageUploadId: string | undefined;
      if (selection !== null) {
        const expectedInstalledPackageContentHash = installedCapabilityPackage
          ? (bundledPipeline?.contentHash ??
            (await hashPipelineDocumentYaml(packageContentKey)))
          : undefined;
        const committed = unwrapShareOperationResult(
          await api.commitCapabilityPackage(
            installedCapabilityPackage
              ? {
                  localAutomationId: activity.id,
                  packageRef: installedCapabilityPackage,
                  expectedPackageContentHash:
                    expectedInstalledPackageContentHash ?? null,
                }
              : {
                  analysisId: selection.analysisId,
                  selectedOptionalResourceIds: [
                    ...selection.selectedOptionalResourceIds,
                  ],
                },
          ),
        );
        committedPackageUploadId = committed.committedPackageUploadId;
        const packagedPipelines = installedCapabilityPackage
          ? []
          : shippedPackagedPipelines(selection.analysis);
        const rebuilt = buildSharedAutomationDocument(activity, {
          ...baseBuildOptions,
          ...(baseBuildOptions.resolvedPlugins
            ? {
                resolvedPlugins: {
                  plugins: (Array.isArray(baseBuildOptions.resolvedPlugins)
                    ? baseBuildOptions.resolvedPlugins
                    : baseBuildOptions.resolvedPlugins.plugins
                  ).filter(isReferenceOnlyBuiltIn),
                  dropped: Array.isArray(baseBuildOptions.resolvedPlugins)
                    ? []
                    : baseBuildOptions.resolvedPlugins.dropped,
                },
              }
            : {}),
          capabilityPackage: committed.capabilityPackage,
          ...(packagedPipelines.length > 0 ? { packagedPipelines } : {}),
        });
        if (!rebuilt.ok) {
          throw new Error(
            rebuilt.reasons.includes('pipeline_dependencies_stale')
              ? AUTOMATION_SHARE_BLOCK_MESSAGES.pipeline_dependencies_stale
              : 'The packaged automation could not be prepared.',
          );
        }
        outgoing = rebuilt.document;
      }

      const ownerFields = shareOwnerFields(input, remoteDetail);
      const create = async (): Promise<SharedAutomationDetail> => {
        input.assertAllowed?.();
        return unwrapShareOperationResult(
          await api.createShared({
            activityId: activity.id,
            automation: outgoing,
            ...(committedPackageUploadId ? { committedPackageUploadId } : {}),
            // Fork lineage names a team share. A public-share id or a curated
            // catalog key is a different namespace and is never one.
            ...(activity.installedFrom &&
            (activity.installedFrom.sourceKind ?? 'shared') === 'shared'
              ? {
                  savedFrom: {
                    remoteId: activity.installedFrom.remoteId,
                    contentHash: activity.installedFrom.contentHash,
                  },
                }
              : {}),
            ...ownerFields,
          }),
        );
      };
      const revokePublicShare =
        input.scope !== 'public' &&
        !input.preservePublicLink &&
        remoteDetail?.publicShare
          ? {
              externalId: remoteDetail.publicShare.externalId,
              updatedAt: remoteDetail.publicShare.updatedAt,
            }
          : undefined;
      let detail: SharedAutomationDetail;
      if (activity.remote && !remoteMissing) {
        try {
          input.assertAllowed?.();
          detail = unwrapShareOperationResult(
            await api.updateShared({
              activityId: activity.id,
              automationId: activity.remote.remoteId,
              automation: outgoing,
              expectedContentHash:
                remoteDetail?.contentHash ?? activity.remote.contentHash,
              ...(committedPackageUploadId ? { committedPackageUploadId } : {}),
              ...(revokePublicShare ? { revokePublicShare } : {}),
              ...ownerFields,
            }),
          );
        } catch (error: unknown) {
          const status = readSharedResourceErrorStatus(error);
          if (status === 409) throw new ShareConflictError();
          if (
            status !== 404 ||
            !(await missingRemoteShareCanBeRecreated(activity.remote.accountId))
          )
            throw error;
          detail = await create();
        }
      } else {
        if (
          activity.remote &&
          !(await missingRemoteShareCanBeRecreated(activity.remote.accountId))
        ) {
          throw new Error('This shared automation was not found.');
        }
        detail = await create();
      }

      input.assertAllowed?.();
      let shareUrl: string | undefined;
      let publicLinkFailed = false;
      if (input.scope === 'public') {
        input.assertAllowed?.();
        try {
          const published = await api.publishPublicShare(detail.id);
          detail = { ...detail, publicShare: published };
          const link = await automationLinks.resolveLink({
            kind: 'public',
            id: detail.id,
            sharePath: published.sharePath,
          });
          shareUrl = link.url;
          input.assertAllowed?.();
          setRemoteLink(link);
          input.assertAllowed?.();
          window.dispatchEvent(
            new Event(AUTOMATION_PUBLIC_SHARE_CHANGED_EVENT),
          );
        } catch {
          publicLinkFailed = true;
        }
      } else {
        if (revokePublicShare) {
          detail = { ...detail, publicShare: null };
          input.assertAllowed?.();
          window.dispatchEvent(
            new Event(AUTOMATION_PUBLIC_SHARE_CHANGED_EVENT),
          );
        }
        if (input.scope === 'team' || input.scope === 'organization') {
          const link = await automationLinks.resolveLink({
            kind: 'scoped',
            id: detail.id,
          });
          shareUrl = link.url;
          input.assertAllowed?.();
          setRemoteLink(link);
        }
      }
      input.assertAllowed?.();
      pendingShared.current = detail;
      input.assertAllowed?.();
      setRemoteDetail(detail);
      input.assertAllowed?.();
      setRemoteMissing(false);
      return {
        ...(shareUrl ? { shareUrl } : {}),
        ...(publicLinkFailed ? { publicLinkFailed: true } : {}),
      };
    },
    [
      activity,
      api,
      baseBuildOptions,
      buildResult,
      declaredTargetContexts,
      bundledPipeline?.contentHash,
      installedCapabilityPackage,
      packageContentKey,
      remoteDetail,
      remoteMissing,
    ],
  );

  const retryPublicLink = useCallback(
    async (assertCurrent?: () => void): Promise<ShareResourceOutcome> => {
      assertCurrent?.();
      const detail = pendingShared.current;
      if (!detail) return { publicLinkFailed: true };
      const published = await api.publishPublicShare(detail.id);
      const next = { ...detail, publicShare: published };
      assertCurrent?.();
      pendingShared.current = next;
      assertCurrent?.();
      setRemoteDetail(next);
      assertCurrent?.();
      window.dispatchEvent(new Event(AUTOMATION_PUBLIC_SHARE_CHANGED_EVENT));
      const link = await automationLinks.resolveLink({
        kind: 'public',
        id: detail.id,
        sharePath: published.sharePath,
      });
      assertCurrent?.();
      setRemoteLink(link);
      return { shareUrl: link.url };
    },
    [api],
  );

  const handleCompleted = useCallback((): void => {
    if (!pendingShared.current) return;
    const detail = pendingShared.current;
    onShared(detail);
    pendingShared.current = null;
  }, [onShared]);

  const extraOptions = useCallback(
    ({ packageReview }: ShareResourceExtraOptionsContext) => (
      <Stack gap="group">
        <FormField label="Description (optional)" error={descriptionError}>
          {(control) => (
            <TextArea
              {...control}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              rows={3}
              placeholder="Describe what this automation does."
              data-testid="share-automation-description"
            />
          )}
        </FormField>
        {sharedPipelinePinError && (
          <Notice intent="destructive" data-testid="share-automation-blockers">
            {sharedPipelinePinError}
          </Notice>
        )}
        {!buildResult.ok &&
          !(
            waitingOnData &&
            buildResult.reasons.every((reason) =>
              TARGET_RESOLUTION_REASONS.has(reason),
            )
          ) && (
            <Notice
              intent="destructive"
              data-testid="share-automation-blockers"
            >
              <p>This automation cannot be shared yet:</p>
              <ul className="list-disc pl-5">
                {buildResult.reasons.map((reason) => (
                  <li key={reason}>
                    {AUTOMATION_SHARE_BLOCK_MESSAGES[reason]}
                  </li>
                ))}
              </ul>
              {buildResult.detail && <p>{buildResult.detail}</p>}
            </Notice>
          )}
        {(buildResult.ok ||
          runConditionCommand ||
          packageReview ||
          (pipelineTargetContexts !== undefined &&
            pipelineTargetContexts.length > 1)) && (
          <Disclosure
            dataTestId="share-automation-advanced"
            label="More details"
            hint={runConditionCollapsedHint}
          >
            {pipelineTargetContexts !== undefined &&
              pipelineTargetContexts.length > 1 && (
                <div className="text-s">
                  <Fieldset
                    gap="tight"
                    legend={
                      <span className="fg-secondary">
                        {TARGET_NARROWING_LABEL}
                      </span>
                    }
                    data-testid="share-automation-target-narrowing"
                  >
                    {TARGET_NARROWING_CHOICES.map(
                      ({ context, label, testId }) => {
                        const selected =
                          declaredTargetContexts ?? pipelineTargetContexts;
                        const checked = selected.includes(context);
                        return (
                          <ShareCheckbox
                            key={context}
                            checked={checked}
                            // At least one context must stay allowed.
                            disabled={checked && selected.length === 1}
                            onChange={(next) =>
                              setDeclaredTargetContexts(
                                pipelineTargetContexts.filter((candidate) =>
                                  candidate === context
                                    ? next
                                    : selected.includes(candidate),
                                ),
                              )
                            }
                            inputTestId={testId}
                          >
                            {label}
                          </ShareCheckbox>
                        );
                      },
                    )}
                  </Fieldset>
                </div>
              )}
            {buildResult.ok &&
              !(
                pipelineTargetContexts !== undefined &&
                pipelineTargetContexts.length > 1
              ) && (
                <AutomationTargetRequirementLine
                  automation={buildResult.document}
                  {...(pipelineTargetContexts !== undefined
                    ? { resolvedTargetContexts: pipelineTargetContexts }
                    : {})}
                />
              )}
            {buildResult.ok &&
              buildResult.notices.includes('pipeline_definition_bundled') && (
                <Notice
                  intent="neutral"
                  data-testid="share-automation-included-notices"
                >
                  <p>Included with this automation:</p>
                  <ul className="list-disc pl-5">
                    <li>
                      {
                        AUTOMATION_SHARE_NOTICE_MESSAGES.pipeline_definition_bundled
                      }
                    </li>
                  </ul>
                </Notice>
              )}
            {buildResult.ok &&
              buildResult.notices.some(
                (notice) => notice !== 'pipeline_definition_bundled',
              ) && (
                <Notice
                  intent="attention"
                  data-testid="share-automation-notices"
                >
                  <p>Kept private when sharing:</p>
                  <ul className="list-disc pl-5">
                    {buildResult.notices
                      .filter(
                        (notice) => notice !== 'pipeline_definition_bundled',
                      )
                      .map((notice) => (
                        <li key={notice}>
                          {AUTOMATION_SHARE_NOTICE_MESSAGES[notice]}
                        </li>
                      ))}
                  </ul>
                </Notice>
              )}
            {buildResult.ok && (resolvedPlugins?.dropped.length ?? 0) > 0 && (
              <Notice intent="attention">
                <p>Local capabilities kept private:</p>
                <ul
                  className="list-disc pl-5"
                  data-testid="share-automation-dropped-plugins"
                >
                  {resolvedPlugins?.dropped.map((label) => (
                    <li key={label}>{label}</li>
                  ))}
                </ul>
              </Notice>
            )}
            {runConditionCommand && (
              <Stack gap="inline" data-testid="share-automation-run-condition">
                <ShareCheckbox
                  checked={includesRunCondition}
                  onChange={setIncludeRunCondition}
                  disabled={
                    !serverAcceptsRunCondition || !runConditionShareable
                  }
                  inputTestId="share-automation-include-run-condition"
                >
                  Include run-condition command
                </ShareCheckbox>
                {cloudAccount !== null && !serverAcceptsRunCondition && (
                  <p
                    className="text-xs fg-secondary"
                    data-testid="share-automation-run-condition-unsupported"
                  >
                    The server can’t receive run-condition commands yet.
                  </p>
                )}
                {serverAcceptsRunCondition && !runConditionShareable && (
                  <p
                    className="text-xs fg-secondary"
                    data-testid="share-automation-run-condition-hidden-characters"
                  >
                    This command has hidden characters, so it can't be shared.
                  </p>
                )}
                <pre
                  className={`${POSTHOG_REPLAY_BLOCK_CLASS} max-h-32 overflow-auto whitespace-pre-wrap rounded-lg bg-secondary p-3 text-xs fg-secondary`}
                  data-testid="share-automation-run-condition-command"
                >
                  {runConditionCommand}
                </pre>
                {!includesRunCondition &&
                  serverAcceptsRunCondition &&
                  runConditionShareable &&
                  runConditionMaySecret && (
                    <p
                      className="text-xs fg-secondary"
                      data-testid="share-automation-run-condition-secret-off"
                    >
                      The command may contain a secret, so it's off by default.
                    </p>
                  )}
                {includesRunCondition && runConditionWarnings.length > 0 && (
                  <Stack
                    gap="tight"
                    data-testid="share-automation-run-condition-warnings"
                  >
                    {runConditionWarnings.map((warning) => (
                      <p key={warning} className="text-xs fg-secondary">
                        {
                          AUTOMATION_RUN_CONDITION_SHARE_WARNING_MESSAGES[
                            warning
                          ]
                        }
                      </p>
                    ))}
                  </Stack>
                )}
              </Stack>
            )}
            {packageReview}
            {buildResult.ok && (
              <div
                className="flex flex-col gap-1"
                data-testid="share-automation-preview"
              >
                <Heading level={3} variant="title">
                  Shared document
                </Heading>
                <pre
                  className={`${POSTHOG_REPLAY_BLOCK_CLASS} max-h-52 overflow-auto rounded-lg bg-secondary p-3 text-xs fg-secondary`}
                >
                  {JSON.stringify(buildResult.document, null, 2)}
                </pre>
              </div>
            )}
          </Disclosure>
        )}
      </Stack>
    ),
    [
      buildResult,
      cloudAccount,
      declaredTargetContexts,
      description,
      descriptionError,
      includesRunCondition,
      pipelineTargetContexts,
      resolvedPlugins?.dropped,
      runConditionCollapsedHint,
      runConditionCommand,
      runConditionMaySecret,
      runConditionShareable,
      runConditionWarnings,
      serverAcceptsRunCondition,
      sharedPipelinePinError,
      waitingOnData,
    ],
  );

  const existingShare = remoteDetail
    ? deriveExistingShare({ ...remoteDetail, link: remoteLink })
    : activity.remote && activity.remote.shareScope !== 'private'
      ? { audience: activity.remote.shareScope }
      : undefined;

  const revokePublicLink = useCallback(
    async (assertCurrent?: () => void): Promise<void> => {
      assertCurrent?.();
      if (!remoteDetail?.publicShare) return;
      await api.revokePublicShare(remoteDetail.id);
      assertCurrent?.();
      setRemoteDetail({ ...remoteDetail, publicShare: null });
      assertCurrent?.();
      window.dispatchEvent(new Event(AUTOMATION_PUBLIC_SHARE_CHANGED_EVENT));
    },
    [api, remoteDetail],
  );

  return (
    <DesktopShareResourceDialog
      marketplace={{ kind: 'automation', resourceKey: activity.id }}
      resourceNoun="automation"
      testIdPrefix="share-automation"
      requiredCapability={
        !buildResult.ok
          ? AUTOMATIONS_CRUD_CAPABILITY
          : buildResult.document.version ===
              SHARED_AUTOMATION_PIPELINE_TARGET_API_VERSION
            ? SHARED_AUTOMATION_PIPELINE_TARGET_CAPABILITY
            : usesPackagedPipelines ||
                buildResult.document.version ===
                  SHARED_AUTOMATION_PIPELINE_DEPENDENCIES_API_VERSION
              ? SHARED_AUTOMATION_PIPELINE_DEPENDENCIES_CAPABILITY
              : buildResult.document.version ===
                  SHARED_AUTOMATION_RUN_CONDITION_API_VERSION
                ? SHARED_AUTOMATION_RUN_CONDITION_CAPABILITY
                : buildResult.document.version ===
                    SHARED_AUTOMATION_TARGET_REQUIREMENT_API_VERSION
                  ? SHARED_AUTOMATION_TARGET_REQUIREMENT_CAPABILITY
                  : AUTOMATIONS_CRUD_CAPABILITY
      }
      scopes={SHARE_SCOPES}
      subtitle={activity.name}
      landing="marketplace"
      shareDisabled={
        waitingOnData ||
        descriptionError !== null ||
        sharedPipelinePinError !== null ||
        !buildResult.ok
      }
      capabilityPackage={{
        port: packagePort,
        placement: 'host',
        ...(pipelineAdd ? { pipelineAdd } : {}),
      }}
      preflight={loadExistingShare}
      {...(existingShare ? { existingShare } : {})}
      keepsOrganizationOwnership
      extraOptions={extraOptions}
      share={share}
      retryPublicLink={retryPublicLink}
      {...(canManagePublicLink(remoteDetail) ? { revokePublicLink } : {})}
      onClose={onClose}
      onOpenAccountSettings={onOpenAccountSettings}
      onCompleted={handleCompleted}
      onStateChange={handleDialogStateChange}
    />
  );
}

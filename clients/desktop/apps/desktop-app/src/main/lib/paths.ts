import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'path';
import { scriptRunFileStem } from '@canopy/core-runtime/node/script/run-log-stem';
import {
  getCanopyDataDir,
  getCanopySecureDataDir,
  getInternalLegacySharedSecureDataDir,
  getPrimaryBrandDataDir,
  getResolvedCanopyDataDir,
} from '@canopy/execution-engine/canopy-paths';
import { getWorktreeCodeGraphDir as getSharedWorktreeCodeGraphDir } from '@canopy/desktop-shared/node/code-graph/worktree-paths';
import {
  pipelineAssetsDir,
  pipelineAssetsManifestPath,
  pipelineDataDir,
} from '@canopy/desktop-shared/node/pipelines/pipeline-assets';
import {
  APP_ADVISOR_PROJECT_ID,
  CODE_REVIEW_CHAT_PROJECT_ID,
  DEFAULT_CHAT_PROJECT_ID,
  PIPELINE_EDITOR_PROJECT_ID,
  PLAN_EXPLORE_CHAT_PROJECT_ID,
  SHARED_CONTAINER_VIEWER_PROJECT_ID,
  type AgentAuditTranscriptRequest,
  type PanelLayoutSurface,
} from '@canopy/desktop-shared/types';
export {
  getCursorRuntimeRootDir,
  getCursorRuntimeStateDir,
} from '@canopy/execution-engine/pipelines/config-paths';
import {
  getWorkspaceExternalPath,
  getWorkspaceType,
} from './workspace-registry';
import { validateId } from './validation';

export function getDataDir(): string {
  return getCanopyDataDir();
}

export function getPipelinePackagesDir(): string {
  return join(getDataDir(), 'pipeline-packages', 'v1');
}

/** `<data>/pipeline-data`: per-pipeline state and installed assets. */
export function getPipelineDataRoot(): string {
  return join(getDataDir(), 'pipeline-data');
}

/** `<data>/pipeline-data/<id>/state`, read as `canopy.pipeline_data_dir`. */
export function getPipelineDataDir(id: string): string {
  validateId(id, 'pipeline data id');
  return pipelineDataDir(getPipelineDataRoot(), id);
}

/** `<data>/pipeline-data/<id>/assets`, the installed asset root. */
export function getPipelineAssetsDir(id: string): string {
  validateId(id, 'pipeline data id');
  return pipelineAssetsDir(getPipelineDataRoot(), id);
}

/** `<data>/pipeline-data/<id>/assets.json`, per-file install hashes. */
export function getPipelineAssetsManifestPath(id: string): string {
  validateId(id, 'pipeline data id');
  return pipelineAssetsManifestPath(getPipelineDataRoot(), id);
}

export function getPipelinePackageInstallStorePath(): string {
  return join(getDataDir(), 'pipeline-package-installs.json');
}

/** `<data>/pipeline-install-intents/`, one record per unfinished install. */
export function getPipelineInstallIntentsDir(): string {
  return join(getDataDir(), 'pipeline-install-intents');
}

export function getPipelinePackageDismissalStorePath(): string {
  return join(getDataDir(), 'pipeline-package-dismissals.json');
}

export function getSharedContainersRootDir(): string {
  return join(getDataDir(), 'shared-containers');
}

export function getSharedContainersIndexPath(): string {
  return join(getSharedContainersRootDir(), 'index.json');
}

/**
 * Recipient consent to materialize shared containers on this device.
 *
 * Deliberately a sibling of the replica root rather than a file inside it: the
 * replica index refuses any entry it does not account for, and consent has to
 * outlive (and precede) the existence of a replica.
 */
export function getSharedContainerAcceptanceFilePath(): string {
  return join(getDataDir(), 'shared-container-acceptance.json');
}

export function getSharedContainerRunEnvFilePath(): string {
  return join(getDataDir(), 'shared-container-run-env.json');
}

/**
 * Attempt journals for installing a fork's capability package: what each
 * attempt created, so a crashed attempt can be finished or compensated. App
 * metadata beside the install ledger; never inside a checkout.
 */
export function getSharedContainerCapabilityInstallJournalDir(): string {
  return join(getDataDir(), 'shared-container-capability-installs');
}

export function getWorkspacesRootDir(): string {
  return join(getDataDir(), 'workspaces');
}

export function getAppWorkspacesRootDir(): string {
  return join(getDataDir(), 'app-workspaces');
}

function isAppManagedChatWorkspaceId(workspaceId: string): boolean {
  return (
    workspaceId === APP_ADVISOR_PROJECT_ID ||
    workspaceId === PLAN_EXPLORE_CHAT_PROJECT_ID ||
    workspaceId === CODE_REVIEW_CHAT_PROJECT_ID ||
    workspaceId === PIPELINE_EDITOR_PROJECT_ID ||
    workspaceId === SHARED_CONTAINER_VIEWER_PROJECT_ID
  );
}

function isAppManagedChatWorkspace(workspaceId: string): boolean {
  if (
    workspaceId === APP_ADVISOR_PROJECT_ID ||
    workspaceId === SHARED_CONTAINER_VIEWER_PROJECT_ID
  ) {
    // These sentinels are permanently app-managed and must never be redirected
    // by the indexed workspace registry, even if stale/corrupt registry state
    // happens to contain a reserved id.
    return true;
  }
  return (
    isAppManagedChatWorkspaceId(workspaceId) &&
    getWorkspaceType(workspaceId) === null
  );
}

export function getAppManagedChatWorkspaceDir(workspaceId: string): string {
  return join(getAppWorkspacesRootDir(), workspaceId);
}

export function getWorkspaceIndexFilePath(): string {
  return join(getWorkspacesRootDir(), 'index.json');
}

export function getRepoShadowsRootDir(): string {
  return join(getDataDir(), 'repo-shadows');
}

export function getPreferencesFilePath(): string {
  return join(getDataDir(), 'preferences.json');
}

export function getMigrationsFilePath(): string {
  return join(getDataDir(), 'migrations.json');
}

/** Global, rebuildable chat-title and transcript search index. */
export function getChatSearchIndexPath(): string {
  return join(getDataDir(), 'derived', 'chat-search.sqlite');
}

/**
 * Durable local Agent Ledger store. Only the Ledger storage worker opens it,
 * and it creates the directory on the first Ledger operation, never at startup.
 */
export function getLedgerDatabasePath(): string {
  return join(getDataDir(), 'ledger', 'ledger.sqlite');
}

/**
 * The W5 commit log: revisions, retry receipts and committed changes to the
 * workspace index, manifests and worktree lists (CAN-3805). Kept outside the
 * workspaces root it records changes to. Only the W5 commit log worker opens
 * it, and it creates the directory on first use, never at startup.
 */
export function getW5CommitLogPath(): string {
  return join(getDataDir(), 'w5', 'commit-log.sqlite');
}

/**
 * The durable operation ledger (CAN-4130): one record per accepted unit of
 * execution work, with its retry receipt, lineage, owner and outcome. Opened
 * on the first `core.operation.*` call or domain admission, never at startup.
 */
export function getOperationLedgerPath(): string {
  return join(getDataDir(), 'operations', 'operation-ledger.sqlite');
}

/** Saved queued hook details beside the operation ledger (CAN-5081). */
export function getHookQueueDir(): string {
  return join(getDataDir(), 'initiated-work', 'hook-queue');
}

/** The flip launch's record of its one W5 backup (CAN-5543). */
export function getW5FlipBackupMarkerPath(): string {
  return join(getDataDir(), 'w5', 'flip-backup.json');
}

export function getW5DestructiveLifecycleDir(): string {
  return join(getDataDir(), 'w5', 'destructive-lifecycles');
}

/**
 * CAN-5335: unreadable lifecycle journal entries the user moved aside. A
 * sibling of the journal directory, on its device, that no scanner reads.
 */
export function getW5QuarantinedLifecycleDir(): string {
  return join(getDataDir(), 'w5', 'quarantined-lifecycles');
}

/**
 * The Ledger lifecycle's durable intent journal: a small JSON file beside the
 * database, never inside it. Written only once the database exists, so it
 * never creates the Ledger directory.
 */
export function getLedgerLifecycleIntentsPath(): string {
  return join(getDataDir(), 'ledger', 'lifecycle-intents.json');
}

/**
 * Merged guest accounts whose Ledger scopes still have to move to the account
 * that signed in. Beside the database, and written only once it exists.
 */
export function getLedgerGuestRebindIntentsPath(): string {
  return join(getDataDir(), 'ledger', 'guest-rebind-intents.json');
}

/**
 * Old chat-project-id -> new cowork-workspace-id mapping produced by the
 * one-time `cowork_workspaces` startup migration. Kept separate from
 * `migrations.json` (which only stores boolean-style markers) so the map can
 * grow without changing that file's shape.
 */
export function getCoworkMigrationMapFilePath(): string {
  return join(getDataDir(), 'cowork-migration.json');
}

export function getAppAdvisorWatchersFilePath(): string {
  return join(getDataDir(), 'app-advisor-watchers.json');
}

export function getAutomationsFilePath(): string {
  return join(getDataDir(), 'automations.json');
}

function getAutomationRunsDir(): string {
  return join(getDataDir(), 'automation-runs');
}

export function getAutomationRunArchiveFilePath(activityId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(activityId)) {
    throw new Error('Invalid automation activity id');
  }
  return join(getAutomationRunsDir(), `${activityId}.jsonl`);
}

export function getSkillUsageFilePath(): string {
  return join(getDataDir(), 'skill-usage.json');
}

/** Durable repeat-task skill suggestion state (CAN-385). */
export function getSkillSuggestionsStateFilePath(): string {
  return join(getDataDir(), 'skill-suggestions.json');
}

/** Rebuildable request fingerprints the skill suggestion scan reads. */
export function getSkillSuggestionFingerprintsFilePath(): string {
  return join(
    getDataDir(),
    'derived',
    'skill-suggestions',
    'fingerprints.jsonl',
  );
}

/** Empty working directory for the report-only skill suggestion scan helper. */
export function getSkillSuggestionsHelperDir(): string {
  return join(getDataDir(), 'derived', 'skill-suggestions', 'helper');
}

/** Device-local install-subscription ledger and outbox (CAN-2334). */
export function getSharedItemUpdateSubscriptionsFilePath(): string {
  return join(getDataDir(), 'shared-item-update-subscriptions.json');
}

export function getUsageLimitedChatsFilePath(): string {
  return join(getDataDir(), 'usage-limited-chats.json');
}

export function getResumeQueueFilePath(): string {
  return join(getDataDir(), 'resume-queue.json');
}

/**
 * Per-account replica of the user's saved per-space notification choices
 * (CAN-3615), one file per account, so saved choices are enforced across
 * restarts and while offline.
 */
export function getSpaceNotificationPolicyDir(): string {
  return join(getDataDir(), 'space-notification-policy');
}

/** Read-only compatibility input for the campaign activation history migration. */
export function getLegacyOnboardingChecklistFilePath(): string {
  return join(getDataDir(), 'onboarding-checklist.json');
}

/**
 * Ledger for the bulk Claude/Codex project import flow (CAN-2439): which
 * discovered roots became which projects, which provider sessions became
 * which chats, the last scan time, and the one-time invite marker. Kept
 * outside any project directory so repeat scans stay idempotent even after a
 * project is removed from the sidebar.
 */
export function getExternalProjectImportsFilePath(): string {
  return join(getDataDir(), 'external-project-imports.json');
}

/**
 * Activation notification journey state (CAN-1967): the first-open anchor,
 * last-activity stamp, holdout assignment, and per-campaign send/suppress
 * latches. The latches enforce the at-most-once send contract across
 * restarts — without them a relaunch would re-fire every due campaign.
 */
export function getActivationJourneyFilePath(): string {
  return join(getDataDir(), 'activation-journey.json');
}

/**
 * Cached copy of the hub-served campaign config (CAN-2765). Cached so a
 * launch with no network still uses the last served document rather than
 * silently reverting to the compiled table -- a copy change that shipped
 * weeks ago should not undo itself on an offline launch.
 */
export function getServedCampaignConfigFilePath(): string {
  return join(getDataDir(), 'notification-campaigns.json');
}

/**
 * Durable, non-secret marker recording whether the last readable cloud account
 * belonged to at least one enforcing organization (CAN-2314). Read at boot by
 * `lib/model-policy-state.ts` so a degraded/corrupt account read still fails
 * closed for a known org member.
 */
export function getModelPolicyMarkerFilePath(): string {
  return join(getDataDir(), 'model-policy-marker.json');
}

export function getModelGatewayMarkerFilePath(): string {
  return join(getDataDir(), 'model-gateway-marker.json');
}

/** Per-account Personal/organization context selection (CAN-2952). */
export function getWorkspaceContextFilePath(): string {
  return join(getDataDir(), 'workspace-context.json');
}

/**
 * Cached organization project catalogs (CAN-2955): one directory per account
 * id, one file per context (`personal.json` or `organization-<uuid>.json`;
 * the serialized `org:<uuid>` form has a colon, which Windows rejects).
 */
export function getOrgProjectCatalogDir(): string {
  return join(getDataDir(), 'org-project-catalog');
}

/**
 * Queued turn ratings awaiting upload (CAN-1521). A queued rating is complete
 * on its own — nothing is uploaded with it — so there is no companion bundle
 * directory.
 */
export function getTurnFeedbackOutboxFilePath(): string {
  return join(getDataDir(), 'turn-feedback-outbox.json');
}

export function getOrphanedWorktreeCleanupFilePath(): string {
  return join(getDataDir(), 'orphaned-worktree-cleanup.json');
}

/**
 * Main-owned registry of shared runs the comment poller watches, plus the
 * last-seen `commentRevision` per run (CAN-397). Kept in the data dir — never
 * inside a git worktree checkout — and deliberately separate from the
 * renderer-owned chat-tabs file so a background poll never races a chat save.
 */
export function getSharedRunCommentsFilePath(): string {
  return join(getDataDir(), 'shared-run-comments.json');
}

/** Small main-owned sidecar for durable background-refresh freshness. */
export function getGitHubRefreshLedgerFilePath(): string {
  return join(getDataDir(), 'github-refresh-ledger.json');
}

/** Advisory success freshness for automatic repository fetches. */
export function getGitFetchFreshnessFilePath(): string {
  return join(getDataDir(), 'git-fetch-freshness.json');
}

/** Advisory remote default-branch knowledge for automatic repository reads. */
export function getGitDefaultBranchFreshnessFilePath(): string {
  return join(getDataDir(), 'git-default-branch-freshness.json');
}

/**
 * PIDs of Codex app-server processes spawned by this data-dir's app instance.
 * Read on startup to reap orphans left behind by a previous run (they can hold
 * the shared Codex state DB and wedge every new app-server spawn).
 */
export function getCodexAppServerPidsFilePath(): string {
  return join(getDataDir(), 'codex-app-server-pids.json');
}

/**
 * Identity of Claude CLIs the Claude process host started for this data dir's
 * app instance. Read on startup to reap CLIs a crashed run left behind.
 */
export function getClaudeProcessPidsFilePath(): string {
  return join(getDataDir(), 'claude-process-pids.json');
}

/**
 * Per-surface default panel-layout template. `'code'` keeps the original
 * `default-panel-layout.json` filename so defaults saved before surfaces
 * existed keep working without migration; `'cowork'` uses a sibling file.
 */
export function getDefaultPanelLayoutFilePath(
  surface: PanelLayoutSurface,
): string {
  return join(
    getDataDir(),
    surface === 'cowork'
      ? 'default-panel-layout.cowork.json'
      : 'default-panel-layout.json',
  );
}

export { getUserEnvironmentFilePath } from '@canopy/execution-engine/canopy-paths';

export function getOllamaModelCacheFilePath(): string {
  return join(getDataDir(), 'ollama-model-cache.json');
}

export function getAgentModelsFilePath(): string {
  return join(getDataDir(), 'agent-models.json');
}

export function getOpenAiPricingCacheFilePath(): string {
  return join(getDataDir(), 'openai-pricing-cache.json');
}

export function getBlueprintCatalogCacheFilePath(): string {
  return join(getDataDir(), 'blueprint-catalog-cache.json');
}

function getAgentObservabilityDir(): string {
  return join(getDataDir(), 'agent-observability');
}

export function getAgentObservabilityAuditDir(): string {
  return join(getAgentObservabilityDir(), 'audit');
}

export function getAgentObservabilityAuditDayFilePath(day: string): string {
  return join(getAgentObservabilityAuditDir(), `${day}.jsonl`);
}

export function getAgentObservabilityUsageEventsDir(): string {
  return join(getAgentObservabilityDir(), 'usage-events');
}

export function getAgentObservabilityUsageEventsDayFilePath(
  day: string,
): string {
  return join(getAgentObservabilityUsageEventsDir(), `${day}.jsonl`);
}

export function getAgentObservabilityDiagnosticsDir(): string {
  return join(getAgentObservabilityDir(), 'diagnostics');
}

// Telemetry-sync (CAN-402) durable state. The pending-upload queue and the
// client-id → server-externalId map both live under agent-observability for
// locality with the rest of the observability data. They are NOT day-bucketed,
// so the rolling `auditRetentionDays` sweep (`pruneOldDayFiles`) does not touch
// them; their growth is instead bounded by queue self-drain on successful flush
// and by `drainWorktreeForDeletion` removing sync-map entries on worktree
// deletion.
export function getTelemetrySyncDir(): string {
  return join(getAgentObservabilityDir(), 'telemetry-sync');
}

export function getTelemetrySyncQueueFilePath(): string {
  return join(getTelemetrySyncDir(), 'queue.jsonl');
}

export function getTelemetrySyncMapFilePath(): string {
  return join(getTelemetrySyncDir(), 'sync-map.json');
}

// App diagnostics are intentionally global-only. They participate in rolling
// retention via `PreferencesData.auditRetentionDays`, but worktree cleanup must
// never try to purge them because these files do not contain worktree/session
// identifiers.
export function getAgentObservabilityAppEventsDir(): string {
  return join(getAgentObservabilityDiagnosticsDir(), 'app-events');
}

export function getAgentObservabilityAppEventsDayFilePath(day: string): string {
  return join(getAgentObservabilityAppEventsDir(), `${day}.jsonl`);
}

// Session diagnostics are worktree-scoped. They live under
// `agent-observability/diagnostics/`, use the same rolling retention window as
// audit/transcript data, and matching lines must be removed during worktree
// cleanup.
export function getAgentObservabilitySessionEventsDir(): string {
  return join(getAgentObservabilityDiagnosticsDir(), 'session-events');
}

export function getAgentObservabilitySessionEventsDayFilePath(
  day: string,
): string {
  return join(getAgentObservabilitySessionEventsDir(), `${day}.jsonl`);
}

export function getAgentObservabilityTranscriptsDir(): string {
  return join(getAgentObservabilityDir(), 'transcripts');
}

export function getAgentObservabilityTranscriptIndexDir(): string {
  return join(getAgentObservabilityDir(), 'transcript-index');
}

export function getAgentObservabilityTranscriptIndexDayFilePath(
  day: string,
): string {
  return join(getAgentObservabilityTranscriptIndexDir(), `${day}.jsonl`);
}

export function getAgentObservabilityTranscriptDayDir(day: string): string {
  return join(getAgentObservabilityTranscriptsDir(), day);
}

function sanitizeTranscriptKeySegment(value: string): string {
  const sanitized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return sanitized.length > 0 ? sanitized : 'na';
}

function buildAgentAuditTranscriptStorageKey(
  request: AgentAuditTranscriptRequest,
): string {
  const digest = createHash('sha256')
    .update([request.eventType, request.startedAt, request.id].join('\n'))
    .digest('hex')
    .slice(0, 12);
  return [
    sanitizeTranscriptKeySegment(request.eventType),
    sanitizeTranscriptKeySegment(request.startedAt),
    digest,
  ].join('__');
}

export function getAgentObservabilityTranscriptFilePath(
  request: AgentAuditTranscriptRequest,
): string {
  const day = request.startedAt.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    throw new Error(`Invalid startedAt date prefix: ${day}`);
  }
  return join(
    getAgentObservabilityTranscriptDayDir(day),
    `${buildAgentAuditTranscriptStorageKey(request)}.jsonl`,
  );
}

export function getAgentObservabilitySnapshotPath(): string {
  return join(getAgentObservabilityDir(), 'snapshot.json');
}
export function getProjectDir(projectId: string): string {
  return getWorkspaceDir(projectId);
}

export function getProjectWorktreesFilePath(projectId: string): string {
  return getWorkspaceWorktreesFilePath(projectId);
}
export function getWorktreeDir(projectId: string, worktreeId: string): string {
  return getWorkspaceWorktreeDir(projectId, worktreeId);
}
export function getChatTabsFilePath(
  projectId: string,
  worktreeId: string,
): string {
  return getWorkspaceChatTabsFilePath(projectId, worktreeId);
}

export function getChatArchivesFilePath(
  projectId: string,
  worktreeId: string,
): string {
  return getWorkspaceChatArchivesFilePath(projectId, worktreeId);
}

function getWorktreeSummariesDir(projectId: string): string {
  return getWorkspaceSummariesDir(projectId);
}

export function getWorktreeSummaryFilePath(
  projectId: string,
  worktreeId: string,
): string {
  return join(getWorktreeSummariesDir(projectId), `${worktreeId}.json`);
}

/** Main-owned, content-free cost projection; never inside a checkout. */
export function getEntryCostDir(projectId: string, scopeId: string): string {
  validateId(projectId, 'projectId');
  validateId(scopeId, 'scopeId');
  return join(getChatWorkspaceRootDir(projectId), 'cost', scopeId);
}

export function getCostIndexCheckpointPath(): string {
  return join(getDataDir(), 'cost-index', 'checkpoint.json');
}

export function getArchivedContainerCostDir(
  projectId: string,
  containerId: string,
): string {
  return join(getArchivedContainerDir(projectId, containerId), 'cost');
}

export function getWorktreeAttachmentsDir(
  projectId: string,
  worktreeId: string,
): string {
  if (isAppManagedChatWorkspace(projectId)) {
    return join(
      getAppManagedChatWorkspaceDir(projectId),
      'attachments',
      worktreeId,
    );
  }
  return getWorkspaceWorktreeAttachmentsDir(projectId, worktreeId);
}
export function getTrackedPlansFilePath(
  projectId: string,
  worktreeId: string,
): string {
  return getWorkspaceTrackedPlansFilePath(projectId, worktreeId);
}
export function getDetectedPlansFilePath(
  projectId: string,
  worktreeId: string,
): string {
  return getWorkspaceDetectedPlansFilePath(projectId, worktreeId);
}

// Script-run logs live under the project/workspace metadata root so whole
// project/workspace deletion cleans them up transitively. Archive flows only
// need per-worktree cleanup.
function getWorktreeScriptRunsDir(projectId: string): string {
  return join(getProjectDir(projectId), 'script-runs');
}

export function getWorktreeScriptRunDir(
  projectId: string,
  worktreeId: string,
): string {
  return join(getWorktreeScriptRunsDir(projectId), worktreeId);
}

function getWorkspaceScriptRunsDir(workspaceId: string): string {
  return join(getWorkspaceDir(workspaceId), 'script-runs');
}

export function getWorkspaceScriptRunDir(
  workspaceId: string,
  worktreeId: string,
): string {
  return join(getWorkspaceScriptRunsDir(workspaceId), worktreeId);
}

export function getWorktreeDataRootDir(workspaceId: string): string {
  if (isAppManagedChatWorkspace(workspaceId)) {
    return join(getAppManagedChatWorkspaceDir(workspaceId), 'worktree-data');
  }
  return join(getWorkspaceDir(workspaceId), 'worktree-data');
}

export function getWorktreeDataDir(
  workspaceId: string,
  worktreeId: string,
): string {
  return join(getWorktreeDataRootDir(workspaceId), worktreeId);
}

export function getSharedContainerRunRootDir(containerId: string): string {
  validateId(containerId, 'containerId');
  return join(
    getWorktreeDataDir(SHARED_CONTAINER_VIEWER_PROJECT_ID, containerId),
    'run',
  );
}

export function getSharedContainerRunRepoDir(
  containerId: string,
  repoId: string,
): string {
  if (!/^[A-Za-z0-9_-]+$/.test(repoId)) {
    throw new Error('Invalid repoId');
  }
  return join(getSharedContainerRunRootDir(containerId), repoId);
}

export function getBrowserTaskFilesDir(
  projectId: string,
  worktreeId: string,
): string {
  return join(getWorktreeDataDir(projectId, worktreeId), 'browser-files');
}

export function getWorktreeBrowserStateFilePath(
  workspaceId: string,
  worktreeId: string,
): string {
  return join(
    getWorktreeDataDir(workspaceId, worktreeId),
    'browser-state.json',
  );
}

export function getGitHubPrStateDir(
  workspaceId: string,
  worktreeId: string,
  repoStorageKey: string,
): string {
  return join(
    getWorktreeDataDir(workspaceId, worktreeId),
    'github-pr',
    repoStorageKey,
  );
}

export function getHookInvocationsDir(
  workspaceId: string,
  worktreeId: string,
): string {
  return join(getWorktreeDataDir(workspaceId, worktreeId), 'hook-invocations');
}

export function getWorktreeTerminalStateFilePath(
  workspaceId: string,
  worktreeId: string,
): string {
  return join(
    getWorktreeDataDir(workspaceId, worktreeId),
    'terminal-state.json',
  );
}

export function getWorktreeShareFileScopePath(
  workspaceId: string,
  worktreeId: string,
): string {
  return join(
    getWorktreeDataDir(workspaceId, worktreeId),
    'share-file-scope.json',
  );
}

export function getWorktreeSharePublicationStatePath(
  workspaceId: string,
  worktreeId: string,
): string {
  return join(
    getWorktreeDataDir(workspaceId, worktreeId),
    'share-publication-state.json',
  );
}

/** Ephemeral delegation transcript spools live outside user checkouts. */
export function getDelegationTranscriptSpoolRootDir(): string {
  return join(getDataDir(), 'delegation-transcript-spools');
}

/**
 * Disposable cache of normalized per-transcript capability usage, kept beside
 * the share publication state. App metadata; never inside a checkout.
 */
export function getWorktreeShareCapabilityUsageCachePath(
  workspaceId: string,
  worktreeId: string,
): string {
  return join(
    getWorktreeDataDir(workspaceId, worktreeId),
    'share-capability-usage-cache.json',
  );
}

/** Ciphertext staging is app-owned and never placed in a user checkout. */
export function getSharedContainerPublishStagingRootDir(): string {
  return join(getDataDir(), 'shared-container-publish-staging');
}

/**
 * Per-worktree VS Code-style panel grid layout file (Phase 5). Lives inside
 * `worktree-data/{worktreeId}/` so `worktree-data-cleanup.ts`'s recursive
 * "worktree metadata" removal deletes it with the rest of the worktree's
 * metadata — never inside the git worktree checkout.
 */
export function getWorktreePanelLayoutFilePath(
  workspaceId: string,
  worktreeId: string,
): string {
  return join(getWorktreeDataDir(workspaceId, worktreeId), 'panel-layout.json');
}

/**
 * The worktree's last provider discovery (slash commands, MCP servers), kept
 * out of `worktrees.json`. Like the panel layout it lives in
 * `worktree-data/{worktreeId}/`, so archive and delete remove it.
 */
export function getWorktreeDiscoveryFilePath(
  workspaceId: string,
  worktreeId: string,
): string {
  return join(getWorktreeDataDir(workspaceId, worktreeId), 'discovery.json');
}

/** Separate versioned layout-mode preference for one code/Cowork entity. */
export function getWorktreePanelLayoutModeFilePath(
  workspaceId: string,
  worktreeId: string,
): string {
  return join(
    getWorktreeDataDir(workspaceId, worktreeId),
    'panel-layout-mode.json',
  );
}

/**
 * Per-worktree code-graph database directory (Phase 2). Delegates to the
 * shared `@canopy/desktop-shared` helper so the desktop app and the headless
 * CLI compute the identical path from the same `getCanopyDataDir()` root.
 * Lives inside `worktree-data/{worktreeId}/code-graph/` so
 * `worktree-data-cleanup.ts`'s recursive "worktree metadata" removal deletes
 * it with the rest of the worktree's metadata — never inside the git worktree
 * checkout.
 */
export function getWorktreeCodeGraphDir(
  workspaceId: string,
  worktreeId: string,
): string {
  return getSharedWorktreeCodeGraphDir(workspaceId, worktreeId);
}

export function getClaudeTerminalRuntimeDir(
  projectId: string,
  worktreeId: string,
  chatId: string,
): string {
  return join(
    getWorktreeDataDir(projectId, worktreeId),
    'claude-terminal',
    chatId,
  );
}

export function getClaudeWorkerRuntimeDir(
  projectId: string,
  worktreeId: string,
  workerId: string,
): string {
  return join(
    getWorktreeDataDir(projectId, worktreeId),
    'claude-workers',
    workerId,
  );
}

export function getElectronAsNodeBinaryPath(): string {
  const execPath = process.execPath;
  if (!execPath || !existsSync(execPath)) {
    throw new Error('Electron runtime is unavailable for Claude Code hooks.');
  }
  return execPath;
}

export function getHookInvocationDir(
  workspaceId: string,
  worktreeId: string,
  runId: string,
): string {
  return join(getHookInvocationsDir(workspaceId, worktreeId), runId);
}

export function resolveScriptRunDir(
  projectId: string,
  worktreeId: string,
): string {
  if (isAppManagedChatWorkspace(projectId)) {
    return join(getWorktreeDataDir(projectId, worktreeId), 'script-runs');
  }
  if (getWorkspaceType(projectId) !== null) {
    return getWorkspaceScriptRunDir(projectId, worktreeId);
  }
  return getWorktreeScriptRunDir(projectId, worktreeId);
}

export function buildScriptRunFileStem(scriptKey: string): string {
  return scriptRunFileStem(scriptKey);
}

// ---------------------------------------------------------------------------
// Standalone chat paths (LEGACY layout)
// ---------------------------------------------------------------------------
//
// @deprecated These `standalone-chat/{project}` helpers describe the legacy
// pre-cowork on-disk layout. As of the cowork workspace unification, live
// cowork data lives under `workspaces/{workspaceId}/` (see getWorkspaceHomeDir,
// getWorkspaceChatHistory*, getWorkspaceChatTabsFilePath) and is addressed via
// `resolveCoworkWorkspaceId()` + `COWORK_HOME_WORKTREE_ID`. The `chatProject*`
// CRUD IPC surface (`ipc/chat-projects.ts`) has been absorbed into the cowork
// workspace layout and no longer uses these helpers. What remains here is
// retained only for: (a) the one-time `cowork-migration.ts` (which reads the
// legacy tree to migrate it), (b) the not-yet-reshaped standalone
// export/import-project flows in `ipc/standalone-chat.ts` (still bundle/
// restore the legacy on-disk shape directly — tracked separately as CRUD-
// surface absorption work), and (c) read-only legacy-tree scanners
// (`desktop-telemetry.ts` counts, `feedback-bundle.ts`, `plugin-service.ts`
// cache scanning). Do not add new callers; new cowork code must use the
// `workspaces/{id}` helpers.

export function getStandaloneChatDir(): string {
  return join(getDataDir(), 'standalone-chat');
}

// ---------------------------------------------------------------------------
// Plan-explore chat paths
// ---------------------------------------------------------------------------

export function getPlanExploreChatsDir(): string {
  return join(getDataDir(), 'plan-explore-chats');
}

export function getPlanExploreRegistryFilePath(): string {
  return join(getPlanExploreChatsDir(), 'registry.json');
}

export function getPlanExploreChatTabsFilePath(planId: string): string {
  validateId(planId, 'planId');
  return join(getPlanExploreChatsDir(), `${planId}.json`);
}

export function getAppAdvisorChatTabsFilePath(entryId: string): string {
  return getWorkspaceChatTabsFilePath(APP_ADVISOR_PROJECT_ID, entryId);
}

/**
 * Directory holding every materialized plan file owned by one real worktree
 * scope (`worktree-data/{worktreeId}/plan-explore`). Each child directory is
 * named for a tracked plan id; the plan-file sync lists it to find the plan
 * files a finished turn may have edited.
 */
export function getPlanExploreScopeDir(
  workspaceId: string,
  worktreeId: string,
): string {
  validateId(worktreeId, 'worktreeId');
  return join(getWorktreeDataDir(workspaceId, worktreeId), 'plan-explore');
}

/**
 * Directory holding the materialized plan file for `planId`. It lives under
 * the owning REAL worktree's `worktree-data/{worktreeId}` tree (never the
 * plan-explore sentinel scope ids) so the existing worktree-data cleanup
 * removes it with the rest of the worktree's metadata.
 */
export function getPlanExploreFileDir(
  workspaceId: string,
  worktreeId: string,
  planId: string,
): string {
  validateId(planId, 'planId');
  return join(getPlanExploreScopeDir(workspaceId, worktreeId), planId);
}

/**
 * Absolute path to the materialized `plan.md` the plan-explore agent edits with
 * its native file tools.
 */
export function getPlanExplorePlanFilePath(
  workspaceId: string,
  worktreeId: string,
  planId: string,
): string {
  return join(
    getPlanExploreFileDir(workspaceId, worktreeId, planId),
    'plan.md',
  );
}

// ---------------------------------------------------------------------------
// Code-review chat paths
// ---------------------------------------------------------------------------

export function getLegacyCodeReviewChatsDir(): string {
  return join(getDataDir(), 'code-review-chats');
}

export function getCodeReviewChatsDir(): string {
  return getWorkspaceChatTabsDir(CODE_REVIEW_CHAT_PROJECT_ID);
}

export function getCodeReviewRegistryFilePath(): string {
  return join(getCodeReviewChatsDir(), 'registry.json');
}

/**
 * Persisted chat tabs for a code-review sentinel scope. `scopeKey` is the
 * `projectId--worktreeId` composite the scope uses as its worktreeId (worktree
 * ids are only unique per workspace); it still satisfies `validateId`.
 */
export function getCodeReviewChatTabsFilePath(scopeKey: string): string {
  validateId(scopeKey, 'worktreeId');
  return join(getCodeReviewChatsDir(), `${scopeKey}.json`);
}

/**
 * Persisted code-review state for a worktree (comment threads, annotation and
 * diagram artifacts, armed flag). Lives under the REAL worktree's
 * worktree-data tree so the existing worktree-data cleanup removes it with
 * the rest of the worktree's metadata. Never written into the git checkout.
 */
export function getCodeReviewStateFilePath(
  workspaceId: string,
  worktreeId: string,
): string {
  return join(getWorktreeDataDir(workspaceId, worktreeId), 'code-review.json');
}

/** Persistent annotations/comment threads attached to ordinary file tabs. */
export function getFileAnnotationsStateFilePath(
  workspaceId: string,
  worktreeId: string,
): string {
  return join(
    getWorktreeDataDir(workspaceId, worktreeId),
    'file-annotations.json',
  );
}

export function getChatProjectsFilePath(): string {
  return join(getStandaloneChatDir(), 'projects.json');
}

export function getChatProjectDir(projectId: string): string {
  return projectId === DEFAULT_CHAT_PROJECT_ID
    ? join(getStandaloneChatDir(), DEFAULT_CHAT_PROJECT_ID)
    : join(getStandaloneChatDir(), 'projects', projectId);
}

export function getChatProjectHistoryDir(projectId: string): string {
  return join(getChatProjectDir(projectId), 'history');
}

function getChatProjectHistoryEntryDir(
  projectId: string,
  chatId: string,
): string {
  return join(getChatProjectHistoryDir(projectId), chatId);
}

export function getChatProjectMetaFilePath(
  projectId: string,
  chatId: string,
): string {
  return join(getChatProjectHistoryEntryDir(projectId, chatId), 'meta.json');
}

export function getChatProjectChatTabsFilePath(projectId: string): string {
  return join(getChatProjectDir(projectId), 'chat-tabs.json');
}

export function getChatProjectProjectFilePath(projectId: string): string {
  return join(getChatProjectDir(projectId), 'project.json');
}

function getSecureStorageDir(): string {
  return getCanopySecureDataDir();
}

function getLegacySecureMigrationDataDir(): string {
  const resolved = getResolvedCanopyDataDir();
  return resolved.source === 'override'
    ? resolved.path
    : getPrimaryBrandDataDir();
}

function getLegacySecureStorageDir(): string {
  return join(getLegacySecureMigrationDataDir(), 'secure');
}

export function getGitHubPatFilePath(): string {
  return join(getSecureStorageDir(), 'github-pat.enc');
}

export function getInternalLegacySharedGitHubPatFilePath(): string | null {
  const legacyDir = getInternalLegacySharedSecureDataDir();
  return legacyDir ? join(legacyDir, 'github-pat.enc') : null;
}

export function getLegacyGitHubPatFilePath(): string {
  return join(getLegacySecureStorageDir(), 'github-pat.enc');
}

export function getCopilotRotationAttemptPath(): string {
  return join(getSecureStorageDir(), 'copilot-rotation-attempt.json');
}

export function getCopilotCredentialFilePath(): string {
  return join(getSecureStorageDir(), 'copilot-account.enc');
}

export function getLinearTokenFilePath(): string {
  return join(getSecureStorageDir(), 'linear-token.enc');
}

export function getInternalLegacySharedLinearTokenFilePath(): string | null {
  const legacyDir = getInternalLegacySharedSecureDataDir();
  return legacyDir ? join(legacyDir, 'linear-token.enc') : null;
}

export function getLegacyLinearTokenFilePath(): string {
  return join(getLegacySecureStorageDir(), 'linear-token.enc');
}

export function getMcpOAuthTokenStorePath(): string {
  return join(getSecureStorageDir(), 'mcp-oauth-tokens.json');
}

/** Account proxy management and client keys, encrypted with safe storage. */
export function getAccountProxyCredentialStorePath(): string {
  return join(getSecureStorageDir(), 'account-proxy-credentials.json');
}

/**
 * The account proxy Canopy runs on this device (CAN-4023): its release under
 * `runtime/`, the config it reads, the accounts it signs in under `auths/`,
 * and the process record that lets a later launch stop an orphan.
 */
export function getAccountProxyLocalDir(): string {
  return join(getDataDir(), 'account-proxy-local');
}

export function getAccountProxyLocalRuntimeDir(): string {
  return join(getAccountProxyLocalDir(), 'runtime');
}

export function getModelGatewayCredentialStorePath(): string {
  return join(getSecureStorageDir(), 'model-gateway-credentials.json');
}

export function getInternalLegacySharedModelGatewayCredentialStorePath():
  | string
  | null {
  const legacyDir = getInternalLegacySharedSecureDataDir();
  return legacyDir ? join(legacyDir, 'model-gateway-credentials.json') : null;
}

export function getLegacyModelGatewayCredentialStorePath(): string {
  return join(
    getLegacySecureMigrationDataDir(),
    'model-gateway-credentials.json',
  );
}

export function getInternalLegacySharedMcpOAuthTokenStorePath(): string | null {
  const legacyDir = getInternalLegacySharedSecureDataDir();
  return legacyDir ? join(legacyDir, 'mcp-oauth-tokens.json') : null;
}

export function getLegacyMcpOAuthTokenStorePath(): string {
  return join(getLegacySecureMigrationDataDir(), 'mcp-oauth-tokens.json');
}

export function getCanopyCloudAccountFilePath(): string {
  return join(getSecureStorageDir(), 'canopy-cloud-account.enc');
}

export function getInternalLegacySharedCanopyCloudAccountFilePath():
  | string
  | null {
  const legacyDir = getInternalLegacySharedSecureDataDir();
  return legacyDir ? join(legacyDir, 'canopy-cloud-account.enc') : null;
}

export function getLegacyCanopyCloudAccountFilePath(): string {
  return join(getLegacySecureStorageDir(), 'canopy-cloud-account.enc');
}

export function getDefaultReposDir(): string {
  return join(getDataDir(), 'repos');
}

export function getPluginCacheDir(): string {
  return join(getDataDir(), 'plugin-cache');
}

export function getPipelinePluginPreferencesFilePath(): string {
  return join(getDataDir(), 'pipeline-plugin-preferences.json');
}

export function getPipelineLocalMetadataFilePath(): string {
  return join(getDataDir(), 'pipeline-local-metadata.json');
}

export function getPipelineDefinitionReplaysFilePath(): string {
  return join(getDataDir(), 'pipeline-definition-replays.json');
}

export function getPipelineExecutionPluginRuntimeDir(
  executionsDir: string,
  executionId: string,
  jobId: string,
  stepId: string,
  childId?: string,
): string {
  return join(
    executionsDir,
    executionId,
    'plugins',
    jobId,
    ...(childId ? [childId] : []),
    stepId,
  );
}

function getBundlesDir(): string {
  return join(getDataDir(), 'bundles');
}

export function getBundlesIndexFilePath(): string {
  return join(getBundlesDir(), 'index.json');
}

export function getBundleConfigFilePath(bundleId: string): string {
  return join(getBundlesDir(), `bundle-${bundleId}.json`);
}

export function getCollectionsDir(): string {
  return join(getDataDir(), 'collections');
}

export function getCollectionsIndexFilePath(): string {
  return join(getCollectionsDir(), 'index.json');
}

export function getCollectionConfigFilePath(collectionId: string): string {
  return join(getCollectionsDir(), `collection-${collectionId}.json`);
}

function getMcpServersDir(): string {
  return join(getDataDir(), 'mcp-servers');
}

function assertSafeMcpServerId(serverId: string): void {
  if (
    serverId.length === 0 ||
    serverId.includes('..') ||
    serverId.includes('/') ||
    serverId.includes('\\') ||
    serverId.includes('\0')
  ) {
    throw new Error('Invalid MCP server identifier');
  }
}

export function getMcpServersIndexFilePath(): string {
  return join(getMcpServersDir(), 'index.json');
}

export function getMcpServerFilePath(serverId: string): string {
  assertSafeMcpServerId(serverId);
  return join(getMcpServersDir(), `server-${serverId}.json`);
}

export function getCuratedMcpCatalogFilePath(): string {
  return join(getMcpServersDir(), 'curated-catalog.json');
}

export function getMcpServerToolsCacheFilePath(): string {
  return join(getMcpServersDir(), 'tools-cache.json');
}

export function getChatPluginsRootDir(): string {
  return join(getDataDir(), 'chat-plugins');
}

export function getChatSkillPluginDir(
  projectId: string,
  worktreeId: string,
  chatId: string,
): string {
  return join(getChatPluginsRootDir(), projectId, worktreeId, chatId);
}

/** Root for the locally-materialized curated plugin marketplace and its sync state. */
export function getCuratedPluginsRootDir(): string {
  return join(getDataDir(), 'curated-plugins');
}

/** Cached curated plugin catalog list fetched from Canopy Cloud. */
export function getCuratedPluginsCatalogFilePath(): string {
  return join(getCuratedPluginsRootDir(), 'catalog.json');
}

/** Bounded metadata-only cache for curated pipeline discovery. */
export function getCuratedPipelinesCatalogFilePath(): string {
  return join(getDataDir(), 'curated-pipelines', 'catalog.json');
}

/** Bounded metadata-only cache for curated Automation discovery. */
export function getCuratedAutomationsCatalogFilePath(): string {
  return join(getDataDir(), 'curated-automations', 'catalog.json');
}

/** Lock file guarding concurrent curated plugin sync runs. */
export function getCuratedPluginsSyncLockFilePath(): string {
  return join(getCuratedPluginsRootDir(), 'sync-lock.json');
}

/** On-disk marketplace directory the curated plugin sync engine materializes into. */
export function getCuratedPluginsMarketplaceDir(): string {
  return join(getCuratedPluginsRootDir(), 'marketplace');
}

/** Scratch directory the curated plugin sync engine stages downloads into before promotion. */
export function getCuratedPluginsStagingDir(): string {
  return join(getCuratedPluginsRootDir(), 'staging');
}

/** Which provider accounts the plugin backfill already ran for (CAN-3639). */
export function getProviderPluginBackfillStateFilePath(): string {
  return join(getDataDir(), 'provider-plugin-backfill.json');
}

/** Receipts for the managed marketplaces Canopy registered with a provider (CAN-4482). */
export function getBuiltInPluginMarketplacesFilePath(): string {
  return join(getDataDir(), 'built-in-plugin-marketplaces.json');
}

export function getCodexCompatibilityCacheRootDir(): string {
  return join(getPluginCacheDir(), 'codex-compatibility');
}
export function getWorkspaceDir(workspaceId: string): string {
  return join(getWorkspacesRootDir(), workspaceId);
}

export function getWorkspaceRepoRulesStatePath(workspaceId: string): string {
  return join(getWorkspaceDir(workspaceId), 'repo-rules.json');
}

/** Root for retention-gated deleted worktrees and work entries. */
export function getArchivedContainersRootDir(workspaceId: string): string {
  validateId(workspaceId, 'workspaceId');
  return join(getChatWorkspaceRootDir(workspaceId), 'archived-containers');
}

export function getArchivedContainerDir(
  workspaceId: string,
  containerId: string,
): string {
  validateId(containerId, 'containerId');
  return join(getArchivedContainersRootDir(workspaceId), containerId);
}

/** Durable recovery evidence owned by the restored worktree's metadata root. */
export function getArchivedContainerRecoveryEvidenceDir(
  workspaceId: string,
  worktreeId: string,
  containerId: string,
): string {
  validateId(worktreeId, 'worktreeId');
  validateId(containerId, 'containerId');
  return join(
    getWorktreeDataDir(workspaceId, worktreeId),
    'archive-recovery-evidence',
    containerId,
  );
}

export function getArchivedContainerManifestPath(
  workspaceId: string,
  containerId: string,
): string {
  return join(
    getArchivedContainerDir(workspaceId, containerId),
    'container.json',
  );
}

/** Crash-recovery journal written before an archived worktree is torn down. */
export function getArchivedContainerGitStateStagedPath(
  workspaceId: string,
  containerId: string,
): string {
  return join(
    getArchivedContainerDir(workspaceId, containerId),
    'git-state.staged.json',
  );
}

export function getArchivedContainerChatsPath(
  workspaceId: string,
  containerId: string,
): string {
  return join(getArchivedContainerDir(workspaceId, containerId), 'chats.json');
}

export function getArchivedContainerChatArchivesPath(
  workspaceId: string,
  containerId: string,
): string {
  return join(
    getArchivedContainerDir(workspaceId, containerId),
    'chat-archives.json',
  );
}

export function getArchivedContainerSummaryPath(
  workspaceId: string,
  containerId: string,
): string {
  return join(
    getArchivedContainerDir(workspaceId, containerId),
    'summary.json',
  );
}

export function getArchivedContainerProviderSessionsDir(
  workspaceId: string,
  containerId: string,
): string {
  return join(
    getArchivedContainerDir(workspaceId, containerId),
    'provider-sessions',
  );
}

export function getArchivedContainerExecutionsDir(
  workspaceId: string,
  containerId: string,
): string {
  return join(
    getArchivedContainerDir(workspaceId, containerId),
    'pipeline-executions',
  );
}

export function getArchivedContainerAttachmentsDir(
  workspaceId: string,
  containerId: string,
): string {
  return join(getArchivedContainerDir(workspaceId, containerId), 'attachments');
}

/** Physical workspace-root files retained separately from managed payloads. */
export function getArchivedContainerWorkspaceRootDir(
  workspaceId: string,
  containerId: string,
): string {
  return join(
    getArchivedContainerDir(workspaceId, containerId),
    'workspace-root',
  );
}

export function getArchivedContainerTrackedPlansPath(
  workspaceId: string,
  containerId: string,
): string {
  return join(
    getArchivedContainerDir(workspaceId, containerId),
    'tracked-plans.json',
  );
}

/**
 * Home directory for the global App Advisor assistant. App Advisor sessions
 * always run from this user-visible directory (never a user worktree).
 * App-managed metadata stays in the parent `app-advisor/` directory so it is
 * not exposed in the file explorer or to agent filesystem tools.
 */
export function getAppAdvisorHomeDir(): string {
  return join(getAppManagedChatWorkspaceDir(APP_ADVISOR_PROJECT_ID), 'home');
}

export function getAppAdvisorSettingsFilePath(): string {
  return join(
    getAppManagedChatWorkspaceDir(APP_ADVISOR_PROJECT_ID),
    'settings.json',
  );
}

/**
 * Writable home directory for the embedded Pipeline Editor assistant. Durable
 * app-managed metadata stays in the parent directory so the agent cannot
 * modify its own policy files through workspace-scoped tools.
 */
export function getPipelineEditorHomeDir(): string {
  return join(
    getAppManagedChatWorkspaceDir(PIPELINE_EDITOR_PROJECT_ID),
    'home',
  );
}

export function getWorkspaceConfigPath(workspaceId: string): string {
  return join(getWorkspaceDir(workspaceId), 'workspace.json');
}

/** User-scoped local memory store. */
export function getUserMemoryDir(): string {
  return join(getDataDir(), 'memory');
}

/** Workspace-scoped local memory store shared by worktree and cowork chats. */
export function getWorkspaceMemoryDir(workspaceId: string): string {
  return join(getWorkspaceDir(workspaceId), 'memory');
}

/**
 * Account replicas of synced memory scopes, one folder per account
 * (`memory-replicas/<accountId>/`), written only by the memory sync engine
 * and the local memory store through the scope resolver.
 */
export function getMemoryReplicasRootDir(): string {
  return join(getDataDir(), 'memory-replicas');
}

/** Local, sensitive reports and automatic dumps from memory diagnostics. */
export function getMemoryReportsDir(): string {
  return join(getDataDir(), 'memory-reports');
}

/**
 * Machine-local, workspace-global Notes storage for code workspaces
 * (markdown files + `index.json`). Cowork workspaces do NOT use this — their
 * notes live in the brand-managed subdir of the cowork working folder.
 */
export function getWorkspaceNotesDir(workspaceId: string): string {
  return join(getWorkspaceDir(workspaceId), 'notes');
}

/** Prompts sibling of {@link getWorkspaceNotesDir}; same cowork caveat. */
export function getWorkspacePromptsDir(workspaceId: string): string {
  return join(getWorkspaceDir(workspaceId), 'prompts');
}

export function getWorkspaceClaudeMdPath(workspaceId: string): string {
  return join(getWorkspaceDir(workspaceId), 'CLAUDE.md');
}

export function getWorkspaceWorktreesFilePath(workspaceId: string): string {
  return join(getWorkspaceDir(workspaceId), 'worktrees.json');
}

/** Membership sidecar; item order stays in the owning registry. */
export function getSidebarItemGroupsFilePath(workspaceId: string): string {
  validateId(workspaceId, 'workspace id');
  return join(
    workspaceId === 'app-advisor'
      ? getAppManagedChatWorkspaceDir(workspaceId)
      : getWorkspaceDir(workspaceId),
    'sidebar-item-groups.json',
  );
}

export function getWorkspaceWorktreesRootDir(workspaceId: string): string {
  return join(getWorkspaceDir(workspaceId), 'worktrees');
}

export function getWorkspaceWorktreeDir(
  workspaceId: string,
  worktreeId: string,
): string {
  return join(getWorkspaceWorktreesRootDir(workspaceId), worktreeId);
}

export function getWorkspaceWorktreeRootRepoDir(
  workspaceId: string,
  worktreeId: string,
): string {
  return getWorkspaceWorktreeDir(workspaceId, worktreeId);
}

export function getWorkspaceWorktreeReposDir(
  workspaceId: string,
  worktreeId: string,
): string {
  return join(getWorkspaceWorktreeDir(workspaceId, worktreeId), 'repos');
}

export function getWorkspaceWorktreeRepoDir(
  workspaceId: string,
  worktreeId: string,
  repoDirName: string,
): string {
  return join(
    getWorkspaceWorktreeReposDir(workspaceId, worktreeId),
    repoDirName,
  );
}

/**
 * Root directory holding a workspace's chat metadata. App-managed chat
 * workspaces (App Advisor, plan-explore, pipeline-editor) store theirs under
 * `app-workspaces/<id>`; real user workspaces use the standard workspace dir.
 * Mirrors the routing used by `getWorktreeAttachmentsDir` /
 * `getWorktreeDataRootDir`.
 */
export function getChatWorkspaceRootDir(workspaceId: string): string {
  return isAppManagedChatWorkspace(workspaceId)
    ? getAppManagedChatWorkspaceDir(workspaceId)
    : getWorkspaceDir(workspaceId);
}

function getWorkspaceChatTabsDir(workspaceId: string): string {
  return join(getChatWorkspaceRootDir(workspaceId), 'chats');
}

function getWorkspaceChatJournalsDir(workspaceId: string): string {
  return join(getChatWorkspaceRootDir(workspaceId), 'chat-journals');
}

/**
 * Work Entry registry (`CoworkWorkEntriesFile`) for a Work Entry workspace.
 * Entries occupy the `worktreeId` slot in every per-worktree
 * store (`chats/{entryId}.json`, `chat-archives/{entryId}.json`,
 * `summaries/{entryId}.json`, `worktree-data/{entryId}/`).
 */
export function getWorkspaceWorkEntriesFilePath(workspaceId: string): string {
  return join(getChatWorkspaceRootDir(workspaceId), 'work-entries.json');
}

export function getWorkspaceWorkEntryAutoDeleteFilePath(
  workspaceId: string,
): string {
  return join(
    getChatWorkspaceRootDir(workspaceId),
    'work-entry-auto-delete.json',
  );
}

export function getWorkspaceChatTabsFilePath(
  workspaceId: string,
  worktreeId: string,
): string {
  return join(getWorkspaceChatTabsDir(workspaceId), `${worktreeId}.json`);
}

/** Durable semantic chat journal for one workspace/worktree scope. */
export function getWorkspaceChatJournalFilePath(
  workspaceId: string,
  worktreeId: string,
): string {
  return join(getWorkspaceChatJournalsDir(workspaceId), `${worktreeId}.jsonl`);
}

/** Legacy single-repository alias; storage is workspace-aware. */
export function getChatJournalFilePath(
  projectId: string,
  worktreeId: string,
): string {
  return getWorkspaceChatJournalFilePath(projectId, worktreeId);
}

export function getChatStateBackupFilePath(snapshotPath: string): string {
  return `${snapshotPath}.bak`;
}

function getWorkspaceChatArchivesDir(workspaceId: string): string {
  return join(getChatWorkspaceRootDir(workspaceId), 'chat-archives');
}

export function getWorkspaceChatArchivesFilePath(
  workspaceId: string,
  worktreeId: string,
): string {
  return join(getWorkspaceChatArchivesDir(workspaceId), `${worktreeId}.json`);
}

/** Where a workspace's (or app workspace's) summary files live. */
export function getWorkspaceSummariesDir(workspaceId: string): string {
  return join(getChatWorkspaceRootDir(workspaceId), 'summaries');
}

function getWorkspaceTrackedPlansDir(workspaceId: string): string {
  return join(getWorkspaceDir(workspaceId), 'plans');
}

export function getWorkspaceTrackedPlansFilePath(
  workspaceId: string,
  worktreeId: string,
): string {
  return join(getWorkspaceTrackedPlansDir(workspaceId), `${worktreeId}.json`);
}

function getWorkspaceDetectedPlansDir(workspaceId: string): string {
  return join(getWorkspaceDir(workspaceId), 'detected-plans');
}

export function getWorkspaceDetectedPlansFilePath(
  workspaceId: string,
  worktreeId: string,
): string {
  return join(getWorkspaceDetectedPlansDir(workspaceId), `${worktreeId}.json`);
}

export function getWorkspaceWorktreeAttachmentsDir(
  workspaceId: string,
  worktreeId: string,
): string {
  return join(getWorkspaceDir(workspaceId), 'attachments', worktreeId);
}
export function getWorkspaceWorktreeSummaryFilePath(
  workspaceId: string,
  worktreeId: string,
): string {
  return join(getWorkspaceSummariesDir(workspaceId), `${worktreeId}.json`);
}

// ---------------------------------------------------------------------------
// Cowork workspaces (type: 'cowork')
// ---------------------------------------------------------------------------

/**
 * Managed home folder for a cowork workspace without an external
 * `externalPath`. This is the agent cwd and the user's plain project folder;
 * Canopy metadata (chats, chat-history, derived) lives in sibling dirs, never
 * inside `home/`. Prefer {@link getCoworkWorkspaceRootDir} for the actual
 * working directory, which honors an attached external directory when set.
 */
export function getWorkspaceHomeDir(workspaceId: string): string {
  return join(getWorkspaceDir(workspaceId), 'home');
}

/**
 * THE way to resolve a cowork workspace's working folder. Returns the
 * registered {@link getWorkspaceExternalPath} directory for the workspace
 * when one is attached, otherwise falls back to the managed home directory
 * (`workspaces/{id}/home/`). Every runtime consumer of a cowork workspace's
 * cwd/`.{brand}/` root must go through this helper rather than calling
 * `getWorkspaceHomeDir` directly, so attached external folders are honored.
 */
export function getCoworkWorkspaceRootDir(workspaceId: string): string {
  return coworkWorkspaceRootDirFor(
    workspaceId,
    getWorkspaceExternalPath(workspaceId) ?? undefined,
  );
}

/**
 * The pure form of {@link getCoworkWorkspaceRootDir} for callers that already
 * hold the workspace's persisted `externalPath` (a `workspace.json` read, a
 * sidebar item) and must not depend on the external-path registry having
 * been rebuilt: an attached folder is the root, otherwise the managed home.
 * Both entry points share this one fallback rule so it cannot drift.
 */
export function coworkWorkspaceRootDirFor(
  workspaceId: string,
  externalPath: string | undefined,
): string {
  return externalPath ?? getWorkspaceHomeDir(workspaceId);
}

/**
 * Dedicated archived-chat root for cowork workspaces. Each archived chat gets
 * `chat-history/{chatId}/{meta.json,summary.md,conversation.json}` — the
 * cowork analog of `chat-archives/`, kept separate because cowork archives
 * are per-chat directory trees, not per-worktree JSON files.
 */
export function getWorkspaceChatHistoryRootDir(workspaceId: string): string {
  return join(getWorkspaceDir(workspaceId), 'chat-history');
}

export function getWorkspaceChatHistoryDir(
  workspaceId: string,
  chatId: string,
): string {
  return join(getWorkspaceChatHistoryRootDir(workspaceId), chatId);
}

export function getWorkspaceChatHistoryMetaFilePath(
  workspaceId: string,
  chatId: string,
): string {
  return join(getWorkspaceChatHistoryDir(workspaceId, chatId), 'meta.json');
}

export function getWorkspaceChatHistorySummaryFilePath(
  workspaceId: string,
  chatId: string,
): string {
  return join(getWorkspaceChatHistoryDir(workspaceId, chatId), 'summary.md');
}

export function getWorkspaceChatHistoryConversationFilePath(
  workspaceId: string,
  chatId: string,
): string {
  return join(
    getWorkspaceChatHistoryDir(workspaceId, chatId),
    'conversation.json',
  );
}

/** Rebuildable per-workspace derived data (search index, history index). */
export function getWorkspaceDerivedDir(workspaceId: string): string {
  return join(getWorkspaceDir(workspaceId), 'derived');
}

function getWorkspaceSplitMapsDir(workspaceId: string): string {
  return join(getWorkspaceDir(workspaceId), 'split-maps');
}

export function getWorkspaceSplitMapFilePath(
  workspaceId: string,
  worktreeId: string,
): string {
  return join(getWorkspaceSplitMapsDir(workspaceId), `${worktreeId}.json`);
}

/** Journals for organization project setups that have not finished. */
export function getOrgProjectSetupsDir(): string {
  return join(getDataDir(), 'org-project-setups');
}

/** Journals for cloud project setups on this device (CAN-5192). */
export function getProjectSetupsDir(): string {
  return join(getDataDir(), 'project-setups');
}

export function getOrgSharedMultiRepoCreationsDir(): string {
  return join(getDataDir(), 'org-shared-multi-repo-creations');
}

/** The device's fencing generation for organization project claims. */
export function getInstallationGenerationFilePath(): string {
  return join(getDataDir(), 'installation-generation.json');
}

/** Device-private relationship decisions; never mirrored to the cloud. */
export function getOrgProjectLinksFilePath(): string {
  return join(getDataDir(), 'org-project-links.json');
}

/**
 * Which workspaces the CAN-3517 activity repair already ran for, per account.
 * Device-local; holds workspace ids and outcomes only.
 */
export function getActivityScopeRepairFilePath(): string {
  return join(getDataDir(), 'activity-scope-repair.json');
}

/**
 * The one-time automatic conversion pass per organization (hybrid model).
 * Device-local; holds organization and workspace ids and timestamps only.
 */
export function getOrgProjectMigrationPassesFilePath(): string {
  return join(getDataDir(), 'org-project-migration-passes.json');
}

/** Explicit, account-scoped project conversion recovery; never inside a checkout. */
export function getPersonalOrganizationUpgradeFilePath(): string {
  return join(getDataDir(), 'personal-organization-upgrade.json');
}

export function getLabsExperimentChoicesPath(): string {
  return join(getDataDir(), 'labs-experiments', 'choices.json');
}
export function getLabsExperimentPendingSyncPath(): string {
  return join(getDataDir(), 'labs-experiments', 'pending-sync.json');
}
export function getLabsExperimentAvailabilityCachePath(): string {
  return join(getDataDir(), 'feature-flags', 'labs-experiments-cache.json');
}

/** Review metadata lives beside the workspace manifest, never in a checkout. */
export function getWorkspaceScriptActionsPath(workspaceId: string): string {
  return join(getWorkspaceDir(workspaceId), 'script-actions.json');
}
export function getScriptAliasesPath(): string {
  return join(getDataDir(), 'script-aliases.json');
}

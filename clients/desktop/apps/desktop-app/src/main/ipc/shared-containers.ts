import {
  type AcceptSharedContainerResponse,
  type DismissSharedContainerResponse,
  type CloseSharedContainerRequest,
  type GetSharedContainerReplicaStateRequest,
  type OpenSharedContainerRequest,
  IPC_CHANNELS,
  type InviteSharedContainerRequest,
  type InviteSharedContainerResponse,
  type ListAcceptedSharedContainersResponse,
  type ListSharedContainerOwnedTargetsRequest,
  type ListSharedContainerOwnedTargetsResponse,
  type ListSharedContainerRecipientsRequest,
  type ListSharedContainerRecipientsResult,
  type ListSharedContainersByMeRequest,
  type ListSharedContainersByMeResponse,
  type ListSharedContainersWithMeRequest,
  type ListSharedContainersWithMeResponse,
  type ListSharedContainerRepositoryTreeRequest,
  type ReadSharedContainerAttachmentRequest,
  type ReadSharedContainerForkProvenanceRequest,
  type ReadSharedContainerChatRequest,
  type ReadSharedContainerOverlayDiffRequest,
  type ReadSharedContainerPlanRequest,
  type ReadSharedContainerWorkspaceItemRequest,
  type RevokeSharedContainerRecipientRequest,
  type RevokeSharedContainerRecipientResponse,
  type SaveSharedContainerFileScopeRequest,
  type SaveSharedContainerFileScopeResponse,
  type SearchSharedContainerMembersRequest,
  type SearchSharedContainerMembersResult,
  type SetSharedContainerLinkIpcRequest,
  type SetSharedContainerLinkIpcResponse,
  type SharedContainerLinkOwnerRequest,
  type SharedContainerLinkTokenRequest,
  type SharedContainerEligibilityRequest,
  type SharedContainerOwnedTarget,
  type SharedContainerEligibilityResponse,
  type SharedContainerForkProvenance,
  type SharedContainerForkRequest,
  type SharedContainerForkResult,
  type SharedContainerPrepareGithubRequest,
  type SharedContainerPrepareGithubResponse,
  type SharedContainerPublicationState,
  type SharedContainerPreviewRequest,
  type SharedContainerSharePreview,
  type SharedContainerRecipientRequest,
  type SharedContainerReplicaState,
  type SharedContainerContentListRequest,
  type SharedContainerRevisionRequest,
  type SharedContainerRunConsentRequest,
  type SharedContainerRunEnvironmentRequest,
  type SharedContainerRunRefreshRequest,
  type SharedContainerRunStatus,
  type SharedContainerRunStatusRequest,
  type ListDismissedSharedContainersRequest,
  type ListDismissedSharedContainersResult,
  type RestoreSharedContainerResult,
  SHARED_CONTAINER_VIEWER_PROJECT_ID,
  isStoredSecretValue,
} from '@canopy/desktop-shared/types';
import { BrowserWindow } from 'electron';
import {
  isSharedContainerCapabilitySet,
  MAX_SHARED_CONTAINER_LIST_LIMIT,
  MAX_SHARED_CONTAINER_RUN_COMMANDS,
  SHARED_CONTAINER_BLOCKED_BY_ORG_BILLING_ERROR_CODE,
  SHARED_CONTAINER_DISMISSAL_NOT_FOUND_ERROR_CODE,
  SHARED_CONTAINER_EXTERNAL_SHARING_DISABLED_ERROR_CODE,
  SHARED_CONTAINER_GRANT_NOT_FOUND_ERROR_CODE,
  SHARED_CONTAINER_INSUFFICIENT_ROLE_ERROR_CODE,
  SHARED_CONTAINER_TYPES,
  SHARED_CONTAINER_LINK_AUDIENCES,
  SHARED_CONTAINER_LINK_TOKEN_PATTERN,
  type SharedContainerLink,
  type SharedContainerLinkClaimResult,
  type SharedContainerLinkLanding,
  type SharedContainerRecipientRequest as SharedContainerRecipientWire,
} from '@canopy/protocol/shared-containers';
import { fileScopeIsAllowlist } from '@canopy/desktop-shared/lib/shared-container-scope-mode';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { CanopyCloudClientError } from '../canopy-cloud/client';
import { getFeatureFlagService } from '../feature-flags';
import { validateId } from '../lib/validation';
import { logMainProcessWarn } from '../lib/main-process-logging';
import { addTrackedPlansWriteListener } from '../lib/plan-persistence';
import { isCoworkWorkspace } from '../lib/workspace-registry';
import {
  createSharedContainerGrant,
  listDismissedSharedContainers,
  listSharedContainerRecipients,
  listSharedContainersByMe,
  restoreSharedContainer,
  revokeSharedContainerGrant,
  searchSharedContainerMembers,
  getSharedContainerLink,
  createSharedContainerLink,
  setSharedContainerLink,
  resetSharedContainerLink,
  resolveSharedContainerLink,
  claimSharedContainerLink,
} from '../shared-containers/canopy-server-client';
import { sharedContainerOwnerKey } from '../shared-containers/owner-scope';
import {
  getSharedContainerEligibility,
  prepareSharedContainerGithub,
} from '../shared-containers/eligibility';
import {
  recordSharedContainerListingBlocked,
  recordSharedContainerListingUnavailable,
} from '../shared-containers/listing-diagnostics';
import {
  MAX_SHARED_CONTAINER_APPROVED_FILE_PATHS,
  MAX_SHARED_CONTAINER_SELECTED_ITEM_IDS,
  normalizeSharedContainerFileScope,
  pinSharedContainerPreferredLayout,
  pinSharedContainerPreferredLayoutIfMissing,
  readSharedContainerFileScope,
  writeSharedContainerFileScope,
} from '../shared-containers/file-scope-store';
import { getSharedContainerPublicationStateStore } from '../shared-containers/publication-state';
import {
  acceptSharedContainer,
  allowSharedContainerRun,
  forgetSharedContainerAcceptance,
  getSharedContainerAcceptance,
  isSharedContainerAccepted,
  isSharedContainerRunAllowed,
  revokeSharedContainerRun,
  listAcceptedSharedContainers,
  withSharedContainerRunLifecycle,
} from '../shared-containers/acceptance-store';
import { getSharedContainerPublishScheduler } from '../shared-containers/publish/scheduler';
import { getSharedContainerReconciliationService } from '../shared-containers/reconciliation-service';
import { getSharedContainerReader } from '../shared-containers/read/reader';
import {
  buildSharedContainerSharePreview,
  listSharedContainerUntrackedCandidatePaths,
} from '../shared-containers/share-preview';
import { getTelemetrySyncService } from '../services/telemetry-sync-service';
import { getSharedContainerInboxWatcher } from '../services/shared-container-inbox-watcher';
import { getObservabilityService } from '../observability';
import { registerIpcHandler } from './register';
import {
  projectSharedContainerRunEnvironment,
  readSharedContainerRunEnvironment,
  removeSharedContainerRunEnvironment,
  writeSharedContainerRunEnvironment,
} from '../shared-containers/run-env-store';
import {
  getSharedContainerRunCopyState,
  measureSharedContainerRunCopyBytes,
  refreshSharedContainerRunCopy,
} from '../shared-containers/run/run-copy';
import { stopWorktreeScripts } from '../services/scripts-service';
import { workerTerminal } from '../terminal/worker-terminal';
import { listTrackedShellScriptsForWorktree } from '../lib/script-runner';
import { forkSharedContainer } from '../shared-containers/fork';
import type { DesktopCanopyDispatcher } from '../canopy-runtime/desktop-runtime';
import { projectedSourceCompositionCommands } from '../canopy-runtime/source-composition-dispatch';
import type { DesktopIpcCallerResolver } from './file-tree';
import { recoverForkCapabilityInstalls } from '../shared-containers/capability-package/install';
import { isCapabilityPackageDigest } from '@canopy/protocol/pipelines';
import {
  SharedContainerForkError,
  forkSourceNotAccepted,
  validateForkDestination,
} from '../shared-containers/fork/destination';
import {
  getSharedContainerForkProvenancePath,
  readSharedContainerForkProvenance,
} from '../shared-containers/fork/provenance';
import { sendToWebContents } from '../lib/web-contents-send';
import {
  recordInviteSendTelemetry,
  recordInviteAcceptTelemetry,
} from '../lib/desktop-telemetry';

const grantMutationTails = new Map<string, Promise<void>>();
const activeRunCopyRefreshRequests = new Set<string>();

function telemetryContainerType(
  value: unknown,
): 'WORKTREE' | 'COWORK' | 'CLOUD_CHAT' | undefined {
  if (value === 'CODE_WORKTREE') return 'WORKTREE';
  if (value === 'COWORK_WORK_ENTRY') return 'COWORK';
  return value === 'CLOUD_CHAT' ? 'CLOUD_CHAT' : undefined;
}

function recordSharedContainerPreviewFailure(
  request: SharedContainerPreviewRequest,
  error: unknown,
): void {
  try {
    getObservabilityService().recordSessionDiagnostic({
      version: 1,
      timestamp: new Date().toISOString(),
      kind: 'shared_container_preview_failure',
      sessionKey: `${request.projectId}/${request.worktreeId}/${sharedContainerOwnerKey(request.organizationId)}`,
      projectId: request.projectId,
      worktreeId: request.worktreeId,
      chatId: '',
      providerType: 'unknown',
      ...(request.organizationId !== undefined
        ? { sharedContainerOrganizationId: request.organizationId }
        : {}),
      sharedContainerType: request.containerType,
      error: error instanceof Error ? error.message : String(error),
    });
  } catch {
    // A diagnostic must never replace the original preview failure.
  }
}

async function serializeGrantMutation<T>(
  request: SharedContainerEligibilityRequest,
  operation: () => Promise<T>,
): Promise<T> {
  const key = `${request.projectId}:${request.worktreeId}:${sharedContainerOwnerKey(request.organizationId)}`;
  const previous = grantMutationTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  grantMutationTails.set(key, tail);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (grantMutationTails.get(key) === tail) {
      grantMutationTails.delete(key);
    }
  }
}

const SHARED_CONTAINER_INVITE_AUDIENCES: readonly string[] = [
  'team',
  'organization',
  'public',
];

/** Validate an optional organization hint; absent means personal/direct. */
function validateOptionalOrganizationId(
  organizationId: string | undefined,
): void {
  if (organizationId !== undefined) {
    validateId(organizationId, 'organizationId');
  }
}

function validateOptionalAccess(access: unknown): void {
  if (
    access !== undefined &&
    access !== 'organization' &&
    access !== 'direct'
  ) {
    throw new Error('Invalid access');
  }
}

const MAX_VIEWER_SESSION_ID_LENGTH = 64;

/**
 * Validates the renderer-minted viewer session id on open, retry and close.
 * Absent on legacy callers, which is why it is optional rather than required.
 */
function validateOptionalViewerSessionId(
  viewerSessionId: unknown,
): asserts viewerSessionId is string | undefined {
  if (viewerSessionId === undefined) return;
  validateId(viewerSessionId, 'viewerSessionId');
  if (viewerSessionId.length > MAX_VIEWER_SESSION_ID_LENGTH) {
    throw new Error('Invalid viewerSessionId: too long');
  }
}

function validateTarget(request: SharedContainerEligibilityRequest): void {
  validateId(request.projectId, 'projectId');
  validateId(request.worktreeId, 'worktreeId');
  // Absent means a personal container, which only Public can create.
  validateOptionalOrganizationId(request.organizationId);
  if (
    request.audience !== undefined &&
    !SHARED_CONTAINER_INVITE_AUDIENCES.includes(request.audience)
  ) {
    throw new Error('Invalid audience');
  }
  if (!SHARED_CONTAINER_TYPES.includes(request.containerType)) {
    throw new Error('Invalid containerType');
  }
  const expectedContainerType = isCoworkWorkspace(request.projectId)
    ? 'COWORK_WORK_ENTRY'
    : 'CODE_WORKTREE';
  if (request.containerType !== expectedContainerType) {
    throw new Error('containerType does not match project type');
  }
}

function isFirstLinkRequest(
  request: SetSharedContainerLinkIpcRequest,
): request is Omit<SharedContainerEligibilityRequest, 'audience'> & {
  containerId: null;
  audience: 'ANYONE' | 'ORGANIZATION';
} {
  return request.containerId === null;
}

/** Match the server's normalized-address limit before crossing IPC. */
const MAX_SHARED_CONTAINER_RECIPIENT_EMAIL_LENGTH = 256;

/**
 * Structural check only: the server normalizes the address and owns real
 * validation. This keeps obviously malformed input off the wire.
 */
function validateInviteRecipient(recipient: unknown): void {
  if (!recipient || typeof recipient !== 'object') {
    throw new Error('Invalid recipient');
  }
  const value: Partial<Record<string, unknown>> = { ...recipient };
  if (value.kind === 'member') {
    if (typeof value.userId !== 'string') throw new Error('Invalid recipient');
    validateId(value.userId, 'recipient.userId');
    return;
  }
  if (value.kind === 'email') {
    const email = typeof value.email === 'string' ? value.email.trim() : '';
    const parts = email.split('@');
    if (
      email.length === 0 ||
      email.length > MAX_SHARED_CONTAINER_RECIPIENT_EMAIL_LENGTH ||
      /\s/.test(email) ||
      parts.length !== 2 ||
      parts[0].length === 0 ||
      parts[1].length === 0
    ) {
      throw new Error('Invalid recipient email');
    }
    return;
  }
  throw new Error('Invalid recipient');
}

/** The wire recipient, with an email address trimmed. */
function normalizeInviteRecipient(
  recipient: SharedContainerRecipientWire,
): SharedContainerRecipientWire {
  return recipient.kind === 'email'
    ? { kind: 'email', email: recipient.email.trim() }
    : { kind: 'member', userId: recipient.userId };
}

/**
 * Bounds for the org-wide owner listing (CAN-2551). Startup hydration fans out
 * over every organization, so the listing is deliberately paged and bounded:
 * a large org must not turn sidebar hydration into an unbounded crawl.
 *
 * The page size is the protocol's own maximum, not a locally chosen number.
 * `MAX_SHARED_CONTAINER_LIST_LIMIT` is what the route parser enforces, and it
 * rejects anything larger with a 400 rather than clamping
 * (`parseSharedContainerOwnerList`). Asking for more therefore does not return
 * a smaller page — it fails every organization's listing, `answered === 0`
 * leaves the renderer store empty, and the sidebar shared badge is silently
 * absent for the whole session. Depth is bought with `maxPages`, never with a
 * larger page.
 */
const DEFAULT_OWNED_TARGET_PAGE_SIZE = MAX_SHARED_CONTAINER_LIST_LIMIT;
const MAX_OWNED_TARGET_PAGE_SIZE = MAX_SHARED_CONTAINER_LIST_LIMIT;
const DEFAULT_OWNED_TARGET_MAX_PAGES = 10;
const MAX_OWNED_TARGET_MAX_PAGES = 50;

function clampOwnedTargetPageBound(
  value: number | undefined,
  fallback: number,
  maximum: number,
): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.floor(value), 1), maximum);
}

function isSharedContainersEnabled(): boolean {
  return getFeatureFlagService().isEnabled(
    CLIENT_FEATURE_FLAGS.canopyDesktopSharedContainers.key,
  );
}

function assertSharedContainersEnabled(): void {
  if (!isSharedContainersEnabled()) {
    throw new Error('Shared containers are disabled.');
  }
}

function assertSharedContainerRunEnabled(): void {
  assertSharedContainersEnabled();
  if (process.platform !== 'darwin') {
    throw new Error('Shared-container run is disabled.');
  }
}

async function stopSharedContainerProcesses(
  containerId: string,
): Promise<void> {
  workerTerminal.killWorktree({
    projectId: SHARED_CONTAINER_VIEWER_PROJECT_ID,
    worktreeId: containerId,
  });
  await stopWorktreeScripts({
    projectId: SHARED_CONTAINER_VIEWER_PROJECT_ID,
    worktreeId: containerId,
  });
}

/**
 * Fails closed unless this device has accepted the container. Materialization
 * clones the publisher's repositories with the recipient's own credentials, so
 * it must never be reachable from a listing alone.
 */
async function assertSharedContainerAccepted(
  containerId: string,
): Promise<void> {
  if (!(await isSharedContainerAccepted(containerId))) {
    throw new Error('Shared container has not been accepted on this device.');
  }
}

/** The connected server predates recoverable removal (CAN-4052). */
function isDismissalsUnsupported(error: unknown): boolean {
  return (
    error instanceof CanopyCloudClientError &&
    error.code === 'unsupported-capability'
  );
}

function isDefinitiveGrantCreationRejection(error: unknown): boolean {
  if (!(error instanceof CanopyCloudClientError)) return false;
  if (
    error.code === 'cloud-not-configured' ||
    error.code === 'missing-api-key' ||
    error.code === 'unsupported-capability'
  ) {
    return true;
  }
  if (error.code !== 'http-error') return false;
  return (
    error.status === 400 ||
    error.status === 401 ||
    error.status === 403 ||
    error.status === 404 ||
    error.status === 422 ||
    error.status === 429
  );
}

async function createAndScheduleSharedContainer<
  T extends { container: { id: string } },
>(
  request: SharedContainerEligibilityRequest,
  organizationId: string | undefined,
  serverWorktreeExternalId: string,
  create: () => Promise<T>,
): Promise<{ created: T; publicationState: SharedContainerPublicationState }> {
  const telemetry = getTelemetrySyncService();
  const reservedAnchor = await telemetry.reserveSharedContainerAnchor(
    request.projectId,
    request.worktreeId,
    organizationId,
    serverWorktreeExternalId,
  );
  let created: T;
  try {
    created = await create();
  } catch (error) {
    if (reservedAnchor && isDefinitiveGrantCreationRejection(error)) {
      try {
        await telemetry.releaseSharedContainerAnchor(
          request.projectId,
          request.worktreeId,
          organizationId,
          serverWorktreeExternalId,
        );
      } catch (releaseError) {
        logMainProcessWarn(
          '[shared-containers] failed to release owner anchor reservation',
          releaseError,
        );
      }
    }
    throw error;
  }
  const publicationState =
    await getSharedContainerPublicationStateStore().markNotPublished({
      projectId: request.projectId,
      worktreeId: request.worktreeId,
      ...(organizationId !== undefined ? { organizationId } : {}),
      containerId: created.container.id,
      containerType: request.containerType,
    });
  // Pin before the first publish is scheduled, so the first revision carries
  // the layout the publisher was looking at when they shared. The publish
  // path pins too, so a failure here only delays the pin.
  try {
    await pinSharedContainerPreferredLayoutIfMissing(
      request.projectId,
      request.worktreeId,
    );
  } catch (error) {
    logMainProcessWarn(
      '[shared-containers] failed to pin the preferred layout',
      error,
    );
  }
  getSharedContainerPublishScheduler().schedule(
    {
      projectId: request.projectId,
      worktreeId: request.worktreeId,
      ...(organizationId !== undefined ? { organizationId } : {}),
      containerId: created.container.id,
      containerType: request.containerType,
    },
    true,
  );
  return { created, publicationState };
}

export function classifySharedContainerError(
  error: unknown,
):
  | 'invalid-request'
  | 'insufficient-role'
  | 'blocked-by-org-billing'
  | 'external-sharing-disabled'
  | 'not-found'
  | 'conflict'
  | 'rate-limited'
  | 'temporarily-unavailable'
  | 'unknown' {
  if (!(error instanceof CanopyCloudClientError)) {
    return 'unknown';
  }
  if (error.status === 403) {
    if (error.serverCode === SHARED_CONTAINER_INSUFFICIENT_ROLE_ERROR_CODE) {
      return 'insufficient-role';
    }
    if (
      error.serverCode === SHARED_CONTAINER_BLOCKED_BY_ORG_BILLING_ERROR_CODE
    ) {
      return 'blocked-by-org-billing';
    }
    if (
      error.serverCode === SHARED_CONTAINER_EXTERNAL_SHARING_DISABLED_ERROR_CODE
    ) {
      return 'external-sharing-disabled';
    }
  }
  if (
    error.code === 'network-error' ||
    error.status === 502 ||
    error.status === 503 ||
    error.status === 504
  ) {
    return 'temporarily-unavailable';
  }
  switch (error.status) {
    case 400:
      return 'invalid-request';
    case 403:
      return 'unknown';
    case 404:
      return 'not-found';
    case 409:
      return 'conflict';
    case 429:
      return 'rate-limited';
    default:
      return 'unknown';
  }
}

export function registerSharedContainerHandlers(runtime: {
  dispatcher: Pick<DesktopCanopyDispatcher, 'instruction'>;
  resolveCaller: DesktopIpcCallerResolver;
}): void {
  addTrackedPlansWriteListener((projectId, worktreeId) => {
    void getSharedContainerPublishScheduler()
      .scheduleKnown(projectId, worktreeId)
      .catch((error) =>
        logMainProcessWarn(
          '[shared-containers] failed to schedule tracked-plan publication',
          error,
        ),
      );
  });
  void getSharedContainerPublicationStateStore()
    .rehydrateAll()
    .then((records) => getSharedContainerPublishScheduler().recover(records))
    .catch((error) =>
      logMainProcessWarn(
        '[shared-containers] failed to rehydrate or recover publication state',
        error,
      ),
    );
  // A crash between fork capability installation steps leaves a journal. The
  // installer finishes it when the ledger committed, or undoes its own objects.
  void recoverForkCapabilityInstalls().catch((error: unknown) =>
    logMainProcessWarn(
      '[shared-containers] failed to recover fork capability installs',
      error,
    ),
  );
  const reconciliation = getSharedContainerReconciliationService();
  const reader = getSharedContainerReader();
  reconciliation.onChanged((state) => {
    for (const window of BrowserWindow.getAllWindows()) {
      sendToWebContents(
        window.webContents,
        IPC_CHANNELS.sharedContainersReplicaChanged,
        state,
      );
    }
  });
  reconciliation.onSyncPhase((event) => {
    for (const window of BrowserWindow.getAllWindows()) {
      sendToWebContents(
        window.webContents,
        IPC_CHANNELS.sharedContainersSyncPhase,
        event,
      );
    }
  });
  registerIpcHandler<
    [SharedContainerEligibilityRequest],
    SharedContainerEligibilityResponse
  >(IPC_CHANNELS.sharedContainersEligibility, async (_event, request) => {
    assertSharedContainersEnabled();
    validateTarget(request);
    return getSharedContainerEligibility(request);
  });

  registerIpcHandler<
    [SharedContainerPrepareGithubRequest],
    SharedContainerPrepareGithubResponse
  >(IPC_CHANNELS.sharedContainersPrepareGithub, async (_event, request) => {
    assertSharedContainersEnabled();
    validateTarget(request);
    // Cowork containers have no Git repository to publish; refuse rather than
    // silently reporting success.
    if (request.containerType !== 'CODE_WORKTREE') {
      throw new Error('containerType does not support GitHub preparation');
    }
    // This is the only handler in this domain that mutates a remote, so the
    // eligibility question is re-asked here rather than trusting that the
    // renderer only rendered the button when it was allowed to. Every other
    // gate — cloud account, guest, org billing, capability, sync-blocked,
    // sync-disabled — lives in `getSharedContainerEligibility`, and stale
    // renderer state must never be what authorizes the push. The one refusal
    // that may proceed is `github-not-ready`, which is precisely the
    // condition this call exists to repair.
    const eligibility = await getSharedContainerEligibility(request);
    if (!eligibility.eligible && eligibility.reason !== 'github-not-ready') {
      return {
        status: 'blocked',
        readiness: { status: 'blocked', reason: 'unavailable' },
      };
    }
    return prepareSharedContainerGithub(request);
  });

  registerIpcHandler<
    [SharedContainerPreviewRequest],
    SharedContainerSharePreview
  >(IPC_CHANNELS.sharedContainersPreview, async (_event, request) => {
    assertSharedContainersEnabled();
    validateTarget(request);
    try {
      return await buildSharedContainerSharePreview(request);
    } catch (error) {
      recordSharedContainerPreviewFailure(request, error);
      throw error;
    }
  });

  registerIpcHandler<
    [SaveSharedContainerFileScopeRequest],
    SaveSharedContainerFileScopeResponse
  >(IPC_CHANNELS.sharedContainersSaveFileScope, async (_event, request) => {
    assertSharedContainersEnabled();
    validateId(request.projectId, 'projectId');
    validateId(request.worktreeId, 'worktreeId');
    if (!Array.isArray(request.includedPaths)) {
      throw new Error('Invalid includedPaths');
    }
    if (
      request.excludedPaths !== undefined &&
      !Array.isArray(request.excludedPaths)
    ) {
      throw new Error('Invalid excludedPaths');
    }
    if (
      request.legacyAllowlist !== undefined &&
      typeof request.legacyAllowlist !== 'boolean'
    ) {
      throw new Error('Invalid legacyAllowlist');
    }
    if (
      (request.includedNoteIds !== undefined &&
        !Array.isArray(request.includedNoteIds)) ||
      (request.excludedNoteIds !== undefined &&
        !Array.isArray(request.excludedNoteIds)) ||
      (request.includedPromptIds !== undefined &&
        !Array.isArray(request.includedPromptIds)) ||
      (request.excludedPromptIds !== undefined &&
        !Array.isArray(request.excludedPromptIds))
    ) {
      throw new Error('Invalid note or prompt selection');
    }
    if (
      (request.runSharingEnabled !== undefined &&
        typeof request.runSharingEnabled !== 'boolean') ||
      (request.runSharingDisabled !== undefined &&
        typeof request.runSharingDisabled !== 'boolean') ||
      (request.includedRunScripts !== undefined &&
        !Array.isArray(request.includedRunScripts)) ||
      (request.excludedRunScripts !== undefined &&
        !Array.isArray(request.excludedRunScripts))
    ) {
      throw new Error('Invalid run sharing selection');
    }
    const preferredLayoutRequest = request.preferredLayout ?? 'keep';
    if (
      preferredLayoutRequest !== 'keep' &&
      preferredLayoutRequest !== 'pin-current' &&
      preferredLayoutRequest !== 'clear'
    ) {
      throw new Error('Invalid preferredLayout');
    }
    if (
      request.includedPaths.length > MAX_SHARED_CONTAINER_APPROVED_FILE_PATHS
    ) {
      throw new Error('Too many includedPaths');
    }
    if (
      (request.excludedPaths?.length ?? 0) >
      MAX_SHARED_CONTAINER_APPROVED_FILE_PATHS
    ) {
      throw new Error('Too many excludedPaths');
    }
    for (const [field, values] of [
      ['includedNoteIds', request.includedNoteIds],
      ['excludedNoteIds', request.excludedNoteIds],
      ['includedPromptIds', request.includedPromptIds],
      ['excludedPromptIds', request.excludedPromptIds],
      ['excludedRunScripts', request.excludedRunScripts],
    ] as const) {
      if ((values?.length ?? 0) > MAX_SHARED_CONTAINER_SELECTED_ITEM_IDS) {
        throw new Error(`Too many ${field}`);
      }
    }
    if (
      (request.includedRunScripts?.length ?? 0) >
      MAX_SHARED_CONTAINER_RUN_COMMANDS
    ) {
      throw new Error('Too many includedRunScripts');
    }
    const normalizedScope = normalizeSharedContainerFileScope({
      includedPaths: request.includedPaths,
      ...(request.excludedPaths !== undefined
        ? { excludedPaths: request.excludedPaths }
        : {}),
      ...(request.legacyAllowlist === true ? { legacyAllowlist: true } : {}),
      includedNoteIds: request.includedNoteIds ?? [],
      excludedNoteIds: request.excludedNoteIds ?? [],
      includedPromptIds: request.includedPromptIds ?? [],
      excludedPromptIds: request.excludedPromptIds ?? [],
      runSharingEnabled: request.runSharingEnabled,
      runSharingDisabled: request.runSharingDisabled,
      includedRunScripts: request.includedRunScripts,
      excludedRunScripts: request.excludedRunScripts,
    });
    const isCoworkContainer = isCoworkWorkspace(request.projectId);
    // Worktrees are permanently opt-out. Old clients and persisted previews
    // may still send their former allowlist fields, but retaining those fields
    // would stop an otherwise-default scope from collapsing back to no file.
    let includedPaths = isCoworkContainer ? normalizedScope.includedPaths : [];
    if (
      normalizedScope.includedPaths.length > 0 &&
      isCoworkContainer &&
      fileScopeIsAllowlist('COWORK_WORK_ENTRY', normalizedScope)
    ) {
      const [persistedScope, currentCandidatePaths] = await Promise.all([
        readSharedContainerFileScope(request.projectId, request.worktreeId),
        listSharedContainerUntrackedCandidatePaths(
          request.projectId,
          request.worktreeId,
        ),
      ]);
      const candidatePaths = new Set(currentCandidatePaths);
      const previouslyApprovedPaths = new Set(persistedScope.includedPaths);
      if (
        normalizedScope.includedPaths.some(
          (path) =>
            !candidatePaths.has(path) && !previouslyApprovedPaths.has(path),
        )
      ) {
        throw new Error('includedPaths must be current untracked files');
      }
      // A path may become tracked or disappear between opening the preview and
      // editing the scope. It is safe to prune a previously persisted approval,
      // but a never-approved non-candidate remains a forged request and fails.
      includedPaths = normalizedScope.includedPaths.filter((path) =>
        candidatePaths.has(path),
      );
    }
    await writeSharedContainerFileScope(request.projectId, request.worktreeId, {
      includedPaths,
      ...(normalizedScope.excludedPaths !== undefined
        ? { excludedPaths: normalizedScope.excludedPaths }
        : {}),
      ...(isCoworkContainer && normalizedScope.legacyAllowlist === true
        ? { legacyAllowlist: true }
        : {}),
      includedNoteIds: normalizedScope.includedNoteIds,
      excludedNoteIds: normalizedScope.excludedNoteIds,
      includedPromptIds: normalizedScope.includedPromptIds,
      excludedPromptIds: normalizedScope.excludedPromptIds,
      runSharingEnabled: normalizedScope.runSharingEnabled,
      runSharingDisabled: normalizedScope.runSharingDisabled,
      includedRunScripts: normalizedScope.includedRunScripts,
      excludedRunScripts: normalizedScope.excludedRunScripts,
      // The store leaves the persisted preferred layout unchanged when this
      // field is absent, which is `keep`.
      ...(preferredLayoutRequest === 'clear'
        ? { preferredLayout: { enabled: false } }
        : {}),
    });
    try {
      if (preferredLayoutRequest === 'pin-current') {
        await pinSharedContainerPreferredLayout(
          request.projectId,
          request.worktreeId,
        );
      }
    } finally {
      // The scope write above has already persisted, so its publication is
      // scheduled even when the pin fails.
      void getSharedContainerPublishScheduler()
        .scheduleKnown(request.projectId, request.worktreeId, true)
        .catch((error) =>
          logMainProcessWarn(
            '[shared-containers] failed to schedule scope publication',
            error,
          ),
        );
    }
    return {
      fileScope: await readSharedContainerFileScope(
        request.projectId,
        request.worktreeId,
      ),
    };
  });

  registerIpcHandler<
    [SharedContainerLinkOwnerRequest],
    SharedContainerLink | null
  >(IPC_CHANNELS.sharedContainersGetLink, async (_event, request) => {
    assertSharedContainersEnabled();
    validateId(request.containerId, 'containerId');
    return getSharedContainerLink(request.containerId);
  });

  registerIpcHandler<
    [SetSharedContainerLinkIpcRequest],
    SetSharedContainerLinkIpcResponse
  >(IPC_CHANNELS.sharedContainersSetLink, async (_event, request) => {
    assertSharedContainersEnabled();
    if (
      request.audience !== null &&
      !SHARED_CONTAINER_LINK_AUDIENCES.includes(request.audience)
    ) {
      throw new Error('Invalid shared-container link audience');
    }
    if (!isFirstLinkRequest(request)) {
      validateId(request.containerId, 'containerId');
      return {
        link: await setSharedContainerLink(
          request.containerId,
          request.audience,
        ),
      };
    }
    if (request.audience === null) {
      throw new Error('Cannot turn off a link before its container exists');
    }
    const target: SharedContainerEligibilityRequest = {
      projectId: request.projectId,
      worktreeId: request.worktreeId,
      containerType: request.containerType,
      ...(request.organizationId !== undefined
        ? { organizationId: request.organizationId }
        : {}),
    };
    validateTarget(target);
    return serializeGrantMutation(target, async () => {
      const eligibility = await getSharedContainerEligibility(target);
      if (!eligibility.eligible || !eligibility.serverWorktreeExternalId) {
        throw new Error(
          `Shared-container link target is not eligible: ${eligibility.reason ?? 'not-yet-synced'}`,
        );
      }
      const serverWorktreeExternalId = eligibility.serverWorktreeExternalId;
      const organizationId = eligibility.ownerOrganizationId;
      const allowed =
        request.audience === 'ANYONE'
          ? eligibility.link?.anyone
          : eligibility.link?.organization;
      if (!allowed) {
        throw new Error('Shared-container link audience is unavailable');
      }
      const { created, publicationState } =
        await createAndScheduleSharedContainer(
          target,
          organizationId,
          serverWorktreeExternalId,
          () =>
            createSharedContainerLink({
              worktreeId: serverWorktreeExternalId,
              ...(organizationId !== undefined ? { organizationId } : {}),
              audience: request.audience,
            }),
        );
      return {
        link: created.link,
        container: created.container,
        publicationState,
      };
    });
  });

  registerIpcHandler<[SharedContainerLinkOwnerRequest], SharedContainerLink>(
    IPC_CHANNELS.sharedContainersResetLink,
    async (_event, request) => {
      assertSharedContainersEnabled();
      validateId(request.containerId, 'containerId');
      return resetSharedContainerLink(request.containerId);
    },
  );

  registerIpcHandler<
    [SharedContainerLinkTokenRequest],
    SharedContainerLinkLanding
  >(IPC_CHANNELS.sharedContainersResolveLink, async (_event, request) => {
    assertSharedContainersEnabled();
    if (!SHARED_CONTAINER_LINK_TOKEN_PATTERN.test(request.token)) {
      throw new Error('Invalid shared-container link token');
    }
    return resolveSharedContainerLink(request.token);
  });

  registerIpcHandler<
    [SharedContainerLinkTokenRequest],
    SharedContainerLinkClaimResult
  >(IPC_CHANNELS.sharedContainersClaimLink, async (_event, request) => {
    assertSharedContainersEnabled();
    if (!SHARED_CONTAINER_LINK_TOKEN_PATTERN.test(request.token)) {
      throw new Error('Invalid shared-container link token');
    }
    const ref = await claimSharedContainerLink(request.token);
    await acceptSharedContainer(
      ref.id,
      ref.organizationId,
      undefined,
      ref.access,
    );
    return ref;
  });

  registerIpcHandler<
    [InviteSharedContainerRequest],
    InviteSharedContainerResponse
  >(IPC_CHANNELS.sharedContainersInvite, async (_event, request) => {
    assertSharedContainersEnabled();
    validateTarget(request);
    validateInviteRecipient(request.recipient);
    if (!isSharedContainerCapabilitySet(request.capabilities)) {
      throw new Error('Invalid capabilities');
    }
    const recipient = normalizeInviteRecipient(request.recipient);
    return serializeGrantMutation(request, async () => {
      const eligibility = await getSharedContainerEligibility(request);
      if (!eligibility.eligible || !eligibility.serverWorktreeExternalId) {
        return {
          invited: false,
          reason: eligibility.reason ?? 'not-yet-synced',
          ...(eligibility.blockedByOrganizationNames
            ? {
                blockedByOrganizationNames:
                  eligibility.blockedByOrganizationNames,
              }
            : {}),
        };
      }
      const serverWorktreeExternalId = eligibility.serverWorktreeExternalId;
      // With external sharing on, eligibility resolves (and may fix) the
      // owner; that answer, not the renderer's selection, decides where the
      // container lives. Without it, the request's organization is the owner,
      // exactly as before.
      const externalSharing = eligibility.audiences !== undefined;
      const organizationId = externalSharing
        ? eligibility.ownerOrganizationId
        : request.organizationId;
      if (recipient.kind === 'email') {
        // Email recipients are the Public audience.
        if (!eligibility.audiences?.public) {
          return { invited: false, reason: 'external-sharing-disabled' };
        }
      } else if (
        organizationId === undefined ||
        organizationId !== request.organizationId
      ) {
        // A member was picked from `request.organizationId`, but the
        // container is owned elsewhere (another organization, or personally),
        // so an organization grant for that member cannot exist.
        return { invited: false, reason: 'anchored-to-other-organization' };
      }
      let result: {
        created: Awaited<ReturnType<typeof createSharedContainerGrant>>;
        publicationState: SharedContainerPublicationState;
      };
      try {
        result = await createAndScheduleSharedContainer(
          request,
          organizationId,
          serverWorktreeExternalId,
          async () => {
            const created = await createSharedContainerGrant({
              ...(organizationId !== undefined ? { organizationId } : {}),
              worktreeId: serverWorktreeExternalId,
              recipient,
              capabilities: request.capabilities,
            });
            // The server has committed the grant, even if later publication fails.
            try {
              const containerType = telemetryContainerType(
                request.containerType,
              );
              if (containerType !== undefined)
                recordInviteSendTelemetry({
                  inviteType: 'teammate_share',
                  inviteId: created.container.id,
                  grantId: created.grant.id,
                  recipientKind: recipient.kind,
                  sendSurface: 'share_dialog',
                  shareAudience:
                    request.audience ??
                    (recipient.kind === 'email' ? 'public' : 'organization'),
                  containerType,
                });
            } catch {
              /* Telemetry cannot turn a committed grant into a retry. */
            }
            return created;
          },
        );
      } catch (error) {
        // Network/timeout, invalid-response, 5xx, and conflict outcomes may have
        // committed remotely. Retain the durable identity so an idempotent retry
        // cannot target a different telemetry worktree.
        const reason = classifySharedContainerError(error);
        if (
          reason === 'insufficient-role' ||
          reason === 'blocked-by-org-billing' ||
          reason === 'external-sharing-disabled'
        ) {
          return { invited: false, reason };
        }
        throw error;
      }
      return {
        invited: true,
        ...result.created,
        publicationState: result.publicationState,
      };
    });
  });

  registerIpcHandler<
    [SearchSharedContainerMembersRequest],
    SearchSharedContainerMembersResult
  >(IPC_CHANNELS.sharedContainersSearchMembers, async (_event, request) => {
    assertSharedContainersEnabled();
    validateId(request.organizationId, 'organizationId');
    if (request.teamId !== undefined) validateId(request.teamId, 'teamId');
    return searchSharedContainerMembers(request);
  });

  registerIpcHandler<
    [ListSharedContainerRecipientsRequest],
    ListSharedContainerRecipientsResult
  >(IPC_CHANNELS.sharedContainersListRecipients, async (_event, request) => {
    validateId(request.containerId, 'containerId');
    validateOptionalOrganizationId(request.organizationId);
    return listSharedContainerRecipients(request);
  });

  registerIpcHandler<
    [RevokeSharedContainerRecipientRequest],
    RevokeSharedContainerRecipientResponse
  >(IPC_CHANNELS.sharedContainersRevokeRecipient, async (_event, request) => {
    validateId(request.containerId, 'containerId');
    validateId(request.grantId, 'grantId');
    validateOptionalOrganizationId(request.organizationId);
    try {
      // By grant id: email recipients and pending invites expose no user id.
      await revokeSharedContainerGrant(
        request.containerId,
        request.grantId,
        request.organizationId,
      );
    } catch (error) {
      // Only the server's machine-readable missing-grant outcome is
      // idempotent. A generic 404 may mean the container lookup failed while
      // an active grant still exists, so it must remain visible to the caller.
      if (
        !(error instanceof CanopyCloudClientError) ||
        error.status !== 404 ||
        error.serverCode !== SHARED_CONTAINER_GRANT_NOT_FOUND_ERROR_CODE
      ) {
        throw error;
      }
    }
    return { revoked: true };
  });

  registerIpcHandler<
    [ListSharedContainersByMeRequest],
    ListSharedContainersByMeResponse
  >(IPC_CHANNELS.sharedContainersListByMe, async (_event, request) => {
    // Absent lists the caller's personal containers.
    validateOptionalOrganizationId(request.organizationId);
    validateId(request.projectId, 'projectId');
    validateId(request.worktreeId, 'worktreeId');
    const serverWorktreeId =
      getTelemetrySyncService().resolveServerWorktreeExternalId(
        request.projectId,
        request.worktreeId,
        request.organizationId,
      );
    if (!serverWorktreeId) {
      return { containers: [], nextCursor: null };
    }
    return listSharedContainersByMe({
      ...(request.organizationId !== undefined
        ? { organizationId: request.organizationId }
        : {}),
      worktreeId: serverWorktreeId,
      ...(request.cursor ? { cursor: request.cursor } : {}),
      ...(request.limit !== undefined ? { limit: request.limit } : {}),
    });
  });

  registerIpcHandler<
    [ListSharedContainerOwnedTargetsRequest],
    ListSharedContainerOwnedTargetsResponse
  >(IPC_CHANNELS.sharedContainersListOwnedTargets, async (_event, request) => {
    // Absent lists the caller's personal containers, resolved through the
    // personal anchor key.
    validateOptionalOrganizationId(request.organizationId);
    // Rollout-off returns an empty *complete* answer rather than throwing.
    // This listing runs unprompted at startup to hydrate an additive sidebar
    // badge, so a disabled rollout must cost zero network calls and must not
    // leave the store permanently marked incomplete.
    if (!isSharedContainersEnabled()) {
      return { targets: [], truncated: false };
    }
    const telemetry = getTelemetrySyncService();
    const maxPages = clampOwnedTargetPageBound(
      request.maxPages,
      DEFAULT_OWNED_TARGET_MAX_PAGES,
      MAX_OWNED_TARGET_MAX_PAGES,
    );
    const limit = clampOwnedTargetPageBound(
      request.limit,
      DEFAULT_OWNED_TARGET_PAGE_SIZE,
      MAX_OWNED_TARGET_PAGE_SIZE,
    );
    // Keyed by local identity: a worktree owns at most one container per org,
    // but a stale anchor could map two server rows onto one local worktree, so
    // the highest revision wins rather than the last page read.
    const targets = new Map<string, SharedContainerOwnedTarget>();
    // Built once per invocation, not once per container. This listing runs
    // unprompted for every organization during startup hydration on the
    // Electron main thread, and each page can carry up to
    // MAX_OWNED_TARGET_PAGE_SIZE containers, so resolving each one with its own
    // scan over every workspace x worktree was O(worktrees x containers). The
    // index makes the handler O(worktrees + containers). It is a snapshot taken
    // before the first page: an anchor created mid-pagination is picked up by
    // the next hydration rather than half of this one.
    const localWorktreesByServerExternalId =
      telemetry.buildLocalWorktreeIndexByServerExternalId(
        request.organizationId,
      );
    let cursor: string | undefined;
    let pages = 0;
    let truncated = false;
    do {
      const page = await listSharedContainersByMe({
        ...(request.organizationId !== undefined
          ? { organizationId: request.organizationId }
          : {}),
        limit,
        ...(cursor ? { cursor } : {}),
      });
      for (const container of page.containers) {
        if (!container.worktreeId) continue;
        const local = localWorktreesByServerExternalId.get(
          container.worktreeId,
        );
        if (!local) continue;
        const key = `${local.projectId}/${local.worktreeId}`;
        const existing = targets.get(key);
        if (existing && existing.revision >= container.revision) continue;
        targets.set(key, {
          projectId: local.projectId,
          worktreeId: local.worktreeId,
          ...(request.organizationId !== undefined
            ? { organizationId: request.organizationId }
            : {}),
          containerId: container.id,
          revision: container.revision,
        });
      }
      cursor = page.nextCursor ?? undefined;
      pages += 1;
      if (cursor && pages >= maxPages) {
        truncated = true;
        break;
      }
    } while (cursor);
    return { targets: Array.from(targets.values()), truncated };
  });

  registerIpcHandler<
    [ListSharedContainersWithMeRequest],
    ListSharedContainersWithMeResponse
  >(IPC_CHANNELS.sharedContainersListWithMe, async (_event, request) => {
    assertSharedContainersEnabled();
    // Absent is the direct listing (email and outside-organization shares).
    // Its purge-on-refusal path lives in the reconciliation service, keyed on
    // the direct scope rather than an organization.
    validateOptionalOrganizationId(request.organizationId);
    try {
      // `return await`, not a bare `return`: a bare return hands the promise
      // out of the try block and this catch never runs.
      return await reconciliation.listSharedWithMe(request);
    } catch (error) {
      const classification = classifySharedContainerError(error);
      if (
        classification === 'temporarily-unavailable' ||
        classification === 'rate-limited'
      ) {
        recordSharedContainerListingUnavailable(request.organizationId, error);
        return {
          containers: [],
          nextCursor: null,
          refusal: 'temporarily-unavailable',
          ...(error instanceof CanopyCloudClientError &&
          error.retryAfterMs !== undefined
            ? { retryAfterMs: error.retryAfterMs }
            : {}),
        };
      }
      // CAN-2551. A lapsed org's listing 403s with a server code, which is a
      // benign, non-retryable refusal rather than a transport failure. An IPC
      // rejection cannot carry that distinction (Electron clones only
      // `message`/`stack`), so the renderer collapsed it into "Could not load
      // shared containers." Convert it to a typed empty response instead;
      // anything else — including an ambiguous 403 with no server code, which
      // still classifies 'unknown' — keeps rethrowing.
      //
      // This conversion MUST stay here, outside
      // `ReconciliationService.listSharedWithMe`. That method's own catch
      // purges the local replica cache on a validated access loss before
      // rethrowing; converting the refusal inside it would leave decrypted
      // replica content on disk. Sitting outside guarantees the purge
      // completes first. Do not move the classification down.
      //
      // Gated on `!request.cursor` for the same reason. The purge inside
      // `ReconciliationService.listSharedWithMe` is itself `!request.cursor`-
      // gated, so converting a refusal on page 2+ would produce the one thing
      // this placement exists to prevent: a benign refusal with no purge. A
      // mid-pagination lapse therefore stays an error, exactly as before —
      // which is also self-healing, because the error is retryable and the
      // retry starts a fresh cursor-less listing that does purge.
      if (request.cursor || classification !== 'blocked-by-org-billing') {
        throw error;
      }
      recordSharedContainerListingBlocked(request.organizationId, error);
      return {
        containers: [],
        nextCursor: null,
        refusal: 'blocked-by-org-billing',
      };
    }
  });

  registerIpcHandler<[], ListAcceptedSharedContainersResponse>(
    IPC_CHANNELS.sharedContainersListAccepted,
    async () => {
      assertSharedContainersEnabled();
      const records = await listAcceptedSharedContainers();
      return { containerIds: Object.keys(records), records };
    },
  );

  registerIpcHandler<
    [SharedContainerRecipientRequest],
    AcceptSharedContainerResponse
  >(IPC_CHANNELS.sharedContainersAccept, async (_event, request) => {
    assertSharedContainersEnabled();
    validateId(request.containerId, 'containerId');
    validateOptionalOrganizationId(request.organizationId);
    validateOptionalAccess(request.access);
    // The record main holds afterwards. On a repeat accept that is the record
    // it kept, which need not match the identity this request carried.
    const record = await acceptSharedContainer(
      request.containerId,
      request.organizationId,
      undefined,
      request.access,
      () =>
        recordInviteAcceptTelemetry({
          inviteType: 'teammate_share',
          inviteId: request.containerId,
          acceptSurface: 'desktop_share_accept',
          containerType: telemetryContainerType(request.containerType),
        }),
    );
    return { accepted: true, record };
  });

  const readRunConfig = async (
    request: SharedContainerRunStatusRequest,
  ): Promise<Awaited<ReturnType<typeof reader.readRunConfig>>> => {
    assertSharedContainerRunEnabled();
    validateId(request.containerId, 'containerId');
    validateId(request.revisionId, 'revisionId');
    await assertSharedContainerAccepted(request.containerId);
    return reader.readRunConfig(request);
  };

  registerIpcHandler<
    [SharedContainerRunStatusRequest],
    SharedContainerRunStatus
  >(IPC_CHANNELS.sharedContainersRunStatus, async (_event, request) => {
    const run = await readRunConfig(request);
    const acceptance = await getSharedContainerAcceptance(request.containerId);
    const declared = new Set(run?.requiredEnv ?? []);
    const stored = (
      await readSharedContainerRunEnvironment(request.containerId)
    ).filter((entry) => declared.has(entry.key));
    const applied = new Map(stored.map((entry) => [entry.key, entry.value]));
    const runCopy = await getSharedContainerRunCopyState(request.containerId);
    const hasRunningProcesses =
      listTrackedShellScriptsForWorktree({
        projectId: SHARED_CONTAINER_VIEWER_PROJECT_ID,
        worktreeId: request.containerId,
      }).length > 0 ||
      workerTerminal.hasLiveTerminals({
        projectId: SHARED_CONTAINER_VIEWER_PROJECT_ID,
        worktreeId: request.containerId,
      });
    return {
      allowed: acceptance?.runAllowedAt !== undefined,
      ...(acceptance?.runAllowedAt
        ? { allowedAt: acceptance.runAllowedAt }
        : {}),
      ...(acceptance?.runAllowedPublisherUserId
        ? { publisherUserId: acceptance.runAllowedPublisherUserId }
        : {}),
      ...(run ? { run } : {}),
      values: projectSharedContainerRunEnvironment(request.containerId, stored),
      unsetRequiredEnv:
        run?.requiredEnv.filter((name) => !(applied.get(name) ?? '').trim()) ??
        [],
      runCopySizeBytes: String(
        await measureSharedContainerRunCopyBytes(request.containerId),
      ),
      runCopyNeedsRefresh:
        runCopy.state !== 'missing' &&
        (runCopy.state === 'pending' ||
          runCopy.revisionId !== request.revisionId),
      hasRunningProcesses,
    };
  });

  registerIpcHandler<[SharedContainerRunConsentRequest], void>(
    IPC_CHANNELS.sharedContainersAllowRun,
    async (_event, request) =>
      withSharedContainerRunLifecycle(request.containerId, async () => {
        assertSharedContainerRunEnabled();
        validateId(request.containerId, 'containerId');
        validateId(request.publisherUserId, 'publisherUserId');
        await assertSharedContainerAccepted(request.containerId);
        const state = await reconciliation.getState(request.containerId);
        if (state?.status !== 'available' && state?.status !== 'pinned') {
          throw new Error('Shared-container revision is not available.');
        }
        const run = await reader.readRunConfig({
          containerId: request.containerId,
          revisionId: state.revisionId,
        });
        if (!run)
          throw new Error('This share did not publish run configuration.');
        await allowSharedContainerRun(
          request.containerId,
          request.publisherUserId,
        );
      }),
  );

  registerIpcHandler<[GetSharedContainerReplicaStateRequest], void>(
    IPC_CHANNELS.sharedContainersRevokeRun,
    async (_event, request) =>
      withSharedContainerRunLifecycle(request.containerId, async () => {
        validateId(request.containerId, 'containerId');
        await stopSharedContainerProcesses(request.containerId);
        await revokeSharedContainerRun(request.containerId);
      }),
  );

  registerIpcHandler<[SharedContainerRunEnvironmentRequest], unknown>(
    IPC_CHANNELS.sharedContainersSaveRunEnvironment,
    async (_event, request) => {
      assertSharedContainerRunEnabled();
      validateId(request.containerId, 'containerId');
      if (!Array.isArray(request.values) || request.values.length > 64) {
        throw new Error('Invalid shared-container run environment.');
      }
      const state = await reconciliation.getState(request.containerId);
      if (state?.status !== 'available' && state?.status !== 'pinned') {
        throw new Error('Shared-container revision is not available.');
      }
      const run = await reader.readRunConfig({
        containerId: request.containerId,
        revisionId: state.revisionId,
      });
      if (!run || !(await isSharedContainerAccepted(request.containerId))) {
        throw new Error('Shared-container run is unavailable.');
      }
      const declared = new Set(run.requiredEnv);
      if (
        request.values.some(
          (entry) =>
            !entry ||
            typeof entry.key !== 'string' ||
            (typeof entry.value !== 'string' &&
              !isStoredSecretValue(entry.value)) ||
            !declared.has(entry.key),
        )
      ) {
        throw new Error('Run environment contains an undeclared name.');
      }
      return writeSharedContainerRunEnvironment(
        request.containerId,
        request.values,
      );
    },
  );

  registerIpcHandler<[SharedContainerRunRefreshRequest], void>(
    IPC_CHANNELS.sharedContainersRefreshRunCopy,
    async (_event, request) => {
      validateId(request.containerId, 'containerId');
      if (activeRunCopyRefreshRequests.has(request.containerId)) {
        throw new Error(
          'Shared-container run copy refresh is already in progress.',
        );
      }
      activeRunCopyRefreshRequests.add(request.containerId);
      try {
        await withSharedContainerRunLifecycle(request.containerId, async () => {
          await readRunConfig(request);
          if (!(await isSharedContainerRunAllowed(request.containerId))) {
            throw new Error('Shared-container run is not allowed.');
          }
          const scripts = listTrackedShellScriptsForWorktree({
            projectId: SHARED_CONTAINER_VIEWER_PROJECT_ID,
            worktreeId: request.containerId,
          });
          const hasRunning =
            scripts.length > 0 ||
            workerTerminal.hasLiveTerminals({
              projectId: SHARED_CONTAINER_VIEWER_PROJECT_ID,
              worktreeId: request.containerId,
            });
          if (hasRunning && request.stopRunning !== true) {
            throw new Error(
              'Stop shared-container processes before refreshing.',
            );
          }
          if (hasRunning) {
            await stopSharedContainerProcesses(request.containerId);
          }
          await refreshSharedContainerRunCopy(
            request.containerId,
            reader.store,
            request.revisionId,
          );
        });
      } finally {
        activeRunCopyRefreshRequests.delete(request.containerId);
      }
    },
  );

  /**
   * Shared by open and retry, which differ only in `force`.
   *
   * The viewer session is registered synchronously, before the first `await`,
   * so sessions are ordered by IPC arrival. Registering after the acceptance
   * read would let a slow read reorder two opens and reintroduce the race the
   * session exists to close. The cost is accepted: an open that then fails
   * acceptance still supersedes the previous session, whose tracking and
   * processes live on until the failed viewer is closed.
   */
  const openSharedContainerViewer = async (
    request: OpenSharedContainerRequest,
    force: boolean,
  ): Promise<SharedContainerReplicaState> => {
    assertSharedContainersEnabled();
    validateId(request.containerId, 'containerId');
    validateOptionalOrganizationId(request.organizationId);
    validateOptionalAccess(request.access);
    const { viewerSessionId } = request;
    validateOptionalViewerSessionId(viewerSessionId);
    if (viewerSessionId !== undefined) {
      reconciliation.beginViewerSession(request.containerId, viewerSessionId);
    }
    await assertSharedContainerAccepted(request.containerId);
    // The argument is omitted, not passed as `undefined`, for a legacy caller.
    return viewerSessionId === undefined
      ? reconciliation.open(
          request.containerId,
          request.organizationId,
          force,
          request.access,
        )
      : reconciliation.open(
          request.containerId,
          request.organizationId,
          force,
          request.access,
          viewerSessionId,
        );
  };

  registerIpcHandler<[OpenSharedContainerRequest], SharedContainerReplicaState>(
    IPC_CHANNELS.sharedContainersOpen,
    async (_event, request) => openSharedContainerViewer(request, false),
  );

  registerIpcHandler<[SharedContainerForkRequest], SharedContainerForkResult>(
    IPC_CHANNELS.sharedContainersFork,
    async (event, request) => {
      assertSharedContainersEnabled();
      validateId(request.containerId, 'containerId');
      validateId(request.revisionId, 'revisionId');
      validateOptionalOrganizationId(request.organizationId);
      if (
        typeof request.sourceOwnerDisplayName !== 'string' ||
        !request.sourceOwnerDisplayName.trim() ||
        request.sourceOwnerDisplayName.length > 256
      ) {
        throw new Error('Invalid sourceOwnerDisplayName');
      }
      if (
        request.expectedPackageDigest !== undefined &&
        !isCapabilityPackageDigest(request.expectedPackageDigest)
      ) {
        throw new Error('Invalid fork expectedPackageDigest');
      }
      try {
        const destination = validateForkDestination(request.destination);
        if (!(await isSharedContainerAccepted(request.containerId))) {
          throw forkSourceNotAccepted();
        }
        const command = {
          ...request,
          destination,
          sourceOwnerDisplayName: request.sourceOwnerDisplayName.trim(),
        };
        return await projectedSourceCompositionCommands({
          dispatcher: runtime.dispatcher,
          caller: runtime.resolveCaller(event),
        }).fork(command, () => forkSharedContainer(command));
      } catch (error) {
        if (error instanceof SharedContainerForkError) {
          return { ok: false, code: error.code, message: error.message };
        }
        throw error;
      }
    },
  );

  registerIpcHandler<
    [ReadSharedContainerForkProvenanceRequest],
    SharedContainerForkProvenance | null
  >(
    IPC_CHANNELS.sharedContainersReadForkProvenance,
    async (_event, request) => {
      assertSharedContainersEnabled();
      validateId(request.projectId, 'projectId');
      validateId(request.worktreeId, 'worktreeId');
      return readSharedContainerForkProvenance(
        getSharedContainerForkProvenancePath(
          request.projectId,
          request.worktreeId,
        ),
      );
    },
  );

  registerIpcHandler<
    [GetSharedContainerReplicaStateRequest],
    SharedContainerReplicaState | null
  >(IPC_CHANNELS.sharedContainersReplicaState, async (_event, request) => {
    assertSharedContainersEnabled();
    validateId(request.containerId, 'containerId');
    return reconciliation.getState(request.containerId);
  });

  registerIpcHandler<
    [SharedContainerRecipientRequest],
    DismissSharedContainerResponse
  >(IPC_CHANNELS.sharedContainersDismiss, async (_event, request) => {
    assertSharedContainersEnabled();
    validateId(request.containerId, 'containerId');
    validateOptionalOrganizationId(request.organizationId);
    const response = await withSharedContainerRunLifecycle(
      request.containerId,
      async (): Promise<DismissSharedContainerResponse> => {
        await stopSharedContainerProcesses(request.containerId);
        await reconciliation.dismiss(
          request.containerId,
          request.organizationId,
        );
        await forgetSharedContainerAcceptance(request.containerId);
        await removeSharedContainerRunEnvironment(request.containerId);
        return { dismissed: true };
      },
    );
    // Every section re-lists its removed shares, not just the one that asked.
    getSharedContainerInboxWatcher().signalLocalChange();
    return response;
  });

  registerIpcHandler<
    [ListDismissedSharedContainersRequest],
    ListDismissedSharedContainersResult
  >(IPC_CHANNELS.sharedContainersListDismissed, async (_event, request) => {
    assertSharedContainersEnabled();
    validateOptionalOrganizationId(request.organizationId);
    try {
      return await listDismissedSharedContainers({
        ...(request.organizationId !== undefined
          ? { organizationId: request.organizationId }
          : {}),
        ...(request.cursor ? { cursor: request.cursor } : {}),
        // The route rejects an over-large page with a 400 instead of clamping.
        ...(request.limit !== undefined
          ? {
              limit: clampOwnedTargetPageBound(
                request.limit,
                MAX_SHARED_CONTAINER_LIST_LIMIT,
                MAX_SHARED_CONTAINER_LIST_LIMIT,
              ),
            }
          : {}),
      });
    } catch (error) {
      // Data, not a rejection: the renderer must tell "cannot restore here"
      // from a failed load, and an IPC rejection carries only a message.
      if (isDismissalsUnsupported(error)) return { unsupported: true };
      throw error;
    }
  });

  registerIpcHandler<
    [SharedContainerRecipientRequest],
    RestoreSharedContainerResult
  >(IPC_CHANNELS.sharedContainersRestore, async (_event, request) => {
    assertSharedContainersEnabled();
    validateId(request.containerId, 'containerId');
    validateOptionalOrganizationId(request.organizationId);
    try {
      const { container } = await restoreSharedContainer(
        request.containerId,
        request.organizationId,
      );
      // The restored share is a pending invitation again; acceptance stays a
      // separate, per-device decision.
      getSharedContainerInboxWatcher().signalLocalChange();
      return { restored: true, container };
    } catch (error) {
      if (isDismissalsUnsupported(error)) {
        return { restored: false, reason: 'unsupported' };
      }
      // The owner revoked the removed share, or it is no longer shared with
      // this account. The server answers both the same way, on purpose.
      if (
        error instanceof CanopyCloudClientError &&
        error.status === 404 &&
        error.serverCode === SHARED_CONTAINER_DISMISSAL_NOT_FOUND_ERROR_CODE
      ) {
        return { restored: false, reason: 'not-restorable' };
      }
      throw error;
    }
  });

  registerIpcHandler<[OpenSharedContainerRequest], SharedContainerReplicaState>(
    IPC_CHANNELS.sharedContainersRetry,
    // A retry reuses the session of the viewer it retries.
    async (_event, request) => openSharedContainerViewer(request, true),
  );

  registerIpcHandler<[CloseSharedContainerRequest], void>(
    IPC_CHANNELS.sharedContainersClose,
    async (_event, request) => {
      // Deliberately available while the feature flag is off: close is a
      // cleanup path that must always be able to release subscriptions.
      const { containerId, viewerSessionId } = request;
      validateId(containerId, 'containerId');
      validateOptionalViewerSessionId(viewerSessionId);
      await withSharedContainerRunLifecycle(containerId, async () => {
        // This close may have waited behind the lifecycle lock long enough for
        // the same share to be opened again. Its terminals and scripts then
        // belong to the session on screen, so a superseded close stops nothing.
        const superseded =
          viewerSessionId !== undefined &&
          reconciliation.isViewerSessionSuperseded(
            containerId,
            viewerSessionId,
          );
        if (!superseded) {
          await stopSharedContainerProcesses(containerId);
        }
        // Always forwarded: the service re-checks supersession itself, which
        // covers a newer open arriving while the processes were stopping, and
        // it owns the diagnostic for an ignored close.
        await (viewerSessionId === undefined
          ? reconciliation.close(containerId)
          : reconciliation.close(containerId, viewerSessionId));
      });
    },
  );

  const validateRevisionRequest = (request: {
    containerId: string;
    revisionId: string;
  }): void => {
    assertSharedContainersEnabled();
    validateId(request.containerId, 'containerId');
    validateId(request.revisionId, 'revisionId');
  };

  registerIpcHandler<[SharedContainerContentListRequest], unknown>(
    IPC_CHANNELS.sharedContainersListChats,
    async (_event, request) => {
      validateRevisionRequest(request);
      return reader.listChats(request);
    },
  );
  registerIpcHandler<[ReadSharedContainerChatRequest], unknown>(
    IPC_CHANNELS.sharedContainersReadChat,
    async (_event, request) => {
      validateRevisionRequest(request);
      return reader.readChat(request);
    },
  );
  registerIpcHandler<[SharedContainerContentListRequest], unknown>(
    IPC_CHANNELS.sharedContainersListPlans,
    async (_event, request) => {
      validateRevisionRequest(request);
      return reader.listPlans(request);
    },
  );
  registerIpcHandler<[ReadSharedContainerPlanRequest], unknown>(
    IPC_CHANNELS.sharedContainersReadPlan,
    async (_event, request) => {
      validateRevisionRequest(request);
      return reader.readPlan(request);
    },
  );
  registerIpcHandler<[SharedContainerContentListRequest], unknown>(
    IPC_CHANNELS.sharedContainersListNotes,
    async (_event, request) => {
      validateRevisionRequest(request);
      return reader.listNotes(request);
    },
  );
  registerIpcHandler<[ReadSharedContainerWorkspaceItemRequest], string>(
    IPC_CHANNELS.sharedContainersReadNote,
    async (_event, request) => {
      validateRevisionRequest(request);
      return reader.readNote(request);
    },
  );
  registerIpcHandler<[SharedContainerContentListRequest], unknown>(
    IPC_CHANNELS.sharedContainersListPrompts,
    async (_event, request) => {
      validateRevisionRequest(request);
      return reader.listPrompts(request);
    },
  );
  registerIpcHandler<[ReadSharedContainerWorkspaceItemRequest], string>(
    IPC_CHANNELS.sharedContainersReadPrompt,
    async (_event, request) => {
      validateRevisionRequest(request);
      return reader.readPrompt(request);
    },
  );
  registerIpcHandler<[SharedContainerContentListRequest], unknown>(
    IPC_CHANNELS.sharedContainersListAttachments,
    async (_event, request) => {
      validateRevisionRequest(request);
      return reader.listAttachments(request);
    },
  );
  registerIpcHandler<[ReadSharedContainerAttachmentRequest], unknown>(
    IPC_CHANNELS.sharedContainersReadAttachment,
    async (_event, request) => {
      validateRevisionRequest(request);
      return reader.readAttachment(request);
    },
  );
  registerIpcHandler<[SharedContainerRevisionRequest], unknown>(
    IPC_CHANNELS.sharedContainersReadRevisionMetadata,
    async (_event, request) => {
      validateRevisionRequest(request);
      return reader.readRevisionMetadata(request);
    },
  );
  registerIpcHandler<[SharedContainerRevisionRequest], unknown>(
    IPC_CHANNELS.sharedContainersListRepositories,
    async (_event, request) => {
      validateRevisionRequest(request);
      return reader.listRepositories(request);
    },
  );
  registerIpcHandler<[ListSharedContainerRepositoryTreeRequest], unknown>(
    IPC_CHANNELS.sharedContainersListRepositoryTree,
    async (_event, request) => {
      validateRevisionRequest(request);
      return reader.listRepositoryTree(request);
    },
  );
  registerIpcHandler<[ReadSharedContainerOverlayDiffRequest], unknown>(
    IPC_CHANNELS.sharedContainersReadOverlayDiff,
    async (_event, request) => {
      validateRevisionRequest(request);
      return reader.readOverlayDiff(request);
    },
  );
}

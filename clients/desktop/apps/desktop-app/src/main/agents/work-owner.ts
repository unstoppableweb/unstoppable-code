// Work-owner resolution for model traffic (CAN-3456).
//
// Every routed model request carries the owner of the work: Personal, or one
// organization. The owner is bound once, when the work starts (a chat session,
// a pipeline step, a helper invocation), and never follows the live sidebar
// selection afterwards. It is additive attribution today: the proxy records the
// claim but no billing or policy decision reads it yet.

import type { WorkOwner } from '@canopy/protocol/llm-gateway';
import {
  parseWorkspaceContext,
  type WorkspaceContext,
} from '@canopy/protocol/workspace-context';
import {
  type AiCreditsScopeRequest,
  APP_ADVISOR_PROJECT_ID,
  STANDALONE_CHAT_PROJECT_ID,
} from '@canopy/desktop-shared/types';
import { getWorkspaceContextService } from '../lib/workspace-context-service';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { getFeatureFlagService } from '../feature-flags';
import type {
  BackgroundWorkspaceTarget,
  WorkspaceOwnerManifestRead,
} from '../services/workspace-owner-projection';

/** Request-local manifest evidence, never a cache for execution/authorization. */
export type SnapshotWorkOwnerEvidence = ReadonlyMap<
  string,
  WorkspaceOwnerManifestRead
>;

const PERSONAL_WORK_OWNER: WorkOwner = { kind: 'personal' };

export function resolveEnforcementOwner(
  owner: WorkOwner | undefined,
): WorkOwner | undefined {
  try {
    return getFeatureFlagService().isEnabled(
      CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key,
    )
      ? owner
      : undefined;
  } catch {
    return undefined;
  }
}

export function shouldRecordUnknownEnforcementOwner(
  owner: WorkOwner | undefined,
): boolean {
  if (owner !== undefined) return false;
  try {
    return getFeatureFlagService().isEnabled(
      CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key,
    );
  } catch {
    return false;
  }
}

/** Where the work runs. An absent project is work outside any workspace. */
export interface WorkOwnerTarget {
  projectId?: string;
  worktreeId?: string;
}

/**
 * Resolve the owner of work in `target`, given the context captured when that
 * work started (Decision D1 of CAN-3455):
 *
 * - App Advisor and work outside a workspace: Personal.
 * - An organization-owned workspace, Cowork included: that organization
 *   (CAN-3462; CAN-3456 treated every Cowork project as Personal). A member
 *   who has left the organization is refused by the proxy there.
 * - A Personal single-repo workspace linked to the captured organization: that
 *   organization.
 * - Any other Personal workspace, Personal Cowork included: Personal.
 *
 * A legacy standalone chat (`STANDALONE_CHAT_PROJECT_ID` with the Cowork
 * workspace, or its legacy chat-project id, in the worktree slot) resolves
 * through that Cowork workspace; without a worktree id it is Personal.
 *
 * Reads persisted owner authority only. Throws when that authority is
 * unreadable, so callers can omit the claim rather than guess.
 */
export function resolveWorkOwner(
  target: WorkOwnerTarget,
  capturedContext: WorkspaceContext,
): Promise<WorkOwner> {
  return resolveWorkOwnerWithEvidence(target, capturedContext);
}

async function resolveWorkOwnerWithEvidence(
  target: WorkOwnerTarget,
  capturedContext: WorkspaceContext,
  snapshotEvidence?: SnapshotWorkOwnerEvidence,
): Promise<WorkOwner> {
  const { projectId, worktreeId } = target;
  if (
    !projectId ||
    projectId === APP_ADVISOR_PROJECT_ID ||
    (projectId === STANDALONE_CHAT_PROJECT_ID && !worktreeId)
  ) {
    return PERSONAL_WORK_OWNER;
  }
  // Deferred: the background-execution graph is only needed once a routed
  // request actually resolves an owner, not whenever routing is imported.
  const persisted = snapshotEvidence
    ? await projectSnapshotWorkspaceTarget(
        projectId,
        worktreeId,
        snapshotEvidence,
      )
    : await import('../services/background-execution-context').then(
        ({ resolveBackgroundWorkspaceTarget }) =>
          resolveBackgroundWorkspaceTarget(projectId, worktreeId),
      );
  if (persisted.workspaceOwner.kind === 'organization') {
    return {
      kind: 'organization',
      organizationId: persisted.workspaceOwner.organizationId,
    };
  }
  if (
    capturedContext.kind !== 'organization' ||
    !persisted.linkedPersonalCandidate
  ) {
    return PERSONAL_WORK_OWNER;
  }
  // Deferred for the same reason: links pull in the organization catalog.
  const { resolveWorkspaceTarget } =
    await import('../services/workspace-target');
  const linked = await resolveWorkspaceTarget(projectId, {
    workspaceOwner: persisted.workspaceOwner,
    linkedPersonalCandidate: persisted.linkedPersonalCandidate,
    organizationId: capturedContext.organizationId,
  });
  return linked.linkedOrganizationIds.includes(capturedContext.organizationId)
    ? { kind: 'organization', organizationId: capturedContext.organizationId }
    : PERSONAL_WORK_OWNER;
}

async function projectSnapshotWorkspaceTarget(
  projectId: string,
  worktreeId: string | undefined,
  evidence: SnapshotWorkOwnerEvidence,
): Promise<BackgroundWorkspaceTarget> {
  const { projectBackgroundWorkspaceTarget } =
    await import('../services/workspace-owner-projection');
  const { resolveCoworkWorkspaceId } =
    await import('../lib/cowork-migration-map');
  const workspaceId =
    projectId === STANDALONE_CHAT_PROJECT_ID && worktreeId
      ? resolveCoworkWorkspaceId(worktreeId)
      : projectId;
  return projectBackgroundWorkspaceTarget(evidence.get(workspaceId));
}

/**
 * {@link resolveWorkOwner}, returning `undefined` when owner authority cannot
 * be read. The request then goes out without a claim and the proxy records it
 * as missing; attribution must never fail a spawn.
 */
async function resolveWorkOwnerOrOmit(
  target: WorkOwnerTarget,
  capturedContext: WorkspaceContext,
  snapshotEvidence?: SnapshotWorkOwnerEvidence,
): Promise<WorkOwner | undefined> {
  try {
    return await resolveWorkOwnerWithEvidence(
      target,
      capturedContext,
      snapshotEvidence,
    );
  } catch {
    return undefined;
  }
}

/**
 * The live navigation context, read once. When organization projects are off
 * the service projects Personal, so the owner resolves to Personal.
 */
async function captureNavigationContext(): Promise<WorkspaceContext> {
  const service = getWorkspaceContextService();
  await service.initialize();
  await service.whenIdle();
  return service.getState().context;
}

/**
 * Owner of background work (pipeline steps, automations, hooks), captured by
 * the run's persisted `execution_context`. A run without one (flag off when it
 * started, a CLI run, or a run from before capture existed) is resolved in the
 * Personal context, matching `authorizeBackgroundExecution`. A malformed value
 * omits the claim.
 */
export async function resolveBackgroundWorkOwner(
  target: WorkOwnerTarget,
  executionContext: string | undefined,
): Promise<WorkOwner | undefined> {
  const context: WorkspaceContext | null =
    executionContext === undefined
      ? { kind: 'personal' }
      : parseWorkspaceContext(executionContext);
  if (!context) return undefined;
  return resolveWorkOwnerOrOmit(target, context);
}

/**
 * Owner of a one-shot invocation (helpers), captured from the navigation
 * context at the moment the invocation starts.
 */
export async function resolveInvocationWorkOwner(
  target: WorkOwnerTarget,
): Promise<WorkOwner | undefined> {
  const context = await snapshotNavigationContext();
  if (!context) return undefined;
  return resolveWorkOwnerOrOmit(target, context);
}

/** The chat session a capture belongs to. */
export interface WorkOwnerSession {
  projectId: string;
  worktreeId: string;
  chatId: string;
  /** Persisted background-run context; absent for interactive sessions. */
  executionContext?: string;
}

function sessionCaptureKey(session: WorkOwnerSession): string {
  return JSON.stringify([
    session.projectId,
    session.worktreeId,
    session.chatId,
  ]);
}

interface SessionWorkOwnerCapture {
  /** Explicit background context that created this provider session. */
  readonly executionContext?: string;
  /** Owner authority resolved once at session start, including omission. */
  readonly owner: Promise<WorkOwner | undefined>;
}

/**
 * Captures keyed by chat session (project, worktree, chat). The navigation context is read when a
 * session first starts and kept for the life of the app. Ordinary provider
 * respawns never re-read the sidebar selection; a later background run with a
 * different persisted execution context replaces the binding.
 */
const sessionCaptures = new Map<string, SessionWorkOwnerCapture>();

/**
 * Bind a chat session to the navigation context current right now. Cheap and
 * synchronous for the caller; the first call for an interactive session wins.
 * A newly created background session can replace it only when its persisted
 * execution context differs. Call it when the provider session is created.
 */
export function captureSessionWorkOwner(session: WorkOwnerSession): void {
  const key = sessionCaptureKey(session);
  const existing = sessionCaptures.get(key);
  if (
    existing &&
    (session.executionContext === undefined ||
      existing.executionContext === session.executionContext)
  ) {
    return;
  }
  const target = {
    projectId: session.projectId,
    worktreeId: session.worktreeId,
  };
  const context =
    session.executionContext === undefined
      ? snapshotNavigationContext()
      : Promise.resolve(parseWorkspaceContext(session.executionContext));
  sessionCaptures.set(key, {
    executionContext: session.executionContext,
    owner: context.then((capturedContext) =>
      capturedContext
        ? resolveWorkOwnerOrOmit(target, capturedContext)
        : undefined,
    ),
  });
}

/**
 * Read the selection synchronously, so a switch made after the session starts
 * can never land in its capture. The service initializes at app startup; only
 * if reading its state fails does this wait for it to settle.
 */
function snapshotNavigationContext(): Promise<WorkspaceContext | null> {
  try {
    return Promise.resolve(getWorkspaceContextService().getState().context);
  } catch {
    return captureNavigationContext().catch(() => null);
  }
}

/**
 * The owner bound to a chat session, for its own routed requests and for work
 * it spawns (delegation children inherit it). `undefined` when no session with
 * that key was captured or its owner authority was unreadable when the session
 * started.
 */
export async function resolveSessionWorkOwner(
  session: WorkOwnerSession,
): Promise<WorkOwner | undefined> {
  const capture = sessionCaptures.get(sessionCaptureKey(session));
  if (!capture) return undefined;
  return capture.owner;
}

/** Read a captured session owner without creating or replacing a capture. */
export async function peekSessionWorkOwner(
  session: WorkOwnerSession,
): Promise<WorkOwner | undefined> {
  return resolveSessionWorkOwner(session);
}

/** Owner represented by the live navigation context. */
export async function resolveNavigationWorkOwner(): Promise<
  WorkOwner | undefined
> {
  const context = await snapshotNavigationContext();
  if (!context) return undefined;
  return context.kind === 'organization'
    ? { kind: 'organization', organizationId: context.organizationId }
    : PERSONAL_WORK_OWNER;
}

/** Resolve an IPC availability scope without mutating session attribution. */
export async function resolveAiCreditsScopeOwner(
  scope: AiCreditsScopeRequest | undefined,
): Promise<WorkOwner | undefined> {
  if (!scope || scope.kind === 'navigation') {
    return resolveNavigationWorkOwner();
  }
  if (scope.chatId && scope.worktreeId) {
    const captured = await peekSessionWorkOwner({
      projectId: scope.projectId,
      worktreeId: scope.worktreeId,
      chatId: scope.chatId,
    });
    if (captured) return captured;
  }
  const context = await snapshotNavigationContext();
  return context
    ? resolveWorkOwnerOrOmit(
        { projectId: scope.projectId, worktreeId: scope.worktreeId },
        context,
      )
    : undefined;
}

/**
 * {@link resolveAiCreditsScopeOwner} for one listing of many chats. Session
 * captures stay per chat; the fallback reads the navigation context once and
 * owner authority once per target. That authority depends on the project
 * alone, except for a legacy standalone chat, whose worktree slot names its
 * Cowork workspace.
 */
export function createAiCreditsScopeOwnerResolver(
  snapshotEvidence?: SnapshotWorkOwnerEvidence,
): (scope: AiCreditsScopeRequest) => Promise<WorkOwner | undefined> {
  let context: Promise<WorkspaceContext | null> | undefined;
  const fallbacks = new Map<string, Promise<WorkOwner | undefined>>();
  return async (scope): Promise<WorkOwner | undefined> => {
    if (scope.kind === 'navigation') return resolveNavigationWorkOwner();
    if (scope.chatId && scope.worktreeId) {
      const captured = await peekSessionWorkOwner({
        projectId: scope.projectId,
        worktreeId: scope.worktreeId,
        chatId: scope.chatId,
      });
      if (captured) return captured;
    }
    const target: WorkOwnerTarget = {
      projectId: scope.projectId,
      worktreeId: scope.worktreeId,
    };
    const key = JSON.stringify(
      scope.projectId === STANDALONE_CHAT_PROJECT_ID
        ? [scope.projectId, scope.worktreeId ?? null]
        : [scope.projectId],
    );
    let owner = fallbacks.get(key);
    if (!owner) {
      context ??= snapshotNavigationContext();
      owner = context.then((captured) =>
        captured
          ? resolveWorkOwnerOrOmit(target, captured, snapshotEvidence)
          : undefined,
      );
      fallbacks.set(key, owner);
    }
    return owner;
  };
}

export function __resetSessionWorkOwnersForTests(): void {
  sessionCaptures.clear();
}

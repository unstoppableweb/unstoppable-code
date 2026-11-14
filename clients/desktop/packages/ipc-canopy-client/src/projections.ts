/**
 * Pure mappings between the neutral Portal payloads `CanopyClient` speaks and
 * the desktop IPC request/reply shapes. Moved unchanged from the desktop
 * renderer adapter; each mirrors the main-process service named beside it so
 * every transport projects the same way.
 */
import { isThinkingLevel } from '@canopy/protocol/thinking';
import type {
  PortalHookRunPayload,
  PortalPipelineRunPayload,
  PortalPlanDetail,
  PortalPlanUpdatePayload,
  PortalScriptRunPayload,
} from '@canopy/protocol/portal';
import type {
  WireAgentModelConfig,
  WireHookRunRequest,
  WireScriptRunRequest,
  WireTrackedPlan,
  WireTrackedPlanReviewStatus,
  WireTrackedPlanSource,
  WireUpdateTrackedPlanRequest,
} from './wire';

/** `ActivitySectionId`: unknown wire ids are dropped, never persisted. */
const ACTIVITY_SECTION_IDS: ReadonlySet<string> = new Set([
  'plugins',
  'summary',
  'changed-files',
  'pull-request',
  'background-processes',
  'plans',
  'pipeline-runs',
  'cost',
  'scripts',
  'hooks',
  'terminals',
  'todo',
  'mcp-servers',
  'memory',
  'notes',
  'prompts',
  'attachments',
]);

export function isActivitySectionId(value: string): boolean {
  return ACTIVITY_SECTION_IDS.has(value);
}

const TRACKED_PLAN_SOURCES: readonly WireTrackedPlanSource[] = [
  'copilot',
  'antigravity',
  'opencode',
  'cursor',
  'claude',
  'codex',
  'ollama',
  'pipeline',
  'imported',
  'detected',
];

const TRACKED_PLAN_REVIEW_STATUSES: readonly WireTrackedPlanReviewStatus[] = [
  'pending',
  'approved',
  'dismissed',
];

function trackedPlanSource(value: string): WireTrackedPlanSource | undefined {
  return TRACKED_PLAN_SOURCES.find((source) => source === value);
}

function trackedPlanReviewStatus(
  value: string,
): WireTrackedPlanReviewStatus | undefined {
  return TRACKED_PLAN_REVIEW_STATUSES.find((status) => status === value);
}

/**
 * Mirror of the main-process `languageForPath` helper in `files-service.ts`:
 * the lowercase file extension (dotfiles like `.gitignore` have none).
 */
export function languageForPath(pathValue: string): string | undefined {
  const basename = pathValue.split('/').pop() ?? pathValue;
  const dotIndex = basename.lastIndexOf('.');
  if (dotIndex <= 0) {
    return undefined;
  }
  const extension = basename.slice(dotIndex + 1).toLowerCase();
  return extension || undefined;
}

/** Mirror of the main-process `versionFromStat` save-conflict cookie. */
export function versionFrom(sizeBytes: number, modifiedAtMs: number): string {
  return `${Number(sizeBytes)}:${Math.round(Number(modifiedAtMs))}`;
}

/** The path's segments as {@link joinRootPath} joins them; `..` is rejected. */
export function rootRelativeSegments(
  relativePath: string,
  rootAbsolutePath: string,
): string[] {
  const windowsRoot =
    /^[a-z]:[\\/]/i.test(rootAbsolutePath) ||
    rootAbsolutePath.startsWith('\\\\') ||
    rootAbsolutePath.startsWith('//');
  const segments = relativePath
    .split(windowsRoot ? /[\\/]+/ : /\/+/)
    .filter((segment) => segment.length > 0 && segment !== '.');
  if (segments.some((segment) => segment === '..')) {
    throw new Error(
      `Relative path "${relativePath}" escapes the file root and was rejected.`,
    );
  }
  return segments;
}

/**
 * Join a file-root absolute path with a root-relative path, rejecting
 * traversal segments — mirroring the main-process `normalizeRelativePath`
 * rejection. Writes are additionally contained main-side.
 */
export function joinRootPath(
  rootAbsolutePath: string,
  relativePath: string,
): string {
  if (!relativePath) {
    return rootAbsolutePath;
  }
  const root = rootAbsolutePath.replace(/[\\/]+$/, '');
  return `${root}/${rootRelativeSegments(relativePath, rootAbsolutePath).join('/')}`;
}

/**
 * Narrow the portal script-run payload onto the desktop `ScriptRunRequest`
 * union, throwing when the target's routing ids are missing.
 */
export function toScriptRunRequest(
  args: PortalScriptRunPayload,
): WireScriptRunRequest {
  if (args.target === 'project') {
    const projectId = args.projectId ?? args.workspaceId;
    const worktreeId = args.worktreeId;
    if (!projectId || !worktreeId) {
      throw new Error(
        'script.run requires projectId and worktreeId for project-target scripts.',
      );
    }
    return {
      target: 'project',
      scriptName: args.scriptName,
      projectId,
      worktreeId,
    };
  }
  const workspaceId = args.workspaceId ?? args.projectId;
  const worktreeId = args.worktreeId;
  if (!workspaceId || !worktreeId) {
    throw new Error(
      'script.run requires workspaceId and worktreeId for workspace-target scripts.',
    );
  }
  if (args.target === 'workspace-repo') {
    if (!args.repoId) {
      throw new Error(
        'script.run requires repoId for workspace-repo-target scripts.',
      );
    }
    return {
      target: 'workspace-repo',
      scriptName: args.scriptName,
      workspaceId,
      worktreeId,
      repoId: args.repoId,
    };
  }
  return {
    target: 'workspace-root',
    scriptName: args.scriptName,
    workspaceId,
    worktreeId,
  };
}

/** Same narrowing as {@link toScriptRunRequest} for the hook-run union. */
export function toHookRunRequest(
  args: PortalHookRunPayload,
): WireHookRunRequest {
  if (args.target === 'project') {
    const projectId = args.projectId ?? args.workspaceId;
    const worktreeId = args.worktreeId;
    if (!projectId || !worktreeId) {
      throw new Error(
        'hook.run requires projectId and worktreeId for project-target hooks.',
      );
    }
    return {
      target: 'project',
      triggerName: args.triggerName,
      projectId,
      worktreeId,
    };
  }
  const workspaceId = args.workspaceId ?? args.projectId;
  const worktreeId = args.worktreeId;
  if (!workspaceId || !worktreeId) {
    throw new Error(
      'hook.run requires workspaceId and worktreeId for workspace-target hooks.',
    );
  }
  if (args.target === 'workspace-repo') {
    if (!args.repoId) {
      throw new Error(
        'hook.run requires repoId for workspace-repo-target hooks.',
      );
    }
    return {
      target: 'workspace-repo',
      triggerName: args.triggerName,
      workspaceId,
      worktreeId,
      repoId: args.repoId,
    };
  }
  return {
    target: 'workspace-root',
    triggerName: args.triggerName,
    workspaceId,
    worktreeId,
  };
}

/**
 * Mirror of the pipelines-service `normalizePortalModelConfig`: fold the
 * portal model config (plus the deprecated `codexFastModeEnabled`) into the
 * desktop `AgentModelConfig`, or `undefined` when nothing is set.
 */
export function toAgentModelConfig(
  args: PortalPipelineRunPayload,
): WireAgentModelConfig | undefined {
  const modelConfig: WireAgentModelConfig = {};
  if (isThinkingLevel(args.modelConfig?.thinkingLevel)) {
    modelConfig.thinkingLevel = args.modelConfig.thinkingLevel;
  }
  if (args.modelConfig?.speed !== undefined) {
    modelConfig.speed = args.modelConfig.speed;
    modelConfig.fastMode =
      args.modelConfig.fastMode ?? args.modelConfig.speed === 'fast';
  } else if (typeof args.modelConfig?.fastMode === 'boolean') {
    modelConfig.fastMode = args.modelConfig.fastMode;
  } else if (typeof args.codexFastModeEnabled === 'boolean') {
    modelConfig.fastMode = args.codexFastModeEnabled;
  }
  return Object.keys(modelConfig).length > 0 ? modelConfig : undefined;
}

/**
 * Mirror of the plans-service `toPlanDetail` projection (`content`
 * canonical, `body` retained for legacy consumers).
 */
export function toPortalPlanDetail(plan: WireTrackedPlan): PortalPlanDetail {
  return {
    workspaceLocalId: plan.projectId,
    worktreeLocalId: plan.worktreeId,
    planId: plan.id,
    title: plan.title,
    status: plan.reviewStatus,
    source: plan.source,
    updatedAt: plan.updatedAt,
    content: plan.content,
    body: plan.content,
    reviewStatus: plan.reviewStatus,
    approvedAt: plan.approvedAt ?? null,
    dismissedAt: plan.dismissedAt ?? null,
    hidden: plan.hidden,
    latestRevisionNumber: plan.latestRevisionNumber,
    revisionNumber: plan.latestRevisionNumber,
  };
}

/**
 * Mirror of the plans-service `toRequestedPlanDetail`: a pinned
 * `revisionNumber` returns that revision or `null`, never the latest in its
 * place (CAN-5354).
 */
export function toRequestedPortalPlanDetail(
  plan: WireTrackedPlan,
  revisionNumber: number | undefined,
): PortalPlanDetail | null {
  const detail = toPortalPlanDetail(plan);
  if (
    revisionNumber === undefined ||
    revisionNumber === plan.latestRevisionNumber
  ) {
    return detail;
  }
  const revision = plan.revisions.find(
    (candidate) => candidate.revisionNumber === revisionNumber,
  );
  if (!revision) return null;
  return {
    ...detail,
    content: revision.content,
    body: revision.content,
    revisionNumber: revision.revisionNumber,
    source: revision.source,
    status: revision.reviewStatus,
    reviewStatus: revision.reviewStatus,
    approvedAt: revision.approvedAt ?? null,
    dismissedAt: revision.dismissedAt ?? null,
  };
}

/**
 * Narrow the wire `plan.update` payload onto the desktop
 * `UpdateTrackedPlanRequest`; unknown `source` / `reviewStatus` values fail
 * loudly instead of corrupting the persisted plan.
 */
export function toUpdateTrackedPlanRequest(
  args: PortalPlanUpdatePayload,
): WireUpdateTrackedPlanRequest {
  const request: WireUpdateTrackedPlanRequest = {
    projectId: args.projectId,
    worktreeId: args.worktreeId,
    planId: args.planId,
    ...(args.content !== undefined ? { content: args.content } : {}),
    ...(args.title !== undefined ? { title: args.title } : {}),
    ...(args.linkedExecutionId !== undefined
      ? { linkedExecutionId: args.linkedExecutionId }
      : {}),
    ...(args.approvedAt !== undefined ? { approvedAt: args.approvedAt } : {}),
    ...(args.dismissedAt !== undefined
      ? { dismissedAt: args.dismissedAt }
      : {}),
    ...(args.hidden !== undefined ? { hidden: args.hidden } : {}),
  };
  if (args.source !== undefined) {
    const source = trackedPlanSource(args.source);
    if (source === undefined) {
      throw new Error(`Unknown plan source "${args.source}".`);
    }
    request.source = source;
  }
  if (args.reviewStatus !== undefined) {
    const reviewStatus = trackedPlanReviewStatus(args.reviewStatus);
    if (reviewStatus === undefined) {
      throw new Error(`Unknown plan review status "${args.reviewStatus}".`);
    }
    request.reviewStatus = reviewStatus;
  }
  return request;
}

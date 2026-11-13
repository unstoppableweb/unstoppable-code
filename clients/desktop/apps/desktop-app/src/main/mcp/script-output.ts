import {
  WORKSPACE_ROOT_REPO_ID,
  type ScriptStartedEvent,
} from '@canopy/desktop-shared/types';
import {
  createScriptKey,
  parseScriptKey,
} from '@canopy/desktop-shared/scripts';
import {
  WORKER_SCRIPT_GRANTS,
  type CanopyCallerDescriptor,
} from '@canopy/protocol/canopy-core';
import { activeAgentCoreOperations } from '../canopy-tools/active-agent-core-operations';
import { LOCAL_DESKTOP_AUTHORITY_ID } from '../canopy-runtime/desktop-runtime-identity';
import { readWorkspaceConfig } from '../lib/workspace-persistence';
import { getWorkspaceType, isCoworkWorkspace } from '../lib/workspace-registry';

/** GetScriptOutput reads runs as its own principal, with only the read grant (CAN-5825). */
const AGENT_SCRIPT_OUTPUT_CALLER: CanopyCallerDescriptor = {
  principalId: 'desktop-agent-script-output',
  clientInstanceId: 'desktop-main',
  authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
  interfaceKind: 'mcp',
  grants: [WORKER_SCRIPT_GRANTS.read],
};

const DEFAULT_MAX_LINES = 1000;
const MAX_ALLOWED_LINES = 2000;
const CANONICAL_SCRIPT_KEY_PREFIXES = [
  'project:',
  'workspace-root:',
  'workspace-repo:',
];

export interface ScriptOutputSnapshot {
  found: boolean;
  scriptKey?: string;
  label?: string;
  invocation?: ScriptStartedEvent['invocation'];
  humanStatus?:
    | 'running'
    | 'succeeded'
    | 'failed'
    | 'timed out'
    | 'stopped'
    | 'interrupted';
  exitCode?: number | null;
  timedOut?: boolean;
  durationMs?: number;
  lines: string[];
  error?: string;
}

export async function loadScriptOutputSnapshot(args: {
  projectId: string;
  worktreeId?: string;
  scriptId: string;
  repo?: string;
  maxLines?: number;
}): Promise<ScriptOutputSnapshot> {
  if (
    isCoworkWorkspace(args.projectId) ||
    !args.worktreeId ||
    args.worktreeId.trim().length === 0
  ) {
    return {
      found: false,
      lines: [],
      error:
        'GetScriptOutput is only available for worktree chats, not standalone chats.',
    };
  }

  const scriptKeyResult = await resolveScriptKey({
    projectId: args.projectId,
    scriptId: args.scriptId,
    repo: args.repo,
  });
  if ('error' in scriptKeyResult) {
    return {
      found: false,
      lines: [],
      error: scriptKeyResult.error,
    };
  }

  const scriptKey = scriptKeyResult.scriptKey;
  const maxLines = Math.max(
    0,
    Math.min(
      Number.isFinite(args.maxLines) ? Math.floor(args.maxLines ?? 0) : 0,
      MAX_ALLOWED_LINES,
    ) || DEFAULT_MAX_LINES,
  );
  const { run } = await activeAgentCoreOperations('scriptOutput').query(
    'worker.script.execution.get',
    {
      scope: { workspaceId: args.projectId, worktreeId: args.worktreeId },
      scriptKey,
      tailLines: maxLines,
    },
    { caller: AGENT_SCRIPT_OUTPUT_CALLER },
  );

  if (!run) {
    return {
      found: false,
      scriptKey,
      lines: [],
      error: `No persisted output found for script "${scriptKey}" in this worktree.`,
    };
  }

  const { execution: meta, lines } = run;
  return {
    found: true,
    scriptKey,
    label: meta.script.label,
    invocation: meta.invocation,
    humanStatus: mapHumanStatus(meta),
    exitCode: meta.exitCode,
    timedOut: meta.timedOut,
    durationMs: meta.durationMs,
    lines,
  };
}

/**
 * Resolve a script name or canonical key plus an optional repo to the
 * canonical script key. Shared by GetScriptOutput and the worktree script
 * actions so both accept the same ids and give the same multi-repo guidance.
 */
export async function resolveScriptKey(args: {
  projectId: string;
  scriptId: string;
  repo?: string;
}): Promise<{ scriptKey: string } | { error: string }> {
  const parsed = parseScriptKey(args.scriptId);
  if (parsed) {
    return { scriptKey: args.scriptId };
  }

  if (
    CANONICAL_SCRIPT_KEY_PREFIXES.some((prefix) =>
      args.scriptId.startsWith(prefix),
    )
  ) {
    return {
      error: `Invalid scriptId "${args.scriptId}". Use a script name like "launch" or a canonical key like "workspace-repo:api:launch".`,
    };
  }

  const workspaceType = getWorkspaceType(args.projectId);
  if (workspaceType === null || workspaceType === 'single-repo') {
    return {
      scriptKey: createScriptKey('project', args.scriptId),
    };
  }

  if (/^(before|after)-/i.test(args.scriptId) && !args.repo) {
    return {
      scriptKey: createScriptKey('workspace-root', args.scriptId),
    };
  }

  if (!args.repo) {
    const config = await readWorkspaceConfig(args.projectId);
    const exampleRepoId = config.repos[0]?.id ?? 'repo-id';
    return {
      error: `Multi-repo script lookup requires repo. Try { "scriptId": "${args.scriptId}", "repo": "workspace-root" } or { "scriptId": "workspace-repo:${exampleRepoId}:${args.scriptId}" }.`,
    };
  }

  if (args.repo === 'workspace-root' || args.repo === WORKSPACE_ROOT_REPO_ID) {
    return {
      scriptKey: createScriptKey('workspace-root', args.scriptId),
    };
  }

  const config = await readWorkspaceConfig(args.projectId);
  const exactMatch = config.repos.find((repo) => repo.id === args.repo);
  if (exactMatch) {
    return {
      scriptKey: createScriptKey(
        'workspace-repo',
        args.scriptId,
        exactMatch.id,
      ),
    };
  }

  const lowerRepo = args.repo.toLowerCase();
  const nameMatches = config.repos.filter(
    (repo) => repo.name.toLowerCase() === lowerRepo,
  );
  if (nameMatches.length > 1) {
    return {
      error: `Multiple repos match name "${args.repo}": ${nameMatches.map((repo) => repo.id).join(', ')}. Use the repo id instead.`,
    };
  }
  if (nameMatches.length === 1) {
    return {
      scriptKey: createScriptKey(
        'workspace-repo',
        args.scriptId,
        nameMatches[0].id,
      ),
    };
  }

  return {
    error: `No repo matches "${args.repo}". Use "workspace-root", an exact repo id, or a unique repo name.`,
  };
}

export function mapHumanStatus(meta: {
  status: 'running' | 'success' | 'failed' | 'cancelled' | 'lost';
  timedOut: boolean;
  exitCode: number | null;
}): NonNullable<ScriptOutputSnapshot['humanStatus']> {
  if (meta.status === 'running') {
    return 'running';
  }
  // A restart interrupted the run; it was not run again.
  if (meta.status === 'lost') {
    return 'interrupted';
  }
  if (meta.status === 'success') {
    return 'succeeded';
  }
  if (meta.timedOut) {
    return 'timed out';
  }
  if (meta.status === 'cancelled') {
    return 'stopped';
  }
  if (meta.exitCode === null && meta.timedOut === false) {
    return 'stopped';
  }
  return 'failed';
}

import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { getCanopyDataDir } from '../../canopy-paths';
import { validateId } from './validation';

/** Native Google sessions share the owning workflow's artifact retention. */
export function getPipelineExecutionAntigravitySessionsDir(
  executionsDir: string,
  executionId: string,
): string {
  validateId(executionId, 'executionId');
  return path.resolve(
    executionsDir || path.join(getCanopyDataDir(), 'pipeline-executions'),
    executionId,
    'antigravity-sessions',
  );
}

/** Copilot conversations share the owning execution's artifact retention. */
export function getPipelineExecutionCopilotSessionsDir(
  executionsDir: string,
  executionId: string,
): string {
  validateId(executionId, 'executionId');
  return path.resolve(
    executionsDir || path.join(getCanopyDataDir(), 'pipeline-executions'),
    executionId,
    'copilot-sessions',
  );
}

/** OpenCode conversations share the owning execution's artifact retention. */
export function getPipelineExecutionOpenCodeSessionsDir(
  executionsDir: string,
  executionId: string,
): string {
  validateId(executionId, 'executionId');
  return path.resolve(
    executionsDir || path.join(getCanopyDataDir(), 'pipeline-executions'),
    executionId,
    'opencode-sessions',
  );
}

export function getPipelineExecutionPluginRuntimeDir(
  executionsDir: string,
  executionId: string,
  jobId: string,
  stepId: string,
  childId?: string,
): string {
  return path.join(
    executionsDir || path.join(getCanopyDataDir(), 'pipeline-executions'),
    executionId,
    'plugin-runtime',
    jobId,
    ...(childId ? [childId] : []),
    stepId,
  );
}

/**
 * Private CURSOR_DATA_DIR for one pipeline step. This is the legacy,
 * step-keyed fallback location: a `builtin/agent-resume` step should instead
 * resolve the profile that its `builtin/agent-prompt` counterpart actually
 * used via `getPipelineExecutionCursorSessionEntryPath` (keyed by ACP
 * session id, not by step id), and fall back to this path only when no
 * per-session entry file exists for that session.
 */
export function getPipelineExecutionCursorProfileDir(
  executionsDir: string,
  executionId: string,
  jobId: string,
  stepId: string,
  childId?: string,
): string {
  return path.join(
    executionsDir || path.join(getCanopyDataDir(), 'pipeline-executions'),
    executionId,
    'cursor-sessions',
    jobId,
    ...(childId ? [childId] : []),
    stepId,
  );
}

/**
 * Directory holding one durable entry file per Cursor ACP session for a
 * pipeline execution (see `getPipelineExecutionCursorSessionEntryPath`
 * below). A directory of independent per-session files — rather than one
 * shared index file — is deliberate: two Cursor steps in the same execution
 * (matrix children, parallel jobs) can finish concurrently, and a shared
 * JSON file's read-modify-write cycle silently drops entries under
 * concurrent writers. Per-session files make concurrent writes to
 * *different* sessions fully independent (each writes its own file); a
 * write to the *same* session id is last-write-wins, which is acceptable
 * since it is the same session's own data.
 */
export function getPipelineExecutionCursorSessionIndexDir(
  executionsDir: string,
  executionId: string,
): string {
  return path.join(
    executionsDir || path.join(getCanopyDataDir(), 'pipeline-executions'),
    executionId,
    'cursor-sessions',
    'index',
  );
}

/**
 * Durable per-session entry file path: `builtin/agent-prompt` writes it once
 * its fresh ACP session id is known (recording the profile dir the
 * conversation actually used); a later `builtin/agent-resume` step reads it
 * by `sessionId` to reuse that exact profile instead of its own (different)
 * step-keyed profile dir. The session id is hashed into the filename rather
 * than sanitized so no session id shape can escape the index directory or
 * collide with another session's file.
 */
export function getPipelineExecutionCursorSessionEntryPath(
  executionsDir: string,
  executionId: string,
  sessionId: string,
): string {
  const fileName = `${createHash('sha256').update(sessionId).digest('hex')}.json`;
  return path.join(
    getPipelineExecutionCursorSessionIndexDir(executionsDir, executionId),
    fileName,
  );
}

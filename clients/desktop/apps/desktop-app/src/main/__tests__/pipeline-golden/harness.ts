// CAN-5061 golden callers: thin drivers for the desktop IPC handlers and agent
// actions, so every golden reaches pipelines through the
// same entry point a real caller uses.
import { EventEmitter } from 'node:events';
import type { CanopyInjectedToolRuntime } from '../../canopy-tools/core';
import type { WorktreeActionRuntime } from '../../canopy-tools/worktree-actions';
import { GOLDEN_WORKSPACE_ID, GOLDEN_WORKTREE_ID } from './world';

export type GoldenIpcHandler = (event: unknown, ...args: unknown[]) => unknown;

const goldenIpcHandlers = new Map<string, GoldenIpcHandler>();

/** Called by the test's `jest.mock('../../ipc/register')` factory. */
export function registerGoldenIpcHandler(
  channel: string,
  handler: GoldenIpcHandler,
): void {
  goldenIpcHandlers.set(channel, handler);
}

export function invokeIpc(
  channel: string,
  ...args: unknown[]
): Promise<unknown> {
  const handler = goldenIpcHandlers.get(channel);
  if (!handler) throw new Error(`No IPC handler registered for ${channel}`);
  return Promise.resolve(handler({ sender: { id: 1 } }, ...args));
}

let toolUseSequence = 0;

export function goldenWorktreeActionRuntime(
  worktreePath: string,
  overrides: Partial<WorktreeActionRuntime> = {},
): WorktreeActionRuntime {
  return {
    projectId: GOLDEN_WORKSPACE_ID,
    worktreeId: GOLDEN_WORKTREE_ID,
    chatId: 'golden-chat',
    cwd: worktreePath,
    getWindow: () => null,
    ...overrides,
  };
}

/**
 * Run one `DispatchAction` call through the desktop agent action surface and
 * return the parsed tool result.
 */
export async function dispatchAgentAction(
  action: Record<string, unknown>,
  worktreeRuntime: WorktreeActionRuntime,
): Promise<unknown> {
  const { executeDesktopAgentActionTool } =
    await import('../../agent-actions/desktop-surface');
  const runtime = {
    requestUserAnswers: () => Promise.resolve([]),
    loadScriptOutput: () => Promise.reject(new Error('unused')),
    worktreeActionRuntime: worktreeRuntime,
  } as unknown as CanopyInjectedToolRuntime;
  const result = await executeDesktopAgentActionTool(
    'dispatch_action',
    { action },
    runtime,
    { toolUseId: `golden-tool-${(toolUseSequence += 1)}` },
  );
  try {
    const parsed: unknown = JSON.parse(result.text);
    return { isError: result.isError ?? false, result: parsed };
  } catch {
    return { isError: result.isError ?? false, text: result.text };
  }
}

/**
 * Electron's `utilityProcess.fork`, served in process: the real pipeline
 * process host worker runs over a message channel, so steps spawn real
 * child processes exactly as the desktop host does.
 */
export function forkGoldenUtilityProcess(): EventEmitter {
  const child = new EventEmitter();
  const parentPort = new EventEmitter();
  let exited = false;
  const exit = (code: number): void => {
    if (exited) return;
    exited = true;
    setImmediate(() => child.emit('exit', code));
  };
  Object.assign(child, {
    pid: process.pid,
    postMessage: (message: unknown): void => {
      setImmediate(() => parentPort.emit('message', { data: message }));
    },
    kill: (): boolean => {
      exit(0);
      return true;
    },
  });
  Object.assign(parentPort, {
    postMessage: (message: unknown): void => {
      setImmediate(() => child.emit('message', message));
    },
  });
  void import('../../pipelines/process-host-worker').then(
    ({ startPipelineProcessHost }) =>
      startPipelineProcessHost(
        parentPort as unknown as Parameters<typeof startPipelineProcessHost>[0],
        exit,
      ),
  );
  return child;
}

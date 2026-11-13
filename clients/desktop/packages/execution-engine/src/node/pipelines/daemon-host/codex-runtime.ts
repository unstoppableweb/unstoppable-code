import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  CodexCapabilityStore,
  configureCodexRuntimeHostHooks,
  createCodexRuntimeService,
  getCodexRuntimeHostHooks,
  type CodexMcpLauncherCommand,
  type CodexRuntimeService,
} from '../../codex-runtime';

/** An app-server the runtime started or saw exit, for the host's supervisor (CAN-5095 D27). */
export type DaemonPipelineCodexProcessEvent =
  | {
      readonly state: 'started';
      readonly id: string;
      readonly processGroupId: number;
    }
  | { readonly state: 'exited'; readonly id: string };

interface Holder {
  readonly dataRoot: string;
  readonly launcher: string;
  readonly service: CodexRuntimeService;
}

let holder: Holder | undefined;

function launcherKey(launcher: CodexMcpLauncherCommand): string {
  return JSON.stringify([launcher.command, ...launcher.args]);
}

/**
 * The pipeline host's one Codex runtime (CAN-5095 D17), created at its first
 * Codex workflow step. App-servers spawn in their own process group, which
 * is reported so a lost host's are killed with its step process groups.
 */
export function acquireDaemonPipelineCodexRuntime(options: {
  readonly dataRoot: string;
  readonly mcpLauncher: CodexMcpLauncherCommand;
  readonly onProcess: (event: DaemonPipelineCodexProcessEvent) => void;
}): CodexRuntimeService {
  const launcher = launcherKey(options.mcpLauncher);
  if (holder) {
    if (holder.dataRoot !== options.dataRoot || holder.launcher !== launcher)
      throw new Error(
        'The background service already runs Codex for another configuration.',
      );
    return holder.service;
  }
  const ids = new WeakMap<ChildProcess, string>();
  configureCodexRuntimeHostHooks({
    ...getCodexRuntimeHostHooks(),
    clientInfo: () => ({
      name: 'canopy-daemon-pipelines',
      title: null,
      version: '1',
    }),
    registerProcessOwner: (child) => {
      if (typeof child.pid !== 'number') return;
      const id = randomUUID();
      ids.set(child, id);
      options.onProcess({ state: 'started', id, processGroupId: child.pid });
    },
    unregisterProcessOwner: (child) => {
      const id = ids.get(child);
      if (id === undefined) return;
      ids.delete(child);
      options.onProcess({ state: 'exited', id });
    },
  });
  const service = createCodexRuntimeService({
    capabilityStore: new CodexCapabilityStore(options.dataRoot),
    mcpLauncher: options.mcpLauncher,
  });
  holder = { dataRoot: options.dataRoot, launcher, service };
  return service;
}

/** Shuts the host's Codex runtime down once; a later step creates a new one. */
export async function shutdownDaemonPipelineCodexRuntime(): Promise<void> {
  const current = holder;
  holder = undefined;
  await current?.service.shutdown();
}

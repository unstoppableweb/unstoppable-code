export * from '@canopy/desktop-shared/node/opencode/mcp-servers';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import type { McpServer } from '@agentclientprotocol/sdk';
import { type OpenCodeMcpLaunch } from '@canopy/desktop-shared/node/opencode/mcp-servers';
import type { getCodexRuntimeService } from '../codex/runtime-service';

/** ACP receives only broker rendezvous, never selected credentials or a CWD wrapper. */
export async function openOpenCodeMcpRoutes(input: {
  servers: readonly OpenCodeMcpLaunch[];
  cwd: string;
  signal: AbortSignal;
  baseEnv: NodeJS.ProcessEnv;
  gate: (
    server: string,
    tool: string,
    args: unknown,
    callId: string,
  ) => Promise<boolean>;
}): Promise<{ servers: McpServer[]; dispose: () => Promise<void> }> {
  const ownerId = `opencode-session:${randomUUID()}`;
  let broker: ReturnType<typeof getCodexRuntimeService> | undefined;
  let disposed = false;
  const dispose = async (): Promise<void> => {
    disposed = true;
    input.signal.removeEventListener('abort', onAbort);
    await broker?.revokeStdioMcpRoutes(ownerId);
  };
  const onAbort = (): void => {
    void dispose().catch(() => undefined);
  };
  input.signal.addEventListener('abort', onAbort, { once: true });
  try {
    const servers: McpServer[] = [];
    for (const server of input.servers) {
      input.signal.throwIfAborted();
      if (!('command' in server)) {
        servers.push(server);
        continue;
      }
      const { getCodexRuntimeService } =
        await import('../codex/runtime-service');
      broker ??= getCodexRuntimeService();
      const route = await broker.registerStdioMcpRoute(
        {
          ownerId,
          routeKey: server.name,
          command: server.command,
          args: server.args,
          cwd: server.cwd ?? input.cwd,
          baseEnv: Object.fromEntries(
            Object.entries(input.baseEnv).filter(
              (entry): entry is [string, string] =>
                typeof entry[1] === 'string',
            ),
          ),
          env: Object.fromEntries(
            server.env.map(({ name, value }) => [name, value]),
          ),
        },
        {
          signal: input.signal,
          toolCallGate: (call) =>
            !disposed && !input.signal.aborted
              ? input.gate(
                  server.name,
                  call.toolName,
                  call.arguments,
                  randomUUID(),
                )
              : Promise.resolve(false),
        },
      );
      if (disposed || input.signal.aborted)
        throw new Error('OpenCode MCP setup stopped.');
      servers.push({
        name: server.name,
        command: route.command,
        args: route.args,
        env: ['TMPDIR', 'TMP', 'TEMP'].map((name) => ({
          name,
          value: tmpdir(),
        })),
      });
    }
    input.signal.throwIfAborted();
    return { servers, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}

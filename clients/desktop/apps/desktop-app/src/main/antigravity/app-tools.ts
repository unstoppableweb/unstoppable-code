import { randomBytes, randomUUID } from 'node:crypto';
import type { McpServer } from '@agentclientprotocol/sdk';
import { CANOPY_INJECTED_TOOL_REGISTRY } from '@canopy/execution-engine/lib/canopy-injected-tools';
import { cursorCanopyMcpServerNames } from '@canopy/desktop-shared/lib/cursor-mcp-tool-call';
import type { ManagedDelegationSession } from '../agents/delegation/service';
import type { AgentSessionOptions } from '../agents/types';
import type { ApprovalSessionHandle } from '../approvals/approval-service';
import { authorizeCursorMcpTool } from '../cursor/tool-approval';
import { getMcpHttpProxyService } from '../mcp/http-proxy-service';
import { isCoworkWorkspace } from '../lib/workspace-registry';
import { isAntigravityConnectionEnabled } from './connection';
import { assertAntigravityHarnessEnabled } from './feature-flag';

export interface AntigravityAppTools {
  servers: McpServer[];
  instructions: string;
  close: () => void;
}

/** Native MCP calls skip ACP permissions in 1.5.1. Gate the actual host effect. */
export async function openAntigravityAppTools(input: {
  sessionKey: string;
  options: AgentSessionOptions;
  approval: ApprovalSessionHandle;
  signal: AbortSignal;
  planMode: boolean;
  stopTurn: () => void;
  onAwaitingUser: () => void;
  ownsSessionResources: () => boolean;
  delegation?: {
    session: ManagedDelegationSession;
    turnId: string;
    currentTurn: () => string | undefined;
  };
}): Promise<AntigravityAppTools> {
  const { options } = input;
  const lifetime = new AbortController();
  const signal = AbortSignal.any([input.signal, lifetime.signal]);
  signal.throwIfAborted();
  const proxy = getMcpHttpProxyService();
  const names = cursorCanopyMcpServerNames();
  const toolSurface = isCoworkWorkspace(options.projectId)
    ? 'antigravity-acp-standalone'
    : 'antigravity-acp';
  const token = randomBytes(32).toString('base64url');
  let closed = false;
  const available = (): boolean =>
    !closed && !signal.aborted && input.ownsSessionResources();
  const close = (): void => {
    if (closed) return;
    closed = true;
    lifetime.abort();
    signal.removeEventListener('abort', close);
    if (input.ownsSessionResources())
      proxy.unregisterCanopyWorktreeSessionRoute(input.sessionKey);
  };
  const delegation =
    toolSurface === 'antigravity-acp' ? input.delegation : undefined;
  const authorize = async (
    tool: string,
    args: unknown,
    callId: string,
    server: string = names.main,
  ): Promise<boolean> => {
    if (!available()) return false;
    assertAntigravityHarnessEnabled();
    if (!(await isAntigravityConnectionEnabled()) || !available()) return false;
    const outcome = await authorizeCursorMcpTool(
      { server, tool, args },
      {
        approval: input.approval,
        cwd: options.cwd,
        toolCallId: callId,
        planMode: input.planMode,
        toolSurface,
        providerLabel: 'Antigravity',
        managedToolNames: delegation?.session.tools.map((entry) => entry.name),
        signal,
      },
    );
    if (outcome.stopTurn) input.stopTurn();
    if (!available() || outcome.decision !== 'allow' || outcome.stopTurn)
      return false;
    assertAntigravityHarnessEnabled();
    return (await isAntigravityConnectionEnabled()) && available();
  };
  try {
    await proxy.registerCanopyWorktreeSessionRoute({
      sessionKey: input.sessionKey,
      projectId: options.projectId,
      worktreeId: options.worktreeId,
      chatId: options.chatId,
      interfaceTools: options.interfaceTools ?? [],
      cwd: options.cwd,
      repoId: options.selectedRepoId,
      sdkSessionId: options.sdkSessionId ?? input.sessionKey,
      providerType: 'antigravity',
      model: options.model,
      authToken: token,
      createdAt: Date.now(),
      hookHandler: () => undefined,
      turnSignal: signal,
      toolSurface,
      deferredToolsAllowed: false,
      autoArchiveAvailable: true,
      ...(delegation
        ? {
            managedDelegation: {
              tools: delegation.session.mcpTools,
              invoke: async (
                name,
                args,
                transport,
              ): Promise<{ text: string; isError: boolean }> => {
                const current = (): boolean =>
                  available() && delegation.currentTurn() === delegation.turnId;
                if (
                  !transport?.requestId ||
                  !current() ||
                  !(await authorize(name, args, transport.requestId)) ||
                  !current()
                )
                  return {
                    text: 'The owning Google turn is unavailable or the call was denied.',
                    isError: true,
                  };
                const result = await delegation.session.parent.invokeCursor(
                  name,
                  args,
                  {
                    callId: transport.requestId,
                    turnId: delegation.turnId,
                  },
                );
                return { text: JSON.stringify(result), isError: !result.ok };
              },
            },
          }
        : {}),
      onAwaitingUser: input.onAwaitingUser,
      authorizeToolCall: (key, args, call): Promise<boolean> => {
        const tool = Object.values(CANOPY_INJECTED_TOOL_REGISTRY).find(
          (entry) => entry.canonicalKey === key,
        );
        return tool
          ? authorize(
              tool.displayName,
              args,
              call?.requestId ?? randomUUID(),
              key === 'ask_user_question' ? names.ui : names.main,
            )
          : Promise.resolve(false);
      },
    });
    signal.addEventListener('abort', close, { once: true });
    signal.throwIfAborted();
    return {
      servers: [
        {
          type: 'http',
          name: names.main,
          url: proxy.getCanopyWorktreeMcpUrl(input.sessionKey),
          headers: [{ name: 'Authorization', value: `Bearer ${token}` }],
        },
        {
          type: 'http',
          name: names.ui,
          url: proxy.getCanopyWorktreeUiMcpUrl(input.sessionKey),
          headers: [{ name: 'Authorization', value: `Bearer ${token}` }],
        },
      ],
      instructions: `Use the supplied ${names.main} MCP tools for app operations. SearchActions describes supported actions before DispatchAction. Use ${names.ui} AskUserQuestion when you need a user decision. Tool descriptions define the available scope and required arguments. Feed and code graph are not available in this integration yet.${delegation ? ' Use the supplied managed delegation tools to run tasks on models reported by ListDelegates. Antigravity child models are not available yet. Parent-selected skills, plugins, commands and MCP servers are not automatically inherited by children. Explicit child Agent selections use their own resolver and permissions.' : ' Agent delegation is not enabled for this chat.'}`,
      close,
    };
  } catch (error) {
    close();
    throw error;
  }
}

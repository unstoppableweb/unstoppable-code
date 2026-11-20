// Golden (VIEW-03, CHAT-03): the main Antigravity session, the delegate
// runner and the pipeline runner build their ACP projection from one factory,
// so native tool arguments and MCP names render identically on every surface.
// A runner with no MCP routes still renders native tools and leaves MCP titles
// raw; configured secrets are masked exactly as a direct projection masks them.
// A native tool the host denied renders the denial text as its failed result,
// since ACP cannot carry the reason back and the runtime reports empty output;
// the authorizer supplies that text for user, plan-mode and fail-closed denials.
import type { SessionNotification } from '@agentclientprotocol/sdk';
import type { AcpPermissionRequest } from '@canopy/desktop-shared/node/acp';
import {
  FAIL_CLOSED_MESSAGE,
  userDeniedMessage,
} from '@canopy/protocol/approvals';
import type * as toolChecks from '../../approvals/tool-checks';
import { approvalCheckForClaudeTool } from '../../approvals/tool-checks';
import { CursorEventProjection } from '../../cursor/events';
import { createAntigravityEventProjection } from '../event-projection';
import {
  ANTIGRAVITY_PLAN_MODE_DENIED_MESSAGE,
  authorizeAntigravityTool,
  authorizeAntigravityToolCall,
} from '../tool-approval';
import { antigravityToolDisplay } from '../tool-display';

jest.mock('../../approvals/tool-checks', () => {
  const actual: typeof toolChecks = jest.requireActual(
    '../../approvals/tool-checks',
  );
  return {
    ...actual,
    approvalCheckForClaudeTool: jest.fn(actual.approvalCheckForClaudeTool),
  };
});

const noRoutes = { canonicalNameFor: (): undefined => undefined };

function notification(update: Record<string, unknown>): SessionNotification {
  return { sessionId: 's', update } as unknown as SessionNotification;
}

function toolUse(
  projection: CursorEventProjection,
  update: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const patches: unknown = projection.update(
    notification({
      sessionUpdate: 'tool_call',
      toolCallId: 't1',
      ...update,
    }),
  )?.patches;
  const first: unknown = Array.isArray(patches) ? patches[0] : undefined;
  return typeof first === 'object' && first !== null && 'block' in first
    ? (first.block as Record<string, unknown>)
    : undefined;
}

describe('createAntigravityEventProjection', () => {
  it('installs the tool display adapter', () => {
    const input = { Path: 'src/a.ts' };
    const expected = antigravityToolDisplay(
      { name: 'read_file', kind: 'read', input },
      noRoutes,
    );
    expect(expected.name).toBe('Read');
    const block = toolUse(
      createAntigravityEventProjection({ limitMessage: 'limit' }),
      {
        title: 'read_file',
        kind: 'read',
        rawInput: input,
      },
    );
    expect(block).toMatchObject({
      type: 'tool_use',
      toolName: 'read_file',
      display: {
        toolName: expected.name,
        input: JSON.stringify(expected.input),
      },
    });
  });

  it('renders native tools without routes and keeps mcp titles raw', () => {
    const projection = createAntigravityEventProjection({
      limitMessage: 'limit',
    });
    expect(
      toolUse(projection, {
        title: 'run_command',
        kind: 'execute',
        rawInput: { CommandLine: 'git status' },
      }),
    ).toMatchObject({
      display: {
        toolName: 'Bash',
        input: JSON.stringify({ command: 'git status' }),
      },
    });
    const mcp = toolUse(
      createAntigravityEventProjection({ limitMessage: 'limit' }),
      { title: 'mcp_gh_list', rawInput: { q: 'x' } },
    );
    expect(mcp).toMatchObject({
      display: { toolName: 'mcp_gh_list', input: JSON.stringify({ q: 'x' }) },
    });
  });

  it('uses supplied routes for mcp titles', () => {
    const block = toolUse(
      createAntigravityEventProjection({
        limitMessage: 'limit',
        routes: {
          canonicalNameFor: (server, tool) =>
            server === 'route' ? { server: 'github', tool } : undefined,
        },
      }),
      { title: 'mcp_route_list', rawInput: {} },
    );
    expect(block).toMatchObject({
      display: { toolName: 'mcp__github__list' },
    });
  });

  it('passes secret values through', () => {
    const secretValues = ['sk-live-0123456789'];
    const run = (projection: CursorEventProjection): unknown[] => {
      const out: unknown[] = [];
      for (const text of ['token ', 'sk-live-0123456789', ' done'])
        out.push(
          projection.update(
            notification({
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text },
            }),
          ),
        );
      out.push(projection.finish());
      out.push(projection.getResponseText());
      // Message ids and timestamps differ per projection; the content may not.
      return JSON.parse(
        JSON.stringify(out, (key, value: unknown) =>
          key === 'messageId' || key === 'timestamp' ? undefined : value,
        ),
      ) as unknown[];
    };
    const factory = run(
      createAntigravityEventProjection({ limitMessage: 'limit', secretValues }),
    );
    const direct = run(
      new CursorEventProjection('limit', {
        recognizeCursorErrors: false,
        secretValues,
      }),
    );
    expect(factory).toEqual(direct);
    // The streamed patches are masked; getResponseText() is the raw reply.
    expect(JSON.stringify(factory.slice(0, -1))).not.toContain(
      'sk-live-0123456789',
    );
    expect(JSON.stringify(factory)).toContain('token ***');
  });
});

/** The tool_result block a failed update for `toolCallId` renders. */
function failedResult(
  projection: CursorEventProjection,
  toolCallId: string,
  rawOutput: unknown,
): Record<string, unknown> | undefined {
  projection.update(
    notification({
      sessionUpdate: 'tool_call',
      toolCallId,
      title: 'run_command',
      kind: 'execute',
      rawInput: { CommandLine: 'touch x' },
    }),
  );
  const patches: unknown = projection.update(
    notification({
      sessionUpdate: 'tool_call_update',
      toolCallId,
      status: 'failed',
      rawOutput,
    }),
  )?.patches;
  if (!Array.isArray(patches)) return undefined;
  for (const patch of patches as unknown[])
    if (
      typeof patch === 'object' &&
      patch !== null &&
      'block' in patch &&
      (patch.block as Record<string, unknown>).type === 'tool_result'
    )
      return patch.block as Record<string, unknown>;
  return undefined;
}

describe('denied Antigravity tool results', () => {
  const denial = userDeniedMessage('not that file');
  const projection = (): CursorEventProjection =>
    createAntigravityEventProjection({
      limitMessage: 'limit',
      deniedToolResult: (id) => (id === 'denied' ? denial : undefined),
    });

  it('renders the denial text for a denied call that failed with empty output', () => {
    expect(failedResult(projection(), 'denied', { output: '' })).toMatchObject({
      type: 'tool_result',
      output: denial,
      isError: true,
    });
    expect(failedResult(projection(), 'denied', undefined)).toMatchObject({
      output: denial,
      isError: true,
    });
  });

  it('keeps output the runtime reported for a denied call', () => {
    expect(
      failedResult(projection(), 'denied', { output: 'refused by runtime' }),
    ).toMatchObject({
      output: JSON.stringify({ output: 'refused by runtime' }),
      isError: true,
    });
  });

  it('leaves an undenied failure unchanged', () => {
    expect(failedResult(projection(), 'other', { output: '' })).toMatchObject({
      output: JSON.stringify({ output: '' }),
      isError: true,
    });
    expect(
      failedResult(new CursorEventProjection('limit'), 'denied', {
        output: '',
      }),
    ).toMatchObject({ output: JSON.stringify({ output: '' }), isError: true });
  });
});

describe('authorizeAntigravityToolCall denial messages', () => {
  function bash(command: string): AcpPermissionRequest {
    return {
      requestId: 1,
      resourceGeneration: 1,
      signal: new AbortController().signal,
      request: {
        sessionId: 's',
        options: [],
        toolCall: {
          toolCallId: 'call-1',
          name: 'run_command',
          kind: 'execute',
          rawInput: { CommandLine: command, Cwd: '/repo' },
        },
      },
    } as unknown as AcpPermissionRequest;
  }

  function context(
    outcome: { decision: 'allow' | 'deny'; message?: string },
    planMode = false,
  ): Parameters<typeof authorizeAntigravityToolCall>[1] & {
    checks: unknown[];
  } {
    const checks: unknown[] = [];
    return {
      checks,
      approval: {
        check: (check) => {
          checks.push(check);
          return Promise.resolve(outcome);
        },
      },
      cwd: '/repo',
      planMode,
      stopTurn: (): void => undefined,
    };
  }

  it('carries the user denial and its reason', async () => {
    const message = userDeniedMessage('do not create files');
    await expect(
      authorizeAntigravityToolCall(
        bash('touch SHOULD_NOT_EXIST.txt'),
        context({ decision: 'deny', message }),
      ),
    ).resolves.toEqual({ decision: 'deny', message });
  });

  it('refuses a plan-mode command with a read-only message and no prompt', async () => {
    const planContext = context({ decision: 'allow' }, true);
    await expect(
      authorizeAntigravityToolCall(bash('ls -la'), planContext),
    ).resolves.toEqual({
      decision: 'deny',
      message: ANTIGRAVITY_PLAN_MODE_DENIED_MESSAGE,
    });
    expect(planContext.checks).toEqual([]);
  });

  it('uses the fail-closed message when the check cannot be prompted', async () => {
    const actual: typeof toolChecks = jest.requireActual(
      '../../approvals/tool-checks',
    );
    jest
      .mocked(approvalCheckForClaudeTool)
      .mockImplementationOnce((...args) => ({
        ...actual.approvalCheckForClaudeTool(...args),
        failClosedReason: 'unbounded',
      }));
    await expect(
      authorizeAntigravityToolCall(bash('ls'), context({ decision: 'allow' })),
    ).resolves.toEqual({ decision: 'deny', message: FAIL_CLOSED_MESSAGE });
  });

  it('allows without a message and keeps the bare decision for other callers', async () => {
    await expect(
      authorizeAntigravityToolCall(bash('ls'), context({ decision: 'allow' })),
    ).resolves.toEqual({ decision: 'allow' });
    await expect(
      authorizeAntigravityTool(
        bash('ls'),
        context({ decision: 'deny', message: 'x' }),
      ),
    ).resolves.toBe('deny');
  });
});

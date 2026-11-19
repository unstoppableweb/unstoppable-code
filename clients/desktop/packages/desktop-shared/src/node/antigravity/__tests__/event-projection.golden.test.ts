// Golden (VIEW-03, CHAT-03): the main Antigravity session, the delegate
// runner and the pipeline runner build their ACP projection from one factory,
// so native tool arguments and MCP names render identically on every surface.
// A runner with no MCP routes still renders native tools and leaves MCP titles
// raw; configured secrets are masked exactly as a direct projection masks them.
import type { SessionNotification } from '@agentclientprotocol/sdk';
import { CursorEventProjection } from '../../cursor/events';
import { createAntigravityEventProjection } from '../event-projection';
import { antigravityToolDisplay } from '../tool-display';

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

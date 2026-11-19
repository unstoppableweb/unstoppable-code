// Golden (VIEW-03): Google chats reuse the Cursor ACP projection, so their
// native tools and routed MCP tools must reach the transcript under the
// display names the chat renderer already knows (Read, Write, Bash and
// mcp__<server>__<tool>), with the inputs Antigravity 1.5.1 actually sends.
// Cursor's own display is unchanged when no adapter is supplied.
import type { SessionNotification } from '@agentclientprotocol/sdk';
import { CursorEventProjection } from '../../cursor/events';
import { antigravityToolDisplay } from '../tool-display';

const ROUTE = 'appproxy-can6709-fixture--9dd00a958bd10468';

const routes = {
  canonicalNameFor(
    server: string,
    tool: string,
  ): { server: string; tool: string } | undefined {
    return server === ROUTE ? { server: 'can6709-fixture', tool } : undefined;
  },
};

const noRoutes = { canonicalNameFor: (): undefined => undefined };

describe('antigravityToolDisplay', () => {
  it('shows read_file as Read with the first path key present', () => {
    expect(
      antigravityToolDisplay(
        { name: 'read_file', kind: 'read', input: { Path: '/repo/a.ts' } },
        noRoutes,
      ),
    ).toEqual({ name: 'Read', input: { file_path: '/repo/a.ts' } });
    expect(
      antigravityToolDisplay(
        {
          name: 'read_file',
          kind: 'read',
          input: { TargetFile: '/repo/b.ts', AbsolutePath: '/repo/c.ts' },
        },
        noRoutes,
      ),
    ).toEqual({ name: 'Read', input: { file_path: '/repo/b.ts' } });
  });

  it('skips path keys that are not non-empty strings', () => {
    for (const input of [
      { Path: null, TargetFile: '/repo/b.ts' },
      { Path: 5, TargetFile: '', AbsolutePath: '/repo/b.ts' },
    ])
      expect(
        antigravityToolDisplay(
          { name: 'read_file', kind: 'read', input },
          noRoutes,
        ),
      ).toEqual({ name: 'Read', input: { file_path: '/repo/b.ts' } });
  });

  it('shows write_file as Write with its path and content', () => {
    expect(
      antigravityToolDisplay(
        {
          name: 'write_file',
          kind: 'edit',
          input: { AbsolutePath: '/repo/c.ts', Content: 'x' },
        },
        noRoutes,
      ),
    ).toEqual({
      name: 'Write',
      input: { file_path: '/repo/c.ts', content: 'x' },
    });
  });

  it('shows run_command as Bash with its command', () => {
    expect(
      antigravityToolDisplay(
        {
          name: 'run_command',
          kind: 'execute',
          input: { CommandLine: 'git status', Cwd: '/repo' },
        },
        noRoutes,
      ),
    ).toEqual({ name: 'Bash', input: { command: 'git status' } });
  });

  // Antigravity 1.5.1 titles native calls for people ("File README.md"), so
  // the ACP kind and the input keys identify the tool, not the title.
  it('recognizes live native tools by ACP kind', () => {
    expect(
      antigravityToolDisplay(
        { name: 'File README.md', kind: 'read', input: { Path: 'README.md' } },
        noRoutes,
      ),
    ).toEqual({ name: 'Read', input: { file_path: 'README.md' } });
    expect(
      antigravityToolDisplay(
        {
          name: 'File a.ts',
          kind: 'edit',
          input: { TargetFile: '/repo/a.ts', Content: 'x' },
        },
        noRoutes,
      ),
    ).toEqual({
      name: 'Write',
      input: { file_path: '/repo/a.ts', content: 'x' },
    });
    expect(
      antigravityToolDisplay(
        { name: 'File a.ts', kind: 'edit', input: { Path: '/repo/a.ts' } },
        noRoutes,
      ),
    ).toEqual({ name: 'Write', input: { file_path: '/repo/a.ts' } });
    expect(
      antigravityToolDisplay(
        {
          name: 'Run git status',
          kind: 'execute',
          input: { CommandLine: 'git status', Cwd: '/repo' },
        },
        noRoutes,
      ),
    ).toEqual({ name: 'Bash', input: { command: 'git status' } });
  });

  it('leaves a kind without its expected input key raw', () => {
    for (const tool of [
      { name: 'File README.md', kind: 'read', input: { File: 'README.md' } },
      { name: 'File a.ts', kind: 'edit', input: { Content: 'x' } },
      { name: 'Run', kind: 'execute', input: { Command: 'ls' } },
      { name: 'Fetch', kind: 'fetch', input: { Path: 'README.md' } },
      { name: 'File README.md', kind: 'read', input: 'README.md' },
      {
        name: `mcp_${ROUTE}_read`,
        kind: 'read',
        input: { Path: 'README.md' },
      },
    ])
      expect(antigravityToolDisplay(tool, noRoutes)).toEqual({
        name: tool.name,
        input: tool.input,
      });
  });

  it('shows a routed MCP tool under its server original name', () => {
    const input = { query: 'q' };
    expect(
      antigravityToolDisplay(
        { name: `mcp_${ROUTE}_search_issues`, input },
        routes,
      ),
    ).toEqual({ name: 'mcp__can6709-fixture__search_issues', input });
  });

  it('renders an underscore server only when one split resolves', () => {
    const routed = (
      servers: string[],
    ): Parameters<typeof antigravityToolDisplay>[1] => ({
      canonicalNameFor: (server, tool) =>
        servers.includes(server) ? { server, tool } : undefined,
    });
    const tool = { name: 'mcp_gh_enterprise_list', input: {} };
    expect(
      antigravityToolDisplay(tool, routed(['gh', 'gh_enterprise'])),
    ).toEqual(tool);
    expect(antigravityToolDisplay(tool, routed(['gh_enterprise']))).toEqual({
      name: 'mcp__gh_enterprise__list',
      input: {},
    });
  });

  it('leaves an unknown route or unparseable title unchanged', () => {
    const input = { query: 'q' };
    for (const name of [
      `mcp_${ROUTE}_search_issues`,
      'mcp_',
      ROUTE,
      'invoke_subagent',
    ]) {
      const tool = { name, input };
      expect(antigravityToolDisplay(tool, noRoutes)).toEqual({ name, input });
    }
    const missing = { name: 'read_file', kind: 'read', input: {} };
    expect(antigravityToolDisplay(missing, noRoutes)).toEqual({
      name: 'read_file',
      input: {},
    });
  });
});

describe('CursorEventProjection tool display', () => {
  function toolUse(
    projection: CursorEventProjection,
    update: Record<string, unknown>,
  ): unknown {
    const notification: SessionNotification = {
      sessionId: 's',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 't1',
        title: 'read_file',
        ...update,
      },
    };
    const patches: unknown = projection.update(notification)?.patches;
    const first: unknown = Array.isArray(patches) ? patches[0] : undefined;
    return typeof first === 'object' && first !== null && 'block' in first
      ? first.block
      : undefined;
  }

  it('applies the Antigravity adapter when supplied', () => {
    const projection = new CursorEventProjection('limit', {
      toolDisplay: (tool): { name: string; input: unknown } =>
        antigravityToolDisplay(tool, routes),
    });
    expect(
      toolUse(projection, { kind: 'read', rawInput: { Path: '/repo/a.ts' } }),
    ).toMatchObject({
      type: 'tool_use',
      toolName: 'read_file',
      display: {
        toolName: 'Read',
        input: JSON.stringify({ file_path: '/repo/a.ts' }),
      },
    });
    expect(
      toolUse(projection, {
        title: 'File README.md',
        kind: 'read',
        rawInput: { Path: 'README.md' },
      }),
    ).toMatchObject({
      type: 'tool_use',
      toolName: 'File README.md',
      display: {
        toolName: 'Read',
        input: JSON.stringify({ file_path: 'README.md' }),
      },
    });
  });

  it("keeps Cursor's own display when no adapter is supplied", () => {
    expect(
      toolUse(new CursorEventProjection('limit'), {
        title: 'Read a.ts',
        kind: 'read',
        rawInput: { path: '/repo/a.ts' },
      }),
    ).toMatchObject({
      display: {
        toolName: 'Read',
        input: JSON.stringify({ file_path: '/repo/a.ts' }),
      },
    });
    expect(
      toolUse(new CursorEventProjection('limit'), {
        kind: 'read',
        rawInput: { Path: '/repo/a.ts' },
      }),
    ).toMatchObject({
      display: {
        toolName: 'read_file',
        input: JSON.stringify({ Path: '/repo/a.ts' }),
      },
    });
  });
});

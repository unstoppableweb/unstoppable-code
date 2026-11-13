jest.mock('../../lib/preferences-store', () => ({
  ...jest.requireActual<object>('../../lib/preferences-store'),
  readPreferencesFile: (): Promise<object> =>
    Promise.resolve({ localMemoryEnabled: true }),
}));

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MEMORY_GRANTS,
  type CanopyCallerDescriptor,
} from '@canopy/protocol/canopy-core';
import type {
  LocalMemoryScopeRequest,
  SearchHit,
} from '@canopy/desktop-shared/types';
import type { LocalMemoryPolicy } from '../../memory/local/policy';
import { LocalMemoryScopeReadOnlyError } from '../../memory/local/scope-manifest';
import {
  createCoreMemoryAdapter,
  type CoreMemoryHost,
} from '../core-memory-adapter';
import { APP_ADVISOR_PROJECT_ID } from '@canopy/desktop-shared/types';
import { createCoreOperationAdapter } from '../core-operation-adapter';
import {
  createDesktopRuntime,
  type DesktopCanopyDispatcher,
} from '../desktop-runtime';

const caller = (
  grants: CanopyCallerDescriptor['grants'],
): CanopyCallerDescriptor => ({
  principalId: 'desktop-agent-memory',
  clientInstanceId: 'desktop-main',
  authorityId: 'local',
  interfaceKind: 'mcp',
  grants,
});
const READ = caller([MEMORY_GRANTS.read]);
const WRITE = caller([MEMORY_GRANTS.write]);
const CHAT = { workspaceId: 'ws', worktreeId: 'wt' };
const SOURCE = { provider: 'claude', chatId: 'chat-1' };
const meta = (key: string): { idempotencyKey: string } => ({
  idempotencyKey: key,
});

interface Calls {
  saves: { scope: LocalMemoryScopeRequest; text: string; origin?: unknown }[];
  searches: LocalMemoryScopeRequest[][];
  usage: { scope: LocalMemoryScopeRequest; keys: string[] }[];
  seeded: string[];
  changed: LocalMemoryScopeRequest[];
  policies: number;
}

function fakeHost(options: {
  enabled?: boolean;
  policy?: LocalMemoryPolicy;
  hits?: SearchHit[];
  files?: Record<string, string>;
  saveError?: Error;
}): { host: CoreMemoryHost; calls: Calls } {
  const calls: Calls = {
    saves: [],
    searches: [],
    usage: [],
    seeded: [],
    changed: [],
    policies: 0,
  };
  let saved = 0;
  const host: CoreMemoryHost = {
    enabled: () => Promise.resolve(options.enabled ?? true),
    policy: () => {
      calls.policies += 1;
      return Promise.resolve(
        options.policy ?? {
          kind: 'scoped',
          workspaceId: 'ws',
          privateMemory: false,
          owner: { organizationId: 'ORG', projectId: 'PROJ' },
        },
      );
    },
    store: {
      saveNote: (scope, note) => {
        if (options.saveError) return Promise.reject(options.saveError);
        calls.saves.push({ scope, text: note.text, origin: note.origin });
        saved += 1;
        return Promise.resolve(`inbox/note-${saved}.md`);
      },
      search: (scopes) => {
        calls.searches.push([...scopes]);
        return Promise.resolve(options.hits ?? []);
      },
      readFile: (_scope, fileKey) => Promise.resolve(options.files?.[fileKey]),
      recordUsage: (scope, keys) => {
        calls.usage.push({ scope, keys });
        return Promise.resolve();
      },
      seedUsage: (_scope, fileKey) => {
        calls.seeded.push(fileKey);
        return Promise.resolve();
      },
    },
    changed: (scope) => calls.changed.push(scope),
  };
  return { host, calls };
}

let root: string;
const runtimes: DesktopCanopyDispatcher[] = [];
function runtimeWith(host: CoreMemoryHost): DesktopCanopyDispatcher {
  const runtime = createDesktopRuntime({
    operationAdapter: createCoreOperationAdapter({
      ledgerPath: () => join(root, `ledger-${runtimes.length}.sqlite`),
    }),
    memoryHost: host,
    shutdownTimeoutMs: 25,
  });
  runtimes.push(runtime);
  return runtime;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'core-memory-'));
});
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.shutdown()));
  rmSync(root, { recursive: true, force: true });
});

describe('core.memory on the desktop dispatcher (CAN-5993)', () => {
  it('appends a note once per idempotency key, with its origin, and seeds its usage', async () => {
    const { host, calls } = fakeHost({});
    const runtime = runtimeWith(host);
    const params = {
      scope: CHAT,
      memory: 'workspace' as const,
      content: 'Use pnpm.',
      source: SOURCE,
      _meta: meta('k1'),
    };
    const first = await runtime.instruction(
      'core.memory.entry.append',
      params,
      { caller: WRITE, metadata: meta('k1') },
    );
    const replay = await runtime.instruction(
      'core.memory.entry.append',
      params,
      { caller: WRITE, metadata: meta('k1') },
    );
    expect(first).toEqual({ memory: 'workspace', fileKey: 'inbox/note-1.md' });
    expect(replay).toEqual(first);
    expect(calls.saves).toEqual([
      {
        scope: { scope: 'workspace', workspaceId: 'ws' },
        text: 'Use pnpm.',
        origin: { organizationId: 'org', projectId: 'proj' },
      },
    ]);
    expect(calls.seeded).toEqual(['inbox/note-1.md']);
    expect(calls.changed).toEqual([{ scope: 'workspace', workspaceId: 'ws' }]);
    await expect(
      runtime.instruction(
        'core.memory.entry.append',
        { ...params, content: 'Something else.' },
        { caller: WRITE, metadata: meta('k1') },
      ),
    ).rejects.toMatchObject({ payload: { kind: 'conflict' } });
    expect(calls.saves).toHaveLength(1);
  });

  it('refuses without the operation’s grant before memory is touched', async () => {
    const { host, calls } = fakeHost({});
    const runtime = runtimeWith(host);
    await expect(
      runtime.instruction(
        'core.memory.entry.append',
        {
          scope: CHAT,
          memory: 'user',
          content: 'x',
          source: SOURCE,
          _meta: meta('k2'),
        },
        { caller: READ, metadata: meta('k2') },
      ),
    ).rejects.toMatchObject({ payload: { kind: 'permission_denied' } });
    await expect(
      runtime.query(
        'core.memory.search',
        { scope: CHAT, query: 'pnpm' },
        { caller: WRITE },
      ),
    ).rejects.toMatchObject({ payload: { kind: 'permission_denied' } });
    expect(calls.policies).toBe(0);
    expect(calls.saves).toEqual([]);
  });

  it('keeps the tools’ refusals: disabled, unreadable project, private user memory, no project, read-only scope', async () => {
    const append = (
      host: CoreMemoryHost,
      memory: 'user' | 'workspace',
      key: string,
    ): Promise<unknown> =>
      runtimeWith(host).instruction(
        'core.memory.entry.append',
        { scope: CHAT, memory, content: 'x', source: SOURCE, _meta: meta(key) },
        { caller: WRITE, metadata: meta(key) },
      );
    await expect(
      append(fakeHost({ enabled: false }).host, 'user', 'a'),
    ).rejects.toMatchObject({
      payload: {
        code: 'core.memory.disabled',
        message: 'Local memory is disabled',
      },
    });
    await expect(
      append(
        fakeHost({ policy: { kind: 'blocked', workspaceId: 'ws' } }).host,
        'user',
        'b',
      ),
    ).rejects.toMatchObject({
      payload: { code: 'core.memory.policyUnavailable' },
    });
    await expect(
      append(
        fakeHost({
          policy: { kind: 'scoped', workspaceId: 'ws', privateMemory: true },
        }).host,
        'user',
        'c',
      ),
    ).rejects.toMatchObject({
      payload: {
        code: 'core.memory.scopeUnavailable',
        message:
          'User memory is unavailable in a private-memory project. Use workspace scope.',
      },
    });
    await expect(
      append(fakeHost({ policy: { kind: 'unscoped' } }).host, 'workspace', 'd'),
    ).rejects.toMatchObject({
      payload: {
        code: 'core.memory.scopeUnavailable',
        message:
          'Project memory is not available in this session because no project is selected; save with scope "user" instead.',
      },
    });
    const readOnly = new LocalMemoryScopeReadOnlyError();
    await expect(
      append(fakeHost({ saveError: readOnly }).host, 'user', 'e'),
    ).rejects.toMatchObject({
      payload: { code: 'core.memory.scopeReadOnly', message: readOnly.message },
    });
  });

  it('searches the scopes the policy allows and records usage as a side effect', async () => {
    const { host, calls } = fakeHost({
      policy: { kind: 'scoped', workspaceId: 'ws', privateMemory: true },
      hits: [
        {
          scope: 'workspace',
          fileKey: 'topics/build.md',
          snippet: 'pnpm',
          heading: 'Build',
        },
        { scope: 'workspace', fileKey: 'topics/build.md', snippet: 'again' },
      ],
    });
    const result = await runtimeWith(host).query(
      'core.memory.search',
      { scope: CHAT, query: 'pnpm' },
      { caller: READ },
    );
    expect(result).toEqual({
      hits: [
        {
          memory: 'workspace',
          fileKey: 'topics/build.md',
          heading: 'Build',
          snippet: 'pnpm',
        },
        {
          memory: 'workspace',
          fileKey: 'topics/build.md',
          heading: null,
          snippet: 'again',
        },
      ],
    });
    expect(calls.searches).toEqual([
      [{ scope: 'workspace', workspaceId: 'ws' }],
    ]);
    expect(calls.usage).toEqual([
      {
        scope: { scope: 'workspace', workspaceId: 'ws' },
        keys: ['topics/build.md'],
      },
    ]);
  });

  it('reads one file and records its use, and answers notFound for a missing one', async () => {
    const { host, calls } = fakeHost({
      policy: { kind: 'unscoped' },
      files: { 'MEMORY.md': '# Memory' },
    });
    const runtime = runtimeWith(host);
    await expect(
      runtime.query(
        'core.memory.entry.get',
        { scope: CHAT, memory: 'user', fileKey: 'MEMORY.md' },
        { caller: READ },
      ),
    ).resolves.toEqual({
      memory: 'user',
      fileKey: 'MEMORY.md',
      content: '# Memory',
    });
    await expect(
      runtime.query(
        'core.memory.entry.get',
        { scope: CHAT, memory: 'user', fileKey: 'topics/none.md' },
        { caller: READ },
      ),
    ).rejects.toMatchObject({
      payload: {
        kind: 'not_found',
        code: 'core.memory.entry.notFound',
        message: 'Local memory file not found: [user] topics/none.md.',
      },
    });
    await expect(
      runtime.query(
        'core.memory.entry.get',
        { scope: CHAT, memory: 'workspace', fileKey: 'MEMORY.md' },
        { caller: READ },
      ),
    ).rejects.toMatchObject({
      payload: {
        code: 'core.memory.scopeUnavailable',
        message:
          'Project memory is not available in this session because no project is selected.',
      },
    });
    expect(calls.usage).toEqual([
      { scope: { scope: 'user' }, keys: ['MEMORY.md'] },
    ]);
  });
});

describe('core.memory.entry.append over the real store (CAN-5993)', () => {
  it('keeps the store’s secret redaction and note size limit, and the operation refuses an oversized note', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'core-memory-store-'));
    const previous = process.env.CANOPY_DATA_DIR;
    process.env.CANOPY_DATA_DIR = dataDir;
    try {
      const append =
        createCoreMemoryAdapter().instructions?.['core.memory.entry.append'];
      if (!append) throw new Error('core.memory.entry.append is not served');
      const token = `ghp_${'A1b2C3d4E5'.repeat(4)}`;
      const params = {
        // App Advisor chats have no project, so user memory is the scope.
        scope: { workspaceId: APP_ADVISOR_PROJECT_ID, worktreeId: 'w' },
        memory: 'user' as const,
        content: `Deploy with ${token} and ${'x'.repeat(1900)}`,
        source: SOURCE,
        _meta: meta('real-1'),
      };
      const { fileKey } = await append(params, {
        requestId: 'r',
        caller: WRITE,
        metadata: meta('real-1'),
        signal: new AbortController().signal,
      });
      const saved = readFileSync(join(dataDir, 'memory', fileKey), 'utf8');
      expect(saved).not.toContain(token);
      expect(saved).toContain('Deploy with');
      await expect(
        runtimeWith(fakeHost({}).host).instruction(
          'core.memory.entry.append',
          { ...params, content: 'x'.repeat(2001), _meta: meta('real-2') },
          { caller: WRITE, metadata: meta('real-2') },
        ),
      ).rejects.toMatchObject({ payload: { kind: 'invalid_argument' } });
    } finally {
      if (previous === undefined) delete process.env.CANOPY_DATA_DIR;
      else process.env.CANOPY_DATA_DIR = previous;
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

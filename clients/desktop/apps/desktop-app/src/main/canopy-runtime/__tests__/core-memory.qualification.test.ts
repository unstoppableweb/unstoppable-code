import type { DatabaseSync } from 'node:sqlite';
import type {
  MemoryChatSearchResult,
  MemoryChatExcerptResult,
} from '@canopy/protocol/canopy-core';
import { openChatSearchDatabase } from '../../chat-search/schema';
import {
  queryChatSearchDatabase,
  type AgentChatSearchFilter,
} from '../../chat-search/query';
import type { CoreMemoryChatsHost } from '../core-memory-chats-adapter';
jest.mock('../../lib/preferences-store', () => ({
  ...jest.requireActual<object>('../../lib/preferences-store'),
  readPreferencesFile: (): Promise<object> =>
    Promise.resolve({ localMemoryEnabled: true }),
}));

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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
import { readMemoryFile, searchMemory } from '../../memory/local/store';
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

// The history operations use the same memory grant, but never grant transcript dumping.
// Real FTS projection backs these dispatcher cases; no transcript reader is injected.
describe('core.memory.chats search and bounded excerpts (CAN-6051)', () => {
  interface HistoryScope {
    workspaceId: string;
    worktreeId: string;
    chatId: string;
  }
  interface HistoryWorld {
    db: DatabaseSync;
    add(
      id: string,
      project: string,
      chat: string,
      source?: string,
      kind?: string,
      expires?: number | null,
      body?: string,
    ): void;
    runtime: DesktopCanopyDispatcher;
    scope: HistoryScope;
    search(limit?: number): Promise<MemoryChatSearchResult>;
    excerpt(
      matchId: string,
      scope?: HistoryScope,
      reader?: CanopyCallerDescriptor,
    ): Promise<MemoryChatExcerptResult>;
    queried: AgentChatSearchFilter[];
    disable(): void;
    setPolicy(value: LocalMemoryPolicy): void;
    expire(): void;
    changeDuringQuery(value: () => void): void;
  }
  function historyWorld(): HistoryWorld {
    const db = openChatSearchDatabase(join(root, 'search.sqlite'));
    const add = (
      id: string,
      project: string,
      chat: string,
      source = 'live',
      kind = 'chat',
      expires: number | null = null,
      body = 'The launch password is orchard.',
    ): void => {
      db.prepare(
        `INSERT INTO chat_docs (doc_id, project_id, worktree_id, chat_id, source, document_kind, title, updated_at, expires_at) VALUES (?, ?, 'wt', ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        project,
        chat,
        source,
        kind,
        `Title ${id}`,
        Date.now(),
        expires,
      );
      db.prepare(
        'INSERT INTO chat_fts (doc_id, title, body) VALUES (?, ?, ?)',
      ).run(id, `Title ${id}`, body);
    };
    let enabled = true;
    let clock = Date.now();
    let policy: LocalMemoryPolicy = {
      kind: 'scoped',
      workspaceId: 'ws',
      privateMemory: false,
    };
    let afterQuery: (() => void) | undefined;
    const queried: AgentChatSearchFilter[] = [];
    const host: CoreMemoryChatsHost = {
      enabled: () => Promise.resolve(enabled),
      policy: (location) =>
        Promise.resolve(
          policy.kind === 'unscoped' && location.projectId === 'cowork-default'
            ? {
                kind: 'scoped',
                workspaceId: 'cowork-default',
                privateMemory: false,
              }
            : policy,
        ),
      now: () => clock,
      query: (request, _context, filter) => {
        queried.push(filter);
        const results = queryChatSearchDatabase(db, request, clock, 0, filter);
        afterQuery?.();
        return Promise.resolve(results);
      },
    };
    const runtime = createDesktopRuntime({
      operationAdapter: createCoreOperationAdapter({
        ledgerPath: () => join(root, 'history-ledger.sqlite'),
      }),
      memoryChatsHost: host,
      shutdownTimeoutMs: 25,
    });
    runtimes.push(runtime);
    const scope = { ...CHAT, chatId: 'current' };
    const search = (limit = 10): Promise<MemoryChatSearchResult> =>
      runtime.query(
        'core.memory.chats.search',
        { scope, query: 'orchard', limit },
        { caller: READ },
      );
    const excerpt = (
      matchId: string,
      scopeOverride = scope,
      reader = READ,
    ): Promise<MemoryChatExcerptResult> =>
      runtime.query(
        'core.memory.chats.excerpt',
        { scope: scopeOverride, matchId },
        { caller: reader },
      );
    return {
      db,
      add,
      runtime,
      scope,
      search,
      excerpt,
      queried,
      disable: () => {
        enabled = false;
      },
      setPolicy: (value: LocalMemoryPolicy) => {
        policy = value;
      },
      expire: () => {
        clock += 16 * 60 * 1000;
      },
      changeDuringQuery: (value: () => void) => {
        afterQuery = value;
      },
    };
  }

  it('finds earlier real chats and visible archives, excluding the current chat, other projects, expired chats, plans and children before limiting', async () => {
    const w = historyWorld();
    try {
      for (let i = 0; i < 105; i++)
        w.add(`outside-${i}`, 'other', `outside-${i}`);
      w.add('current-live', 'ws', 'current');
      w.add('current-archive', 'ws', 'current', 'worktree-archive');
      w.add('plan', 'ws', 'plan', 'plan', 'plan');
      w.add(
        'container',
        'ws',
        'container',
        'archived-container',
        'archived-container',
      );
      w.add('expired', 'ws', 'expired', 'worktree-archive', 'chat', 1);
      w.add('child', 'ws', 'parent', 'live', 'chat-child');
      w.add('earlier', 'ws', 'earlier');
      w.add('archive', 'ws', 'archive', 'worktree-archive');
      w.add('retained', 'ws', 'retained', 'archived-container');
      w.add('cowork', 'ws', 'cowork', 'cowork-archive');
      const result = await w.search();
      expect(result.hits.map((hit) => hit.title).sort()).toEqual([
        'Title archive',
        'Title cowork',
        'Title earlier',
        'Title retained',
      ]);
      for (const hit of result.hits) {
        expect(hit.date).toMatch(/^\d{4}-/);
        expect(hit.snippet).toContain('orchard');
        const excerptResult = await w.excerpt(hit.matchId);
        expect(excerptResult.title).toBe(hit.title);
        expect(excerptResult.excerpt).toContain('orchard');
      }
      expect((await w.search(1)).hits).toHaveLength(1);
      await expect(
        w.runtime.query(
          'core.memory.chats.search',
          { scope: w.scope, query: 'orchard', limit: 11 },
          { caller: READ },
        ),
      ).rejects.toMatchObject({ payload: { kind: 'invalid_argument' } });
      await expect(
        w.runtime.query(
          'core.memory.chats.search',
          { scope: w.scope, query: 'orchard', limit: 5 },
          { caller: WRITE },
        ),
      ).rejects.toMatchObject({ payload: { kind: 'permission_denied' } });
    } finally {
      w.db.close();
    }
  });

  it('bounds text and binds match handles to the calling chat, policy and expiry, without offsets or raw document IDs', async () => {
    const w = historyWorld();
    try {
      w.add(
        'long',
        'ws',
        'earlier',
        'live',
        'chat',
        null,
        `${'before '.repeat(1000)}orchard ${'after '.repeat(1000)}`,
      );
      const [hit] = (await w.search()).hits;
      expect(hit).toBeDefined();
      if (!hit) throw new Error('Missing seeded match');
      const read = await w.excerpt(hit.matchId);
      expect(read.excerpt).toContain('orchard');
      expect(read.excerpt.length).toBeLessThanOrEqual(6000);
      expect(read.excerpt.length).toBeLessThan(1000);
      expect(read.excerpt.length).toBeGreaterThan(hit.snippet.length);
      await expect(
        w.excerpt(hit.matchId, { ...w.scope, chatId: 'another' }),
      ).rejects.toMatchObject({
        payload: { code: 'core.memory.chats.matchUnavailable' },
      });
      await expect(
        w.excerpt(hit.matchId, w.scope, { ...READ, principalId: 'other' }),
      ).rejects.toMatchObject({
        payload: { code: 'core.memory.chats.matchUnavailable' },
      });
      w.setPolicy({ kind: 'scoped', workspaceId: 'ws', privateMemory: true });
      await expect(w.excerpt(hit.matchId)).rejects.toMatchObject({
        payload: { code: 'core.memory.chats.matchUnavailable' },
      });
      // Private projects still read their own earlier chats.
      const [privateHit] = (await w.search()).hits;
      if (!privateHit) throw new Error('Missing private match');
      expect(await w.excerpt(privateHit.matchId)).toMatchObject({
        title: 'Title long',
      });
      w.expire();
      await expect(w.excerpt(privateHit.matchId)).rejects.toMatchObject({
        payload: { code: 'core.memory.chats.matchUnavailable' },
      });
      w.disable();
      await expect(w.search()).rejects.toMatchObject({
        payload: { code: 'core.memory.disabled' },
      });
    } finally {
      w.db.close();
    }
  });

  it('rechecks revoked policy and deleted matches, and keeps project and personal scopes separate', async () => {
    const w = historyWorld();
    try {
      w.add('project', 'ws', 'earlier');
      w.add('personal', 'cowork-default', 'personal');
      w.scope.workspaceId = APP_ADVISOR_PROJECT_ID;
      w.setPolicy({ kind: 'unscoped' });
      expect((await w.search()).hits.map((hit) => hit.title)).toEqual([
        'Title personal',
      ]);
      w.scope.workspaceId = 'ws';
      w.setPolicy({
        kind: 'scoped',
        workspaceId: 'ws',
        privateMemory: false,
        owner: { organizationId: 'org', projectId: 'project' },
      });
      const [hit] = (await w.search()).hits;
      if (!hit) throw new Error('Missing project match');
      await expect(
        w.runtime.query(
          'core.memory.chats.search',
          {
            scope: { ...w.scope, organizationId: 'another-org' },
            query: 'orchard',
            limit: 5,
          },
          { caller: READ },
        ),
      ).rejects.toMatchObject({
        payload: { code: 'core.memory.scopeUnavailable' },
      });
      w.db.prepare('DELETE FROM chat_docs WHERE doc_id = ?').run('project');
      await expect(w.excerpt(hit.matchId)).rejects.toMatchObject({
        payload: { code: 'core.memory.chats.matchUnavailable' },
      });
      w.setPolicy({ kind: 'blocked', workspaceId: 'ws' });
      await expect(w.search()).rejects.toMatchObject({
        payload: { code: 'core.memory.policyUnavailable' },
      });
      w.setPolicy({ kind: 'scoped', workspaceId: 'ws', privateMemory: false });
      w.changeDuringQuery(() => w.disable());
      await expect(w.search()).rejects.toMatchObject({
        payload: { code: 'core.memory.disabled' },
      });
    } finally {
      w.db.close();
    }
  });
});

describe('archived memory through the core dispatcher (CAN-6048)', () => {
  it('keeps live results first, opens archived notes and imports, and enforces private scope on search and reads', async () => {
    const userDir = join(root, 'user');
    const workspaceDir = join(root, 'workspace');
    const savedAt = '2026-10-01T12:00:00.000Z';
    const note = `---\ncreated: "${savedAt}"\n---\n# Build\nquartz archived detail`;
    for (const dir of [userDir, workspaceDir]) {
      mkdirSync(join(dir, 'inbox', '.consolidated'), { recursive: true });
      mkdirSync(join(dir, 'imported', '.consolidated'), { recursive: true });
      writeFileSync(join(dir, 'MEMORY.md'), 'quartz current guidance');
      writeFileSync(join(dir, 'inbox', '.consolidated', 'note.md'), note);
      writeFileSync(
        join(dir, 'inbox', '.consolidated', 'topic-pruned.md'),
        'quartz pruned',
      );
      writeFileSync(
        join(dir, 'imported', '.consolidated', 'import.md'),
        'quartz imported detail',
      );
    }
    const { host } = fakeHost({
      policy: { kind: 'scoped', workspaceId: 'ws', privateMemory: true },
    });
    const dirFor = (scope: LocalMemoryScopeRequest): string =>
      scope.scope === 'user' ? userDir : workspaceDir;
    host.store.search = (scopes, query): Promise<SearchHit[]> =>
      searchMemory(
        scopes.map((scope) => ({ scope: scope.scope, dir: dirFor(scope) })),
        query,
      );
    host.store.readFile = (scope, key): Promise<string | undefined> =>
      readMemoryFile(dirFor(scope), key);
    const runtime = runtimeWith(host);
    const result = await runtime.query(
      'core.memory.search',
      { scope: CHAT, query: 'quartz' },
      { caller: READ },
    );
    expect(result.hits.map((hit) => hit.fileKey)).toEqual([
      'MEMORY.md',
      'inbox/.consolidated/note.md',
      'imported/.consolidated/import.md',
    ]);
    expect(result.hits.every((hit) => hit.memory === 'workspace')).toBe(true);
    expect(result.hits[1].snippet).toBe(
      `[Archived; saved ${savedAt}] quartz archived detail`,
    );
    expect(result.hits[2].snippet).toMatch(/^\[Archived; saved \d{4}-/);
    for (const hit of result.hits) {
      const read = await runtime.query(
        'core.memory.entry.get',
        { scope: CHAT, memory: hit.memory, fileKey: hit.fileKey },
        { caller: READ },
      );
      expect(read.content).toContain('quartz');
    }
    await expect(
      runtime.query(
        'core.memory.entry.get',
        {
          scope: CHAT,
          memory: 'workspace',
          fileKey: 'inbox/.consolidated/topic-pruned.md',
        },
        { caller: READ },
      ),
    ).rejects.toMatchObject({ payload: { kind: 'not_found' } });
    await expect(
      runtime.query(
        'core.memory.entry.get',
        { scope: CHAT, memory: 'user', fileKey: 'inbox/.consolidated/note.md' },
        { caller: READ },
      ),
    ).rejects.toMatchObject({
      payload: { code: 'core.memory.scopeUnavailable' },
    });
  });
});

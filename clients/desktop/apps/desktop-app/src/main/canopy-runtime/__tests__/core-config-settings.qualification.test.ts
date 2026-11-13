import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CONFIG_GRANTS,
  type CanopyCallerDescriptor,
  type ConfigAppAdvisorValue,
} from '@canopy/protocol/canopy-core';
import { DEFAULT_PREFERENCES } from '@canopy/desktop-shared/node/preferences/defaults';
import type { PreferencesData } from '@canopy/desktop-shared/types';
import type { CoreConfigHost } from '../core-config-adapter';
import { createCoreOperationAdapter } from '../core-operation-adapter';
import {
  createDesktopRuntime,
  type DesktopCanopyDispatcher,
} from '../desktop-runtime';
import { LOCAL_DESKTOP_AUTHORITY_ID } from '../desktop-runtime-identity';
import { INTERFACE_RELAY_ALLOWLIST } from '../renderer-relay/interface-allowlist.generated';
import {
  RENDERER_RELAY_SURFACES,
  relayAllows,
} from '../renderer-relay/surface-allowlist';

const caller = (
  grants: CanopyCallerDescriptor['grants'],
): CanopyCallerDescriptor => ({
  principalId: 'local-desktop-user',
  clientInstanceId: 'agent-action:advisor-chat',
  authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
  interfaceKind: 'mcp',
  grants,
});
const READ = caller([CONFIG_GRANTS.read]);
const WRITE = caller([CONFIG_GRANTS.write]);
const meta = (key: string): { idempotencyKey: string } => ({
  idempotencyKey: key,
});

/** Stores that behave like the window's: a serialized commit with a precondition. */
function fakeStores(): {
  host: Partial<CoreConfigHost>;
  stored: { preferences: PreferencesData; appAdvisor: ConfigAppAdvisorValue };
  saves: Array<Partial<PreferencesData>>;
  /** Runs inside the next commit, before its precondition. */
  beforeCommit: { run: () => void };
  flags: { skillSuggestions: boolean };
} {
  const stored: {
    preferences: PreferencesData;
    appAdvisor: ConfigAppAdvisorValue;
  } = {
    preferences: {
      ...DEFAULT_PREFERENCES,
      managedDelegationMode: 'off',
      managedDelegationMaxDepth: 1,
    },
    appAdvisor: { archiveRetentionDays: null, autoArchiveDays: null },
  };
  const saves: Array<Partial<PreferencesData>> = [];
  const beforeCommit = { run: (): void => undefined };
  const flags = { skillSuggestions: true };
  const host: Partial<CoreConfigHost> = {
    readPreferences: () => Promise.resolve({ ...stored.preferences }),
    savePreferences: (patch, precondition) => {
      beforeCommit.run();
      beforeCommit.run = (): void => undefined;
      precondition({ ...stored.preferences });
      saves.push(patch);
      stored.preferences = { ...stored.preferences, ...patch };
      return Promise.resolve({ ...stored.preferences });
    },
    readAppAdvisorSettings: () => Promise.resolve({ ...stored.appAdvisor }),
    saveAppAdvisorSettings: (patch, precondition) => {
      precondition({ ...stored.appAdvisor });
      stored.appAdvisor = { ...stored.appAdvisor, ...patch };
      return Promise.resolve({ ...stored.appAdvisor });
    },
    skillSuggestionsAvailable: () => Promise.resolve(flags.skillSuggestions),
  };
  return { host, stored, saves, beforeCommit, flags };
}

let root: string;
const runtimes: DesktopCanopyDispatcher[] = [];
function runtimeWith(host: Partial<CoreConfigHost>): DesktopCanopyDispatcher {
  const runtime = createDesktopRuntime({
    operationAdapter: createCoreOperationAdapter({
      ledgerPath: () => join(root, `ledger-${runtimes.length}.sqlite`),
    }),
    configHost: host,
    shutdownTimeoutMs: 25,
  });
  runtimes.push(runtime);
  return runtime;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'core-config-settings-'));
});
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.shutdown()));
  rmSync(root, { recursive: true, force: true });
});

describe('core.config settings namespaces on the desktop dispatcher (CAN-6004)', () => {
  it('serves each namespace from its store, and only the allowlisted fields', async () => {
    const { host, stored } = fakeStores();
    stored.preferences = {
      ...stored.preferences,
      claudeMaxTurns: 40,
      accountProxyRouteCodex: false,
      ledgerAgentRecordingEnabled: false,
      profileRole: 'designer',
      navigationMode: 'work',
    };
    stored.appAdvisor = { archiveRetentionDays: 60, autoArchiveDays: null };
    const runtime = runtimeWith(host);
    const get = (namespace: string): Promise<{ value: object }> =>
      runtime.query('core.config.get', { namespace }, { caller: READ });
    await expect(get('agent')).resolves.toMatchObject({
      namespace: 'agent',
      scope: {},
      value: {
        claudeMaxTurns: 40,
        managedDelegationMode: 'off',
        managedDelegationMaxDepth: 1,
      },
      enforcedPaths: [],
    });
    expect((await get('accountProxy')).value).toEqual({
      routeClaude: true,
      routeCodex: false,
      keepChatOnOneAccount: true,
    });
    expect((await get('ledger')).value).toEqual({
      agentRecordingEnabled: false,
    });
    expect((await get('profile')).value).toMatchObject({ role: 'designer' });
    expect((await get('navigation')).value).toEqual({ mode: 'work' });
    expect((await get('appAdvisor')).value).toEqual({
      archiveRetentionDays: 60,
      autoArchiveDays: null,
    });
    // Nothing outside the namespace's schema is answered.
    expect(Object.keys((await get('memory')).value).sort()).toEqual([
      'enabled',
      'model',
      'modelSetByUser',
      'thinkingLevel',
    ]);
    await expect(get('approvals')).rejects.toMatchObject({
      payload: { kind: 'not_found', code: 'core.config.notFound' },
    });
  });

  it('writes a namespace at the revision it read, once per key, and answers what was stored', async () => {
    const { host, stored, saves } = fakeStores();
    const runtime = runtimeWith(host);
    const { revision } = await runtime.query(
      'core.config.get',
      { namespace: 'agent' },
      { caller: READ },
    );
    const params = {
      namespace: 'agent' as const,
      expectedRevision: revision,
      patch: { claudeMaxTurns: 25, managedDelegationMaxDepth: 3 },
      _meta: meta('a1'),
    };
    const first = await runtime.instruction('core.config.update', params, {
      caller: WRITE,
      metadata: meta('a1'),
    });
    const replay = await runtime.instruction('core.config.update', params, {
      caller: WRITE,
      metadata: meta('a1'),
    });
    expect(replay).toEqual(first);
    expect(first.value).toMatchObject({
      claudeMaxTurns: 25,
      managedDelegationMaxDepth: 3,
    });
    expect(first.revision).not.toBe(revision);
    expect(saves).toEqual([
      { claudeMaxTurns: 25, managedDelegationMaxDepth: 3 },
    ]);
    expect(stored.preferences.claudeMaxTurns).toBe(25);
  });

  it('refuses a stale revision inside the commit, so a change after the read is never overwritten', async () => {
    const { host, stored, saves, beforeCommit } = fakeStores();
    const runtime = runtimeWith(host);
    const { revision } = await runtime.query(
      'core.config.get',
      { namespace: 'accountProxy' },
      { caller: READ },
    );
    // Settings changes the routing between the read and the commit.
    beforeCommit.run = (): void => {
      stored.preferences = {
        ...stored.preferences,
        accountProxyRouteClaude: false,
      };
    };
    await expect(
      runtime.instruction(
        'core.config.update',
        {
          namespace: 'accountProxy',
          expectedRevision: revision,
          patch: { routeCodex: false },
          _meta: meta('p1'),
        },
        { caller: WRITE, metadata: meta('p1') },
      ),
    ).rejects.toMatchObject({
      payload: {
        kind: 'conflict',
        code: 'core.config.revisionConflict',
        retry: { kind: 'after_refresh', resource: 'core.config.get' },
      },
    });
    expect(saves).toEqual([]);
    expect(stored.preferences.accountProxyRouteCodex).not.toBe(false);
  });

  it('checks values as Settings does, before anything is written', async () => {
    const { host, saves, flags } = fakeStores();
    const runtime = runtimeWith(host);
    const update = async (
      namespace: 'agent' | 'memory' | 'profile' | 'appAdvisor',
      patch: Record<string, unknown>,
      key: string,
    ): Promise<unknown> => {
      const { revision } = await runtime.query(
        'core.config.get',
        { namespace },
        { caller: READ },
      );
      return runtime.instruction(
        'core.config.update',
        // The schema checks the patch's shape; these values pass it.
        { namespace, expectedRevision: revision, patch, _meta: meta(key) },
        { caller: WRITE, metadata: meta(key) },
      );
    };
    for (const [namespace, patch, key] of [
      ['agent', { handoffSummaryModel: 'not-a-model' }, 'v1'],
      ['agent', { managedDelegationMaxDepth: 99 }, 'v2'],
      ['agent', { claudeMaxTurns: 100000 }, 'v3'],
      ['memory', { model: 'not-a-model' }, 'v4'],
      ['profile', { roleDetail: 'Sculptor' }, 'v5'],
      ['appAdvisor', { archiveRetentionDays: 100000 }, 'v6'],
    ] as const)
      await expect(update(namespace, patch, key)).rejects.toMatchObject({
        payload: { kind: 'invalid_argument' },
      });
    flags.skillSuggestions = false;
    await expect(
      update('profile', { skillSuggestionsEnabled: true }, 'v7'),
    ).rejects.toMatchObject({
      payload: {
        kind: 'failed_precondition',
        code: 'core.config.invalidState',
      },
    });
    expect(saves).toEqual([]);
  });

  it('keeps a role detail for `other` only, as Settings and onboarding do', async () => {
    const { host, saves } = fakeStores();
    const runtime = runtimeWith(host);
    for (const [patch, key] of [
      [{ role: 'other', roleDetail: 'Sculptor' }, 'r1'],
      [{ role: 'other' }, 'r2'],
      [{ role: 'designer', roleDetail: 'ignored' }, 'r3'],
    ] as const) {
      const { revision } = await runtime.query(
        'core.config.get',
        { namespace: 'profile' },
        { caller: READ },
      );
      await runtime.instruction(
        'core.config.update',
        {
          namespace: 'profile',
          expectedRevision: revision,
          patch,
          _meta: meta(key),
        },
        { caller: WRITE, metadata: meta(key) },
      );
    }
    expect(saves).toEqual([
      {
        profileRole: 'other',
        profileRoles: ['other'],
        profileRoleDetail: 'Sculptor',
      },
      { profileRole: 'other', profileRoles: ['other'] },
      {
        profileRole: 'designer',
        profileRoles: ['designer'],
        profileRoleDetail: '',
      },
    ]);
  });

  it("refuses a write without the operation's grant before any store is touched", async () => {
    const { host, saves } = fakeStores();
    const runtime = runtimeWith(host);
    const { revision } = await runtime.query(
      'core.config.get',
      { namespace: 'navigation' },
      { caller: READ },
    );
    await expect(
      runtime.instruction(
        'core.config.update',
        {
          namespace: 'navigation',
          expectedRevision: revision,
          patch: { mode: 'work' },
          _meta: meta('g1'),
        },
        { caller: READ, metadata: meta('g1') },
      ),
    ).rejects.toMatchObject({ payload: { kind: 'permission_denied' } });
    expect(saves).toEqual([]);
  });

  it('no renderer relay can write settings; the read it exposed still reaches it', () => {
    for (const mode of Object.values(INTERFACE_RELAY_ALLOWLIST))
      for (const operations of Object.values(mode))
        expect(operations).not.toContain('core.config.update');
    for (const surface of RENDERER_RELAY_SURFACES)
      expect(relayAllows(surface, 'instruction', 'core.config.update')).toBe(
        false,
      );
    expect(relayAllows('main', 'query', 'core.config.get')).toBe(true);
  });
});

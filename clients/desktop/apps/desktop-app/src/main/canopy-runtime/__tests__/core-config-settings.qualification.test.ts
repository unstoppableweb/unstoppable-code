import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CONFIG_GRANTS,
  CONFIG_WRITABLE_NAMESPACES,
  ConfigUpdateParamsSchema,
  type CanopyCallerDescriptor,
  type ConfigAppAdvisorValue,
} from '@canopy/protocol/canopy-core';
import { DEFAULT_PREFERENCES } from '@canopy/desktop-shared/node/preferences/defaults';
import { normalizePreferences } from '@canopy/desktop-shared/node/preferences/normalize-preferences';
import {
  applyOnboardingTipsUpdate,
  parseOnboardingTipsState,
} from '@canopy/protocol/onboarding-tips';
import {
  applySuggestionsUpdate,
  parseSuggestionsState,
} from '@canopy/protocol/suggestions';
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
  flags: { skillSuggestions: boolean; preferencesLoadFailed: boolean };
  reads: { count: number };
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
  const flags = { skillSuggestions: true, preferencesLoadFailed: false };
  const reads = { count: 0 };
  const host: Partial<CoreConfigHost> = {
    readPreferences: () => {
      reads.count++;
      return Promise.resolve({ ...stored.preferences });
    },
    preferencesLoadFailed: () => Promise.resolve(flags.preferencesLoadFailed),
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
  return { host, stored, saves, beforeCommit, flags, reads };
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

describe('read-only onboardingTips and suggestions namespaces (CAN-7434)', () => {
  const get = (
    runtime: DesktopCanopyDispatcher,
    namespace: string,
    as = READ,
  ): Promise<{ value: object; revision: number }> =>
    runtime.query('core.config.get', { namespace }, { caller: as });
  const DISMISSED_AT = '2026-11-01T10:00:00.000Z';

  it('answers only the tips or suggestions fields, never another preference', async () => {
    const { host, stored } = fakeStores();
    stored.preferences = {
      ...stored.preferences,
      claudeMaxTurns: 40,
      onboardingTipsDismissed: { 'worktree-chat': DISMISSED_AT },
      suggestions: {
        enabled: false,
        dismissed: { 'plan-mode-hint': DISMISSED_AT },
        lastCornerShownAt: DISMISSED_AT,
      },
    };
    const runtime = runtimeWith(host);
    await expect(get(runtime, 'onboardingTips')).resolves.toMatchObject({
      namespace: 'onboardingTips',
      scope: {},
      enforcedPaths: [],
      value: { dismissed: { 'worktree-chat': DISMISSED_AT } },
    });
    expect((await get(runtime, 'onboardingTips')).value).toEqual({
      dismissed: { 'worktree-chat': DISMISSED_AT },
    });
    expect((await get(runtime, 'suggestions')).value).toEqual({
      enabled: false,
      dismissed: { 'plan-mode-hint': DISMISSED_AT },
      lastCornerShownAt: DISMISSED_AT,
    });
  });

  it('answers what preferences:load projects for the same stored preferences, defaults and the legacy switch included', async () => {
    const { host, stored } = fakeStores();
    const runtime = runtimeWith(host);
    const projected = (): PreferencesData =>
      normalizePreferences(stored.preferences);
    const defaults = await get(runtime, 'suggestions');
    expect(defaults.value).toEqual({ enabled: true, dismissed: {} });
    expect('lastCornerShownAt' in defaults.value).toBe(false);
    expect((await get(runtime, 'onboardingTips')).value).toEqual({
      dismissed: {},
    });
    expect(parseSuggestionsState(defaults.value)).toEqual(
      projected().suggestions,
    );
    // An older file: no suggestions record, only the retired repeat-task switch.
    const olderFile: Record<string, unknown> = {
      ...stored.preferences,
      repeatTaskAutomationSuggestionsEnabled: false,
    };
    delete olderFile.suggestions;
    stored.preferences = normalizePreferences(olderFile);
    const folded = await get(runtime, 'suggestions');
    expect(folded.value).toEqual({ enabled: false, dismissed: {} });
    expect(parseSuggestionsState(folded.value)).toEqual(
      projected().suggestions,
    );
  });

  it('drops a retired id and a malformed stamp from stored state instead of refusing', async () => {
    const { host, stored } = fakeStores();
    const tolerated: Record<string, unknown> = {
      'worktree-chat': DISMISSED_AT,
      'retired-tip': DISMISSED_AT,
      workflows: 12,
    };
    const suggestions: Record<string, unknown> = {
      enabled: true,
      dismissed: {
        'plan-mode-hint': DISMISSED_AT,
        'retired-suggestion': DISMISSED_AT,
        'skill-share': 'yesterday',
      },
      lastCornerShownAt: 'not a time',
      extra: true,
    };
    Object.assign(stored.preferences, {
      onboardingTipsDismissed: tolerated,
      suggestions,
    });
    const runtime = runtimeWith(host);
    expect((await get(runtime, 'onboardingTips')).value).toEqual({
      dismissed: { 'worktree-chat': DISMISSED_AT },
    });
    expect((await get(runtime, 'suggestions')).value).toEqual({
      enabled: true,
      dismissed: { 'plan-mode-hint': DISMISSED_AT },
    });
  });

  it('keeps the revision across equal reads and changes it after a write, which the next read returns', async () => {
    const { host, stored } = fakeStores();
    const runtime = runtimeWith(host);
    const tipsBefore = await get(runtime, 'onboardingTips');
    expect((await get(runtime, 'onboardingTips')).revision).toBe(
      tipsBefore.revision,
    );
    const now = new Date(DISMISSED_AT);
    stored.preferences = {
      ...stored.preferences,
      onboardingTipsDismissed: applyOnboardingTipsUpdate(
        stored.preferences.onboardingTipsDismissed,
        { action: 'dismiss', tipId: 'worktree-chat' },
        now,
      ),
    };
    const tipsAfter = await get(runtime, 'onboardingTips');
    expect(tipsAfter.revision).not.toBe(tipsBefore.revision);
    expect(parseOnboardingTipsState(tipsAfter.value)).toEqual({
      dismissed: normalizePreferences(stored.preferences)
        .onboardingTipsDismissed,
    });

    const suggestionsBefore = await get(runtime, 'suggestions');
    stored.preferences = {
      ...stored.preferences,
      suggestions: applySuggestionsUpdate(
        stored.preferences.suggestions,
        { action: 'dismiss', suggestionId: 'plan-mode-hint' },
        now,
      ),
    };
    const suggestionsAfter = await get(runtime, 'suggestions');
    expect(suggestionsAfter.revision).not.toBe(suggestionsBefore.revision);
    expect(parseSuggestionsState(suggestionsAfter.value)).toEqual(
      normalizePreferences(stored.preferences).suggestions,
    );
  });

  it('refuses while preferences could not be loaded, and reads again once that clears', async () => {
    const { host, stored, flags } = fakeStores();
    stored.preferences = {
      ...stored.preferences,
      onboardingTipsDismissed: { 'worktree-chat': DISMISSED_AT },
    };
    flags.preferencesLoadFailed = true;
    const runtime = runtimeWith(host);
    for (const namespace of ['onboardingTips', 'suggestions'])
      await expect(get(runtime, namespace)).rejects.toMatchObject({
        payload: {
          kind: 'failed_precondition',
          code: 'core.config.invalidState',
        },
      });
    flags.preferencesLoadFailed = false;
    expect((await get(runtime, 'onboardingTips')).value).toEqual({
      dismissed: { 'worktree-chat': DISMISSED_AT },
    });
  });

  it('refuses a caller without the read grant before preferences are read', async () => {
    const { host, reads } = fakeStores();
    const runtime = runtimeWith(host);
    for (const namespace of ['onboardingTips', 'suggestions'])
      await expect(get(runtime, namespace, WRITE)).rejects.toMatchObject({
        payload: { kind: 'permission_denied' },
      });
    expect(reads.count).toBe(0);
  });

  it('leaves both namespaces out of core.config.update, so an update naming either is refused at its schema', async () => {
    const { host } = fakeStores();
    const runtime = runtimeWith(host);
    for (const namespace of ['onboardingTips', 'suggestions']) {
      expect(CONFIG_WRITABLE_NAMESPACES).not.toContain(namespace);
      const { revision } = await get(runtime, namespace);
      expect(
        ConfigUpdateParamsSchema.safeParse({
          namespace,
          expectedRevision: revision,
          patch: { dismissed: {} },
          _meta: meta(`ro-${namespace}`),
        }).success,
      ).toBe(false);
    }
  });
});

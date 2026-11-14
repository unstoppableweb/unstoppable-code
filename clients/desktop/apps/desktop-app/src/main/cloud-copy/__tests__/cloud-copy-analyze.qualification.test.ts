/**
 * The consent dialog's cloud-copy analysis (CAN-6176 9c): the renderer names
 * a desktop catalog entry only, and main finds the files itself; only a
 * custom skill or an installed plugin that isn't built in or curated can be
 * analysed; only the main window may ask, and only for the account the cloud
 * chat belongs to.
 */
import type { PipelinePackageAnalysisSummary } from '@canopy/protocol/pipelines';
import type { ShareRemoteMetadata } from '@canopy/protocol/sharing';
import type { InstalledSkillInfo } from '@canopy/protocol/skills';
import type { CloudCopyAudience } from '@canopy/desktop-shared/types';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import {
  analyzeForCloudCopy,
  type AnalyzeForCloudCopyDeps,
} from '../analyze-for-cloud-copy';

const handlers = new Map<string, (event: unknown, raw: unknown) => unknown>();
jest.mock('../../ipc/register', () => ({
  registerIpcHandler: (
    channel: string,
    handler: (event: unknown, raw: unknown) => unknown,
  ): void => {
    handlers.set(channel, handler);
  },
}));
let mockCloudChatsEnabled = true;
jest.mock('../../ipc/cloud-chats', () => ({
  cloudChatsEnabled: (): boolean => mockCloudChatsEnabled,
  signedInAccountId: (): Promise<string | null> => Promise.resolve('acct-1'),
}));

import { registerCloudCopyHandlers } from '../../ipc/cloud-copy';

const SUMMARY = { analysisId: 'a-1' } as PipelinePackageAnalysisSummary;

function fakes(
  skills: readonly InstalledSkillInfo[] = [],
  live: (
    skillId: string,
    accountId: string,
  ) => Promise<CloudCopyAudience | null> = () => Promise.resolve('private'),
): {
  deps: AnalyzeForCloudCopyDeps;
  calls: { skills: unknown[]; plugins: unknown[] };
} {
  const calls = { skills: [] as unknown[], plugins: [] as unknown[] };
  return {
    calls,
    deps: {
      loadSkills: () => Promise.resolve(skills),
      linkedCopyAudience: live,
      readRawSkill: (localId) =>
        localId === 'custom:app/helper'
          ? Promise.resolve('---\nname: helper\n---\nHelp.\n')
          : Promise.reject(new Error('missing')),
      analyzeSkill: (request) => {
        calls.skills.push(request);
        return Promise.resolve(SUMMARY);
      },
      marketplaces: () =>
        Promise.resolve([
          { id: 'local-tools', plugins: [{ name: 'notes' }] },
          { id: 'builtin', builtIn: true, plugins: [{ name: 'core' }] },
          { id: 'curated', curated: true, plugins: [{ name: 'picked' }] },
        ]),
      analyzePlugin: (request) => {
        calls.plugins.push(request);
        return Promise.resolve(SUMMARY);
      },
    },
  };
}

describe('the cloud-copy analysis of a desktop entry (CAN-6176 9c)', () => {
  it('reads a custom skill and an installed plugin in main, from the entry id alone', async () => {
    const { deps, calls } = fakes();
    await expect(
      analyzeForCloudCopy('skill:custom:app/helper', 'acct-1', deps),
    ).resolves.toEqual({ ok: true, analysis: SUMMARY, audience: 'private' });
    expect(calls.skills).toEqual([
      {
        sourceId: 'custom:app',
        skillName: 'helper',
        rawSkill: '---\nname: helper\n---\nHelp.\n',
      },
    ]);
    await expect(
      analyzeForCloudCopy('plugin:local-tools/notes', 'acct-1', deps),
    ).resolves.toEqual({ ok: true, analysis: SUMMARY, audience: 'private' });
    expect(calls.plugins).toEqual([
      { marketplaceId: 'local-tools', pluginName: 'notes' },
    ]);
  });

  it("names a linked skill copy's audience as the cloud has it now, as the publish checks it", async () => {
    const skill = (remote?: ShareRemoteMetadata): InstalledSkillInfo =>
      ({
        name: 'helper',
        sourceId: 'custom:app',
        ...(remote === undefined ? {} : { remote }),
      }) as InstalledSkillInfo;
    // As the desktop writes it: a public share stores 'private' and no link.
    const link = (
      overrides: Partial<ShareRemoteMetadata> = {},
    ): ShareRemoteMetadata => ({
      accountId: 'acct-1',
      remoteId: 'remote-1',
      contentHash: 'c'.repeat(64),
      shareScope: 'private',
      sharedAt: '2026-11-13T00:00:00.000Z',
      ...overrides,
    });
    const asked: string[] = [];
    const audience = async (
      remote: ShareRemoteMetadata | undefined,
      live: () => Promise<CloudCopyAudience | null>,
    ): Promise<unknown> => {
      const result = await analyzeForCloudCopy(
        'skill:custom:app/helper',
        'acct-1',
        fakes([skill(remote)], (skillId, accountId) => {
          asked.push(`${skillId}@${accountId}`);
          return live();
        }).deps,
      );
      return result.ok ? result.audience : null;
    };
    // Unlinked: a new private copy, and the cloud isn't asked.
    await expect(
      audience(undefined, () => Promise.resolve('team')),
    ).resolves.toBe('private');
    expect(asked).toEqual([]);
    // The local link says private; the cloud has a public link, or a scope
    // changed on the web. The dialog shows what the publish will find.
    for (const now of ['public_link', 'team', 'organization'] as const)
      await expect(audience(link(), () => Promise.resolve(now))).resolves.toBe(
        now,
      );
    expect(asked).toContain('remote-1@acct-1');
    // Gone from the cloud: the publish makes a new private copy.
    await expect(audience(link(), () => Promise.resolve(null))).resolves.toBe(
      'private',
    );
    // Unreadable: the local scope stands, and the publish checks again.
    await expect(
      audience(link({ shareScope: 'team' }), () =>
        Promise.reject(new Error('offline')),
      ),
    ).resolves.toBe('team');
    // Another account's link isn't a copy this publish would update.
    asked.length = 0;
    await expect(
      audience(link({ shareScope: 'team', accountId: 'acct-2' }), () =>
        Promise.resolve('team'),
      ),
    ).resolves.toBe('private');
    expect(asked).toEqual([]);
  });

  it('refuses built-in, curated, project and unknown entries before analysing', async () => {
    const { deps, calls } = fakes();
    for (const [entryId, reason] of [
      ['plugin:builtin/core', 'unsupported'],
      ['plugin:curated/picked', 'unsupported'],
      ['skill:project:repo/helper', 'unsupported'],
      ['mcp_server:s/c', 'unsupported'],
      ['skill:custom:app/gone', 'not-found'],
      ['skill:custom:app/a/../b', 'not-found'],
      ['plugin:local-tools/missing', 'not-found'],
    ] as const)
      await expect(
        analyzeForCloudCopy(entryId, 'acct-1', deps),
      ).resolves.toEqual({
        ok: false,
        reason,
      });
    expect(calls).toEqual({ skills: [], plugins: [] });
  });

  it('answers only the main window, for the cloud chat’s own account', async () => {
    const analyze = jest.fn(() =>
      Promise.resolve({
        ok: true as const,
        analysis: SUMMARY,
        audience: 'team' as const,
      }),
    );
    const bound: [string, string, string][] = [];
    registerCloudCopyHandlers(
      (event) =>
        ({
          surface: (event as unknown) === 'main-window' ? 'main' : 'other',
        }) as never,
      analyze,
      () => Promise.resolve('acct-1'),
      (analysisId, accountId, audience) =>
        bound.push([analysisId, accountId, audience]),
    );
    const handler = handlers.get(IPC_CHANNELS.cloudCopyAnalyze);
    if (handler === undefined) throw new Error('no handler');
    const request = {
      entryId: 'plugin:local-tools/notes',
      expectedAccountId: 'acct-1',
    };

    await expect(
      Promise.resolve().then(() => handler('another-window', request)),
    ).rejects.toThrow('Untrusted');
    await expect(
      handler('main-window', { ...request, expectedAccountId: 'acct-2' }),
    ).resolves.toEqual({ ok: false, reason: 'account-mismatch' });
    mockCloudChatsEnabled = false;
    await expect(handler('main-window', request)).resolves.toEqual({
      ok: false,
      reason: 'disabled',
    });
    expect(analyze).not.toHaveBeenCalled();
    mockCloudChatsEnabled = true;
    await expect(handler('main-window', request)).resolves.toEqual({
      ok: true,
      analysis: SUMMARY,
      audience: 'team',
    });
    expect(analyze).toHaveBeenCalledWith('plugin:local-tools/notes', 'acct-1');
    // The analysis is bound to the account it was issued for, so its publish
    // can go nowhere else; a refused request binds nothing.
    // And to the audience its dialog showed.
    expect(bound).toEqual([[SUMMARY.analysisId, 'acct-1', 'team']]);
  });
});

/**
 * CAN-6900: a watcher's background authorization reads local inventories
 * (the plugin catalog, the skill inventory, the agent models file). One that
 * isn't ready is a transient refusal that is retried within a bound; one
 * that won't clear by itself refuses for good with copy naming the cause.
 * Neither is ever a grant, and neither reads as an unknown provenance.
 * CAN-4481: a damaged or newer plugin catalog is read as-is, so it never
 * refuses by itself; a plugin it can't decode is missing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { getDataDir } from '../../lib/paths';

jest.mock('../../feature-flags', () => ({
  getFeatureFlagService: (): { isEnabled: () => boolean } => ({
    isEnabled: (): boolean => true,
  }),
}));

type SkillsResult = { success: boolean; data?: unknown[]; error?: string };
const loadSkillsMock = jest.fn<SkillsResult, []>();
jest.mock('../../skills/skill-service', () => ({
  loadSkills: (): SkillsResult => loadSkillsMock(),
}));

import { backgroundExecutionDeniedMessage } from '@canopy/desktop-shared/node/background-execution-context';
import type { ResourceContextDecision } from '@canopy/execution-engine/lib/resource-context-policy';
import { createBackgroundCapabilityResolver } from '../background-capability-context';
import { authorizeBackgroundExecution } from '../background-execution-context';
import {
  retryTransientAuthorization,
  WATCHER_AUTHORIZATION_RETRY_DELAYS_MS,
} from '../background-authorization-retry';

const grant = (): Promise<ResourceContextDecision> =>
  Promise.resolve({ allow: true });

function writeData(name: string, content: string): void {
  fs.mkdirSync(getDataDir(), { recursive: true });
  fs.writeFileSync(path.join(getDataDir(), name), content);
}

const pluginSelected = {
  selections: {
    collectionIds: [],
    skillRefs: [],
    pluginRefs: [{ marketplaceId: 'market', pluginName: 'plugin' }],
  },
};
const skillSelected = {
  selections: {
    collectionIds: [],
    skillRefs: [{ sourceId: 'local', skillName: 'notes' }],
    pluginRefs: [],
  },
};

const notReady: ResourceContextDecision = {
  allow: false,
  reason: 'unknown-provenance',
  transient: true,
};

beforeEach(() => {
  for (const name of [
    'plugins-cache.json',
    'plugin-cache-index.json',
    'agent-models.json',
  ])
    fs.rmSync(path.join(getDataDir(), name), { force: true });
  loadSkillsMock.mockReset();
  loadSkillsMock.mockReturnValue({ success: true, data: [] });
});

describe('a watcher authorization inventory that is not ready (CAN-6900)', () => {
  const subjectNameMatcher: unknown = expect.any(String);

  it('a damaged catalog is read as-is: a plugin it cannot decode is missing, never a grant', async () => {
    writeData(
      'plugins-cache.json',
      JSON.stringify({
        version: 2,
        lastRefreshed: '2026-11-18T00:00:00Z',
        marketplaces: [null, { id: 'market', plugins: 'wrong' }],
      }),
    );
    await expect(
      createBackgroundCapabilityResolver(grant)(pluginSelected),
    ).resolves.toEqual({
      allow: false,
      reason: 'missing-dependency',
      subject: { kind: 'plugin', name: subjectNameMatcher },
    });
  });

  it('a catalog a newer build wrote is read as-is rather than refused', async () => {
    writeData(
      'plugins-cache.json',
      JSON.stringify({
        version: 3,
        lastRefreshed: '2026-11-18T00:00:00Z',
        marketplaces: [],
      }),
    );
    await expect(
      createBackgroundCapabilityResolver(grant)(pluginSelected),
    ).resolves.toEqual({
      allow: false,
      reason: 'missing-dependency',
      subject: { kind: 'plugin', name: subjectNameMatcher },
    });
  });

  it('a skill inventory that failed to load is retried', async () => {
    loadSkillsMock.mockReturnValue({ success: false, error: 'busy' });
    await expect(
      createBackgroundCapabilityResolver(grant)(skillSelected),
    ).resolves.toEqual(notReady);
  });

  it('an agent models file not written yet, or read mid-write, is retried', async () => {
    const resolve = createBackgroundCapabilityResolver(grant);
    await expect(resolve({ model: 'agent_model_a' })).resolves.toEqual(
      notReady,
    );
    writeData('agent-models.json', '{"version":1,"agents":[');
    await expect(
      createBackgroundCapabilityResolver(grant)({ model: 'agent_model_a' }),
    ).resolves.toEqual(notReady);
  });

  it('reaches the watcher as a transient refusal, not a final unknown provenance', async () => {
    const decision = await authorizeBackgroundExecution(
      undefined,
      [
        {
          owner: undefined,
          requiresHostAuthorization: true,
          capabilities: { model: 'agent_model_a' },
        },
      ],
      { scope: 'global' },
    );
    expect(decision).toEqual(notReady);
  });
});

describe('a watcher authorization inventory that will not clear by itself (CAN-6900)', () => {
  it('a newer-build refusal is not retried', async () => {
    expect(backgroundExecutionDeniedMessage('plugin-catalog-newer')).toBe(
      "The plugin catalog was written by a newer version of the app, so this didn't run. Update the app to run it.",
    );
    const decide = jest.fn(
      (): Promise<ResourceContextDecision> =>
        Promise.resolve({ allow: false, reason: 'plugin-catalog-newer' }),
    );
    const sleep = jest.fn((): Promise<void> => Promise.resolve());
    await expect(retryTransientAuthorization(decide, sleep)).resolves.toEqual({
      allow: false,
      reason: 'plugin-catalog-newer',
    });
    expect(decide).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});

describe('bounded retries for a watcher authorization (CAN-6900)', () => {
  it('asks again with backoff and takes the answer once the inventory is ready', async () => {
    const answers: ResourceContextDecision[] = [
      notReady,
      notReady,
      { allow: true },
    ];
    const sleeps: number[] = [];
    await expect(
      retryTransientAuthorization(
        () => Promise.resolve(answers.shift() ?? notReady),
        (ms) => {
          sleeps.push(ms);
          return Promise.resolve();
        },
      ),
    ).resolves.toEqual({ allow: true });
    expect(sleeps).toEqual(WATCHER_AUTHORIZATION_RETRY_DELAYS_MS.slice(0, 2));
  });

  it('reports the refusal once the budget is spent', async () => {
    const decide = jest.fn(() => Promise.resolve(notReady));
    await expect(
      retryTransientAuthorization(decide, () => Promise.resolve()),
    ).resolves.toEqual(notReady);
    expect(decide).toHaveBeenCalledTimes(
      WATCHER_AUTHORIZATION_RETRY_DELAYS_MS.length + 1,
    );
  });

  it('a catalog still damaged after the budget is damaged, and refuses for good', async () => {
    await expect(
      retryTransientAuthorization(
        () =>
          Promise.resolve({
            allow: false,
            reason: 'plugin-catalog-damaged',
            transient: true,
          }),
        () => Promise.resolve(),
      ),
    ).resolves.toEqual({ allow: false, reason: 'plugin-catalog-damaged' });
    expect(backgroundExecutionDeniedMessage('plugin-catalog-damaged')).toBe(
      "The plugin catalog is damaged, so this didn't run.",
    );
  });
});

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CanopyOperationError,
  createCanopyDispatcher,
} from '@canopy/core-runtime';
import {
  CatalogMutationRuns,
  CatalogSkillRefusedError,
  createCoreSkillCatalogHandlers,
  type CoreSkillCatalogHost,
} from '@canopy/core-runtime/node/catalog';
import { OperationService } from '@canopy/core-runtime/node/operations';
import { OperationLedger } from '@canopy/core-runtime/node/operations/ledger';
import {
  CORE_CATALOG_SKILL_INSTRUCTION_DEFINITIONS,
  CORE_CATALOG_SKILL_QUERY_DEFINITIONS,
  type CatalogSkillRow,
} from '@canopy/protocol/canopy-core';
import { SKILLS_CHANNELS } from '@canopy/desktop-shared/constants/skill-channels';

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;
const mockHandlers = new Map<string, Handler>();
let mockDispatcher: ReturnType<typeof composeDispatcher> | null = null;
let mockRuntimeOverride: unknown = null;

jest.mock('electron', () => ({
  BrowserWindow: { getAllWindows: (): unknown[] => [] },
}));
jest.mock('../../ipc/register', () => ({
  registerIpcHandler: (channel: string, handler: Handler): void => {
    mockHandlers.set(channel, handler);
  },
}));
jest.mock('../../canopy-runtime/desktop-runtime-access', () => ({
  getDesktopCanopyRuntime: (): unknown => mockRuntimeOverride ?? mockDispatcher,
}));
jest.mock('../../lib/web-contents-send', () => ({
  sendToWebContents: (
    sender: { send: (channel: string, payload: unknown) => void },
    channel: string,
    payload: unknown,
  ): void => sender.send(channel, payload),
}));
jest.mock('../../plugins/invocable-inventory-service', () => ({
  refreshInvocableInventoryAfterMutation: jest.fn(),
}));
jest.mock('../skill-service', () => ({
  saveCustomSkill: jest.fn(() =>
    Promise.resolve({ success: true, data: { name: 'n' } }),
  ),
  installSkills: jest.fn(),
  removeSkillForContext: jest.fn(),
  updateSkill: jest.fn(),
  checkUpdates: jest.fn(),
  fetchAvailable: jest.fn(),
  listSkillFiles: jest.fn(),
  readSkillFile: jest.fn(),
  readSkillContent: jest.fn(),
  loadSkills: jest.fn(),
}));
jest.mock('../skill-install-context', () => ({
  ...jest.requireActual<object>('../skill-install-context'),
  assertStoredSkillContext: jest.fn(() => Promise.resolve()),
}));

import { SkillServiceResultError } from '../../canopy-runtime/core-skill-catalog-host';
import { readRemoteControlSkill } from '../../services/plugin-catalog-service';
import {
  installSkills,
  readSkillContent,
  saveCustomSkill,
} from '../skill-service';
import { registerSkillHandlers } from '../skill-handlers';

const fakeHost = {
  list: jest.fn(),
  read: jest.fn(),
  listFiles: jest.fn(),
  readFile: jest.fn(),
  discover: jest.fn(),
  install: jest.fn(),
  update: jest.fn(),
  remove: jest.fn(),
  saveCustom: jest.fn(),
  checkUpdates: jest.fn(),
} satisfies Record<keyof CoreSkillCatalogHost, jest.Mock>;

let root: string;
let operations: OperationService;

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- the dispatcher type is inferred from its definitions
function composeDispatcher(service: OperationService) {
  return createCanopyDispatcher({
    profile: 'core',
    definitions: {
      queries: CORE_CATALOG_SKILL_QUERY_DEFINITIONS,
      instructions: CORE_CATALOG_SKILL_INSTRUCTION_DEFINITIONS,
      streams: {},
    },
    handlers: {
      ...createCoreSkillCatalogHandlers({
        host: fakeHost,
        runs: new CatalogMutationRuns({ operations: service }),
      }),
      streams: {},
    },
  });
}

function handler(channel: string): Handler {
  const found = mockHandlers.get(channel);
  if (!found) throw new Error(`no handler for ${channel}`);
  return found;
}

beforeAll(() => {
  registerSkillHandlers();
});
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'can-4124-'));
  const ledgerPath = join(root, 'ledger.sqlite');
  operations = new OperationService({
    openLedger: (): OperationLedger => OperationLedger.open(ledgerPath),
  });
  mockDispatcher = composeDispatcher(operations);
  for (const mock of Object.values(fakeHost)) mock.mockReset();
  jest.mocked(saveCustomSkill).mockClear();
  jest.mocked(installSkills).mockClear();
});
afterEach(() => {
  operations.close();
  rmSync(root, { recursive: true, force: true });
});

describe('skill IPC and Portal through core (CAN-4124)', () => {
  it('keeps resolved failures and their text', async () => {
    fakeHost.remove.mockRejectedValue(
      new CatalogSkillRefusedError(
        'skill-read-only',
        new SkillServiceResultError('Built-in skills cannot be removed.'),
      ),
    );
    await expect(
      handler(SKILLS_CHANNELS.REMOVE)({}, 'builtin:app', 'b'),
    ).resolves.toEqual({
      success: false,
      error: 'Built-in skills cannot be removed.',
    });
  });

  it('keeps rejected guard errors', async () => {
    fakeHost.update.mockRejectedValue(
      new CatalogSkillRefusedError(
        'skill-context-refused',
        new Error('Skill unavailable (access-removed)'),
      ),
    );
    await expect(
      handler(SKILLS_CHANNELS.UPDATE)({}, 'github:o:r', 'x'),
    ).rejects.toThrow('Skill unavailable (access-removed)');
  });

  it('routes custom saves with non-JSON metadata to the direct path', async () => {
    const dated = {
      name: 'n',
      description: 'd',
      body: 'b',
      preservedMetadata: { created: new Date(0) },
    };
    await handler(SKILLS_CHANNELS.SAVE_CUSTOM)({}, dated);
    expect(fakeHost.saveCustom).not.toHaveBeenCalled();
    expect(jest.mocked(saveCustomSkill).mock.calls[0]?.[0]).toBe(dated);

    fakeHost.saveCustom.mockResolvedValue({ skillName: 'n' });
    await expect(
      handler(SKILLS_CHANNELS.SAVE_CUSTOM)(
        {},
        {
          name: 'n',
          description: 'd',
          body: 'b',
          preservedMetadata: { tags: ['a'] },
        },
      ),
    ).resolves.toEqual({ success: true, data: { name: 'n' } });
    expect(fakeHost.saveCustom).toHaveBeenCalledTimes(1);
    expect(fakeHost.saveCustom).toHaveBeenCalledWith(
      expect.objectContaining({
        preservedMetadata: { tags: ['a'] },
        files: null,
      }),
    );
  });

  it('saves metadata past the old wire bound through the core and refuses saves past the new one (CAN-5873)', async () => {
    fakeHost.saveCustom.mockResolvedValue({ skillName: 'n' });
    const notes = 'x'.repeat(40_000);
    await expect(
      handler(SKILLS_CHANNELS.SAVE_CUSTOM)(
        {},
        {
          name: 'n',
          description: 'd',
          body: 'b',
          preservedMetadata: { notes },
        },
      ),
    ).resolves.toEqual({ success: true, data: { name: 'n' } });
    expect(fakeHost.saveCustom).toHaveBeenCalledWith(
      expect.objectContaining({ preservedMetadata: { notes } }),
    );

    const refusals: [Record<string, unknown>, string][] = [
      [
        { body: 'x'.repeat(2_000_001) },
        'Skill instructions can be up to 2,000,000 characters.',
      ],
      [
        { files: [{ path: 'notes.md', content: 'x'.repeat(2_000_001) }] },
        '"notes.md" is too large. Files can be up to 2,000,000 characters.',
      ],
      [
        { preservedMetadata: { notes: 'x'.repeat(262_143) } },
        'The "notes" metadata value is too large to save.',
      ],
    ];
    for (const [fields, error] of refusals)
      await expect(
        handler(SKILLS_CHANNELS.SAVE_CUSTOM)(
          {},
          { name: 'n', description: 'd', body: 'b', ...fields },
        ),
      ).resolves.toEqual({ success: false, error });
    expect(fakeHost.saveCustom).toHaveBeenCalledTimes(1);
    expect(saveCustomSkill).not.toHaveBeenCalled();
  });

  it("reports update checks with today's progress events", async () => {
    fakeHost.checkUpdates.mockResolvedValue([
      { sourceId: 'github:o:r', skillName: 'x', updateAvailable: true },
      { sourceId: 'github:o:r', skillName: 'y', updateAvailable: false },
    ]);
    const row = (
      skillName: string,
      origin: CatalogSkillRow['origin'],
      updateAvailable: boolean,
    ): CatalogSkillRow => ({
      entryId: `skill:github:o:r/${skillName}`,
      sourceId: 'github:o:r',
      skillName,
      description: '',
      source: 'o/r',
      origin,
      installedAt: '',
      updatedAt: '',
      updateAvailable,
      version: null,
    });
    // CAN-5898: the map comes from the list the check updated, so the
    // false entry that clears an old positive survives a compact result.
    fakeHost.list.mockResolvedValue([
      row('x', 'installed', true),
      row('y', 'installed', false),
      row('b', 'builtin', false),
    ]);
    const updateMap = { 'github:o:r/x': true, 'github:o:r/y': false };
    const send = jest.fn();
    await expect(
      handler(SKILLS_CHANNELS.CHECK_UPDATES)({ sender: { send } }),
    ).resolves.toEqual({ success: true, data: updateMap });
    expect(send.mock.calls).toEqual([
      [
        SKILLS_CHANNELS.UPDATE_PROGRESS,
        {
          operation: 'check-updates',
          status: 'running',
          message: 'Checking installed skills for updates...',
        },
      ],
      [
        SKILLS_CHANNELS.UPDATE_PROGRESS,
        {
          operation: 'check-updates',
          status: 'complete',
          message: 'Skill update check complete.',
          updateMap,
        },
      ],
    ]);
  });

  it('ends a failed update check with its error event', async () => {
    fakeHost.checkUpdates.mockRejectedValue(new Error('network down'));
    const send = jest.fn();
    await expect(
      handler(SKILLS_CHANNELS.CHECK_UPDATES)({ sender: { send } }),
    ).resolves.toEqual({ success: false, error: 'network down' });
    expect(send.mock.calls.map(([, event]: unknown[]) => event)).toEqual([
      {
        operation: 'check-updates',
        status: 'running',
        message: 'Checking installed skills for updates...',
      },
      { operation: 'check-updates', status: 'error', message: 'network down' },
    ]);
  });

  it('Portal skill read keeps its result and not_found text', async () => {
    fakeHost.read.mockResolvedValue({
      frontmatter: { name: 'x' },
      body: 'hi',
      truncated: false,
    });
    await expect(
      readRemoteControlSkill('custom:app', 'x'),
    ).resolves.toMatchObject({
      frontmatter: { name: 'x' },
      body: 'hi',
    });

    fakeHost.read.mockRejectedValue(
      new CatalogSkillRefusedError(
        'skill-not-found',
        new SkillServiceResultError('SKILL.md not found for "x".'),
      ),
    );
    await expect(
      readRemoteControlSkill('custom:app', 'x'),
    ).rejects.toMatchObject({
      code: 'not_found',
      message: 'SKILL.md not found for "x".',
    });
  });

  it('installs 600 skills through the core and refuses more than the core takes (CAN-5873)', async () => {
    const names = Array.from({ length: 600 }, (_, index) => `s${index}`);
    fakeHost.install.mockResolvedValue({
      sourceId: 'github:o:r',
      skillNames: names,
    });
    await expect(
      handler(SKILLS_CHANNELS.INSTALL)({}, 'o/r', ['', ...names]),
    ).resolves.toEqual({ success: true, data: undefined });
    expect(fakeHost.install).toHaveBeenCalledWith({
      source: 'o/r',
      skillNames: names,
    });

    const tooMany = Array.from({ length: 5001 }, (_, index) => `s${index}`);
    await expect(
      handler(SKILLS_CHANNELS.INSTALL)({}, 'o/r', tooMany),
    ).resolves.toEqual({
      success: false,
      error: 'Install up to 5,000 skills at a time.',
    });
    expect(fakeHost.install).toHaveBeenCalledTimes(1);
    expect(installSkills).not.toHaveBeenCalled();
  });

  it('Portal skill read carries frontmatter past the old wire bound through the core (CAN-5873)', async () => {
    jest.mocked(readSkillContent).mockClear();
    const notes = 'x'.repeat(40_000);
    fakeHost.read.mockResolvedValue({
      frontmatter: { notes },
      body: 'hi',
      truncated: false,
    });
    await expect(
      readRemoteControlSkill('custom:app', 'x'),
    ).resolves.toMatchObject({
      frontmatter: { notes },
      body: 'hi',
    });
    expect(fakeHost.read).toHaveBeenCalledTimes(1);
    expect(readSkillContent).not.toHaveBeenCalled();
  });

  it('Portal skill read never falls back to the direct path on an internal error', async () => {
    jest.mocked(readSkillContent).mockClear();
    const hostFailure = new Error('host failure');
    mockRuntimeOverride = {
      query: (): Promise<never> =>
        Promise.reject(
          new CanopyOperationError(
            {
              kind: 'internal',
              message: 'The operation failed.',
              retry: { kind: 'never' },
            },
            hostFailure,
          ),
        ),
    };
    try {
      await expect(readRemoteControlSkill('custom:app', 'x')).rejects.toBe(
        hostFailure,
      );
    } finally {
      mockRuntimeOverride = null;
    }
    expect(readSkillContent).not.toHaveBeenCalled();

    // An invalid result (internal, no cause) no longer takes the direct path either (CAN-5873).
    fakeHost.read.mockResolvedValue({
      frontmatter: { ['k'.repeat(513)]: 'v' },
      body: 'hi',
      truncated: false,
    });
    await expect(
      readRemoteControlSkill('custom:app', 'x'),
    ).rejects.toBeInstanceOf(CanopyOperationError);
    expect(readSkillContent).not.toHaveBeenCalled();
  });

  it('each renderer call uses a fresh key', async () => {
    fakeHost.install.mockResolvedValue({
      sourceId: 'github:o:r',
      skillNames: ['x'],
    });
    const install = handler(SKILLS_CHANNELS.INSTALL);
    await install({}, 'o/r', ['x']);
    await install({}, 'o/r', ['x']);
    expect(fakeHost.install).toHaveBeenCalledTimes(2);
  });
});

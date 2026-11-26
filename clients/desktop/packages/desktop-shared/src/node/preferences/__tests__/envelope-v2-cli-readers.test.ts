import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readHeadlessPreferences } from '../../approvals/headless-session';
import { cursorEnabledInPreferencesFile } from '../../pipelines/cli-runtime';

// CAN-7925 (CAN-5722 slice C): the CLI's preferences readers (headless
// approvals, CLI agent hosts and the Cursor connection) get the same values
// from an envelope version 2 file as from version 1.

const PREFERENCES = {
  cursorEnabled: true,
  globalApprovalRules: [
    {
      id: 'rule-1',
      toolName: 'Bash',
      behavior: 'deny',
      createdAt: '2026-11-25T00:00:00.000Z',
      origin: 'user',
    },
  ],
  openCodeEnabled: true,
};

const envelope = (version: number, preferences: object = PREFERENCES): string =>
  JSON.stringify({ version, generation: 4, preferences });

describe('preferences envelope v2 CLI readers (CAN-7925)', () => {
  const savedDataDir = process.env.CANOPY_DATA_DIR;
  let dataDir = '';

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'preferences-envelope-v2-'));
    process.env.CANOPY_DATA_DIR = dataDir;
  });

  afterEach(async () => {
    if (savedDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
    else process.env.CANOPY_DATA_DIR = savedDataDir;
    await rm(dataDir, { recursive: true, force: true });
  });

  const headlessRead = async (contents: string): Promise<unknown> => {
    await writeFile(join(dataDir, 'preferences.json'), contents);
    return readHeadlessPreferences();
  };

  it('headless approvals and CLI agent hosts read a version 2 file as version 1', async () => {
    const v1 = await headlessRead(envelope(1));
    expect(v1).toEqual(PREFERENCES);
    await expect(headlessRead(envelope(2))).resolves.toEqual(v1);
    // An unknown version still fails closed.
    await expect(headlessRead(envelope(3))).rejects.toThrow(
      'Preferences are unreadable.',
    );
  });

  it('the CLI reads Cursor as connected from a version 2 file as from version 1', () => {
    const read = (version: number, cursorEnabled: unknown): boolean =>
      cursorEnabledInPreferencesFile(
        JSON.parse(envelope(version, { cursorEnabled })),
      );
    for (const cursorEnabled of [true, false, undefined, 'true']) {
      expect(read(2, cursorEnabled)).toBe(read(1, cursorEnabled));
    }
    expect(read(2, true)).toBe(true);
    expect(read(3, true)).toBe(false);
  });
});

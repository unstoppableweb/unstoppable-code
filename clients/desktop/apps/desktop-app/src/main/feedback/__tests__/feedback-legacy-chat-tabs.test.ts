/**
 * A feedback bundle leaves out a scope's legacy tabs file once the scope has
 * an authority manifest (CAN-7178 follow-up 2, SWAN 18 Nov). With the format 4
 * switch on, migrated scopes keep that file until format 4 reads back, and
 * nothing reads it again; a scope that is still legacy keeps sending it.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, posix } from 'node:path';
import { resetResolvedCanopyDataDirForTests } from '@canopy/desktop-shared/canopy-paths';

jest.mock('electron', () => ({
  app: {
    getPath: (): string => tmpdir(),
    getVersion: (): string => '0.0.0-test',
    isPackaged: false,
  },
  BrowserWindow: { getAllWindows: (): never[] => [] },
}));
jest.mock('../../lib/cowork-work-entries', () => ({
  ...jest.requireActual<object>('../../lib/cowork-work-entries'),
  listWorkEntryIds: (): Promise<string[]> => Promise.resolve([]),
}));

import { FeedbackBundleBuilder } from '../feedback-archive';
import { feedbackChatDetailsForTests } from '../feedback-bundle';

let dataDir: string;
const previousDataDir = process.env.CANOPY_DATA_DIR;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'feedback-legacy-tabs-'));
  process.env.CANOPY_DATA_DIR = dataDir;
  resetResolvedCanopyDataDirForTests();
});

afterEach(async () => {
  if (previousDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = previousDataDir;
  resetResolvedCanopyDataDirForTests();
  await rm(dataDir, { recursive: true, force: true });
});

async function put(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}

const TABS = JSON.stringify({ version: 1, tabs: [] });

describe('legacy chat tabs in a feedback bundle', () => {
  it('a worktree scope with a manifest sends its manifest but not its leftover legacy tabs; a legacy-only scope still sends its tabs', async () => {
    const root = join(dataDir, 'workspaces', 'project');
    await put(join(root, 'chats', 'migrated.json'), TABS);
    await put(join(root, 'chat-storage-manifests', 'migrated.json'), '{}');
    await put(join(root, 'chats', 'legacy.json'), TABS);
    const builder = new FeedbackBundleBuilder();
    await feedbackChatDetailsForTests.includeWorktreeChatDetails(builder, [
      { workspaceId: 'project', worktreeIds: ['migrated', 'legacy'] },
    ]);
    expect(builder.includedFiles()).toContain(
      posix.join(
        'workspaces',
        'project',
        'chat-storage-manifests',
        'migrated.json',
      ),
    );
    expect(builder.includedFiles()).not.toContain(
      posix.join('workspaces', 'project', 'chats', 'migrated.json'),
    );
    expect(builder.includedFiles()).toContain(
      posix.join('workspaces', 'project', 'chats', 'legacy.json'),
    );
  });

  it('a cowork home with a manifest leaves out its leftover legacy tabs too', async () => {
    const root = join(dataDir, 'workspaces', 'cowork-1');
    await put(join(root, 'chats', 'home.json'), TABS);
    await put(join(root, 'chat-storage-manifests', 'home.json'), '{}');
    const builder = new FeedbackBundleBuilder();
    await feedbackChatDetailsForTests.includeStandaloneChatDetails(builder, [
      'cowork-1',
    ]);
    expect(builder.includedFiles()).toContain(
      posix.join(
        'workspaces',
        'cowork-1',
        'chat-storage-manifests',
        'home.json',
      ),
    );
    expect(builder.includedFiles()).not.toContain(
      posix.join('workspaces', 'cowork-1', 'chats', 'home.json'),
    );
  });

  it('a cowork home with no manifest still sends its legacy tabs', async () => {
    await put(
      join(dataDir, 'workspaces', 'cowork-2', 'chats', 'home.json'),
      TABS,
    );
    const builder = new FeedbackBundleBuilder();
    await feedbackChatDetailsForTests.includeStandaloneChatDetails(builder, [
      'cowork-2',
    ]);
    expect(builder.includedFiles()).toContain(
      posix.join('workspaces', 'cowork-2', 'chats', 'home.json'),
    );
  });
});

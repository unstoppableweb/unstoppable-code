import { installRoutedW5GoldenStore } from '../lib/__tests__/fixtures/w5-routed-golden-store';
// CAN-3233: current Cowork creation must remain independent of user Git policy.
jest.mock('../portal/portal-structural-sync', () => ({
  schedulePortalStructuralSync: jest.fn(),
}));
jest.mock('../portal/portal-event-bus', () => ({
  notifyPortalStructureChanged: jest.fn(),
}));
jest.mock('../agents/session-manager', () => ({}));
jest.mock('../pipelines/execution-runtime', () => ({}));
jest.mock('../ledger/lifecycle', () => ({}));

import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createCoworkWorkspace,
  createExternalCoworkWorkspace,
  listCoworkWorkspacesAsChatProjects,
  updateCoworkWorkspace,
} from '../lib/cowork-workspace-crud';
import { getCoworkWorkspaceRootDir } from '../lib/paths';
import { __resetSidebarItemsStateForTests } from '../lib/sidebar-items';
import {
  loadChatProjectInstructions,
  saveChatProjectInstructions,
} from '../lib/chat-project-instructions';

interface GitFailureFixture {
  env: NodeJS.ProcessEnv;
  runControl(repo?: string): Promise<unknown>;
  readInvocations(): unknown[];
  readTrace(): string;
  assertPolicyUnchanged(): void;
}
const { GIT_FAILURE_CASES, createGitFailureFixture } = jest.requireActual<{
  GIT_FAILURE_CASES: string[];
  createGitFailureFixture: (
    root: string,
    scenario: string,
  ) => GitFailureFixture;
}>('../../../tests/electron/gitFailureFixture.js');

// The pre-migration standalone-chat seed commit was removed. This golden
// exercises its current production successor, including durable rediscovery.
// Linux runs every fixture; macOS also proves parity. POSIX scripts are not
// portable to Windows, whose existing Git readiness goldens remain separate.
const posixTest = process.platform === 'win32' ? test.skip : test;
posixTest.each(GIT_FAILURE_CASES)(
  'first Cowork stays usable under %s without changing user Git policy',
  async (scenario) => {
    const originalEnv = process.env;
    const root = await mkdtemp(join(tmpdir(), 'can-3233-unit-'));
    const fixture = createGitFailureFixture(join(root, 'git-policy'), scenario);
    process.env = {
      ...originalEnv,
      ...fixture.env,
      CANOPY_DATA_DIR: join(root, 'data'),
    };
    __resetSidebarItemsStateForTests();
    const closeW5Store = await installRoutedW5GoldenStore();
    try {
      const trace = fixture.readTrace();
      const started = performance.now();
      const project = await createCoworkWorkspace('First project');
      // A test budget for the observable creation, not a new product timeout.
      expect(performance.now() - started).toBeLessThan(5000);
      const home = getCoworkWorkspaceRootDir(project.id);
      expect(existsSync(join(home, '.git'))).toBe(false);
      expect(fixture.readTrace()).toBe(trace);
      expect(fixture.readInvocations()).toEqual([]);
      const loaded = await loadChatProjectInstructions(home);
      expect(
        await saveChatProjectInstructions(home, {
          content: '# Still usable\n',
          revision: loaded.revision,
        }),
      ).toMatchObject({ status: 'saved' });
      expect((await loadChatProjectInstructions(home)).content).toBe(
        '# Still usable\n',
      );
      await updateCoworkWorkspace({ projectId: project.id, name: 'Renamed' });
      __resetSidebarItemsStateForTests();
      expect(
        await listCoworkWorkspacesAsChatProjects(undefined, {
          provisionDefaults: false,
        }),
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: project.id, name: 'Renamed' }),
        ]),
      );
      // Only the control initializes Git. An ordinary user commit in the same
      // folder must still encounter the configured hooks/signing/identity.
      await fixture.runControl(home);
      expect((await loadChatProjectInstructions(home)).content).toBe(
        '# Still usable\n',
      );
      fixture.assertPolicyUnchanged();
    } finally {
      await closeW5Store();
      process.env = originalEnv;
      __resetSidebarItemsStateForTests();
      try {
        fixture.assertPolicyUnchanged();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  },
  15000,
);

// CAN-6019: the core.workspace.cowork.folder.check projection and native
// chat-project:reveal-folder-location recovery share this authoritative project.
// Native file-manager delivery is exercised locally; this golden protects the
// durable no-recreation / no-new-work product flow.
// appErrors.resolveCoworkFolderMissing projects this refusal across
// contextBridge; that delivery is exercised by the retained headless captures
// and scratch bridge tests, rather than by this Node golden.
test('missing external Cowork folder refuses selection writes and first send without new work', async () => {
  const originalEnv = process.env;
  const base = await mkdtemp(join(tmpdir(), 'can-6019-golden-'));
  process.env = { ...originalEnv, CANOPY_DATA_DIR: join(base, 'data') };
  __resetSidebarItemsStateForTests();
  const closeW5Store = await installRoutedW5GoldenStore();
  try {
    const folder = join(base, 'FY27 Budget');
    await mkdir(folder);
    const project = await createExternalCoworkWorkspace(folder);
    const { ensureCoworkHomeScaffold } =
      await import('../lib/chat-project-utils');
    const { saveNote } = await import('../lib/standalone-workspace-files');
    const { listWorkEntryIds } = await import('../lib/cowork-work-entries');
    const { sendStandaloneChatMessage } =
      await import('../services/standalone-chat-service');
    const { createCoworkFolderAdapter } =
      await import('../canopy-runtime/cowork-folder-adapter');
    await rm(folder, { recursive: true });
    await ensureCoworkHomeScaffold(project.id);
    expect(existsSync(folder)).toBe(false);
    expect(
      await createCoworkFolderAdapter()['core.workspace.cowork.folder.check']({
        workspaceId: project.id,
      }),
    ).toMatchObject({
      kind: 'external',
      status: 'missing',
      code: 'cowork_folder_missing',
    });
    await expect(saveNote(project.id, 'Note', 'hello')).rejects.toMatchObject({
      code: 'cowork_folder_missing',
    });
    await expect(
      sendStandaloneChatMessage({
        projectId: project.id,
        chatId: 'new-chat',
        message: 'hello',
      }),
    ).rejects.toMatchObject({ code: 'cowork_folder_missing' });
    // core.workspace.cowork.send.rollback must resolve real project identity
    // before touching canonical storage, even for a cleanup request.
    await expect(
      createCoworkFolderAdapter()['core.workspace.cowork.send.rollback']({
        workspaceId: `${project.id}-unknown`,
        worktreeId: 'new-chat',
        chatId: 'new-chat',
        userMessageId: 'new-message',
      }),
    ).rejects.toThrow('Chat project not found');
    expect(await listWorkEntryIds(project.id)).toEqual([]);
    expect(existsSync(folder)).toBe(false);
    await mkdir(folder);
    expect(
      await createCoworkFolderAdapter()['core.workspace.cowork.folder.check']({
        workspaceId: project.id,
      }),
    ).toMatchObject({ status: 'present' });
    await saveNote(project.id, 'Note', 'hello');
  } finally {
    await closeW5Store();
    process.env = originalEnv;
    __resetSidebarItemsStateForTests();
    await rm(base, { recursive: true, force: true });
  }
});

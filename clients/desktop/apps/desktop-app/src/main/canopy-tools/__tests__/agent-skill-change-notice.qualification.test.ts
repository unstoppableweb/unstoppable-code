import { SKILLS_CHANNELS } from '@canopy/desktop-shared/constants/skill-channels';
import type {
  AgentResourceActionRuntime,
  dispatchAgentResourceAction,
} from '../resource-actions';
import type * as CanopyCloudClientModule from '../../canopy-cloud/client';

const mockSend = jest.fn<void, unknown[]>();
const mockWindow = {
  isDestroyed: (): boolean => false,
  webContents: {
    isDestroyed: (): boolean => false,
    isCrashed: (): boolean => false,
    mainFrame: { detached: false, isDestroyed: (): boolean => false },
    send: (...args: unknown[]): void => {
      mockSend(...args);
    },
  },
};

jest.mock('electron', () => ({
  app: { getPath: (): string => '/nonexistent/canopy-test', isPackaged: false },
  BrowserWindow: { getAllWindows: (): unknown[] => [mockWindow] },
  ipcMain: { on: jest.fn(), handle: jest.fn(), removeHandler: jest.fn() },
}));

const mockSaveCustomSkill = jest.fn();
const mockRemoveSkillForContext = jest.fn();
const mockWriteRawSkillForContext = jest.fn();
const mockReadSkillContent = jest.fn();
// Agent saves take the Skills editor's core save (CAN-7498).
jest.mock('../../canopy-runtime/skill-catalog-dispatch', () => ({
  saveCustomSkillThroughCore: (...args: unknown[]): unknown =>
    mockSaveCustomSkill(...args),
}));
jest.mock('../../skills/skill-service', () => ({
  removeSkillForContext: (...args: unknown[]): unknown =>
    mockRemoveSkillForContext(...args),
  writeRawSkillForContext: (...args: unknown[]): unknown =>
    mockWriteRawSkillForContext(...args),
  readSkillContent: (...args: unknown[]): unknown =>
    mockReadSkillContent(...args),
}));

jest.mock('../../skills/skill-install-context', () => ({
  assertStoredSkillContext: (): Promise<void> => Promise.resolve(),
  assertSkillShareOrigin: (): Promise<void> => Promise.resolve(),
  filterStoredSkillContexts: (skills: unknown[]): Promise<unknown[]> =>
    Promise.resolve(skills),
}));

const mockRefreshInventory = jest.fn();
jest.mock('../../plugins/invocable-inventory-service', () => ({
  refreshInvocableInventoryAfterMutation: (reason: string): void => {
    mockRefreshInventory(reason);
  },
}));

jest.mock('../../canopy-cloud/client', (): object => ({
  ...jest.requireActual<typeof CanopyCloudClientModule>(
    '../../canopy-cloud/client',
  ),
  assertCanopyCloudCapability: (): Promise<void> => Promise.resolve(),
}));

const mockGetSharedSkill = jest.fn();
jest.mock('../../skills/canopy-server-client', () => ({
  getSharedSkill: (...args: unknown[]): unknown => mockGetSharedSkill(...args),
  listSharedSkills: jest.fn(),
  createSharedSkill: jest.fn(),
  updateSharedSkill: jest.fn(),
  deleteSharedSkill: jest.fn(),
}));

const runtime: AgentResourceActionRuntime = {
  projectId: 'project-1',
  worktreeId: 'worktree-1',
  chatId: 'chat-1',
  cwd: '/worktrees/project-1/worktree-1',
  getWindow: () => null,
};

function skillsChangedSends(): unknown[][] {
  return mockSend.mock.calls.filter(
    ([channel]) => channel === SKILLS_CHANNELS.CHANGED,
  );
}

async function loadDispatch(): Promise<typeof dispatchAgentResourceAction> {
  const module = await import('../resource-actions');
  return module.dispatchAgentResourceAction;
}

describe('agent skill change notice (CAN-5860)', () => {
  beforeEach(() => {
    mockSend.mockClear();
    mockRefreshInventory.mockClear();
    mockSaveCustomSkill.mockReset();
    mockRemoveSkillForContext.mockReset();
    mockWriteRawSkillForContext.mockReset();
    mockReadSkillContent.mockReset();
    mockGetSharedSkill.mockReset();
  });

  it('create, update and delete of a custom skill each send skills:changed once after the save', async () => {
    const dispatch = await loadDispatch();
    const sendsAtSave: number[] = [];
    mockSaveCustomSkill.mockImplementation(() => {
      sendsAtSave.push(skillsChangedSends().length);
      return Promise.resolve({
        success: true,
        data: { name: 'notes', sourceId: 'custom' },
      });
    });

    const created = await dispatch(
      {
        type: 'skills.create_custom',
        name: 'notes',
        description: 'Take notes',
        body: 'Write notes.',
      },
      runtime,
    );
    expect(created.ok).toBe(true);
    expect(skillsChangedSends()).toEqual([[SKILLS_CHANNELS.CHANGED]]);

    mockReadSkillContent.mockReturnValue({
      success: true,
      data: { frontmatter: { description: 'Take notes' }, body: 'Old.' },
    });
    const updated = await dispatch(
      { type: 'skills.update_custom', originalName: 'notes', body: 'New.' },
      runtime,
    );
    expect(updated.ok).toBe(true);
    expect(skillsChangedSends()).toHaveLength(2);
    expect(sendsAtSave).toEqual([0, 1]);

    mockRemoveSkillForContext.mockResolvedValue({ success: true });
    const deleted = await dispatch(
      { type: 'skills.delete_custom', name: 'notes' },
      runtime,
    );
    expect(deleted.ok).toBe(true);
    expect(skillsChangedSends()).toHaveLength(3);
  });

  it('a failed save sends no notice', async () => {
    const dispatch = await loadDispatch();
    mockSaveCustomSkill.mockResolvedValue({
      success: false,
      error: 'A skill with this name already exists.',
    });
    mockRemoveSkillForContext.mockResolvedValue({
      success: false,
      error: 'Skill not found.',
    });

    const created = await dispatch(
      {
        type: 'skills.create_custom',
        name: 'notes',
        description: 'Take notes',
        body: 'Write notes.',
      },
      runtime,
    );
    const deleted = await dispatch(
      { type: 'skills.delete_custom', name: 'notes' },
      runtime,
    );

    expect(created.ok).toBe(false);
    expect(deleted.ok).toBe(false);
    expect(skillsChangedSends()).toHaveLength(0);
  });

  it('importing a shared skill sends skills:changed once', async () => {
    const dispatch = await loadDispatch();
    mockGetSharedSkill.mockResolvedValue({
      id: 'shared-1',
      name: 'notes',
      description: 'Take notes',
      rawSkill: '---\nname: notes\n---\nWrite notes.',
      shareScope: 'organization',
    });
    mockWriteRawSkillForContext.mockResolvedValue({
      skillId: 'custom/notes',
      skillName: 'notes',
    });

    const imported = await dispatch(
      { type: 'skills.import_shared', skillId: 'shared-1' },
      runtime,
    );

    expect(imported.ok).toBe(true);
    expect(skillsChangedSends()).toEqual([[SKILLS_CHANNELS.CHANGED]]);
  });
});

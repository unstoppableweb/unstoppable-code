import type {
  ChatStateChange,
  ChatTabPluginSelections,
} from '@canopy/desktop-shared/types';
import { requestDiscoveryForCommittedPluginChanges } from '../committed-plugin-discovery';

const BEFORE: ChatTabPluginSelections = {
  collectionIds: [],
  skillRefs: [{ sourceId: 'user', skillName: 'deploy' }],
  pluginRefs: [],
  mcpServerRefs: [],
};
const AFTER: ChatTabPluginSelections = {
  ...BEFORE,
  skillRefs: [
    { sourceId: 'user', skillName: 'deploy' },
    { sourceId: 'user', skillName: 'review' },
  ],
};
const TABS = [
  { id: 'chat-1', pluginSelections: BEFORE },
  { id: 'file-1', kind: 'file' },
];

function patched(pluginSelections: ChatTabPluginSelections): ChatStateChange {
  return {
    type: 'tab.metadata_patched',
    tabId: 'chat-1',
    patch: { pluginSelections },
  };
}

function discover(changes: ChatStateChange[]): unknown[] {
  const requests: unknown[] = [];
  requestDiscoveryForCommittedPluginChanges(
    { projectId: 'p', worktreeId: 'w', changes },
    TABS,
    (request) => requests.push(request),
  );
  return requests;
}

describe('slash-command discovery after committed plugin changes (CAN-5999)', () => {
  it('a plugin change main committed triggers exactly one discovery in the window', () => {
    expect(discover([patched(AFTER)])).toEqual([
      {
        projectId: 'p',
        worktreeId: 'w',
        chatId: 'chat-1',
        pluginSelections: AFTER,
      },
    ]);
  });

  it('a plugin change the Portal committed triggers exactly one discovery too', () => {
    // Committed events carry no origin: the window reacts to the commit itself.
    const remoteControlEvent = [
      patched(AFTER),
      {
        type: 'tab.metadata_patched',
        tabId: 'chat-1',
        patch: { unread: false },
      } as ChatStateChange,
    ];

    expect(discover(remoteControlEvent)).toHaveLength(1);
  });

  it("selections that did not change trigger no discovery, so the window's own change is not repeated", () => {
    expect(discover([patched(BEFORE)])).toEqual([]);
    expect(
      discover([patched({ ...BEFORE, skillRefs: [...BEFORE.skillRefs] })]),
    ).toEqual([]);
  });

  it('a file tab and an unrelated patch trigger no discovery', () => {
    expect(
      discover([
        {
          type: 'tab.metadata_patched',
          tabId: 'file-1',
          patch: { pluginSelections: AFTER },
        },
        {
          type: 'tab.metadata_patched',
          tabId: 'chat-1',
          patch: { title: 'Renamed' },
        },
      ]),
    ).toEqual([]);
  });
});

import * as core from '@canopy/core-runtime/node/chat/chat-storage-activity';
import * as workCounters from '../work-counters';

const STORE_RECORDERS = [
  'recordChatStorageFileWrite',
  'recordChatStorageFileSync',
  'recordChatStorageDirectorySync',
  'recordChatStorageAtomicReplacement',
  'recordChatStorageDeltaJournalCheckpoint',
  'recordChatStorageCommit',
  'recordChatStorageIndexSerializations',
  'recordChatStorageIndexParses',
  'recordChatStoragePayloadPass',
  'recordChatStorageArtifactPublished',
] as const;

const LIVE_INDEX = '/data/workspaces/w/chat-storage-v2/s/live-index.json';

describe('chat storage work counters (CAN-6995)', () => {
  beforeEach(() => {
    workCounters.resetWorkCounters();
  });

  it('re-exports the core recorders rather than copies of them', () => {
    for (const name of STORE_RECORDERS)
      expect(workCounters[name]).toBe(core[name]);
    expect(workCounters.classifyChatStorageFile).toBe(
      core.classifyChatStorageFile,
    );
    expect(workCounters.isChatStoragePath).toBe(core.isChatStoragePath);
  });

  it('shows a count recorded through core-runtime in the work-counters snapshot', () => {
    core.recordChatStorageFileSync(LIVE_INDEX);
    core.recordChatStorageArtifactPublished();

    const snapshot = workCounters.snapshotWorkCounters().chatStorage;
    expect(snapshot['syncs.file']).toBe(1);
    expect(snapshot['syncs.file.liveIndex']).toBe(1);
    expect(snapshot.artifactsPublished).toBe(1);
  });

  it('shows a count recorded through work-counters in the core counter set', () => {
    workCounters.recordChatStorageFileSync(LIVE_INDEX);
    workCounters.recordChatStorageMutations(3);

    expect(core.chatStorageWorkCounters.snapshot()).toEqual(
      workCounters.snapshotWorkCounters().chatStorage,
    );
    expect(core.chatStorageWorkCounters.snapshot().mutations).toBe(3);
  });

  it.each([
    [
      'recordChatStorageMutations',
      (): void => workCounters.recordChatStorageMutations(2),
      'mutations',
      2,
    ],
    [
      'recordChatStorageIndexClone',
      (): void => workCounters.recordChatStorageIndexClone(),
      'indexClones',
      1,
    ],
  ] as const)(
    'counts %s, which stays in work-counters, in the core counter set',
    (_name, record, key, expected) => {
      record();

      expect(core.chatStorageWorkCounters.snapshot()[key]).toBe(expected);
    },
  );

  it('clears the core counter set when work-counters resets', () => {
    core.recordChatStorageCommit();
    expect(core.chatStorageWorkCounters.snapshot().commits).toBe(1);

    workCounters.resetWorkCounters();
    expect(core.chatStorageWorkCounters.snapshot()).toEqual({});
  });
});

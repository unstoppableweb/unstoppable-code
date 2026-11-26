// A real child authority and producer: ordinary forgets arm after load;
// pending-import forgets assert unfenced v1, queue before release, then arm
// only at the record image that actually installs the queued forget.
import { readFileSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import {
  TerminalRecordAuthority,
  TerminalRecordRepository,
} from '@canopy/core-runtime/node/terminal/record';
import { TerminalPersistenceStore } from '../../persistence';
import type { TerminalRecordClientPort } from '../../record-client';
import { TerminalRecordOutbox } from '../../record-outbox';

const root = process.env.TERMINAL_TEST_ROOT ?? '';
const pendingMode = process.env.TERMINAL_PENDING_IMPORT === '1';
const quitPending = process.env.TERMINAL_QUIT_PENDING === '1';
let holdImport = pendingMode;
let forgetQueued = false;
class CrashRepository extends TerminalRecordRepository {
  public override importLegacy(
    input: Parameters<TerminalRecordRepository['importLegacy']>[0],
  ): ReturnType<TerminalRecordRepository['importLegacy']> {
    if (holdImport)
      throw new Error('Legacy import held for pending-forget crash');
    return super.importLegacy(input);
  }

  public override save(
    envelope: Parameters<TerminalRecordRepository['save']>[0],
  ): void {
    if (
      pendingMode &&
      forgetQueued &&
      !envelope.import.pending &&
      !envelope.record.terminals.some((entry) => entry.session.id === 'a')
    )
      process.env.TERMINAL_CRASH_ARMED = '1';
    super.save(envelope);
  }
}
const authority = new TerminalRecordAuthority({
  repository: new CrashRepository({
    dataRoot: root,
    flushDirectorySync: (): void => undefined,
  }),
  installDebounceMs: 1,
});
const reach = <T>(run: () => T): Promise<T> => Promise.resolve().then(run);
const records: TerminalRecordClientPort = {
  available: () => Promise.resolve(true),
  open: (client) => reach(() => authority.open(client)),
  historyRead: (params) => reach(() => authority.historyRead(params)),
  apply: (params) => reach(() => authority.apply(params)),
  retire: (params) =>
    reach(() => {
      authority.retire(params);
    }),
  shutdown: (signal) =>
    reach(() => {
      authority.shutdown(signal);
    }),
};
const store = new TerminalPersistenceStore({
  records,
  outbox: new TerminalRecordOutbox(() => root),
});
void (async (): Promise<void> => {
  const sourcePath = join(
    root,
    'workspaces/p/worktree-data/w/terminal-state.json',
  );
  const sourceBytes = quitPending ? readFileSync(sourcePath, 'utf8') : '';
  const loaded = await store.loadWorktreeState('p', 'w');
  if (quitPending) {
    assert.equal(holdImport, true);
    assert.equal(
      authority.open({
        projectId: 'p',
        worktreeId: 'w',
        legacyLayout: 'workspaces',
        incarnation: null,
      }).import.pending,
      true,
    );
    assert.equal(readFileSync(sourcePath, 'utf8'), sourceBytes);
    const entry = loaded.terminals.find(
      (candidate) => candidate.session.id === 'a',
    );
    assert.ok(entry);
    store.registerLiveSession(entry.session);
    store.appendTerminalOutput('p', 'w', 'a', Buffer.from('-quit-once'));
    store.saveWorktreeState({ ...loaded, projectId: 'p', worktreeId: 'w' });
    store.markAllLiveTerminalsExited('app-quit');
    assert.equal(readFileSync(sourcePath, 'utf8'), sourceBytes);
    writeFileSync(join(root, 'quit-reached'), 'pending-unfenced-v1');
    process.exit(0);
  }
  if (process.env.TERMINAL_FORGET === '1') {
    if (pendingMode) {
      const source: unknown = JSON.parse(
        readFileSync(
          join(root, 'workspaces/p/worktree-data/w/terminal-state.json'),
          'utf8',
        ),
      );
      assert.ok(
        typeof source === 'object' && source !== null && 'version' in source,
      );
      assert.equal(source.version, 1);
      assert.equal(
        authority.open({
          projectId: 'p',
          worktreeId: 'w',
          legacyLayout: 'workspaces',
          incarnation: null,
        }).import.pending,
        true,
      );
      writeFileSync(join(root, 'forget-reached'), 'pending-unfenced-v1');
      store.forget('a');
      forgetQueued = true;
      holdImport = false;
    } else {
      await store.drainAll();
      authority.flushSync();
      writeFileSync(join(root, 'forget-reached'), '');
      process.env.TERMINAL_CRASH_ARMED = '1';
      store.forget('a');
    }
  }
  await store.drainAll();
  store.flushAllSync();
  authority.flushSync();
  process.exit(0);
})();

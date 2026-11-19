import { isDeepStrictEqual } from 'node:util';
import type { VaultPutRequest, VaultSecretPin } from '../contracts';
import type {
  VaultRepositoryTestSubject,
  VaultTestCommit,
} from './memory-repository';

export interface VaultConformanceTestApi {
  describe(name: string, body: () => void): void;
  it(name: string, body: () => Promise<void>): void;
}

export class VaultConformanceFailure extends Error {
  override readonly name = 'VaultConformanceFailure';
}

function check(condition: boolean, message: string): asserts condition {
  if (!condition) throw new VaultConformanceFailure(message);
}
function equal(actual: unknown, expected: unknown, message: string): void {
  // DTOs may cross a VM/adapter boundary; compare fields, not realm prototypes.
  check(
    isDeepStrictEqual(structuredClone(actual), structuredClone(expected)),
    message,
  );
}
/** A failed mutation: kind and ref, at most the closed step/io diagnostic. */
function failureKeysOnly(result: object): boolean {
  const keys = Object.keys(result);
  return (
    keys.includes('kind') &&
    keys.includes('ref') &&
    keys.every((key) => ['kind', 'ref', 'step', 'io'].includes(key))
  );
}
function create(
  idempotencyKey = 'create',
): Extract<VaultPutRequest, { entryId: null }> {
  return {
    entryId: null,
    expectedRevision: null,
    family: 'test.family',
    label: 'Test secret',
    material: new Uint8Array([1, 2, 3]),
    expiresAt: null,
    idempotencyKey,
  };
}
function replace(
  pin: VaultSecretPin,
  idempotencyKey = 'replace',
): Extract<VaultPutRequest, { expectedRevision: number }> {
  return {
    ref: pin.ref,
    expectedRevision: pin.revision,
    label: 'Replacement',
    material: new Uint8Array([4, 5, 6]),
    expiresAt: null,
    idempotencyKey,
  };
}
async function seed(
  subject: VaultRepositoryTestSubject,
): Promise<VaultSecretPin> {
  const result = await subject.writer('test.family').put(create());
  check(result.kind === 'committed', 'create must be durably committed');
  equal(
    subject.repository.admit(result.pin),
    { kind: 'admitted' },
    'confirmed pin must be admitted',
  );
  return result.pin;
}
async function closed(
  subject: VaultRepositoryTestSubject,
  pin: VaultSecretPin,
  deleting: boolean,
): Promise<void> {
  check(
    subject.repository.admit(pin).kind !== 'admitted',
    'narrowing must precede durability',
  );
  equal(
    await subject.repository.get(pin.ref),
    {
      kind: 'unconfirmed',
      state: deleting ? 'delete_unconfirmed' : 'unconfirmed',
    },
    'unconfirmed entry must contain no material, pin, or not_found reason',
  );
  const listed = (await subject.repository.list()).find(
    (entry) => entry.ref.entryId === pin.ref.entryId,
  );
  check(
    listed?.state === (deleting ? 'delete_unconfirmed' : 'unconfirmed'),
    'list must retain the unconfirmed state',
  );
}

/** Required fault scenarios run on every adapter; no opt-out that silently skips them. */
export function runVaultRepositoryConformance(
  t: VaultConformanceTestApi,
  makeSubject: () =>
    | VaultRepositoryTestSubject
    | Promise<VaultRepositoryTestSubject>,
): void {
  function scenario(
    name: string,
    body: (subject: VaultRepositoryTestSubject) => Promise<void>,
  ): void {
    t.it(name, async () => {
      const subject = await makeSubject();
      const holds = new Set<
        ReturnType<VaultRepositoryTestSubject['holdNextCommit']>
      >();
      try {
        await body({
          repository: subject.repository,
          writer: (family) => subject.writer(family),
          reconcile: (ref) => subject.reconcile(ref),
          holdNextCommit: () => {
            const gate = subject.holdNextCommit();
            holds.add(gate);
            return {
              release: (outcome): void => {
                holds.delete(gate);
                gate.release(outcome);
              },
            };
          },
        });
      } finally {
        // A failed assertion must not strand an adapter's in-flight disposal.
        for (const gate of Array.from(holds))
          gate.release({ kind: 'unavailable' });
        await subject.dispose?.();
      }
    });
  }
  t.describe('vault repository conformance', () => {
    scenario(
      'empty repository and absent/foreign references',
      async ({ repository }) => {
        equal(await repository.list(), [], 'fresh repository must be empty');
        equal(
          await repository.get({
            vaultId: 'foreign-vault',
            entryId: 'missing',
          }),
          { kind: 'not_found', reason: 'foreign_vault' },
          'foreign vault must be detected',
        );
      },
    );
    scenario(
      'create becomes usable only after durable confirmation; copies never alias',
      async (subject) => {
        const gate = subject.holdNextCommit();
        const input = create();
        const pending = subject.writer('test.family').put(input);
        input.material.fill(9);
        const listed = await subject.repository.list();
        const entry = listed[0];
        check(
          entry !== undefined,
          'accepted create must be visible as unconfirmed',
        );
        await closed(
          subject,
          { ref: entry.ref, revision: entry.revision },
          false,
        );
        gate.release({ kind: 'committed' });
        const result = await pending;
        check(result.kind === 'committed', 'create must commit');
        const read = await subject.repository.get(result.pin.ref);
        check(read.kind === 'available', 'confirmed create must be readable');
        equal(
          Array.from(read.material),
          [1, 2, 3],
          'write must snapshot bytes',
        );
        read.material.fill(8);
        read.pin.ref.entryId = 'mutated';
        const again = await subject.repository.get(result.pin.ref);
        check(
          again.kind === 'available',
          'mutating read ref must not mutate store',
        );
        equal(
          Array.from(again.material),
          [1, 2, 3],
          'reads must own their bytes',
        );
        check(
          !JSON.stringify(await subject.repository.list()).includes('material'),
          'list must redact material',
        );
      },
    );
    for (const deleting of [false, true]) {
      const operation = deleting ? 'delete' : 'replace';
      const outcomes: readonly VaultTestCommit[] = [
        { kind: 'committed' },
        { kind: 'unavailable' },
        { kind: 'outcome_unknown', applied: false },
        { kind: 'outcome_unknown', applied: true },
      ];
      for (const outcome of outcomes) {
        scenario(
          `${operation}: synchronous narrowing and ${JSON.stringify(outcome)}`,
          async (subject) => {
            const pin = await seed(subject);
            const gate = subject.holdNextCommit();
            const writer = subject.writer('test.family');
            const pending = deleting
              ? writer.delete({
                  ref: pin.ref,
                  expectedRevision: pin.revision,
                  idempotencyKey: operation,
                })
              : writer.put(replace(pin));
            let settled = false;
            void pending.then(
              () => {
                settled = true;
              },
              () => {
                settled = true;
              },
            );
            check(
              subject.repository.admit(pin).kind !== 'admitted',
              'admission must close before promise is awaited',
            );
            await closed(subject, pin, deleting);
            check(
              !settled,
              'mutation must not settle before durability returns',
            );
            gate.release(outcome);
            const result = await pending;
            check(
              result.kind === outcome.kind,
              'durability result must not be masked',
            );
            if (outcome.kind === 'committed') {
              if (deleting)
                equal(
                  await subject.repository.get(pin.ref),
                  { kind: 'not_found', reason: 'deleted' },
                  'confirmed delete needs tombstone',
                );
              else {
                const read = await subject.repository.get(pin.ref);
                check(
                  read.kind === 'available' && read.pin.revision > pin.revision,
                  'confirmed successor must advance revision',
                );
                equal(
                  Array.from(read.material),
                  [4, 5, 6],
                  'replacement material',
                );
                equal(
                  subject.repository.admit(pin),
                  { kind: 'stale' },
                  'old pin must be stale',
                );
              }
            } else {
              check(
                failureKeysOnly(result),
                'failed mutation must contain only kind, ref and diagnostics',
              );
              await closed(subject, pin, deleting);
              await Promise.resolve();
              await closed(subject, pin, deleting);
              if (outcome.kind === 'outcome_unknown' && outcome.applied) {
                await subject.reconcile(pin.ref);
                const read = await subject.repository.get(pin.ref);
                check(
                  deleting
                    ? read.kind === 'not_found' && read.reason === 'deleted'
                    : read.kind === 'available' &&
                        read.pin.revision > pin.revision,
                  'only reconciliation promotes an applied unknown outcome',
                );
              }
            }
          },
        );
      }
    }
    scenario(
      'unavailable delete cannot be reopened by put',
      async (subject) => {
        const pin = await seed(subject);
        const gate = subject.holdNextCommit();
        const pending = subject.writer('test.family').delete({
          ref: pin.ref,
          expectedRevision: pin.revision,
          idempotencyKey: 'delete',
        });
        gate.release({ kind: 'unavailable' });
        check(
          (await pending).kind === 'unavailable',
          'delete must report unavailable',
        );
        equal(
          await subject.writer('test.family').put(replace(pin)),
          { kind: 'refused', reason: 'entry_closed' },
          'revoked entry must refuse put without reporting uncertainty',
        );
        await closed(subject, pin, true);
        const recreated = await subject
          .writer('test.family')
          .put(create('replace'));
        check(recreated.kind === 'committed', 'refused key is not reserved');
        await closed(subject, pin, true);
      },
    );
    const competingOutcomes: readonly VaultTestCommit[] = [
      { kind: 'committed' },
      { kind: 'unavailable' },
      { kind: 'outcome_unknown', applied: false },
      { kind: 'outcome_unknown', applied: true },
    ];
    for (const creating of [false, true]) {
      for (const outcome of competingOutcomes) {
        scenario(
          `competing put during ${creating ? 'create' : 'replace'} is not accepted: ${JSON.stringify(outcome)}`,
          async (subject) => {
            const writer = subject.writer('test.family');
            const committedPin = creating ? undefined : await seed(subject);
            const gate = subject.holdNextCommit();
            const pending = writer.put(
              committedPin ? replace(committedPin) : create(),
            );
            const entry = (await subject.repository.list())[0];
            check(entry !== undefined, 'accepted mutation must be listed');
            const pin = committedPin ?? {
              ref: entry.ref,
              revision: entry.revision,
            };
            const competing = replace(pin, 'competing');
            const refused = { kind: 'refused', reason: 'entry_closed' };
            equal(
              await writer.put(competing),
              refused,
              'competing put must report non-acceptance, not uncertainty',
            );
            equal(
              await writer.put(competing),
              refused,
              'pending retry is refused',
            );
            const changed = { ...competing, material: new Uint8Array([9]) };
            equal(
              await writer.put(changed),
              refused,
              'non-acceptance must not reserve an idempotency key',
            );
            await closed(subject, pin, false);
            gate.release(outcome);
            const result = await pending;
            check(
              result.kind === outcome.kind,
              'accepted put keeps its outcome',
            );
            if (outcome.kind === 'outcome_unknown') {
              equal(
                await writer.put(competing),
                refused,
                'uncertain entry still refuses competing puts',
              );
              await closed(subject, pin, false);
              await subject.reconcile(pin.ref);
              if (!outcome.applied) {
                equal(
                  await writer.put(changed),
                  refused,
                  'unapplied stays closed',
                );
                await closed(subject, pin, false);
                return;
              }
            }
            let expectedRevision = pin.revision;
            if (outcome.kind !== 'unavailable') {
              const read = await subject.repository.get(pin.ref);
              check(
                read.kind === 'available',
                'confirmed winner must be readable',
              );
              equal(
                Array.from(read.material),
                creating ? [1, 2, 3] : [4, 5, 6],
                'winner keeps its bytes',
              );
              expectedRevision = read.pin.revision;
              if (!creating) {
                equal(
                  await writer.put(competing),
                  {
                    kind: 'revision_conflict',
                    currentRevision: expectedRevision,
                  },
                  'a refused request has no uncertain receipt to replay',
                );
              }
            } else {
              await closed(subject, pin, false);
            }
            const successor = await writer.put({
              ...changed,
              expectedRevision,
            });
            check(
              successor.kind === 'committed',
              'refused key remains reusable',
            );
            equal(
              await writer.put({ ...changed, expectedRevision }),
              successor,
              'accepted successor now replays its receipt',
            );
            equal(
              await writer.put({
                ...changed,
                expectedRevision,
                label: 'Changed',
              }),
              { kind: 'idempotency_conflict' },
              'accepted successor now reserves its key',
            );
            const read = await subject.repository.get(pin.ref);
            check(read.kind === 'available', 'successor must be readable');
            equal(
              Array.from(read.material),
              [9],
              'only accepted bytes are served',
            );
          },
        );
      }
    }
    for (const newerCommits of [false, true]) {
      scenario(
        `unavailable retry retains its key while a newer put ${newerCommits ? 'commits' : 'fails'}`,
        async (subject) => {
          const pin = await seed(subject);
          const writer = subject.writer('test.family');
          const request = replace(pin);
          const firstGate = subject.holdNextCommit();
          const first = writer.put(request);
          firstGate.release({ kind: 'unavailable' });
          check((await first).kind === 'unavailable', 'first put failed');

          const newerGate = subject.holdNextCommit();
          const newer = writer.put({
            ...replace(pin, 'newer'),
            material: new Uint8Array([9]),
          });
          equal(
            await writer.put(request),
            { kind: 'refused', reason: 'entry_closed' },
            'unavailable retry cannot bypass a pending successor',
          );
          const changed = { ...request, material: new Uint8Array([8]) };
          equal(
            await writer.put(changed),
            { kind: 'idempotency_conflict' },
            'refusal must not release a previously accepted key',
          );
          await closed(subject, pin, false);
          newerGate.release({
            kind: newerCommits ? 'committed' : 'unavailable',
          });
          const result = await newer;
          if (newerCommits) {
            check(result.kind === 'committed', 'newer put committed');
            equal(
              await writer.put(request),
              {
                kind: 'revision_conflict',
                currentRevision: result.pin.revision,
              },
              'unavailable retry must still pass CAS',
            );
          } else {
            check(result.kind === 'unavailable', 'newer put failed');
            const retry = await writer.put(request);
            check(retry.kind === 'committed', 'original key can retry again');
            equal(
              await writer.put(request),
              retry,
              'recovered receipt replays',
            );
          }
          equal(
            await writer.put(changed),
            { kind: 'idempotency_conflict' },
            'original accepted key stays bound after the successor settles',
          );
          const read = await subject.repository.get(pin.ref);
          check(read.kind === 'available', 'confirmed winner is readable');
          equal(
            Array.from(read.material),
            newerCommits ? [9] : [4, 5, 6],
            'refused retry must not overwrite the winner',
          );
        },
      );
    }
    for (const replaceOutcome of competingOutcomes) {
      for (const deleteOutcome of competingOutcomes) {
        for (const deleteSettlesFirst of [false, true]) {
          scenario(
            `delete supersedes replace: ${JSON.stringify({ replaceOutcome, deleteOutcome, deleteSettlesFirst })}`,
            async (subject) => {
              const pin = await seed(subject);
              const writer = subject.writer('test.family');
              const request = replace(pin);
              const putGate = subject.holdNextCommit();
              const pendingPut = writer.put(request);
              const joinedPut = writer.put(request);
              const deleteGate = subject.holdNextCommit();
              const deletion = {
                ref: pin.ref,
                expectedRevision: pin.revision,
                idempotencyKey: 'delete',
              };
              const pendingDelete = writer.delete(deletion);
              const joinedDelete = writer.delete(deletion);
              equal(
                subject.repository.admit(pin),
                { kind: 'revoked' },
                'delete closes admission synchronously',
              );
              await closed(subject, pin, true);
              if (deleteSettlesFirst) {
                deleteGate.release(deleteOutcome);
                await pendingDelete;
              }
              putGate.release(replaceOutcome);
              const superseded = { kind: 'superseded', ref: pin.ref };
              equal(
                await pendingPut,
                superseded,
                'late replacement must settle superseded without a pin',
              );
              equal(
                await joinedPut,
                superseded,
                'joined replacement must share superseded outcome',
              );
              equal(
                await writer.put(request),
                superseded,
                'replacement retry cannot restart durability',
              );
              if (!deleteSettlesFirst) {
                await closed(subject, pin, true);
                deleteGate.release(deleteOutcome);
              }
              const deleted = await pendingDelete;
              check(
                deleted.kind === deleteOutcome.kind,
                'delete must run rather than return busy',
              );
              equal(
                await joinedDelete,
                deleted,
                'identical pending deletes join',
              );
              const assertDeleted = async (): Promise<void> => {
                equal(
                  await subject.repository.get(pin.ref),
                  { kind: 'not_found', reason: 'deleted' },
                  'only confirmed deletion produces a tombstone',
                );
              };
              if (deleteOutcome.kind === 'committed') await assertDeleted();
              else await closed(subject, pin, true);
              await subject.reconcile(pin.ref);
              if (
                deleteOutcome.kind === 'committed' ||
                (deleteOutcome.kind === 'outcome_unknown' &&
                  deleteOutcome.applied)
              ) {
                await assertDeleted();
              } else {
                await closed(subject, pin, true);
                if (deleteOutcome.kind === 'unavailable') {
                  check(
                    (await writer.delete(deletion)).kind === 'committed',
                    'same-key delete retry can confirm removal',
                  );
                  await assertDeleted();
                } else {
                  equal(
                    await writer.delete(deletion),
                    deleted,
                    'unknown delete retry replays until reconciliation',
                  );
                }
              }
              equal(
                await writer.put(request),
                superseded,
                'reconciliation cannot revive a superseded receipt',
              );
              const recreated = await writer.put(create('recreate'));
              check(
                recreated.kind === 'committed' &&
                  recreated.pin.ref.entryId !== pin.ref.entryId,
                'new put creates a distinct entry',
              );
              equal(
                subject.repository.admit(pin),
                { kind: 'revoked' },
                'new create cannot reopen the old ref',
              );
            },
          );
        }
      }
    }
    for (const sameKey of [false, true]) {
      scenario(
        `unavailable replace recovers via ${sameKey ? 'same key' : 'new put'}`,
        async (subject) => {
          const pin = await seed(subject);
          const writer = subject.writer('test.family');
          const gate = subject.holdNextCommit();
          const pending = writer.put(replace(pin));
          gate.release({ kind: 'unavailable' });
          check(
            (await pending).kind === 'unavailable',
            'failed replace outcome',
          );
          await closed(subject, pin, false);
          const result = await writer.put(
            replace(pin, sameKey ? 'replace' : 'new-put'),
          );
          check(
            result.kind === 'committed',
            'confirmed successor can reopen a failed replace',
          );
          equal(
            subject.repository.admit(result.pin),
            { kind: 'admitted' },
            'successor is admitted',
          );
        },
      );
    }
    for (const outcome of competingOutcomes) {
      scenario(
        `delete supersedes pending create: ${JSON.stringify(outcome)}`,
        async (subject) => {
          const writer = subject.writer('test.family');
          const createGate = subject.holdNextCommit();
          const pendingCreate = writer.put(create());
          const entry = (await subject.repository.list())[0];
          check(entry !== undefined, 'pending create must be listed');
          const pin = { ref: entry.ref, revision: entry.revision };
          const deleteGate = subject.holdNextCommit();
          const pendingDelete = writer.delete({
            ref: pin.ref,
            expectedRevision: pin.revision,
            idempotencyKey: 'delete',
          });
          equal(
            subject.repository.admit(pin),
            { kind: 'revoked' },
            'delete closes pending create',
          );
          await closed(subject, pin, true);
          createGate.release(outcome);
          equal(
            await pendingCreate,
            { kind: 'superseded', ref: pin.ref },
            'create cannot escape deletion',
          );
          await subject.reconcile(pin.ref);
          await closed(subject, pin, true);
          deleteGate.release({ kind: 'committed' });
          check(
            (await pendingDelete).kind === 'committed',
            'delete confirms removal',
          );
          equal(
            await writer.put(create()),
            { kind: 'superseded', ref: pin.ref },
            'create replay cannot resurrect',
          );
          equal(
            await subject.repository.get(pin.ref),
            { kind: 'not_found', reason: 'deleted' },
            'create stays deleted',
          );
        },
      );
      for (const latestFirst of [false, true]) {
        scenario(
          `competing deletes fence older receipts: ${JSON.stringify({ outcome, latestFirst })}`,
          async (subject) => {
            const pin = await seed(subject);
            const writer = subject.writer('test.family');
            const request = {
              ref: pin.ref,
              expectedRevision: pin.revision,
              idempotencyKey: 'first-delete',
            };
            const olderGate = subject.holdNextCommit();
            const older = writer.delete(request);
            const latestGate = subject.holdNextCommit();
            const latestRequest = {
              ...request,
              idempotencyKey: 'latest-delete',
            };
            const latest = writer.delete(latestRequest);
            const joined = writer.delete(latestRequest);
            if (latestFirst) {
              latestGate.release({ kind: 'unavailable' });
              await latest;
            }
            olderGate.release(outcome);
            equal(
              await older,
              { kind: 'superseded', ref: pin.ref },
              'older delete cannot override the latest receipt',
            );
            await subject.reconcile(pin.ref);
            await closed(subject, pin, true);
            if (!latestFirst) latestGate.release({ kind: 'unavailable' });
            const result = await latest;
            check(
              result.kind === 'unavailable',
              'latest delete retains its own outcome',
            );
            equal(await joined, result, 'identical deletes join');
            check(
              (await writer.delete(latestRequest)).kind === 'committed',
              'latest same-key retry recovers',
            );
            const recreated = await writer.put(create('recreate'));
            check(recreated.kind === 'committed', 'recreate commits');
            await subject.reconcile(pin.ref);
            await subject.reconcile(recreated.pin.ref);
            equal(
              await writer.delete(request),
              { kind: 'superseded', ref: pin.ref },
              'older retry stays fenced after recovery',
            );
            equal(
              await subject.repository.get(pin.ref),
              { kind: 'not_found', reason: 'deleted' },
              'stale reconciliation cannot replace tombstone',
            );
            equal(
              subject.repository.admit(recreated.pin),
              { kind: 'admitted' },
              'stale receipts cannot revoke recreated entry',
            );
          },
        );
      }
    }
    scenario(
      'delete supersedes an already uncertain replacement',
      async (subject) => {
        const pin = await seed(subject);
        const writer = subject.writer('test.family');
        const request = replace(pin);
        const gate = subject.holdNextCommit();
        const pending = writer.put(request);
        gate.release({ kind: 'outcome_unknown', applied: true });
        check(
          (await pending).kind === 'outcome_unknown',
          'replacement is uncertain',
        );
        const deleteGate = subject.holdNextCommit();
        const deletion = {
          ref: pin.ref,
          expectedRevision: pin.revision,
          idempotencyKey: 'delete',
        };
        const pendingDelete = writer.delete(deletion);
        equal(
          subject.repository.admit(pin),
          { kind: 'revoked' },
          'uncertain replacement cannot defer revocation',
        );
        await subject.reconcile(pin.ref);
        await closed(subject, pin, true);
        deleteGate.release({ kind: 'unavailable' });
        check(
          (await pendingDelete).kind === 'unavailable',
          'delete preserves its durability outcome',
        );
        await subject.reconcile(pin.ref);
        await closed(subject, pin, true);
        equal(
          await writer.put(request),
          { kind: 'superseded', ref: pin.ref },
          'old uncertain receipt cannot be promoted',
        );
        check(
          (await writer.delete(deletion)).kind === 'committed',
          'same-key retry confirms removal',
        );
      },
    );
    scenario(
      'rejected concurrent deletes do not supersede the pending writer',
      async (subject) => {
        const pin = await seed(subject);
        const writer = subject.writer('test.family');
        const gate = subject.holdNextCommit();
        const pending = writer.put(replace(pin));
        const deletion = {
          ref: pin.ref,
          expectedRevision: pin.revision,
          idempotencyKey: 'delete',
        };
        equal(
          await subject.writer('other.family').delete(deletion),
          { kind: 'refused', reason: 'managed_family' },
          'non-designated writer cannot revoke',
        );
        equal(
          await writer.delete({
            ...deletion,
            expectedRevision: pin.revision + 1,
          }),
          { kind: 'revision_conflict', currentRevision: pin.revision },
          'CAS mismatch cannot revoke',
        );
        equal(
          await writer.delete({ ...deletion, idempotencyKey: 'replace' }),
          { kind: 'idempotency_conflict' },
          'changed-key payload cannot revoke',
        );
        await closed(subject, pin, false);
        gate.release({ kind: 'committed' });
        const result = await pending;
        check(
          result.kind === 'committed',
          'refused deletes must not supersede replacement',
        );
        equal(
          subject.repository.admit(result.pin),
          { kind: 'admitted' },
          'replacement remains admissible',
        );
      },
    );
    for (const outcome of [
      { kind: 'unavailable' },
      { kind: 'outcome_unknown', applied: false },
      { kind: 'outcome_unknown', applied: true },
    ] satisfies readonly VaultTestCommit[]) {
      scenario(
        `create ${JSON.stringify(outcome)} never issues a usable pin`,
        async (subject) => {
          const writer = subject.writer('test.family');
          const gate = subject.holdNextCommit();
          const pending = writer.put(create());
          gate.release(outcome);
          const result = await pending;
          check(
            result.kind === 'unavailable' || result.kind === 'outcome_unknown',
            'create must report the failure',
          );
          check(failureKeysOnly(result), 'failed create must not issue a pin');
          const metadata = (await subject.repository.list())[0];
          check(
            metadata !== undefined,
            'failed create must retain unconfirmed metadata',
          );
          await closed(
            subject,
            { ref: result.ref, revision: metadata.revision },
            false,
          );
          const retried = await writer.put(create());
          if (outcome.kind === 'unavailable') {
            check(
              retried.kind === 'committed',
              'same-key retry recovers unavailable create',
            );
            equal(
              retried.pin.ref,
              result.ref,
              'create retry must retain its assigned ID',
            );
          } else {
            equal(
              retried,
              result,
              'uncertain create retries must await reconciliation',
            );
            await closed(
              subject,
              { ref: result.ref, revision: metadata.revision },
              false,
            );
          }
          check(
            (await subject.repository.list()).length === 1,
            'create retries must not duplicate entries',
          );
        },
      );
    }
    scenario(
      'expiry blocks confirmed material but never masks an unknown successor',
      async (subject) => {
        const writer = subject.writer('test.family');
        const result = await writer.put({
          ...create(),
          expiresAt: '2000-01-01T00:00:00.000Z',
        });
        check(result.kind === 'committed', 'expired entry may be stored');
        equal(
          await subject.repository.get(result.pin.ref),
          { kind: 'blocked', reason: 'expired' },
          'expiry must not serve material',
        );
        equal(
          subject.repository.admit(result.pin),
          { kind: 'blocked', reason: 'expired' },
          'expired pin cannot be admitted',
        );
        const gate = subject.holdNextCommit();
        const pending = writer.put({
          ...replace(result.pin),
          expiresAt: '2000-01-01T00:00:00.000Z',
        });
        gate.release({ kind: 'outcome_unknown', applied: true });
        await pending;
        await closed(subject, result.pin, false);
      },
    );
    scenario(
      'recreate gets a new ID and fresh revision; old ref stays deleted',
      async (subject) => {
        const first = await seed(subject);
        const writer = subject.writer('test.family');
        const replacement = await writer.put(replace(first));
        check(replacement.kind === 'committed', 'replace must commit');
        await writer.delete({
          ref: first.ref,
          expectedRevision: replacement.pin.revision,
          idempotencyKey: 'delete',
        });
        const recreated = await writer.put(create('recreate'));
        check(recreated.kind === 'committed', 'recreate must commit');
        check(
          recreated.pin.ref.entryId !== first.ref.entryId,
          'entry IDs are never reissued',
        );
        equal(recreated.pin.revision, first.revision, 'revisions start fresh');
        equal(
          await subject.repository.get(first.ref),
          { kind: 'not_found', reason: 'deleted' },
          'old ref must not follow recreate',
        );
      },
    );
    scenario(
      'foreign refs, CAS conflicts and non-designated writers have no effects',
      async (subject) => {
        const pin = await seed(subject);
        const writer = subject.writer('test.family');
        const other = subject.writer('other.family');
        const stolen = { ...other, family: 'test.family' };
        equal(
          await stolen.put(create('wrong-family')),
          { kind: 'refused', reason: 'managed_family' },
          'family property cannot widen the capability',
        );
        equal(
          await stolen.put(replace(pin)),
          { kind: 'refused', reason: 'managed_family' },
          'replace requires designated family writer',
        );
        equal(
          await stolen.delete({
            ref: pin.ref,
            expectedRevision: pin.revision,
            idempotencyKey: 'delete',
          }),
          { kind: 'refused', reason: 'managed_family' },
          'delete requires designated family writer',
        );
        for (const ref of [
          { ...pin.ref, vaultId: 'foreign-vault' },
          { ...pin.ref, entryId: 'absent' },
        ]) {
          const expected = {
            kind: 'not_found',
            reason:
              ref.vaultId === pin.ref.vaultId ? 'absent' : 'foreign_vault',
          };
          equal(
            await writer.put({ ...replace(pin), ref }),
            expected,
            'replace must refuse invalid refs',
          );
          equal(
            await writer.delete({
              ref,
              expectedRevision: pin.revision,
              idempotencyKey: 'delete',
            }),
            expected,
            'delete must refuse invalid refs',
          );
        }
        equal(
          await writer.put({
            ...replace(pin),
            expectedRevision: pin.revision + 1,
          }),
          { kind: 'revision_conflict', currentRevision: pin.revision },
          'CAS mismatch',
        );
        equal(
          subject.repository.admit(pin),
          { kind: 'admitted' },
          'refusal must not narrow admission',
        );
      },
    );
    scenario(
      'pending retries join; changed input conflicts; replay never resurrects',
      async (subject) => {
        const writer = subject.writer('test.family');
        const gate = subject.holdNextCommit();
        const first = writer.put(create());
        const retry = writer.put(create());
        equal(
          await writer.put({ ...create(), label: 'Changed' }),
          { kind: 'idempotency_conflict' },
          'changed retry must conflict',
        );
        gate.release({ kind: 'committed' });
        const result = await first;
        equal(await retry, result, 'pending retries must share result');
        check(result.kind === 'committed', 'create receipt');
        check(
          (await subject.repository.list()).length === 1,
          'retry must not allocate another entry',
        );
        await writer.delete({
          ref: result.pin.ref,
          expectedRevision: result.pin.revision,
          idempotencyKey: 'delete',
        });
        equal(
          await writer.put(create()),
          result,
          'same request replays receipt',
        );
        equal(
          await subject.repository.get(result.pin.ref),
          { kind: 'not_found', reason: 'deleted' },
          'replay must not resurrect',
        );
      },
    );
    scenario(
      'invalid material and CAS inputs reject without effects',
      async (subject) => {
        const pin = await seed(subject);
        for (const request of [
          { ...replace(pin), material: new Uint8Array() },
          { ...replace(pin), material: new Uint8Array(1_000_001) },
          { ...replace(pin), expectedRevision: -1 },
          { ...replace(pin), label: '' },
          { ...replace(pin), idempotencyKey: '' },
          { ...replace(pin), idempotencyKey: 'x'.repeat(513) },
          { ...replace(pin), expectedRevision: 0.5 },
          { ...replace(pin), expiresAt: 'not-a-timestamp' },
          { ...replace(pin), secret: 'unexpected wire-only field' },
        ]) {
          let error: unknown;
          try {
            await subject.writer('test.family').put(request);
          } catch (caught) {
            error = caught;
          }
          check(
            error instanceof TypeError,
            'invalid input must reject with TypeError',
          );
          equal(
            subject.repository.admit(pin),
            { kind: 'admitted' },
            'invalid input must have no effects',
          );
        }
      },
    );
  });
}

import {
  WORKER_GIT_DIFF_READS_REVISION,
  WORKER_GIT_DIFF_SCHEMA_REVISION,
  WorkerGitDiffGetResultSchema,
  type CanopyCallerDescriptor,
  type WorkerGitDiffGetParams,
  type WorkerGitDiffGetResult,
} from '@canopy/protocol/canopy-core';
import { CanopyOperationError } from '../../../runtime/errors';
import type { CanopyHandlerContext } from '../../../runtime/types';
import type {
  GitChangeSetRead,
  GitChangeSetReader,
  GitUntrackedEstimate,
} from '../change-set';
import { GitRepositoryReadError } from '../repository-reads';
import { estimateGitUntrackedChanges } from '../untracked-estimate';
import {
  createWorkerGitDiffHandlers,
  WORKER_GIT_DIFF_READS_RESULT_BYTES,
} from '../worker-git-diff';

/*
 * CAN-4729 revision 3 of worker.git.diff.get: the comparison's settled reads,
 * so the desktop rebuilds its legacy lists from a daemon answer. Each read is
 * bounded where the legacy listing would blank it; the whole answer is capped
 * at 48 MiB, measured before the transport splits it.
 */

const MiB = 1024 * 1024;
const caller: CanopyCallerDescriptor = {
  principalId: 'user',
  clientInstanceId: 'client',
  authorityId: 'local',
  interfaceKind: 'test',
  grants: ['worker.git.read'],
};
const context = (): CanopyHandlerContext => ({
  requestId: '1',
  caller,
  metadata: {},
  signal: new AbortController().signal,
});

type Outputs = Partial<
  Record<GitChangeSetRead['kind'], string | (() => Promise<string>)>
>;

/** A reader answering each read from `outputs`; an absent one exits 128. */
function reader(
  outputs: Outputs,
  estimates: readonly GitUntrackedEstimate[] = [],
): GitChangeSetReader & { readonly kinds: string[] } {
  const kinds: string[] = [];
  return {
    kinds,
    read: (read) => {
      kinds.push(read.kind);
      const output = outputs[read.kind];
      if (typeof output === 'function') return output();
      return output === undefined
        ? Promise.reject(
            new GitRepositoryReadError('exit_status', { exitCode: 128 }),
          )
        : Promise.resolve(output);
    },
    estimateUntracked: (paths) =>
      Promise.resolve(paths.map((_, index) => estimates[index] ?? none)),
  };
}
const none: GitUntrackedEstimate = { insertions: 0, binary: false };

function handler(
  source: GitChangeSetReader,
): (
  params: Partial<WorkerGitDiffGetParams>,
) => Promise<WorkerGitDiffGetResult> {
  const { 'worker.git.diff.get': get } = createWorkerGitDiffHandlers({
    authorityId: 'local',
    resolveRepository: () => Promise.resolve('repo'),
    reads: () => source,
  });
  return async (params) =>
    get(
      {
        scope: { workspaceId: 'w', worktreeId: 't' },
        repoId: '__workspace_root__',
        base: 'HEAD',
        head: 'WORKTREE',
        ...params,
      },
      context(),
    );
}

const rev3 = { revision: WORKER_GIT_DIFF_READS_REVISION } as const;

async function refusal(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => 'answered',
    (error: unknown) =>
      error instanceof CanopyOperationError
        ? { kind: error.payload.kind, code: error.payload.code }
        : error,
  );
}

/** `count` NUL-terminated name-status records of `width`-byte paths. */
function nameStatus(count: number, width: number, prefix = 'n'): string {
  let out = '';
  for (let index = 0; index < count; index += 1)
    out += `M\0${`${prefix}${index}/`.padEnd(width, 'x')}\0`;
  return out;
}

/** Renames that keep a long shared directory: one short legacy name each. */
function renames(count: number, width: number): string {
  let out = '';
  for (let index = 0; index < count; index += 1) {
    const dir = `r${index}/`.padEnd(width, 'd');
    out += `0\t0\t\0${dir}/a\0${dir}/b\0`;
  }
  return out;
}

const bytes = (value: unknown): number =>
  Buffer.byteLength(JSON.stringify(value));

describe('worker.git.diff.get revision 3', () => {
  it('answers every read as -z fields, with files empty, and parses under the result schema', async () => {
    const source = reader(
      {
        'diff-name-status': 'M\0a.txt\0R100\0old\0new\0',
        'diff-numstat': '1\t2\ta.txt\0' + '0\t0\t\0old\0new\0',
        'untracked-files': 'u1\0u2\0',
        'unmerged-files': '100644 ' + 'a'.repeat(40) + ' 1\tc.txt\0',
      },
      [
        { insertions: 3, binary: false },
        { insertions: 0, binary: true, confined: true },
      ],
    );
    const answer = await handler(source)(rev3);
    expect(WorkerGitDiffGetResultSchema.parse(answer)).toEqual(answer);
    expect(answer).toEqual({
      files: [],
      truncated: false,
      reads: {
        nameStatus: { ok: true, fields: ['M', 'a.txt', 'R100', 'old', 'new'] },
        numstat: { ok: true, fields: ['1\t2\ta.txt', '0\t0\t', 'old', 'new'] },
        untracked: { ok: true, fields: ['u1', 'u2'] },
        unmerged: {
          ok: true,
          fields: ['100644 ' + 'a'.repeat(40) + ' 1\tc.txt'],
        },
        untrackedEstimates: [
          { insertions: 3, binary: false },
          { insertions: 0, binary: true, confined: true },
        ],
      },
    });
    // The same four reads as revision 1, and no object probe.
    expect([...source.kinds].sort()).toEqual([
      'diff-name-status',
      'diff-numstat',
      'unmerged-files',
      'untracked-files',
    ]);
  });

  it('reports a failed read with its exit code instead of failing the call', async () => {
    // No commit yet: both diffs exit 128, the untracked listing still answers.
    const answer = await handler(
      reader({ 'untracked-files': 'only\0', 'unmerged-files': '' }),
    )(rev3);
    expect(answer.reads).toEqual({
      nameStatus: { ok: false, exitCode: 128 },
      numstat: { ok: false, exitCode: 128 },
      untracked: { ok: true, fields: ['only'] },
      unmerged: { ok: true, fields: [] },
      untrackedEstimates: [{ insertions: 0, binary: false }],
    });
    // Revision 1 fails the same comparison with the typed state: HEAD is absent.
    const noHead = (): Promise<string> =>
      Promise.reject(
        new GitRepositoryReadError('exit_status', { exitCode: 1 }),
      );
    expect(
      await refusal(
        handler(
          reader({
            'untracked-files': 'only\0',
            'unmerged-files': '',
            'object-exists': noHead,
          }),
        )({}),
      ),
    ).toEqual({
      kind: 'failed_precondition',
      code: 'worker.git.diff.invalidState',
    });
  });

  it('carries no untracked or unmerged read for two objects', async () => {
    const a = 'a'.repeat(40);
    const b = 'b'.repeat(40);
    const answer = await handler(
      reader({ 'diff-name-status': 'A\0x\0', 'diff-numstat': '1\t0\tx\0' }),
    )({ ...rev3, base: a, head: b });
    expect(answer.reads).toEqual({
      nameStatus: { ok: true, fields: ['A', 'x'] },
      numstat: { ok: true, fields: ['1\t0\tx'] },
      untracked: null,
      unmerged: null,
      untrackedEstimates: [],
    });
  });

  it('answers objectMissing when Git would not fetch a partial clone object', async () => {
    const blocked = (): Promise<string> =>
      Promise.reject(
        new GitRepositoryReadError('exit_status', {
          exitCode: 128,
          lazyFetchBlocked: true,
        }),
      );
    expect(
      await refusal(
        handler(
          reader({
            'diff-name-status': '',
            'diff-numstat': blocked,
            'untracked-files': '',
            'unmerged-files': '',
          }),
        )(rev3),
      ),
    ).toEqual({
      kind: 'failed_precondition',
      code: 'worker.git.diff.objectMissing',
    });
  });

  it('blanks a read past its legacy bound: 8 MiB raw, 16 MiB for numstat', async () => {
    const over = nameStatus(1, 8 * MiB);
    const under = nameStatus(1, 8 * MiB - 8);
    const answer = await handler(
      reader({
        'diff-name-status': over,
        // About 10 MiB raw: both paths of one 5 MiB-deep rename.
        'diff-numstat': renames(1, 5 * MiB),
        'untracked-files': under.slice(2),
        'unmerged-files': '',
      }),
    )(rev3);
    expect(answer.reads?.nameStatus).toEqual({
      ok: true,
      fields: [],
      overCap: true,
    });
    // Over 8 MiB raw, but its legacy text names the rename once.
    expect(answer.reads?.numstat).toMatchObject({ ok: true });
    expect(answer.reads?.numstat).not.toHaveProperty('overCap');
    expect(answer.reads?.untracked).not.toHaveProperty('overCap');
    // One record is 2 * width + 11 bytes: one byte either side of 16 MiB,
    // both well under the 32 MiB a real Git read may return.
    const numstat = async (
      width: number,
    ): Promise<{ bytes: number; read: unknown }> => {
      const raw = renames(1, width);
      expect(raw.length).toBeLessThan(17 * MiB);
      return {
        bytes: raw.length,
        read: (
          await handler(
            reader({
              'diff-name-status': '',
              'diff-numstat': raw,
              'untracked-files': '',
              'unmerged-files': '',
            }),
          )(rev3)
        ).reads?.numstat,
      };
    };
    const atBound = await numstat(8 * MiB - 6);
    expect(atBound.bytes).toBe(16 * MiB - 1);
    expect(atBound.read).toMatchObject({ ok: true });
    expect(atBound.read).not.toHaveProperty('overCap');
    const pastBound = await numstat(8 * MiB);
    expect(pastBound.bytes).toBe(16 * MiB + 11);
    expect(pastBound.read).toEqual({ ok: true, fields: [], overCap: true });
  });

  it('answers a rename-heavy comparison near 40 MiB raw, and refuses one over 48 MiB', async () => {
    const width = 4000;
    const per = (record: string): number => Buffer.byteLength(record);
    const fill = (bound: number, make: (count: number) => string): string => {
      const count = Math.floor((bound - 64) / per(make(1)));
      return make(count);
    };
    const outputs = {
      'diff-name-status': fill(8 * MiB, (count) => nameStatus(count, width)),
      'diff-numstat': fill(16 * MiB, (count) => renames(count, width)),
      'untracked-files': fill(8 * MiB, (count) =>
        nameStatus(count, width, 'u').replaceAll('M\0', ''),
      ),
      'unmerged-files': fill(8 * MiB, (count) =>
        nameStatus(count, width, 'c').replaceAll(
          'M\0',
          `100644 ${'a'.repeat(40)} 1\t`,
        ),
      ),
    };
    const raw = Object.values(outputs).reduce(
      (sum, output) => sum + Buffer.byteLength(output),
      0,
    );
    expect(raw).toBeGreaterThan(39 * MiB);
    const answer = await handler(reader(outputs))(rev3);
    for (const read of Object.values(answer.reads ?? {}))
      if (read !== null && !Array.isArray(read))
        expect(read).not.toHaveProperty('overCap');
    expect(bytes(answer)).toBeGreaterThan(39 * MiB);
    expect(bytes(answer)).toBeLessThanOrEqual(
      WORKER_GIT_DIFF_READS_RESULT_BYTES,
    );
    expect(WORKER_GIT_DIFF_READS_RESULT_BYTES).toBe(48 * MiB);

    // Control characters: each is six bytes of JSON for one of output.
    const control = (count: number): string =>
      Array.from({ length: count }, () => `${'\u0001'.repeat(1000)}\0`).join(
        '',
      );
    expect(
      await refusal(
        handler(
          reader({
            ...outputs,
            'untracked-files': control(Math.floor((8 * MiB - 64) / 1001)),
          }),
        )(rev3),
      ),
    ).toEqual({ kind: 'resource_exhausted', code: undefined });
  });

  it('serves no patches under revision 3, and still refuses revision 2', async () => {
    const source = reader({});
    expect(await refusal(handler(source)({ ...rev3, paths: ['a'] }))).toEqual({
      kind: 'capability_unavailable',
      code: undefined,
    });
    expect(
      await refusal(
        handler(source)({ revision: WORKER_GIT_DIFF_SCHEMA_REVISION }),
      ),
    ).toEqual({ kind: 'capability_unavailable', code: undefined });
    expect(source.kinds).toEqual([]);
  });

  it('answers reads-only only to a revision-3 request: without one the same comparison carries its files', async () => {
    const outputs = {
      'diff-name-status': 'M\0a.txt\0',
      'diff-numstat': '1\t2\ta.txt\0',
      'untracked-files': 'new.txt\0',
      'unmerged-files': '',
    };
    const plain = await handler(reader(outputs))({});
    expect(plain).not.toHaveProperty('reads');
    expect(plain.files.map((file) => file.path)).toEqual(['a.txt', 'new.txt']);
    const reads = await handler(reader(outputs))(rev3);
    expect(reads.files).toEqual([]);
    expect(reads.truncated).toBe(false);
    expect(reads.reads?.nameStatus).toEqual({
      ok: true,
      fields: ['M', 'a.txt'],
    });
    // Revision 2 is the web core's: these hosts refuse it rather than answer
    // either shape.
    expect(
      await refusal(
        handler(reader(outputs))({ revision: WORKER_GIT_DIFF_SCHEMA_REVISION }),
      ),
    ).toEqual({ kind: 'capability_unavailable', code: undefined });
  });

  it('leaves revision 1 byte for byte as before: no reads, canonical files', async () => {
    const answer = await handler(
      reader({
        'diff-name-status': 'M\0a.txt\0',
        'diff-numstat': '1\t2\ta.txt\0',
        'untracked-files': '',
        'unmerged-files': '',
      }),
    )({});
    expect(JSON.stringify(answer)).toBe(
      JSON.stringify({
        files: [
          {
            path: 'a.txt',
            previousPath: null,
            status: 'modified',
            additions: 1,
            deletions: 2,
            patch: null,
          },
        ],
        truncated: false,
      }),
    );
  });

  it('flags confined only for a path shown outside the checkout: an unresolvable root is a plain skip', async () => {
    expect(
      await estimateGitUntrackedChanges(
        '/nonexistent/canopy-checkout-root',
        ['a.txt'],
        { confined: true },
      ),
    ).toEqual([{ insertions: 0, binary: false }]);
  });
});

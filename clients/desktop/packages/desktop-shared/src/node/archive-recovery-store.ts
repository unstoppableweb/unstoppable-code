import { createHash } from 'node:crypto';
import {
  lstat,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  unlink,
  rmdir,
} from 'node:fs/promises';
import { dirname, join, resolve, relative, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import {
  inspectDestructiveJournals,
  journalSchema,
} from './w5-destructive-journal';
import {
  createDirectoryDurably,
  renameWithRetry,
  syncDirectory,
  syncTreeDurably,
  writeFileAtomically,
} from '@canopy/execution-engine/node/lib/atomic-file';

export class ArchiveRecoveryRefusedError extends Error {
  public constructor(
    message: string,
    public readonly refusalCause?: unknown,
  ) {
    super(message);
    this.name = 'ArchiveRecoveryRefusedError';
  }
}

const id = z.string().regex(/^[a-z0-9][a-z0-9-]*$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const receiptTemporaryName = /^\.receipt\.json\.\d+\.[a-f0-9-]{36}\.tmp$/;
export const archiveRecoveryInventorySchema = z.object({
  identity: z.string(),
  entries: z.array(
    z.object({
      path: z.string(),
      kind: z.enum(['directory', 'file', 'symlink']),
      digest: digest.optional(),
      size: z.number().optional(),
    }),
  ),
});
export const archiveRecoveryRepositorySchema = z.object({
  repoId: z.string(),
  referenceRepoPath: z.string(),
  commonDir: z.string(),
  identity: z.string(),
  refs: z.array(
    z.object({
      name: z.string(),
      objectId: z.string().regex(/^[a-f0-9]{40,64}$/),
    }),
  ),
});
export type ArchiveRecoveryRepository = z.infer<
  typeof archiveRecoveryRepositorySchema
>;
const preparationSchema = z.object({
  workspaceId: id,
  worktreeId: id,
  operationId: z.string().uuid(),
  action: z.enum(['keep-worktree', 'release']),
  revision: digest,
  createdAt: z.string().datetime(),
  copies: z.array(
    z.object({
      name: z.string().regex(/^(?:[a-f0-9]{64}|[a-f0-9-]{36})\.json$/),
      contents: z.string(),
      digest,
    }),
  ),
  sourceRecord: z.record(z.string(), z.unknown()),
  repositories: z.array(archiveRecoveryRepositorySchema),
  capture: z.enum(['complete', 'partial', 'unpublished', 'none']),
});
export const archiveRecoveryReceiptSchema = preparationSchema.extend({
  version: z.literal(1),
  retention: z.enum(['deleting', 'deleted']).optional(),
  cancelled: z.literal(true).optional(),
  stage: z.enum([
    'prepared',
    'retention-intent',
    'retained',
    'reset-intent',
    'staging-reset',
    'withdrawal-intent',
    'withdrawn',
    'completed',
  ]),
  staging: archiveRecoveryInventorySchema.nullable(),
});
export type ArchiveRecoveryReceipt = z.infer<
  typeof archiveRecoveryReceiptSchema
>;
export type ArchiveRecoveryPreparation = z.infer<typeof preparationSchema>;

export function archiveRecoveryDigest(contents: string | Buffer): string {
  return createHash('sha256').update(contents).digest('hex');
}

function missing(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}

/** Links inside the retained tree are evidence, never traversal targets. */
export async function inventoryArchiveRecoveryTree(
  path: string,
): Promise<z.infer<typeof archiveRecoveryInventorySchema> | null> {
  const root = await lstat(path).catch((error: unknown) => {
    if (missing(error)) return null;
    throw error;
  });
  if (!root) return null;
  if (!root.isDirectory() || root.isSymbolicLink())
    throw new ArchiveRecoveryRefusedError(
      'Recovery staging is not a canonical directory.',
    );
  const entries: z.infer<typeof archiveRecoveryInventorySchema>['entries'] = [];
  const visit = async (directory: string, prefix: string): Promise<void> => {
    for (const name of (await readdir(directory)).sort()) {
      const relative = prefix ? `${prefix}/${name}` : name;
      const child = join(directory, name);
      const info = await lstat(child);
      if (info.isSymbolicLink())
        entries.push({
          path: relative,
          kind: 'symlink',
          digest: archiveRecoveryDigest(await readlink(child)),
        });
      else if (info.isDirectory()) {
        entries.push({ path: relative, kind: 'directory' });
        await visit(child, relative);
      } else if (info.isFile() && info.nlink === 1) {
        const contents = await readFile(child);
        entries.push({
          path: relative,
          kind: 'file',
          size: contents.length,
          digest: archiveRecoveryDigest(contents),
        });
      } else
        throw new ArchiveRecoveryRefusedError(
          'Unsupported or aliased recovery payload.',
        );
    }
  };
  await visit(path, '');
  return { identity: `${root.dev}:${root.ino}:${root.birthtimeMs}`, entries };
}

function isReusedSourceSlot(
  contents: string | null,
  operationId: string,
): boolean {
  if (contents === null) return true;
  try {
    return (
      journalSchema.parse(JSON.parse(contents)).operationId !== operationId
    );
  } catch {
    return false;
  }
}

function assertRecoveryCopies(receipt: ArchiveRecoveryPreparation): void {
  if (receipt.copies.length === 0) return;
  const record = journalSchema.parse(receipt.sourceRecord);
  if (
    record.operationId !== receipt.operationId ||
    record.workspaceId !== receipt.workspaceId ||
    record.worktreeId !== receipt.worktreeId ||
    record.createdAt !== receipt.createdAt ||
    record.operation !== 'worktree-archive' ||
    record.state !== 'recovery-required'
  )
    throw new ArchiveRecoveryRefusedError('Recovery source identity mismatch.');
  const slot = `${archiveRecoveryDigest(JSON.stringify([receipt.workspaceId, receipt.worktreeId]))}.json`;
  const names = new Set<string>();
  let original: unknown;
  for (const copy of receipt.copies) {
    const raw: unknown = JSON.parse(copy.contents);
    if (
      names.has(copy.name) ||
      (copy.name !== slot && copy.name !== `${receipt.operationId}.json`) ||
      archiveRecoveryDigest(copy.contents) !== copy.digest ||
      !isDeepStrictEqual(journalSchema.parse(raw), record)
    )
      throw new ArchiveRecoveryRefusedError(
        'Invalid recovery source copy binding.',
      );
    if (names.size === 0) original = raw;
    else if (!isDeepStrictEqual(original, raw))
      throw new ArchiveRecoveryRefusedError(
        'Conflicting recovery source copies.',
      );
    names.add(copy.name);
  }
}

export interface ArchiveRecoveryInspection {
  receipt: ArchiveRecoveryReceipt;
  reset: 'unperformed' | 'performed' | 'conflict';
  copies: ('original' | 'retired' | 'conflict')[];
  payload: 'exact' | 'subset' | 'absent' | 'conflict';
  effectFree: boolean;
  classification: ArchiveRecoveryClassification;
}

export interface ArchiveRecoveryClassification {
  stage: ArchiveRecoveryReceipt['stage'];
  effects:
    | Pick<ArchiveRecoveryInspection, 'reset' | 'copies' | 'payload'>
    | undefined;
  disposition: 'cancelled' | 'deleting' | 'deleted' | 'resolving' | 'held';
  conflict: boolean;
  worktreeFence: boolean;
  projectFence: boolean;
  relocationNeedsQualification: boolean;
  payloadRule: 'source' | 'absent' | 'subset' | 'exact';
}

/** Lifecycle policy is projected from the same stage/effect classification as settlement. */
export function classifyArchiveRecovery(
  receipt: ArchiveRecoveryReceipt,
  effects?: Pick<ArchiveRecoveryInspection, 'reset' | 'copies' | 'payload'>,
): ArchiveRecoveryClassification {
  const unfinished = !receipt.cancelled && receipt.stage !== 'completed';
  return {
    stage: receipt.stage,
    effects,
    disposition: receipt.cancelled
      ? 'cancelled'
      : (receipt.retention ?? (unfinished ? 'resolving' : 'held')),
    conflict:
      effects !== undefined &&
      (effects.copies.includes('conflict') ||
        effects.payload === 'conflict' ||
        (unfinished && effects.reset === 'conflict')),
    worktreeFence: unfinished || receipt.retention === 'deleting',
    projectFence: unfinished,
    relocationNeedsQualification: receipt.retention !== 'deleted',
    payloadRule: receipt.cancelled
      ? 'source'
      : receipt.retention === 'deleted'
        ? 'absent'
        : receipt.retention === 'deleting'
          ? 'subset'
          : 'exact',
  };
}

/** Worker-side durable ownership. The caller owns mutation, archive and journal admission. */
export class ArchiveRecoveryStore {
  public constructor(private readonly dataRoot: string) {}

  private async assertOwnedPath(path: string): Promise<void> {
    const suffix = relative(resolve(this.dataRoot), resolve(path));
    if (suffix.startsWith('..'))
      throw new ArchiveRecoveryRefusedError(
        'Recovery path escaped the data root.',
      );
    const canonicalRoot = await realpath(this.dataRoot).catch(
      (error: unknown) => {
        if (missing(error)) return null;
        throw error;
      },
    );
    if (canonicalRoot === null) return;
    let current = this.dataRoot;
    for (const part of suffix.split(sep)) {
      current = join(current, part);
      const info = await lstat(current).catch((error: unknown) => {
        if (missing(error)) return null;
        throw error;
      });
      if (!info) return;
      if (
        info.isSymbolicLink() ||
        (await realpath(current)) !==
          join(canonicalRoot, relative(this.dataRoot, current))
      )
        throw new ArchiveRecoveryRefusedError('Aliased recovery path.');
    }
  }

  public directory(
    receipt: Pick<ArchiveRecoveryReceipt, 'workspaceId' | 'operationId'>,
  ): string {
    id.parse(receipt.workspaceId);
    z.string().uuid().parse(receipt.operationId);
    return join(
      this.dataRoot,
      'w5',
      'archive-recovery',
      receipt.workspaceId,
      receipt.operationId,
    );
  }

  public payloadPath(receipt: ArchiveRecoveryReceipt): string {
    return join(this.directory(receipt), 'payload');
  }

  public stagingPath(
    receipt: Pick<ArchiveRecoveryReceipt, 'workspaceId' | 'worktreeId'>,
  ): string {
    id.parse(receipt.workspaceId);
    id.parse(receipt.worktreeId);
    return join(
      this.dataRoot,
      'workspaces',
      receipt.workspaceId,
      'archived-containers',
      receipt.worktreeId,
    );
  }

  /** Requires the existing exclusive writer or cold relocation lease. Never called by readers. */
  public async normalize(
    workspaceId: string,
    operationId: string,
  ): Promise<void> {
    const directory = this.directory({ workspaceId, operationId });
    await this.assertOwnedPath(directory);
    const info = await lstat(directory).catch((error: unknown) => {
      if (missing(error)) return null;
      throw error;
    });
    if (!info) return;
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (process.getuid && info.uid !== process.getuid())
    )
      throw new ArchiveRecoveryRefusedError(
        'Unowned recovery operation directory.',
      );
    const names = await readdir(directory);
    const published = names.includes('receipt.json');
    const receipt = published
      ? await this.read(workspaceId, operationId)
      : null;
    const files = await Promise.all(
      names.map(async (name) => ({
        name,
        info: await lstat(join(directory, name)),
      })),
    );
    for (const entry of files) {
      if (published && ['payload', 'journals'].includes(entry.name)) {
        await this.assertOwnedPath(join(directory, entry.name));
        if (!entry.info.isDirectory() || entry.info.isSymbolicLink())
          throw new ArchiveRecoveryRefusedError(
            'Aliased recovery effect directory.',
          );
        if (entry.name === 'journals') {
          for (const name of await readdir(join(directory, 'journals'))) {
            const copy = receipt?.copies.find((copy) => copy.name === name);
            if (
              !copy ||
              (await this.journalContents(
                join(directory, 'journals', name),
              )) !== copy.contents
            )
              throw new ArchiveRecoveryRefusedError(
                'Unknown or replaced retired journal artifact.',
              );
          }
        }
        continue;
      }
      if (
        entry.name !== 'receipt.json' &&
        !receiptTemporaryName.test(entry.name)
      )
        throw new ArchiveRecoveryRefusedError(
          'Unknown recovery publication artifact.',
        );
      if (
        !entry.info.isFile() ||
        entry.info.isSymbolicLink() ||
        (process.getuid && entry.info.uid !== process.getuid()) ||
        (entry.name !== 'receipt.json' && (entry.info.mode & 0o077) !== 0)
      )
        throw new ArchiveRecoveryRefusedError(
          'Unowned recovery publication artifact.',
        );
      const links = files.filter(
        (other) =>
          other.info.dev === entry.info.dev &&
          other.info.ino === entry.info.ino,
      );
      if (
        entry.info.nlink !== links.length ||
        (links.length > 1 &&
          !links.some((other) => other.name === 'receipt.json'))
      )
        throw new ArchiveRecoveryRefusedError(
          'Unaccounted recovery publication alias.',
        );
    }
    for (const entry of files) {
      if (!receiptTemporaryName.test(entry.name)) continue;
      await unlink(join(directory, entry.name));
      await syncDirectory(directory);
    }
    if (!published) {
      await rmdir(directory);
      await syncDirectory(dirname(directory));
    }
  }

  public async normalizeWorkspace(workspaceId: string): Promise<void> {
    const directory = join(
      this.dataRoot,
      'w5',
      'archive-recovery',
      id.parse(workspaceId),
    );
    await this.assertOwnedPath(directory);
    const names = await readdir(directory).catch((error: unknown) => {
      if (missing(error)) return [];
      throw error;
    });
    for (const name of names) await this.normalize(workspaceId, name);
    await this.settleSupersededCancellations(workspaceId);
  }

  /** Exclusive writer only. Missing sources alone never prove another owner's completion. */
  private async settleSupersededCancellations(
    workspaceId: string,
  ): Promise<void> {
    const receipts = (await this.list(workspaceId)).filter(
      (receipt) => receipt.cancelled,
    );
    if (!receipts.length) return;
    const inspection = await inspectDestructiveJournals(this.dataRoot);
    if (inspection.issues.length) return;
    for (const receipt of receipts) {
      const source = journalSchema.parse(receipt.sourceRecord);
      const sameIncarnation = (record: typeof source): boolean =>
        record.workspaceId === source.workspaceId &&
        record.worktreeId === source.worktreeId &&
        record.createdAt === source.createdAt &&
        (record.directoryIdentity === source.directoryIdentity ||
          // Pre-CAN-5024 journals compare only the project stat, before its marker was added.
          (source.directoryIdentity?.split(':').length === 3 &&
            record.directoryIdentity?.split(':').slice(0, 3).join(':') ===
              source.directoryIdentity));
      const records = inspection.records.map((entry) => entry.record);
      const sources = records.filter(
        (record) => record.operationId === source.operationId,
      );
      // An original history copy still protects the source, even after the slot advanced.
      if (
        sources.some(
          (record) =>
            record.state !== 'completed' ||
            record.cleanupRequired ||
            record.operation !== source.operation ||
            !sameIncarnation(record) ||
            !isDeepStrictEqual(record, sources[0]),
        )
      )
        continue;
      const witnesses = records.filter(
        (record) =>
          sameIncarnation(record) &&
          record.state === 'completed' &&
          !record.cleanupRequired &&
          record.operation !== 'workspace-delete' &&
          (record.operationId === source.operationId
            ? record.operation === source.operation
            : record.supersedesArchives?.includes(source.operationId) ||
              (record.operation === 'worktree-delete' &&
                record.steps[0]?.phase ===
                  `discard:supersede:${source.operationId}` &&
                record.steps[0].state === 'done' &&
                record.steps.some(
                  (step) =>
                    step.phase === 'discard:retire-superseded' &&
                    step.state === 'done',
                ))),
      );
      if (
        !witnesses.some((witness) =>
          records
            .filter((record) => record.operationId === witness.operationId)
            .every((record) => isDeepStrictEqual(record, witness)),
        )
      )
        continue;
      if (
        receipt.retention ||
        (await readdir(this.directory(receipt))).some(
          (name) => name !== 'receipt.json',
        )
      )
        continue;
      // The completing journal remains the durable replay proof if unlink or directory removal is interrupted.
      await unlink(join(this.directory(receipt), 'receipt.json'));
      await syncDirectory(this.directory(receipt));
      await rmdir(this.directory(receipt));
      await syncDirectory(dirname(this.directory(receipt)));
    }
  }

  public async inspect(
    receipt: ArchiveRecoveryReceipt,
  ): Promise<ArchiveRecoveryInspection> {
    const current = await this.read(receipt.workspaceId, receipt.operationId);
    if (!current || !isDeepStrictEqual(current, receipt))
      throw new ArchiveRecoveryRefusedError('Recovery receipt changed.');
    await this.assertOwnedPath(this.payloadPath(receipt));
    const payload = await inventoryArchiveRecoveryTree(
      this.payloadPath(receipt),
    );
    const exact = isDeepStrictEqual(payload, receipt.staging);
    const subset =
      payload !== null &&
      payload.identity === receipt.staging?.identity &&
      payload.entries.every((entry) =>
        receipt.staging?.entries.some((original) =>
          isDeepStrictEqual(entry, original),
        ),
      );
    const copies: ArchiveRecoveryInspection['copies'] = [];
    for (const copy of receipt.copies) {
      const retired = await this.journalContents(
        join(this.directory(receipt), 'journals', copy.name),
      );
      // A proven retired copy permits reuse of the original source slot by another operation.
      if (retired === copy.contents) {
        const original = await this.journalContents(
          join(this.dataRoot, 'w5', 'destructive-lifecycles', copy.name),
        );
        copies.push(
          isReusedSourceSlot(original, receipt.operationId)
            ? 'retired'
            : 'conflict',
        );
      } else {
        const original = await this.journalContents(
          join(this.dataRoot, 'w5', 'destructive-lifecycles', copy.name),
        );
        copies.push(
          retired === null && original === copy.contents
            ? 'original'
            : 'conflict',
        );
      }
    }
    let reset: ArchiveRecoveryInspection['reset'] = 'conflict';
    if (
      receipt.stage === 'completed' ||
      receipt.stage === 'withdrawn' ||
      receipt.stage === 'withdrawal-intent' ||
      receipt.stage === 'staging-reset'
    ) {
      reset = exact ? 'performed' : 'conflict';
    } else {
      await this.assertOwnedPath(this.stagingPath(receipt));
      const staging = await inventoryArchiveRecoveryTree(
        this.stagingPath(receipt),
      );
      if (isDeepStrictEqual(staging, receipt.staging) && payload === null)
        reset = 'unperformed';
      else if (
        receipt.stage === 'reset-intent' &&
        receipt.staging !== null &&
        staging === null &&
        exact
      )
        reset = 'performed';
    }
    const payloadEvidence =
      payload === null
        ? 'absent'
        : exact
          ? 'exact'
          : subset
            ? 'subset'
            : 'conflict';
    return {
      classification: classifyArchiveRecovery(receipt, {
        reset,
        copies,
        payload: payloadEvidence,
      }),
      receipt,
      reset,
      copies,
      payload:
        payload === null
          ? 'absent'
          : exact
            ? 'exact'
            : subset
              ? 'subset'
              : 'conflict',
      effectFree:
        !receipt.retention &&
        reset === 'unperformed' &&
        receipt.copies.length > 0 &&
        copies.every((copy) => copy === 'original'),
    };
  }

  /** The caller must first qualify all retained refs; cancellation never withdraws source journals. */
  public async restartCancelled(
    receipt: ArchiveRecoveryReceipt,
  ): Promise<ArchiveRecoveryReceipt> {
    const evidence = await this.inspect(receipt);
    if (!receipt.cancelled || !evidence.effectFree)
      throw new ArchiveRecoveryRefusedError(
        'Cancelled resolution evidence changed.',
      );
    const updated = { ...receipt, stage: 'prepared' as const };
    delete updated.cancelled;
    await writeFileAtomically(
      join(this.directory(receipt), 'receipt.json'),
      JSON.stringify(updated),
      { durable: true, mode: 0o600 },
    );
    return updated;
  }

  public async cancel(
    receipt: ArchiveRecoveryReceipt,
  ): Promise<ArchiveRecoveryReceipt> {
    const evidence = await this.inspect(receipt);
    if (
      !['prepared', 'retention-intent', 'retained', 'reset-intent'].includes(
        receipt.stage,
      ) ||
      !evidence.effectFree
    )
      throw new ArchiveRecoveryRefusedError(
        'Resolver effects cannot be proven absent.',
      );
    const updated = { ...receipt, cancelled: true as const };
    await writeFileAtomically(
      join(this.directory(receipt), 'receipt.json'),
      JSON.stringify(updated),
      { durable: true, mode: 0o600 },
    );
    return updated;
  }

  public async read(
    workspaceId: string,
    operationId: string,
  ): Promise<ArchiveRecoveryReceipt | null> {
    const path = join(
      this.directory({ workspaceId, operationId }),
      'receipt.json',
    );
    await this.assertOwnedPath(path);
    const info = await lstat(path).catch((error: unknown) => {
      if (missing(error)) return null;
      throw error;
    });
    if (!info) return null;
    if (!info.isFile())
      throw new ArchiveRecoveryRefusedError(
        'Aliased archive recovery receipt.',
      );
    if (info.nlink !== 1) {
      let temporaryLinks = 0;
      for (const name of await readdir(dirname(path))) {
        if (!receiptTemporaryName.test(name)) continue;
        const sibling = await lstat(join(dirname(path), name));
        if (
          sibling.isFile() &&
          sibling.dev === info.dev &&
          sibling.ino === info.ino
        )
          temporaryLinks += 1;
      }
      // Exclusive atomic publication links the fully written sibling before unlinking it.
      if (info.nlink !== temporaryLinks + 1)
        throw new ArchiveRecoveryRefusedError(
          'Aliased archive recovery receipt.',
        );
    }
    const receipt = archiveRecoveryReceiptSchema.parse(
      JSON.parse(await readFile(path, 'utf8')),
    );
    if (
      receipt.workspaceId !== workspaceId ||
      receipt.operationId !== operationId
    )
      throw new ArchiveRecoveryRefusedError(
        'Replaced archive recovery receipt.',
      );
    assertRecoveryCopies(receipt);
    return receipt;
  }

  public async list(workspaceId: string): Promise<ArchiveRecoveryReceipt[]> {
    id.parse(workspaceId);
    const directory = join(
      this.dataRoot,
      'w5',
      'archive-recovery',
      workspaceId,
    );
    const info = await lstat(directory).catch((error: unknown) => {
      if (missing(error)) return null;
      throw error;
    });
    if (!info) return [];
    await this.assertOwnedPath(directory);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new ArchiveRecoveryRefusedError('Aliased recovery store.');
    const receipts: ArchiveRecoveryReceipt[] = [];
    for (const name of (await readdir(directory)).sort()) {
      const receipt = await this.read(workspaceId, name);
      if (!receipt) {
        const operationDirectory = this.directory({
          workspaceId,
          operationId: name,
        });
        await this.assertOwnedPath(operationDirectory);
        // Before publication no effect is authorized, including after a partial sibling write.
        const unpublished = await readdir(operationDirectory, {
          withFileTypes: true,
        });
        if (
          unpublished.every(
            (entry) => entry.isFile() && receiptTemporaryName.test(entry.name),
          )
        )
          continue;
        throw new ArchiveRecoveryRefusedError(
          'Incomplete recovery receipt publication.',
        );
      }
      receipts.push(receipt);
    }
    return receipts;
  }

  public async prepare(
    input: ArchiveRecoveryPreparation,
  ): Promise<ArchiveRecoveryReceipt> {
    await this.normalize(input.workspaceId, input.operationId);
    const preparation = preparationSchema.parse(input);
    assertRecoveryCopies(preparation);
    const existing = await this.read(input.workspaceId, input.operationId);
    if (existing) {
      const saved = preparationSchema.parse(existing);
      if (existing.cancelled) {
        if (
          !isDeepStrictEqual(
            {
              ...saved,
              action: preparation.action,
              revision: preparation.revision,
            },
            preparation,
          ) ||
          !(await this.inspect(existing)).effectFree
        )
          throw new ArchiveRecoveryRefusedError(
            'Cancelled resolution evidence changed.',
          );
        // The admitted replacement retains the same protection in one durable write.
        const replacement: ArchiveRecoveryReceipt = {
          ...preparation,
          version: 1,
          stage: 'prepared',
          staging: existing.staging,
        };
        await writeFileAtomically(
          join(this.directory(existing), 'receipt.json'),
          JSON.stringify(replacement),
          { durable: true, mode: 0o600 },
        );
        return replacement;
      }
      if (!isDeepStrictEqual(saved, preparation))
        throw new ArchiveRecoveryRefusedError(
          'Conflicting archive resolution intent.',
        );
      return existing;
    }
    await this.assertOwnedPath(this.directory(preparation));
    await this.assertOwnedPath(this.stagingPath(preparation));
    const receipt: ArchiveRecoveryReceipt = {
      ...preparation,
      version: 1,
      stage: 'prepared',
      staging: await inventoryArchiveRecoveryTree(
        this.stagingPath(preparation),
      ),
    };
    await createDirectoryDurably(this.directory(receipt), {
      dataRoot: this.dataRoot,
    });
    await writeFileAtomically(
      join(this.directory(receipt), 'receipt.json'),
      JSON.stringify(receipt),
      { durable: true, overwrite: false, mode: 0o600 },
    );
    return receipt;
  }

  public async writeStage(
    receipt: ArchiveRecoveryReceipt,
    stage: ArchiveRecoveryReceipt['stage'],
  ): Promise<ArchiveRecoveryReceipt> {
    const current = await this.read(receipt.workspaceId, receipt.operationId);
    if (!current)
      throw new ArchiveRecoveryRefusedError('Recovery receipt disappeared.');
    if (!isDeepStrictEqual({ ...current, stage: receipt.stage }, receipt))
      throw new ArchiveRecoveryRefusedError('Recovery receipt changed.');
    const transitions: Partial<
      Record<ArchiveRecoveryReceipt['stage'], ArchiveRecoveryReceipt['stage']>
    > = {
      prepared: 'retention-intent',
      'retention-intent': 'retained',
      retained: 'reset-intent',
      'reset-intent': 'staging-reset',
      'staging-reset': 'withdrawal-intent',
      'withdrawal-intent': 'withdrawn',
      withdrawn: 'completed',
    };
    if (current.cancelled)
      throw new ArchiveRecoveryRefusedError('Resolution was cancelled.');
    if (stage === current.stage) return current;
    if (transitions[current.stage] !== stage)
      throw new ArchiveRecoveryRefusedError(
        'Recovery effect intent was not recorded.',
      );
    if (stage === 'staging-reset' || stage === 'withdrawn') {
      const evidence = await this.inspect(current);
      if (
        (receipt.staging !== null && evidence.reset !== 'performed') ||
        evidence.reset === 'conflict' ||
        (stage === 'withdrawn' &&
          evidence.copies.some((copy) => copy !== 'retired'))
      )
        throw new ArchiveRecoveryRefusedError(
          'Recovery effect acknowledgement lacks exact evidence.',
        );
    }
    const updated = { ...current, stage };
    await writeFileAtomically(
      join(this.directory(receipt), 'receipt.json'),
      JSON.stringify(updated),
      { durable: true, mode: 0o600 },
    );
    return updated;
  }

  public async publishRetention(
    receipt: ArchiveRecoveryReceipt,
  ): Promise<ArchiveRecoveryReceipt> {
    const published = await this.read(receipt.workspaceId, receipt.operationId);
    if (
      !published ||
      !isDeepStrictEqual({ ...published, stage: receipt.stage }, receipt)
    )
      throw new ArchiveRecoveryRefusedError('Recovery receipt changed.');
    receipt = published;
    if (!['prepared', 'retention-intent'].includes(receipt.stage))
      return receipt;
    const intent =
      receipt.stage === 'prepared'
        ? await this.writeStage(receipt, 'retention-intent')
        : receipt;
    if (intent.stage !== 'retention-intent') return intent;
    if (
      !isDeepStrictEqual(
        await inventoryArchiveRecoveryTree(this.stagingPath(intent)),
        intent.staging,
      )
    )
      throw new ArchiveRecoveryRefusedError(
        'Recovery staging changed before retention.',
      );
    if (intent.staging) await syncTreeDurably(this.stagingPath(intent));
    return this.writeStage(intent, 'retained');
  }

  public async resetStaging(
    receipt: ArchiveRecoveryReceipt,
  ): Promise<ArchiveRecoveryReceipt> {
    const published = await this.read(receipt.workspaceId, receipt.operationId);
    if (
      !published ||
      !isDeepStrictEqual({ ...published, stage: receipt.stage }, receipt)
    )
      throw new ArchiveRecoveryRefusedError('Recovery receipt changed.');
    receipt = published;
    if (!['retained', 'reset-intent'].includes(receipt.stage)) return receipt;
    const intent =
      receipt.stage === 'retained'
        ? await this.writeStage(receipt, 'reset-intent')
        : receipt;
    await this.assertOwnedPath(this.stagingPath(intent));
    await this.assertOwnedPath(this.payloadPath(intent));
    const source = this.stagingPath(intent);
    await this.assertOwnedPath(source);
    await this.assertOwnedPath(this.payloadPath(intent));
    const target = this.payloadPath(intent);
    const original = await inventoryArchiveRecoveryTree(source);
    const retained = await inventoryArchiveRecoveryTree(target);
    if (original !== null && retained !== null)
      throw new ArchiveRecoveryRefusedError(
        'Both recovery staging and hold are occupied.',
      );
    if (intent.staging === null) {
      if (original !== null || retained !== null)
        throw new ArchiveRecoveryRefusedError(
          'Unexpected recovery staging occupant.',
        );
    } else if (original !== null) {
      if (!isDeepStrictEqual(original, intent.staging))
        throw new ArchiveRecoveryRefusedError('Replaced recovery staging.');
      await syncTreeDurably(source);
      await renameWithRetry(source, target);
    } else if (!isDeepStrictEqual(retained, intent.staging))
      throw new ArchiveRecoveryRefusedError(
        'Missing or replaced retained recovery payload.',
      );
    // Re-flush both parents even on replay after an unacknowledged rename.
    if (intent.staging !== null) {
      await syncDirectory(dirname(source));
      await syncDirectory(dirname(target));
      if (
        !isDeepStrictEqual(
          await inventoryArchiveRecoveryTree(target),
          intent.staging,
        )
      )
        throw new ArchiveRecoveryRefusedError(
          'Retained recovery payload changed.',
        );
    }
    return this.writeStage(intent, 'staging-reset');
  }

  /** Called under exclusive lifecycle-journal access; never writes the current slot. */
  public async withdrawJournals(
    receipt: ArchiveRecoveryReceipt,
  ): Promise<ArchiveRecoveryReceipt> {
    const published = await this.read(receipt.workspaceId, receipt.operationId);
    if (
      !published ||
      !isDeepStrictEqual({ ...published, stage: receipt.stage }, receipt)
    )
      throw new ArchiveRecoveryRefusedError('Recovery receipt changed.');
    receipt = published;
    if (!['staging-reset', 'withdrawal-intent'].includes(receipt.stage))
      return receipt;
    const intent =
      receipt.stage === 'staging-reset'
        ? await this.writeStage(receipt, 'withdrawal-intent')
        : receipt;
    if (intent.stage === 'completed' || intent.stage === 'withdrawn')
      return intent;
    if (intent.copies.length === 0)
      throw new ArchiveRecoveryRefusedError(
        'No source journal copies were bound.',
      );
    const inspection = await inspectDestructiveJournals(this.dataRoot);
    if (
      inspection.issues.some(
        (issue) =>
          issue.path === 'w5/destructive-lifecycles' ||
          /\.json$/.test(issue.path),
      )
    )
      throw new ArchiveRecoveryRefusedError(
        'Unreadable source journal evidence.',
      );
    const expected = new Set(intent.copies.map((copy) => copy.name));
    if (
      inspection.records.some(
        (entry) =>
          entry.record.operationId === intent.operationId &&
          !expected.has(entry.name),
      )
    )
      throw new ArchiveRecoveryRefusedError(
        'New copy of the source operation.',
      );
    const targetDirectory = join(this.directory(intent), 'journals');
    await this.assertOwnedPath(targetDirectory);
    await createDirectoryDurably(targetDirectory, { dataRoot: this.dataRoot });
    // Verify every preimage before the first move. On replay, the exact retained copy proves a previous move.
    for (const copy of intent.copies) {
      if (archiveRecoveryDigest(copy.contents) !== copy.digest)
        throw new ArchiveRecoveryRefusedError(
          'Source journal digest mismatch.',
        );
      const source = join(
        this.dataRoot,
        'w5',
        'destructive-lifecycles',
        copy.name,
      );
      const target = join(targetDirectory, copy.name);
      const original = await this.journalContents(source);
      const retained = await this.journalContents(target);
      if (
        !(
          (original === copy.contents && retained === null) ||
          (isReusedSourceSlot(original, intent.operationId) &&
            retained === copy.contents)
        )
      )
        throw new ArchiveRecoveryRefusedError(
          'Missing, replaced or duplicated source journal.',
        );
    }
    for (const copy of intent.copies) {
      const source = join(
        this.dataRoot,
        'w5',
        'destructive-lifecycles',
        copy.name,
      );
      const target = join(targetDirectory, copy.name);
      const contents = await this.journalContents(source);
      if ((await this.journalContents(target)) !== copy.contents) {
        if (
          contents !== copy.contents ||
          (await this.journalContents(target)) !== null
        )
          throw new ArchiveRecoveryRefusedError(
            'Source journal changed before withdrawal.',
          );
        await renameWithRetry(source, target);
      }
      await syncDirectory(dirname(source));
      await syncDirectory(targetDirectory);
      if ((await this.journalContents(target)) !== copy.contents)
        throw new ArchiveRecoveryRefusedError(
          'Retired journal verification failed.',
        );
    }
    return this.writeStage(intent, 'withdrawn');
  }

  public async beginDeletion(
    receipt: ArchiveRecoveryReceipt,
  ): Promise<ArchiveRecoveryReceipt> {
    const current = await this.read(receipt.workspaceId, receipt.operationId);
    if (
      !current ||
      !isDeepStrictEqual(current, receipt) ||
      current.stage !== 'completed'
    )
      throw new ArchiveRecoveryRefusedError(
        'Only a completed exact hold can be deleted.',
      );
    if (current.retention) return current;
    await this.assertOwnedPath(this.payloadPath(current));
    if (
      !isDeepStrictEqual(
        await inventoryArchiveRecoveryTree(this.payloadPath(current)),
        current.staging,
      )
    )
      throw new ArchiveRecoveryRefusedError('Retained payload changed.');
    const updated = { ...current, retention: 'deleting' as const };
    await writeFileAtomically(
      join(this.directory(current), 'receipt.json'),
      JSON.stringify(updated),
      { durable: true, mode: 0o600 },
    );
    return updated;
  }

  /** Called only after all retained ref deletions have settled. The receipt remains a tombstone. */
  public async deletePayload(
    receipt: ArchiveRecoveryReceipt,
  ): Promise<ArchiveRecoveryReceipt> {
    const current = await this.read(receipt.workspaceId, receipt.operationId);
    if (
      !current ||
      !isDeepStrictEqual(current, receipt) ||
      current.stage !== 'completed' ||
      !current.retention
    )
      throw new ArchiveRecoveryRefusedError(
        'Retained deletion intent is missing.',
      );
    if (current.retention === 'deleted') return current;
    const path = this.payloadPath(current);
    await this.assertOwnedPath(path);
    const payload = await inventoryArchiveRecoveryTree(path);
    if (
      payload &&
      (payload.identity !== current.staging?.identity ||
        payload.entries.some(
          (entry) =>
            !current.staging?.entries.some((original) =>
              isDeepStrictEqual(entry, original),
            ),
        ))
    )
      throw new ArchiveRecoveryRefusedError(
        'Retained payload was replaced during deletion.',
      );
    await rm(path, { recursive: true, force: true });
    await syncDirectory(this.directory(current));
    const updated = { ...current, retention: 'deleted' as const };
    await writeFileAtomically(
      join(this.directory(current), 'receipt.json'),
      JSON.stringify(updated),
      { durable: true, mode: 0o600 },
    );
    return updated;
  }

  private async journalContents(path: string): Promise<string | null> {
    await this.assertOwnedPath(path);
    const info = await lstat(path).catch((error: unknown) => {
      if (missing(error)) return null;
      throw error;
    });
    if (!info) return null;
    if (!info.isFile() || info.nlink !== 1)
      throw new ArchiveRecoveryRefusedError('Aliased source journal.');
    return readFile(path, 'utf8');
  }
}

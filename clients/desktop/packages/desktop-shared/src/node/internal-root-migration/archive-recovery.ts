import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { InternalRootMigrationRefused } from '@canopy/core-runtime/node/internal-root-migration';
import {
  movedOwnedPath,
  type RelocationTransition,
} from '@canopy/core-runtime/node/relocation';
import {
  ArchiveRecoveryStore,
  classifyArchiveRecovery,
  archiveRecoveryDigest,
  archiveRecoveryInventorySchema,
  archiveRecoveryReceiptSchema,
  inventoryArchiveRecoveryTree,
  type ArchiveRecoveryReceipt,
} from '../archive-recovery-store';
import type { InternalRootLifecycleJournalEvidence } from '@canopy/core-runtime/node/internal-root-repairs';
import { projectInternalRootJournal } from './lifecycle-journals';
import { durableJson, statIfPresent } from './filesystem';
import type { InternalRootFilesystemHost } from './filesystem-host';

const evidenceSchema = z
  .object({
    inventory: archiveRecoveryInventorySchema.nullable(),
    receipts: z.array(z.object({ raw: z.string() }).strict()),
  })
  .strict();

function refuse(detail: string): never {
  throw new InternalRootMigrationRefused(
    'repair-refused',
    `Archive recovery relocation refused: ${detail}. Preserve both roots and the receipts.`,
  );
}

async function canonicalDirectory(path: string): Promise<string> {
  const stat = await lstat(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (await realpath(path)) !== path
  )
    refuse(`aliased directory ${JSON.stringify(path)}`);
  return `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
}

async function inventory(
  root: string,
): ReturnType<typeof inventoryArchiveRecoveryTree> {
  for (const path of [
    root,
    join(root, 'w5'),
    join(root, 'w5/archive-recovery'),
  ]) {
    if (!(await statIfPresent(path))) return null;
    await canonicalDirectory(path);
  }
  return inventoryArchiveRecoveryTree(join(root, 'w5/archive-recovery'));
}

function parseReceipt(raw: string): ArchiveRecoveryReceipt {
  const value: unknown = JSON.parse(raw);
  const receipt = archiveRecoveryReceiptSchema.parse(value);
  if (!isDeepStrictEqual(value, receipt)) refuse('unsupported receipt fields');
  if (classifyArchiveRecovery(receipt).projectFence)
    refuse(
      `unfinished receipt ${receipt.operationId} at ${receipt.stage}; resume resolution before relocation`,
    );
  return receipt;
}

async function checkPayload(
  root: string,
  receipt: ArchiveRecoveryReceipt,
): Promise<void> {
  const classification = classifyArchiveRecovery(receipt);
  if (classification.payloadRule === 'source') {
    if (!(await new ArchiveRecoveryStore(root).inspect(receipt)).effectFree)
      refuse(`cancelled receipt ${receipt.operationId} is not effect-free`);
    return;
  }
  const store = new ArchiveRecoveryStore(root);
  const payload = await inventoryArchiveRecoveryTree(
    store.payloadPath(receipt),
  );
  if (classification.payloadRule === 'absent') {
    if (payload !== null)
      refuse(`deleted hold ${receipt.operationId} still has a payload`);
  } else if (classification.payloadRule === 'subset') {
    if (
      payload &&
      (payload.identity !== receipt.staging?.identity ||
        payload.entries.some(
          (entry) =>
            !receipt.staging?.entries.some((original) =>
              isDeepStrictEqual(original, entry),
            ),
        ))
    )
      refuse(`changed partially deleted payload ${receipt.operationId}`);
  } else if (!isDeepStrictEqual(payload, receipt.staging))
    refuse(`missing or replaced retained payload ${receipt.operationId}`);
}

/** Called only by the relocation worker after acquiring cold-exclusive root ownership. */
export async function normalizeInternalRootArchiveRecovery(
  root: string,
): Promise<void> {
  const path = join(root, 'w5/archive-recovery');
  if (!(await statIfPresent(path))) return;
  for (const parent of [root, join(root, 'w5'), path])
    await canonicalDirectory(parent);
  const store = new ArchiveRecoveryStore(root);
  for (const workspaceId of await readdir(path))
    await store.normalizeWorkspace(workspaceId);
}

/** Freeze retained payloads and effect-free cancelled intents under cold-exclusive ownership. */
export async function freezeInternalRootArchiveRecovery(
  root: string,
): Promise<string | undefined> {
  try {
    const before = await inventory(root);
    const receipts: { raw: string }[] = [];
    const store = new ArchiveRecoveryStore(root);
    if (before) {
      for (const workspaceId of (
        await readdir(join(root, 'w5/archive-recovery'))
      ).sort()) {
        await canonicalDirectory(
          join(root, 'w5/archive-recovery', workspaceId),
        );
        for (const operationId of (
          await readdir(join(root, 'w5/archive-recovery', workspaceId))
        ).sort()) {
          const receipt = await store.read(workspaceId, operationId);
          if (!receipt)
            refuse(`unpublished receipt ${workspaceId}/${operationId}`);
          const raw = await readFile(
            join(store.directory(receipt), 'receipt.json'),
            'utf8',
          );
          const parsed = parseReceipt(raw);
          if (!isDeepStrictEqual(receipt, parsed))
            refuse('receipt changed during qualification');
          await checkPayload(root, receipt);
          // Tombstones are historical evidence and confer no repository deletion rights.
          if (receipt.retention !== 'deleted')
            for (const repo of receipt.repositories.filter(
              (repo) => receipt.cancelled || repo.refs.length > 0,
            ))
              if (
                `${repo.commonDir}:${await canonicalDirectory(repo.commonDir)}` !==
                repo.identity
              )
                refuse(
                  `repository identity changed for ${receipt.operationId}/${repo.repoId}`,
                );
          const journals = join(store.directory(receipt), 'journals');
          if (await statIfPresent(journals)) await canonicalDirectory(journals);
          const names = (await statIfPresent(journals))
            ? [...(await readdir(journals))].sort()
            : [];
          if (
            !isDeepStrictEqual(
              names,
              receipt.cancelled
                ? []
                : receipt.copies.map((copy) => copy.name).sort(),
            )
          )
            refuse(
              `withdrawn journal membership changed for ${receipt.operationId}`,
            );
          for (const copy of receipt.cancelled ? [] : receipt.copies) {
            const path = join(journals, copy.name);
            const info = await lstat(path);
            if (
              !info.isFile() ||
              info.nlink !== 1 ||
              (await realpath(path)) !== path
            )
              refuse(
                `aliased retired journal ${receipt.operationId}/${copy.name}`,
              );
            if ((await readFile(path, 'utf8')) !== copy.contents)
              refuse(`withdrawn journal changed for ${receipt.operationId}`);
          }
          const children = (await readdir(store.directory(receipt))).sort();
          if (
            children.some(
              (name) => !['receipt.json', 'journals', 'payload'].includes(name),
            )
          )
            refuse(`unsettled receipt publication for ${receipt.operationId}`);
          receipts.push({ raw });
        }
      }
    }
    if (!isDeepStrictEqual(before, await inventory(root)))
      refuse('storage changed during qualification');
    return before === null
      ? undefined
      : JSON.stringify({ inventory: before, receipts });
  } catch (error) {
    if (error instanceof InternalRootMigrationRefused) throw error;
    refuse(
      `unreadable or conflicting evidence (${error instanceof Error ? error.message : String(error)})`,
    );
  }
}

export function internalRootArchiveRecoveryRepositories(
  frozen: string | undefined,
): ArchiveRecoveryReceipt['repositories'] {
  if (frozen === undefined) return [];
  return evidenceSchema
    .parse(JSON.parse(frozen))
    .receipts.flatMap(({ raw }) => {
      const receipt = parseReceipt(raw);
      return receipt.retention === 'deleted'
        ? []
        : receipt.repositories.filter((repo) => repo.refs.length > 0);
    });
}

/** Historical holds stay exact; cancelled intents follow the projected live source journals. */
export async function relocateInternalRootArchiveRecovery(
  transition: RelocationTransition,
  workingRoot: string,
  host: InternalRootFilesystemHost,
  frozen: string | undefined,
  verify = false,
  lifecycleJournals: readonly InternalRootLifecycleJournalEvidence[] = [],
): Promise<void> {
  try {
    const source = transition.from.canonicalDataRoot;
    if (source === workingRoot) refuse('cannot project the source root');
    if (frozen === undefined && (await inventory(source)) !== null)
      refuse('source recovery storage has no frozen evidence');
    const evidence =
      frozen === undefined
        ? { inventory: null, receipts: [] }
        : evidenceSchema.parse(JSON.parse(frozen));
    if (
      frozen !== undefined &&
      (await freezeInternalRootArchiveRecovery(source)) !== frozen
    )
      refuse('source storage differs from frozen evidence');
    const current = await inventory(workingRoot);
    const expected =
      evidence.inventory?.entries.map((entry) => ({ ...entry })) ?? null;
    const writes: { path: string; receipt: ArchiveRecoveryReceipt }[] = [];
    const copiedStore = new ArchiveRecoveryStore(workingRoot);
    const sourceStore = new ArchiveRecoveryStore(source);
    for (const { raw } of evidence.receipts) {
      const original = parseReceipt(raw);
      // Source remains the immutable restore image, including retired journal preimages.
      if (
        (await readFile(
          join(sourceStore.directory(original), 'receipt.json'),
          'utf8',
        )) !== raw
      )
        refuse('source receipt differs from frozen evidence');
      const payload = await inventoryArchiveRecoveryTree(
        copiedStore.payloadPath(original),
      );
      const live = original.cancelled
        ? await inventoryArchiveRecoveryTree(copiedStore.stagingPath(original))
        : payload;
      if (
        original.cancelled &&
        !isDeepStrictEqual(
          live?.entries ?? null,
          original.staging?.entries ?? null,
        )
      )
        refuse(`changed cancelled staging ${original.operationId}`);
      if (original.cancelled && live)
        await canonicalDirectory(copiedStore.stagingPath(original));
      const staging =
        original.staging && original.retention !== 'deleted' && live
          ? { ...original.staging, identity: live.identity }
          : original.staging;
      const copies: ArchiveRecoveryReceipt['copies'] = [];
      let sourceRecord = original.sourceRecord;
      const revision = createHash('sha256');
      for (const copy of original.cancelled ? original.copies : []) {
        const evidence = lifecycleJournals.find(
          (entry) => entry.name === copy.name,
        );
        if (
          !evidence ||
          evidence.abandoned ||
          !isDeepStrictEqual(JSON.parse(evidence.raw), original.sourceRecord)
        )
          refuse(
            `cancelled source lacks frozen lifecycle evidence ${original.operationId}`,
          );
        const record = await projectInternalRootJournal(
          transition,
          workingRoot,
          evidence,
        );
        const contents = `${JSON.stringify(record)}\n`;
        if (
          (await readFile(
            join(workingRoot, 'w5/destructive-lifecycles', copy.name),
            'utf8',
          )) !== contents
        )
          refuse(`changed copied cancelled journal ${original.operationId}`);
        copies.push({
          ...copy,
          contents,
          digest: archiveRecoveryDigest(contents),
        });
        sourceRecord = record;
        revision.update(copy.name).update('\0').update(contents).update('\0');
      }
      const projected: ArchiveRecoveryReceipt = {
        ...original,
        staging,
        ...(original.cancelled
          ? { copies, sourceRecord, revision: revision.digest('hex') }
          : {}),
        repositories: await Promise.all(
          original.repositories.map(async (repo) => {
            if (
              original.retention === 'deleted' ||
              (!original.cancelled && repo.refs.length === 0)
            )
              return repo;
            const path = movedOwnedPath(transition, repo.commonDir);
            const physical =
              path === repo.commonDir
                ? path
                : join(
                    workingRoot,
                    relative(transition.to.canonicalDataRoot, path),
                  );
            const identity = `${path}:${await canonicalDirectory(physical)}`;
            if (path === repo.commonDir && identity !== repo.identity)
              refuse(
                `external repository identity changed for ${original.operationId}`,
              );
            return {
              ...repo,
              commonDir: path,
              referenceRepoPath: movedOwnedPath(
                transition,
                repo.referenceRepoPath,
              ),
              identity,
            };
          }),
        ),
      };
      if (original.cancelled) {
        if (payload !== null)
          refuse(`cancelled receipt ${original.operationId} has a payload`);
      } else await checkPayload(workingRoot, projected);
      const path = join(copiedStore.directory(projected), 'receipt.json');
      const contents = await readFile(path, 'utf8');
      const postimage = `${JSON.stringify(projected)}\n`;
      if (contents !== postimage && (verify || contents !== raw))
        refuse('copied receipt differs from frozen projection');
      const entry = expected?.find(
        (entry) =>
          entry.path ===
          `${original.workspaceId}/${original.operationId}/receipt.json`,
      );
      if (!entry || entry.digest !== archiveRecoveryDigest(raw))
        refuse('receipt missing from frozen inventory');
      if (verify || contents === postimage) {
        entry.digest = archiveRecoveryDigest(postimage);
        entry.size = Buffer.byteLength(postimage);
      }
      writes.push({ path, receipt: projected });
    }
    if (!isDeepStrictEqual(current?.entries ?? null, expected))
      refuse('copied storage membership or contents changed');
    if (!verify)
      for (const { path, receipt } of writes)
        await durableJson(path, receipt, host);
  } catch (error) {
    if (error instanceof InternalRootMigrationRefused) throw error;
    refuse(
      `unreadable or conflicting evidence (${error instanceof Error ? error.message : String(error)})`,
    );
  }
}

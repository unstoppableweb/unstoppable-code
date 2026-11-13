import { lstat, open, readdir, link, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hostOperatingSystem } from '@canopy/core-platform/host-platform';
import {
  InternalRootMigrationRefused,
  type InternalRootIdentity,
  type InternalRootMigrationWorker,
} from '@canopy/core-runtime/node/internal-root-migration';
import {
  createPrivateMigrationDirectory,
  internalRootFilesystemHost,
} from './filesystem-host';
import { flush, privateDirectory, statIfPresent } from './filesystem';

/** A separate startup choice, never a migration journal or a source inventory. */
export async function createFreshInternalRoot(options: {
  readonly identity: InternalRootIdentity;
  readonly worker: InternalRootMigrationWorker;
  readonly ownedChildPath?: string;
  readonly windowsPrincipal?: () => Promise<string>;
}): Promise<void> {
  const { identity, worker } = options;
  const host = internalRootFilesystemHost(options.ownedChildPath);
  const path = join(
    dirname(identity.destination),
    `.${identity.brandId}-internal-startup.json`,
  );
  const refuse = (
    reason: 'destination-exists' | 'recovery-required',
    message: string,
  ): never => {
    throw new InternalRootMigrationRefused(reason, message);
  };
  // The predecessor may be unrelated: even cold-proof membership reads use only
  // the destination. Whole-user product/process inspection is still required.
  const freshIdentity = { ...identity, source: identity.destination };
  await worker.proveCold(freshIdentity);
  const release = await worker.coordinate(identity);
  try {
    if (await statIfPresent(join(identity.coordination, 'journal.json')))
      refuse(
        'recovery-required',
        'A migration journal exists. Resume or recover it; --skip-migration cannot supersede it.',
      );
    await worker.readJournal(identity);
    if (
      (await readdir(identity.coordination)).some(
        (name) =>
          name.startsWith('restarted-') ||
          name.startsWith('abandoned-w5-commits-'),
      )
    )
      refuse(
        'recovery-required',
        `A retained migration exists under ${JSON.stringify(identity.coordination)}. Resume with --apply or obtain recovery; --skip-migration cannot supersede it.`,
      );
    await worker.validateStaging(identity, null);
    if (await statIfPresent(path))
      refuse(
        'recovery-required',
        'A startup choice already exists. Preserve it and the internal folder.',
      );
    const previous = await statIfPresent(identity.destination);
    if (previous) {
      await privateDirectory(identity.destination, host);
      if ((await readdir(identity.destination)).length)
        refuse(
          'destination-exists',
          'The internal folder is not empty; nothing was copied or replaced.',
        );
    }
    await worker.proveCold(freshIdentity);
    if (!previous)
      await createPrivateMigrationDirectory(identity.destination, host);
    await privateDirectory(identity.destination, host);
    const current = await statIfPresent(identity.destination);
    if (
      previous &&
      (!current || current.dev !== previous.dev || current.ino !== previous.ino)
    )
      refuse(
        'recovery-required',
        'The internal folder was replaced; preserve it for recovery.',
      );
    const root = await lstat(identity.destination, { bigint: true });
    if ((await readdir(identity.destination)).length)
      refuse(
        'destination-exists',
        'The internal folder changed; retain it for recovery.',
      );
    const principal =
      hostOperatingSystem() === 'win32'
        ? await options.windowsPrincipal?.()
        : process.getuid?.()?.toString();
    if (!principal)
      refuse('recovery-required', 'The native owner could not be observed.');
    const record = {
      version: 1,
      choice: 'empty-internal',
      brandId: identity.brandId,
      destination: identity.destination,
      principal,
      publicationIdentity: `${root.dev}:${root.ino}`,
    };
    const temp = join(
      identity.destination,
      `.startup-choice-${randomUUID()}.tmp`,
    );
    const file = await open(temp, 'wx', 0o600);
    try {
      await file.writeFile(`${JSON.stringify(record)}\n`);
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      if (host.windows) {
        // The temporary file inherits the private destination DACL, not HOME.
        host.windows.inspect(temp);
      }
      const after = await lstat(identity.destination, { bigint: true });
      if (
        after.dev !== root.dev ||
        after.ino !== root.ino ||
        (await readdir(identity.destination)).some(
          (name) => join(identity.destination, name) !== temp,
        )
      )
        refuse(
          'recovery-required',
          'The internal folder changed before the startup choice was recorded.',
        );
      await flush(identity.destination);
      // Atomic no-replace publication; a crash leaves at most an untrusted temp.
      await link(temp, path);
    } finally {
      await unlink(temp);
    }
    await flush(dirname(path));
  } finally {
    await release();
  }
}

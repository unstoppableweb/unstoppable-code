export type { BrandBuildIdentity } from '@canopy/protocol/brand';
import type { ProductBuild } from '@canopy/protocol/brand';

/** Facts supplied by B's validated journal reader, never inferred from a folder name. */
export type InternalRootStartupState =
  | 'fresh'
  | 'required'
  | 'stable-owned'
  | 'incomplete'
  | 'complete'
  | 'unsupported';

export type BuildStorageRefusalReason =
  | 'internal-migration-required'
  | 'internal-migration-stable-owned'
  | 'internal-migration-incomplete'
  | 'internal-migration-unsupported'
  | 'secure-relocation-required'
  | 'secure-relocation-conflict'
  | 'secure-relocation-unsafe';

export class BuildStorageStartupRefused extends Error {
  override readonly name = 'BuildStorageStartupRefused';
  constructor(
    readonly reason: BuildStorageRefusalReason,
    recovery: string,
  ) {
    super(recovery);
  }
}

/** Must run before creation, recovery, cohort registration or writer admission. */
export function assertBuildStorageStartup(options: {
  readonly build: ProductBuild;
  readonly internalState: InternalRootStartupState;
  readonly migrationCommand?: string;
}): void {
  if (options.build !== 'internal') return;
  const state = options.internalState;
  if (state === 'fresh' || state === 'complete') return;
  // Installed builds do not ship a source checkout or its migration script.
  if (!options.migrationCommand) {
    throw new BuildStorageStartupRefused(
      `internal-migration-${state}`,
      state === 'stable-owned'
        ? "Couldn't start the internal build because secure storage belongs to the stable build. Keep both installations unchanged and contact support with this message."
        : state === 'required'
          ? 'This install needs an internal data migration; contact support with this message.'
          : `This install has ${state} internal migration data; contact support with this message.`,
    );
  }
  const freshStartCommand = `${options.migrationCommand.replace(/ --apply(?: --declare-internal)?$/, '')} --skip-migration`;
  // Whole-tree migration cannot transfer stable's nested secure storage.
  if (state === 'stable-owned')
    throw new BuildStorageStartupRefused(
      'internal-migration-stable-owned',
      `Couldn't start the internal build because secure storage belongs to the stable build. Keep both installations unchanged and ask a teammate for assisted recovery, or run ${freshStartCommand} to start with an empty internal folder. See docs/internal-root-migration.md.`,
    );
  const reason =
    state === 'required'
      ? 'required'
      : state === 'incomplete'
        ? 'incomplete'
        : 'unsupported';
  throw new BuildStorageStartupRefused(
    `internal-migration-${reason}`,
    `Internal data migration is ${reason}. Quit all app, CLI and daemon processes, then run ${options.migrationCommand}. To start with an empty internal folder instead, run ${freshStartCommand} (only before a migration starts). See docs/internal-root-migration.md.`,
  );
}

export function assertDaemonSecureStorageReady(options: {
  readonly historicalPresent: boolean;
  readonly nestedPresent: boolean;
}): void {
  if (!options.historicalPresent) return;
  throw new BuildStorageStartupRefused(
    options.nestedPresent
      ? 'secure-relocation-conflict'
      : 'secure-relocation-required',
    options.nestedPresent
      ? 'Both secure folders exist. Quit all app, CLI and daemon processes and resolve the conflict explicitly; neither folder was changed.'
      : 'Secure storage must move before the daemon can start. Quit all app, CLI and daemon processes, then start the app or CLI first.',
  );
}

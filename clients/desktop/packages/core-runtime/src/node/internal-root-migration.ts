import type { InternalRootRepairPlan } from './internal-root-repairs';
import type { PlatformOperatingSystem } from '../platform/platform-services';
/** Compare persisted migration evidence; callers still verify path and ownership. */
export function matchesInternalRootNodeIdentity(
  current: string | null,
  recorded: unknown,
  os: string | null,
): boolean {
  if (current === null || typeof recorded !== 'string') return false;
  const actual = /^\d+:([1-9]\d*)$/.exec(current);
  const prior = /^\d+:([1-9]\d*)$/.exec(recorded);
  if (!actual || !prior || actual[0] !== current || prior[0] !== recorded)
    return false;
  // macOS device numbers can change after reboot; the inode stays stable.
  return current === recorded || (os === 'darwin' && actual[1] === prior[1]);
}

/** Offline core policy. Trusted workers supply paths and filesystem/process effects. */
export interface InternalRootIdentity {
  readonly brandId: 'canopy' | 'unstoppable-code';
  readonly brandDisplayName: string;
  readonly build: 'internal';
  readonly source: string;
  readonly destination: string;
  readonly historicalSecure: string;
  readonly coordination: string;
}
export interface InternalRootInventory {
  readonly sourceIdentity: string | null;
  readonly destinationIdentity: string | null;
  readonly fingerprint: string;
  readonly files: number;
  readonly bytes: number;
  readonly historicalSecure: boolean;
  readonly nestedSecure: boolean;
  readonly stableOwned: boolean;
}
export interface InternalRootSpace {
  readonly requiredBytes: number;
  readonly availableBytes: number;
}
export type InternalRootPhase =
  | 'prepared'
  | 'source-settled'
  | 'building'
  | 'publishing'
  | 'complete'
  | 'restoring-external'
  | 'rebuilding';
export interface InternalRootExternalSnapshot {
  readonly path: string;
  readonly preimage: string;
  readonly mode: number;
  readonly postimage?: string;
}
export interface InternalRootJournal {
  readonly version: 6 | 7;
  readonly transactionId: string;
  readonly identity: InternalRootIdentity;
  readonly internalDeclaration: boolean;
  readonly phase: InternalRootPhase;
  readonly inventory: InternalRootInventory;
  readonly externalFiles: readonly string[];
  readonly externalSnapshots?: readonly InternalRootExternalSnapshot[];
  readonly stagingRoot: string;
  readonly stagingIdentity?: string;
  readonly settledFingerprint?: string;
  readonly publicationIdentity?: string;
  readonly publicationFingerprint?: string;
  /** Secure relocation is CAN-5786, never implied by root completion. */
  readonly secureRelocation: 'pending' | 'complete';
  readonly repairPlan?: InternalRootRepairPlan;
}
/** Lifetime-bound qualification issued only while migration coordination is held. */
export interface InternalRootColdRecovery {
  readonly identity: InternalRootIdentity;
  readonly transactionId: string;
  readonly assertHeld: () => Promise<void>;
  /** Native process/open-file snapshot; W5 checks its own claim/cohort separately. */
  readonly assertCold?: () => Promise<void>;
}
export type InternalRootRefusal =
  | 'ownership-required'
  | 'stable-owned'
  | 'source-missing'
  | 'destination-exists'
  | 'journal-unsupported'
  | 'coordination-held'
  | 'cold-proof-unavailable'
  | 'writer-active'
  | 'recovery-required'
  | 'repair-unavailable'
  | 'unsupported-layout'
  | 'source-changed'
  | 'already-complete'
  | 'clone-unavailable'
  | 'insufficient-space'
  | 'repair-refused';
export class InternalRootMigrationRefused extends Error {
  constructor(
    readonly reason: InternalRootRefusal,
    readonly recovery: string,
  ) {
    super(`Internal root migration refused (${reason}): ${recovery}`);
    this.name = 'InternalRootMigrationRefused';
  }
}

export function internalRootDestinationExistsRecovery(
  destination: string,
): string {
  return `An independent destination already exists at ${JSON.stringify(destination)}. It may contain data created after an internal-478 launch. Check its contents, then manually move or rename it to an unused location; never delete it. Re-run --apply only when the destination is absent. See docs/internal-root-migration.md#unstoppable-code-history-stored-in-canopy for the manual step. No automatic merge or overwrite is supported.`;
}
export interface InternalRootRepairContext {
  readonly identity: InternalRootIdentity;
  readonly transactionId: string;
  readonly inventory: InternalRootInventory;
  /** Physical sibling staging tree, or the final root for qualifyPublished only. */
  readonly workingRoot: string;
  /** Exact journaled external write membership; preimages are saved before repair. */
  readonly externalFiles: readonly string[];
  readonly repairPlan?: InternalRootRepairPlan;
}
export type InternalRootRepairResult =
  | { readonly kind: 'ok' }
  | { readonly kind: 'refused'; readonly recovery: string };
/**
 * CAN-5785 seam, composed/published by CAN-5786. prepare is read-only and
 * enumerates every external metadata file.
 * prepare runs for fresh/source-settled construction, not partial repair or
 * publication resume. repair/verify/qualifyPublished reopen frozen evidence by
 * transactionId; they cannot depend on prepare running in the same process.
 * Membership must remain identical after partial repairs. repair/verify operate
 * on workingRoot, but project hard absolute paths to identity.destination.
 * They must not write the source, decode credentials or rewrite historical images.
 * External writes are restricted to externalFiles, and must be restart-idempotent:
 * failed builds are discarded and rebuilt from the settled, intact source.
 * verify qualifies staging only, never the final root. After rename B rechecks
 * its inode/tree seal and external postimages, then qualifyPublished must verify
 * final authority and read-only Git common directory, HEAD, branch and complete
 * dirty/untracked status against the projected frozen plan. Git probes disable
 * optional locks/index refresh with --no-optional-locks or GIT_OPTIONAL_LOCKS=0.
 * Only this hook gets
 * workingRoot equal to identity.destination. No daemon/proxy may run in staging.
 * Qualification repeats on every published-but-incomplete resume; a refusal
 * retains publishing intent for journal/W5 recovery, never fresh preparation.
 */
export interface InternalRootRepairs {
  /** Live composition freezes owner/Git evidence only after original-root W5 recovery. */
  readonly settleSourceFirst?: boolean;
  /** Read-only inventory qualification; never persists a plan or repairs state. */
  inspect?(context: InternalRootRepairContext): Promise<readonly string[]>;
  prepare(context: InternalRootRepairContext): Promise<
    | {
        readonly kind: 'ready';
        readonly externalFiles: readonly string[];
        readonly repairPlan?: InternalRootRepairPlan;
      }
    | { readonly kind: 'refused'; readonly recovery: string }
  >;
  repair(context: InternalRootRepairContext): Promise<InternalRootRepairResult>;
  verify(context: InternalRootRepairContext): Promise<InternalRootRepairResult>;
  qualifyPublished(
    context: InternalRootRepairContext,
  ): Promise<InternalRootRepairResult>;
}
export const unavailableInternalRootRepairs: InternalRootRepairs = {
  prepare: () =>
    Promise.resolve({
      kind: 'refused',
      recovery: 'CAN-5785 repairs are not installed; neither root was changed.',
    }),
  repair: () =>
    Promise.resolve({
      kind: 'refused',
      recovery: 'CAN-5785 repairs required.',
    }),
  verify: () =>
    Promise.resolve({
      kind: 'refused',
      recovery: 'CAN-5785 verification required.',
    }),
  qualifyPublished: () =>
    Promise.resolve({
      kind: 'refused',
      recovery: 'CAN-5785 published-root qualification required.',
    }),
};
export interface InternalRootMigrationWorker {
  readonly os: PlatformOperatingSystem | null;
  diagnose?(source: string): Promise<readonly string[]>;
  space(
    identity: InternalRootIdentity,
    sourceBytes: number,
    /** Only trees this build will discard; never pass the attempt retained by restart. */
    reclaim?: InternalRootJournal,
  ): Promise<InternalRootSpace>;
  inventory(
    identity: InternalRootIdentity,
    destination?: boolean,
  ): Promise<InternalRootInventory>;
  readJournal(
    identity: InternalRootIdentity,
  ): Promise<InternalRootJournal | null>;
  coordinate(identity: InternalRootIdentity): Promise<() => Promise<void>>;
  saveJournal(journal: InternalRootJournal): Promise<void>;
  proveCold(
    identity: InternalRootIdentity,
    externalFiles?: readonly string[],
  ): Promise<void>;
  recoverW5(journal: InternalRootJournal): Promise<void>;
  stagingRoot(identity: InternalRootIdentity): string;
  validateStaging(
    identity: InternalRootIdentity,
    journal: InternalRootJournal | null,
  ): Promise<void>;
  validateExternal(
    identity: InternalRootIdentity,
    files: readonly string[],
  ): Promise<void>;
  build(journal: InternalRootJournal): Promise<string>;
  exposeStaging(journal: InternalRootJournal): Promise<void>;
  seal(
    journal: InternalRootJournal,
    publicationIdentity: string,
  ): Promise<string>;
  publicationRoot(journal: InternalRootJournal): Promise<string>;
  publish(journal: InternalRootJournal): Promise<void>;
  validateRebuild(journal: InternalRootJournal): Promise<void>;
  discardDestination(journal: InternalRootJournal): Promise<void>;
  preserveUnpublished(
    journal: InternalRootJournal,
    checkOnly?: boolean,
  ): Promise<void>;
  captureExternal(
    journal: InternalRootJournal,
  ): Promise<readonly InternalRootExternalSnapshot[]>;
  sealExternal(
    journal: InternalRootJournal,
  ): Promise<readonly InternalRootExternalSnapshot[]>;
  assertExternalPostimages(journal: InternalRootJournal): Promise<void>;
  assertExternalPreimages(journal: InternalRootJournal): Promise<void>;
  restoreExternal(journal: InternalRootJournal): Promise<void>;
  /** Called under coordination and repeated cold proof, after root publication. */
  relocateSecure(journal: InternalRootJournal): Promise<void>;
  validateSecureResume(journal: InternalRootJournal): Promise<void>;
  transactionId(): string;
}
export type InternalRootMigrationResult =
  | {
      readonly kind: 'inventory';
      readonly preflight: {
        readonly kind: 'ready' | 'refused' | 'unavailable';
        readonly blockers: readonly string[];
      };
      readonly identity: InternalRootIdentity;
      readonly inventory: InternalRootInventory;
      readonly space: InternalRootSpace;
      readonly journal: InternalRootJournal | null;
      readonly internalDeclaration: boolean;
      readonly coldProof:
        | { readonly kind: 'ready' }
        | {
            readonly kind: 'refused';
            readonly reason: InternalRootRefusal;
            readonly recovery: string;
          };
    }
  | {
      readonly kind: 'complete';
      readonly journal: InternalRootJournal;
      readonly recovery: string;
    };

export async function migrateInternalRoot(
  worker: InternalRootMigrationWorker,
  identity: InternalRootIdentity,
  options: {
    readonly apply: boolean;
    readonly declareInternal: boolean;
    readonly rebuild?: boolean;
    readonly restart?: boolean;
  },
  repairs: InternalRootRepairs = unavailableInternalRootRepairs,
): Promise<InternalRootMigrationResult> {
  function refuse(reason: InternalRootRefusal, recovery: string): never {
    throw new InternalRootMigrationRefused(reason, recovery);
  }
  const spaceRecovery = (space: InternalRootSpace): string =>
    `Insufficient space on destination volume for ${JSON.stringify(identity.destination)}: required ${space.requiredBytes} bytes, available ${space.availableBytes} bytes.${options.restart ? ' Restart retains the old staging tree on this volume; it does not free its space.' : ''} Free space outside the retained roots and retry; the old root keeps using space until you clean it up after verification.`;
  const requireSpace = (space: InternalRootSpace): void => {
    if (space.availableBytes < space.requiredBytes)
      refuse('insufficient-space', spaceRecovery(space));
  };
  const canRestart = (journal: InternalRootJournal): boolean =>
    journal.phase !== 'complete' || journal.secureRelocation === 'pending';
  const restartRecovery = `Preserve ${JSON.stringify(identity.source)} and ${JSON.stringify(identity.destination)} and the journal under ${JSON.stringify(identity.coordination)} for teammate-assisted recovery. Choose which root to keep before proceeding; --restart cannot reverse secure relocation or discard a used destination.`;
  const secureConflict = (inventory: InternalRootInventory): boolean =>
    identity.brandId === 'canopy' &&
    inventory.nestedSecure &&
    inventory.historicalSecure;
  const prior = await worker.readJournal(identity);
  await worker.validateStaging(identity, prior);
  if (
    options.restart &&
    (!options.apply || options.rebuild || (prior && !canRestart(prior)))
  )
    refuse(
      'recovery-required',
      `Restart requires --apply without --rebuild and secure relocation still pending. ${restartRecovery}`,
    );
  if (
    options.apply &&
    identity.brandId === 'unstoppable-code' &&
    !options.declareInternal
  )
    refuse(
      'ownership-required',
      'Declare the selected installation internal; stable installations must stay untouched.',
    );
  if (options.apply && options.restart && prior && canRestart(prior)) {
    const inventory = await worker.inventory(identity);
    requireSpace(await worker.space(identity, inventory.bytes));
    const release = await worker.coordinate(identity);
    try {
      if (
        JSON.stringify(await worker.readJournal(identity)) !==
        JSON.stringify(prior)
      )
        refuse(
          'source-changed',
          `Another invocation changed the journal under ${JSON.stringify(identity.coordination)}; inventory again.`,
        );
      await worker.proveCold(identity, prior.externalFiles);
      await worker.validateStaging(identity, prior);
      const current = await worker.inventory(identity);
      if (
        !matchesInternalRootNodeIdentity(
          current.sourceIdentity,
          prior.inventory.sourceIdentity,
          worker.os,
        ) ||
        current.stableOwned ||
        (identity.brandId === 'unstoppable-code' && current.nestedSecure)
      )
        refuse(
          'source-changed',
          `Restart requires the original source directory. ${restartRecovery}`,
        );
      // Prove trees before rolling back any backlink, then recheck before moving.
      try {
        await worker.preserveUnpublished(prior, true);
      } catch (error) {
        if (!(error instanceof InternalRootMigrationRefused)) throw error;
        refuse(
          prior.publicationIdentity ? 'recovery-required' : error.reason,
          `${error.recovery} ${restartRecovery}`,
        );
      }
      if (prior.externalSnapshots) {
        await worker.restoreExternal(prior);
        await worker.assertExternalPreimages(prior);
      } else if (prior.phase !== 'prepared' && prior.phase !== 'source-settled')
        refuse(
          'recovery-required',
          `Missing external preimages. ${restartRecovery}`,
        );
      await worker.preserveUnpublished(prior);
    } finally {
      await release();
    }
    return migrateInternalRoot(
      worker,
      identity,
      { ...options, restart: false },
      repairs,
    );
  }
  if (options.apply && prior?.phase === 'complete' && !options.rebuild) {
    if (prior.secureRelocation === 'complete')
      refuse(
        'already-complete',
        'Migration is complete. Never adopt the retained predecessor automatically. Explicit --apply --rebuild requires cold recovery and refuses nested secure storage.',
      );
    const release = await worker.coordinate(identity);
    try {
      if (
        JSON.stringify(await worker.readJournal(identity)) !==
        JSON.stringify(prior)
      )
        refuse(
          'source-changed',
          `Another invocation changed the journal under ${JSON.stringify(identity.coordination)}; inventory again.`,
        );
      await worker.proveCold(identity, prior.externalFiles);
      await worker.validateSecureResume(prior);
      const qualified = await repairs.qualifyPublished({
        identity,
        transactionId: prior.transactionId,
        inventory: prior.inventory,
        workingRoot: identity.destination,
        externalFiles: prior.externalFiles,
        repairPlan: prior.repairPlan,
      });
      if (qualified.kind !== 'ok') refuse('repair-refused', qualified.recovery);
      await worker.relocateSecure(prior);
      const journal: InternalRootJournal = {
        ...prior,
        version: 7,
        secureRelocation: 'complete',
      };
      await worker.saveJournal(journal);
      return {
        kind: 'complete',
        journal,
        recovery:
          'Root and secure relocation are complete. The retained predecessor is never automatically adopted again.',
      };
    } finally {
      await release();
    }
  }
  const inventory = await worker.inventory(identity);
  if (!options.apply) {
    const space = await worker.space(identity, inventory.bytes);
    let coldProof: Extract<
      InternalRootMigrationResult,
      { kind: 'inventory' }
    >['coldProof'];
    try {
      await worker.proveCold(identity, prior?.externalFiles);
      coldProof = { kind: 'ready' };
    } catch (error) {
      if (!(error instanceof InternalRootMigrationRefused)) throw error;
      coldProof = {
        kind: 'refused',
        reason: error.reason,
        recovery: error.recovery,
      };
    }
    const blockers: string[] = [];
    if (space.availableBytes < space.requiredBytes)
      blockers.push(spaceRecovery(space));
    if (!inventory.sourceIdentity) blockers.push('Source root is missing');
    if (inventory.stableOwned)
      blockers.push('Source root belongs to a stable installation');
    if (secureConflict(inventory))
      blockers.push(
        'Both the non-empty source secure-storage and historical secure store exist; obtain teammate-assisted secure storage recovery before publishing.',
      );
    if (identity.brandId === 'unstoppable-code' && inventory.nestedSecure)
      blockers.push('Nested secure state cannot be transferred');
    if (identity.brandId === 'unstoppable-code' && !options.declareInternal)
      blockers.push('Apply requires --declare-internal for this brand');
    if (
      prior?.phase === 'complete' &&
      prior.secureRelocation === 'complete' &&
      !options.rebuild
    )
      blockers.push(
        'Migration is already complete; rebuilding requires --apply --rebuild',
      );
    if (!prior && inventory.destinationIdentity)
      blockers.push(
        internalRootDestinationExistsRecovery(identity.destination),
      );
    if (coldProof.kind === 'refused') blockers.push(coldProof.recovery);
    for (const check of [
      worker.diagnose
        ? worker.diagnose.bind(worker, identity.source)
        : undefined,
      repairs.inspect
        ? repairs.inspect.bind(repairs, {
            identity,
            transactionId: prior?.transactionId ?? 'read-only-inventory',
            inventory,
            workingRoot: identity.source,
            externalFiles: prior?.externalFiles ?? [],
          })
        : undefined,
    ]) {
      if (!check) continue;
      try {
        blockers.push(...(await check()));
      } catch (error) {
        blockers.push(
          error instanceof Error ? error.message : 'Inventory check failed',
        );
      }
    }
    return {
      kind: 'inventory',
      preflight: {
        kind: blockers.length
          ? 'refused'
          : worker.diagnose && repairs.inspect
            ? 'ready'
            : 'unavailable',
        blockers: blockers
          .slice(0, 60)
          .map((value) => value.slice(0, 1000))
          .concat(
            blockers.length > 60 ? [`… ${blockers.length - 60} more`] : [],
          ),
      },
      identity,
      inventory,
      space,
      journal: prior,
      internalDeclaration: options.declareInternal,
      coldProof,
    };
  }
  if (secureConflict(inventory))
    refuse(
      'recovery-required',
      'Both the non-empty source secure-storage and historical secure store exist; obtain teammate-assisted secure storage recovery before publishing.',
    );
  if (identity.brandId === 'unstoppable-code' && !options.declareInternal)
    refuse(
      'ownership-required',
      'Declare the selected installation internal; stable installations must stay untouched.',
    );
  if (
    inventory.stableOwned ||
    (identity.brandId === 'unstoppable-code' && inventory.nestedSecure)
  )
    refuse(
      'stable-owned',
      'Stable-owned or nested secure state cannot be transferred. Use a fresh internal installation.',
    );
  if (!inventory.sourceIdentity)
    refuse(
      'source-missing',
      'The selected source directory is missing. Check --source-dir, or use --skip-migration for an empty internal folder; no root was created.',
    );
  if (!prior && inventory.destinationIdentity)
    refuse(
      'destination-exists',
      internalRootDestinationExistsRecovery(identity.destination),
    );
  if (
    prior?.phase === 'complete' &&
    prior.secureRelocation === 'complete' &&
    !options.rebuild
  )
    refuse(
      'already-complete',
      'Migration is complete. To restore from the old root, explicitly use --apply --rebuild while cold; this discards the recorded destination. Never start an old build.',
    );
  if (prior?.phase !== 'publishing')
    requireSpace(
      prior
        ? await worker.space(identity, inventory.bytes, prior)
        : await worker.space(identity, inventory.bytes),
    );
  await worker.proveCold(identity, prior?.externalFiles);
  const transactionId = prior?.transactionId ?? worker.transactionId();
  const context = (
    journal?: InternalRootJournal,
  ): InternalRootRepairContext => ({
    identity,
    transactionId,
    inventory: journal?.inventory ?? inventory,
    workingRoot: worker.stagingRoot(identity),
    externalFiles: journal?.externalFiles ?? [],
    repairPlan: journal?.repairPlan,
  });
  let repairPlan = prior?.repairPlan;
  const prepare = async (
    journal?: InternalRootJournal,
  ): Promise<readonly string[]> => {
    const ready = await repairs.prepare(context(journal));
    if (ready.kind !== 'ready') refuse('repair-unavailable', ready.recovery);
    if (
      new Set(ready.externalFiles).size !== ready.externalFiles.length ||
      (journal &&
        JSON.stringify(ready.externalFiles) !==
          JSON.stringify(journal.externalFiles))
    )
      refuse(
        'repair-refused',
        'External repair membership is duplicate or changed. Retain the journal for recovery.',
      );
    await worker.validateExternal(identity, ready.externalFiles);
    repairPlan = ready.repairPlan;
    return ready.externalFiles;
  };
  const needsFrozenEvidence =
    prior &&
    [
      'complete',
      'restoring-external',
      'rebuilding',
      'building',
      'publishing',
    ].includes(prior.phase);
  // C cannot freshly observe authority/Git until backlinks are restored and the
  // previous destination is absent. Partial repairs/publication use frozen
  // evidence, never a fresh Git inventory. The inert default still refuses first.
  let externalFiles =
    needsFrozenEvidence && repairs !== unavailableInternalRootRepairs
      ? prior.externalFiles
      : repairs.settleSourceFirst && (!prior || prior.phase === 'prepared')
        ? (prior?.externalFiles ?? [])
        : await prepare(prior ?? undefined);
  const release = await worker.coordinate(identity);
  try {
    const loaded = await worker.readJournal(identity);
    if (JSON.stringify(loaded) !== JSON.stringify(prior))
      refuse(
        'source-changed',
        `Another invocation changed the journal under ${JSON.stringify(identity.coordination)}; inventory again.`,
      );
    await worker.validateStaging(identity, loaded);
    await worker.proveCold(identity, externalFiles);
    const current = await worker.inventory(identity);
    if (
      current.fingerprint !== inventory.fingerprint ||
      current.sourceIdentity !== inventory.sourceIdentity ||
      current.destinationIdentity !== inventory.destinationIdentity
    )
      refuse('source-changed', 'Inventory changed; run inventory again.');
    let journal: InternalRootJournal = loaded ?? {
      version: 7,
      transactionId,
      identity,
      internalDeclaration: options.declareInternal,
      phase: 'prepared',
      inventory,
      externalFiles,
      stagingRoot: worker.stagingRoot(identity),
      secureRelocation: 'pending',
      repairPlan,
    };
    if (!loaded) await worker.saveJournal(journal);
    const advance = async (
      phase: InternalRootPhase,
      extra: Partial<InternalRootJournal> = {},
    ): Promise<void> => {
      journal = { ...journal, ...extra, phase };
      await worker.saveJournal(journal);
    };
    const checkSource = async (): Promise<InternalRootInventory> => {
      const original = await worker.inventory(identity);
      if (
        !matchesInternalRootNodeIdentity(
          original.sourceIdentity,
          journal.inventory.sourceIdentity,
          worker.os,
        ) ||
        original.stableOwned ||
        (journal.settledFingerprint &&
          original.fingerprint !== journal.settledFingerprint)
      )
        refuse(
          'source-changed',
          `Original root ${JSON.stringify(identity.source)} changed. Preserve both trees; never adopt or overwrite another installation.${canRestart(journal) ? ' Use --apply --restart to preserve this attempt and restart from the current source, only if the destination was not used.' : ''}`,
        );
      return original;
    };
    await checkSource();
    if (journal.phase === 'complete') {
      await worker.validateRebuild(journal);
      await worker.assertExternalPostimages(journal);
      await advance('restoring-external', { secureRelocation: 'pending' });
    }
    if (journal.phase === 'restoring-external') {
      await worker.proveCold(identity, externalFiles);
      await checkSource();
      await worker.validateRebuild(journal);
      await worker.restoreExternal(journal);
      await advance('rebuilding');
    }
    if (journal.phase === 'rebuilding') {
      await worker.proveCold(identity, externalFiles);
      await checkSource();
      await worker.assertExternalPreimages(journal);
      await worker.discardDestination(journal);
      await advance('source-settled', {
        publicationIdentity: undefined,
        publicationFingerprint: undefined,
        stagingIdentity: undefined,
      });
      externalFiles = await prepare({ ...journal, repairPlan: undefined });
      await advance('source-settled', { repairPlan });
    }
    if (journal.phase === 'prepared') {
      if (current.destinationIdentity)
        refuse(
          'destination-exists',
          internalRootDestinationExistsRecovery(identity.destination),
        );
      await worker.recoverW5(journal);
      if (repairs.settleSourceFirst) {
        externalFiles = await prepare();
        await worker.proveCold(identity, externalFiles);
      }
      await advance('source-settled', {
        externalFiles,
        repairPlan,
        settledFingerprint: (await worker.inventory(identity)).fingerprint,
      });
    }
    if (journal.phase === 'source-settled' || journal.phase === 'building') {
      await worker.proveCold(identity, externalFiles);
      const source = await checkSource();
      requireSpace(
        loaded
          ? await worker.space(identity, source.bytes, journal)
          : await worker.space(identity, source.bytes),
      );
      if (!journal.externalSnapshots)
        await advance('source-settled', {
          externalSnapshots: await worker.captureExternal(journal),
        });
      await advance('building');
      const publicationIdentity = await worker.build(journal);
      // Journal the inode before exposing a clone outside private coordination.
      await advance('building', { stagingIdentity: publicationIdentity });
      await worker.exposeStaging(journal);
      await worker.proveCold(identity, externalFiles);
      await worker.validateExternal(identity, externalFiles);
      await checkSource();
      const repaired = await repairs.repair(context(journal));
      if (repaired.kind !== 'ok') refuse('repair-refused', repaired.recovery);
      const verified = await repairs.verify(context(journal));
      if (verified.kind !== 'ok') refuse('repair-refused', verified.recovery);
      await worker.proveCold(identity, externalFiles);
      await checkSource();
      const publicationFingerprint = await worker.seal(
        journal,
        publicationIdentity,
      );
      await advance('publishing', {
        publicationIdentity,
        publicationFingerprint,
        externalSnapshots: await worker.sealExternal(journal),
      });
    }
    if (journal.phase === 'publishing') {
      await worker.proveCold(identity, externalFiles);
      await worker.validateExternal(identity, externalFiles);
      await checkSource();
      const workingRoot = await worker.publicationRoot(journal);
      if (workingRoot === identity.destination) {
        await worker.assertExternalPostimages(journal);
      } else {
        const verified = await repairs.verify({
          ...context(journal),
          workingRoot,
        });
        if (verified.kind !== 'ok') refuse('repair-refused', verified.recovery);
      }
      await worker.proveCold(identity, externalFiles);
      await checkSource();
      await worker.publish(journal);
      const publishedRoot = await worker.publicationRoot(journal);
      if (publishedRoot !== identity.destination)
        refuse(
          'recovery-required',
          'Publication did not reach the final root. Keep both trees and the journal for recovery.',
        );
      await worker.assertExternalPostimages(journal);
      const recovery =
        'Final root is published but unqualified. Keep all affected hosts stopped and retain both roots and the journal for teammate-assisted journal/W5 recovery. Retry qualification from the frozen plan, never fresh preparation.';
      let qualified: InternalRootRepairResult;
      try {
        qualified = await repairs.qualifyPublished({
          ...context(journal),
          workingRoot: publishedRoot,
        });
      } catch (error) {
        refuse(
          'repair-refused',
          `${recovery} ${error instanceof Error ? error.message : 'Unknown qualification failure.'}`,
        );
      }
      if (qualified.kind !== 'ok')
        refuse('repair-refused', `${recovery} ${qualified.recovery}`);
      await advance('complete');
    }
    if (journal.secureRelocation !== 'complete') {
      await worker.proveCold(identity, externalFiles);
      await worker.relocateSecure(journal);
      await advance('complete', { version: 7, secureRelocation: 'complete' });
    }
    return {
      kind: 'complete',
      journal,
      recovery: `Old root ${identity.source} remains in place, untouched apart from W5 settlement. Re-running migration (explicit --rebuild after completion) is the only supported restore path. Do not start stale processes or old builds against it: external Git backlinks now point at ${identity.destination}. Delete the old root yourself only after verifying the new installation, Git worktrees, account state and secure relocation, and accepting loss of this restore path. The script never deletes the old root.${identity.brandId === 'unstoppable-code' ? ` Do not start ${identity.brandDisplayName} stable until you have checked the new installation and deleted ${identity.source}, because stable uses that folder.` : ''}`,
    };
  } finally {
    await release();
  }
}

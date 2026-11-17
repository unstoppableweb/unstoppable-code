import { createHash } from 'node:crypto';
import * as path from 'node:path';
import {
  codeGraphBaseVariantHash,
  getCodeGraphBaseVariantDir,
  readPublishedCodeGraphBase,
  type CodeGraphBaseIdentity,
  type CodeGraphSeedSource,
  type ValidatedCodeGraphBase,
} from '@canopy/code-graph/base-graph';
import { copyPublishedCodeGraphBaseForSeed } from '@canopy/code-graph/host/base-seed';
import { resolveWorkspaceReferenceRepoPath } from './workspace-reference-repo';
import { getRepoShadowDir } from './repo-shadow';
import { CODE_GRAPH_BASE_RUNNER_KEY_PREFIX } from '../code-graph/base-runner-key';

const variantLocks = new Map<string, Promise<unknown>>();
const retiringShadowDirs = new Set<string>();

export function withCodeGraphBaseVariantLock<T>(
  variantDir: string,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = variantLocks.get(variantDir) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  variantLocks.set(variantDir, settled);
  void settled.finally(() => {
    if (variantLocks.get(variantDir) === settled) {
      variantLocks.delete(variantDir);
    }
  });
  return run;
}

export interface CodeGraphBaseVariantLease {
  variantDir: string;
  identity: CodeGraphBaseIdentity;
  destinationRootPath: string;
}

/**
 * Holds every immutable-base variant needed by one seed operation while a
 * caller consumes it. The caller may hand these fully resolved descriptors to
 * a utility process; keeping the main-process locks held until that process
 * responds prevents base retirement from removing a generation mid-copy.
 *
 * No SQLite database is opened here. Validation and copying are deliberately
 * left to the utility process so leasing a large base cannot block Electron's
 * main event loop.
 */
export async function withCodeGraphBaseVariantLeases<T>(
  inputs: readonly {
    canonicalRepoPath: string;
    repoId: string;
    customLanguagesFingerprint: string;
    destinationRootPath: string;
  }[],
  fn: (leases: readonly CodeGraphBaseVariantLease[]) => Promise<T>,
): Promise<T> {
  const leases = await Promise.all(
    inputs.map(async (input): Promise<CodeGraphBaseVariantLease> => {
      const canonicalRepoRoot = await resolveWorkspaceReferenceRepoPath(
        input.canonicalRepoPath,
      );
      const identity: CodeGraphBaseIdentity = {
        repoId: input.repoId,
        canonicalRepoRoot,
        customLanguagesFingerprint: input.customLanguagesFingerprint,
      };
      return {
        variantDir: codeGraphBaseVariantDir(canonicalRepoRoot, identity),
        identity,
        destinationRootPath: input.destinationRootPath,
      };
    }),
  );
  const ordered = Array.from(
    new Map(leases.map((lease) => [lease.variantDir, lease])).values(),
  ).sort((left, right) => left.variantDir.localeCompare(right.variantDir));

  const acquire = (index: number): Promise<T> => {
    const lease = ordered[index];
    if (lease === undefined) {
      return fn(leases);
    }
    const shadowDir = getRepoShadowDir(lease.identity.canonicalRepoRoot);
    if (retiringShadowDirs.has(shadowDir)) {
      return Promise.reject(
        new Error('code-graph base seed cancelled: repository is retiring'),
      );
    }
    return withCodeGraphBaseVariantLock(lease.variantDir, () => {
      if (retiringShadowDirs.has(shadowDir)) {
        throw new Error(
          'code-graph base seed cancelled: repository is retiring',
        );
      }
      return acquire(index + 1);
    });
  };

  return acquire(0);
}

export function codeGraphBaseRunnerKey(
  canonicalRepoRoot: string,
  identity: Pick<
    CodeGraphBaseIdentity,
    'repoId' | 'customLanguagesFingerprint'
  >,
): string {
  const shadowKey = path.basename(getRepoShadowDir(canonicalRepoRoot));
  const variantHash = codeGraphBaseVariantHash(identity);
  const scopedHash = createHash('sha256')
    .update(`${shadowKey}\0${variantHash}`)
    .digest('hex')
    .slice(0, 32);
  return `${CODE_GRAPH_BASE_RUNNER_KEY_PREFIX}${scopedHash}`;
}

export function codeGraphBaseVariantDir(
  canonicalRepoRoot: string,
  identity: Pick<
    CodeGraphBaseIdentity,
    'repoId' | 'customLanguagesFingerprint'
  >,
): string {
  return getCodeGraphBaseVariantDir(
    getRepoShadowDir(canonicalRepoRoot),
    identity,
  );
}

/**
 * Main-process read of the current generation's manifest. It never opens
 * SQLite; callers that need counts or rows read the database off-main.
 */
export async function readCompatibleCodeGraphBase(input: {
  canonicalRepoRoot: string;
  repoId: string;
  customLanguagesFingerprint: string;
}): Promise<ValidatedCodeGraphBase | null> {
  const identity = { ...input, canonicalRepoRoot: input.canonicalRepoRoot };
  const variantDir = codeGraphBaseVariantDir(input.canonicalRepoRoot, identity);
  return withCodeGraphBaseVariantLock(variantDir, () =>
    readPublishedCodeGraphBase({
      variantDir,
      identity,
      validation: 'manifest-only',
    }),
  );
}

/** Prevents new seed leases and drains copies before the shadow is removed. */
export async function retireCodeGraphBaseVariants(
  canonicalRepoRoot: string,
): Promise<void> {
  const shadowDir = getRepoShadowDir(canonicalRepoRoot);
  retiringShadowDirs.add(shadowDir);
  const prefix = `${shadowDir}${path.sep}`;
  await Promise.all(
    Array.from(variantLocks.entries())
      .filter(([variantDir]) => variantDir.startsWith(prefix))
      .map(([, lock]) => lock.catch(() => undefined)),
  );
}

export function allowCodeGraphBaseVariants(canonicalRepoRoot: string): void {
  retiringShadowDirs.delete(getRepoShadowDir(canonicalRepoRoot));
}

/**
 * Copies one immutable generation while holding only its short variant lock.
 * Main reads just the manifest; the build worker validates the copied source
 * before fusing it (`seedCodeGraphDatabase`).
 */
export async function copyCompatibleCodeGraphBaseForSeed(input: {
  canonicalRepoPath: string;
  repoId: string;
  customLanguagesFingerprint: string;
  destinationRootPath: string;
  seedStagingDir: string;
}): Promise<CodeGraphSeedSource | null> {
  const canonicalRepoRoot = await resolveWorkspaceReferenceRepoPath(
    input.canonicalRepoPath,
  );
  const shadowDir = getRepoShadowDir(canonicalRepoRoot);
  if (retiringShadowDirs.has(shadowDir)) {
    throw new Error('code-graph base seed cancelled: repository is retiring');
  }
  const identity = { ...input, canonicalRepoRoot };
  const variantDir = codeGraphBaseVariantDir(canonicalRepoRoot, identity);
  return withCodeGraphBaseVariantLock(variantDir, async () => {
    if (retiringShadowDirs.has(shadowDir)) {
      throw new Error('code-graph base seed cancelled: repository is retiring');
    }
    return copyPublishedCodeGraphBaseForSeed({
      shadowDir,
      identity,
      destinationRootPath: input.destinationRootPath,
      seedStagingDir: input.seedStagingDir,
    });
  });
}

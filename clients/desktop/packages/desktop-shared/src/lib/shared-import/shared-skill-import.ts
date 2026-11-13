import type { SharedImportPort } from './port';
// ---------------------------------------------------------------------------
// Shared skill import helper.
//
// Persists a `SharedSkillDetail` as a local custom skill via the raw write
// preload API so the on-disk SKILL.md bytes match the server-stored content
// exactly. Resolves a few collision scenarios:
//
//   - If a local custom skill with the identical `contentHash` already exists,
//     the helper returns that skill's id/name unchanged. This is how
//     Collection import deduplicates linked custom skills (the resolver passes
//     each `SharedSkillDetail` through here and expects a stable local id
//     back).
//
//   - If a different local custom skill already owns the same name, the
//     server-recommended suffix scheme (`<name>-2`, `<name>-3`, …) picks the
//     first non-colliding alternative. We never overwrite an existing local
//     skill silently.
// ---------------------------------------------------------------------------

import { extractIpcErrorMessage } from '@canopy/protocol/app-errors/ipc-rejection';
import type {
  InstallSkillCapabilityPackageResult,
  PublicShareSkillOrigin,
  SharedSkillDetail,
  SkillWriteFailureCode,
  WriteRawSkillRequest,
} from '../../types/skills';

/**
 * The subset of `SharedSkillDetail` the import actually reads. Widened so
 * snapshot-shaped callers (e.g. the deep-link public-share landing, which
 * only has the pinned name/raw/hash) can import without fabricating a full
 * detail object.
 */
export type SharedSkillImportSource = Pick<
  SharedSkillDetail,
  'name' | 'rawSkill' | 'contentHash'
> & {
  /**
   * Set when the share carries supporting files. `id` is the remote id the
   * package is fetched from, which for a public-share import is the share's
   * external id rather than the skill's.
   */
  id?: string;
  sourceRemoteId?: string;
  package?: SharedSkillDetail['package'];
  distributionMode?: SharedSkillDetail['distributionMode'];
  /**
   * True when `id` addresses a public share rather than an owned skill.
   * Deliberately not named `publicShare`: `SharedSkillDetail` already has a
   * field by that name holding the share's metadata object, and reusing it
   * here would make a detail assignable only by accident.
   */
  fromPublicShare?: boolean;
  /**
   * The Public collection snapshot that pins this skill. Such a skill has no
   * standalone share, so main verifies it against this collection instead.
   */
  publicCollection?: PublicShareSkillOrigin['collection'];
  /**
   * Imported as a member of a team or organization collection, whose own
   * update-email subscription covers it.
   */
  inCollection?: boolean;
  /**
   * Replace this scoped share's reviewed installed copy in place (CAN-5307).
   * Never downgraded to an ordinary install: an unsupported request fails.
   */
  replaceInstalled?: NonNullable<WriteRawSkillRequest['replaceInstalled']>;
};

/**
 * The only source id shared-skill imports ever write to. Exported so callers
 * (e.g. the deep-link landing) reference the same literal instead of keeping
 * private copies.
 */
export const CUSTOM_SKILL_SOURCE_ID = 'custom:app';

export interface LocalImportedSkill {
  /** Local skill id used by `readContent` / `removeSkill`. */
  skillId: string;
  /** Local custom-skill name as it appears in the Skills tab. */
  skillName: string;
  /**
   * `true` when the import found an existing identical local skill instead
   * of writing a new file. Surfaced for tests and for the import progress
   * UI; callers can ignore it during normal happy-path.
   */
  reused: boolean;
  /**
   * What the share's capability package added beyond SKILL.md, when it had
   * one. Absent for a definition-only share, which is every share published
   * before packaging existed.
   */
  packageInstall?: InstallSkillCapabilityPackageResult;
  /**
   * Why the share's supporting files could not be installed, when it carried
   * a package and the install failed. The skill itself still landed — this is
   * a partial-success signal, not an error result.
   */
  packageInstallError?: string;
  /**
   * The copy was written durably, but its update-email subscription was not
   * recorded. Reviewing the share again repairs it without reinstalling.
   */
  subscriptionWarning?: 'subscription-update-failed';
}

const MAX_SUFFIX_ATTEMPTS = 100;

/**
 * Persist `detail.rawSkill` verbatim to the local custom-skill source.
 *
 * On name collision the helper retries with a numeric suffix
 * (`<name>-2`, `<name>-3`, …). On `contentHash` collision (computed by the
 * server before responding) the helper short-circuits and returns the
 * already-installed local skill so Collection import does not fork the link.
 *
 * `writeRawSkill` reports the resulting id/name and writes the exact bytes;
 * the helper never re-serializes the body through `saveCustomSkill` (which
 * would re-emit frontmatter and shift the hash).
 */
export async function importSharedSkill(
  port: SharedImportPort,
  detail: SharedSkillImportSource,
): Promise<LocalImportedSkill> {
  // 1. If we already have a local custom skill with the same content, link to
  //    it directly. `loadSkills` returns hashes only indirectly (via the lock
  //    file) so we fall back to listing the custom source and reading raw
  //    bytes — this is the only reliable way to detect content-hash equality
  //    from the renderer.
  const sourceRemoteId = detail.sourceRemoteId ?? detail.id;
  const contextEnabled = port.receiptsEnforced();
  if (sourceRemoteId && !detail.fromPublicShare && contextEnabled) {
    const written = await port.skills.writeRawSkill({
      skillName: detail.name,
      rawSkill: detail.rawSkill,
      sourceRemoteId,
      ...(detail.inCollection === true ? { inCollection: true } : {}),
      ...(detail.replaceInstalled
        ? { replaceInstalled: detail.replaceInstalled }
        : {}),
    });
    // Even when SKILL.md already matched, the package is reinstalled: a
    // successful content write does not establish package currency.
    return {
      skillId: written.skillId,
      skillName: written.skillName,
      reused: false,
      ...(written.subscriptionWarning
        ? { subscriptionWarning: written.subscriptionWarning }
        : {}),
      ...(await installPackagedFiles(port, detail, written.skillName)),
    };
  }
  if (detail.replaceInstalled) {
    // Only a scoped, receipt-bound import can replace a copy. Continuing as
    // an ordinary install here could create a duplicate.
    throw new Error(
      'Skill unavailable (replacement-unsupported). Open the shared skill again to review it.',
    );
  }
  // With enforcement on, only main can decide whether an identical copy has
  // an owned-source receipt and may be reused by a public import.
  const existing =
    detail.fromPublicShare && contextEnabled
      ? null
      : await findExistingByContent(port, detail);
  if (existing) {
    // Reusing the SKILL.md does not mean reusing the package: a recipient who
    // took the definition-only version before the publisher added supporting
    // files would otherwise never receive them on re-import.
    const packaged = await installPackagedFiles(
      port,
      detail,
      existing.skillName,
    );
    await recordDefinitionOnlyOrigin(
      port,
      detail,
      existing.skillName,
      packaged,
    );
    return {
      ...existing,
      reused: true,
      ...packaged,
    };
  }

  // 2. Walk numeric suffixes until a name lands.
  const baseName = detail.name;
  // A public share has no owned source to receipt. Naming the share lets main
  // verify the origin itself when context enforcement is on; without
  // enforcement main writes the bytes as before and ignores it. Under
  // enforcement main also resolves the name itself from the published
  // skill, so the suffix walk below completes on its first attempt and the
  // name it returns is the one to use.
  const publicShare =
    detail.fromPublicShare === true && detail.id !== undefined
      ? {
          externalId: detail.id,
          contentHash: detail.contentHash,
          ...(detail.publicCollection
            ? { collection: detail.publicCollection }
            : {}),
        }
      : undefined;
  for (let attempt = 0; attempt < MAX_SUFFIX_ATTEMPTS; attempt += 1) {
    const candidate = attempt === 0 ? baseName : `${baseName}-${attempt + 1}`;
    try {
      const written = await port.skills.writeRawSkill({
        skillName: candidate,
        rawSkill: detail.rawSkill,
        ...(publicShare ? { publicShare } : {}),
      });
      const packaged = await installPackagedFiles(
        port,
        detail,
        written.skillName,
      );
      await recordDefinitionOnlyOrigin(
        port,
        detail,
        written.skillName,
        packaged,
      );
      return {
        skillId: written.skillId,
        skillName: written.skillName,
        reused: false,
        ...packaged,
      };
    } catch (err: unknown) {
      // The preload bridge propagates main-side errors via promise rejection.
      // The naming-collision path surfaces a specific message; on any other
      // error we re-throw so the caller can render it via
      // `resolveSharedResourceErrorMessage`.
      if (!isNameCollisionError(err)) {
        throw err;
      }
    }
  }

  throw new Error(
    `Could not import shared skill "${baseName}": exhausted ${MAX_SUFFIX_ATTEMPTS} name-suffix attempts.`,
  );
}

function isNameCollisionError(err: unknown): boolean {
  if (err instanceof Error) {
    const lower = err.message.toLowerCase();
    return (
      lower.includes('already exists') ||
      lower.includes('exists') ||
      lower.includes('eexist')
    );
  }
  return false;
}

async function findExistingByContent(
  port: SharedImportPort,
  detail: SharedSkillImportSource,
): Promise<{ skillId: string; skillName: string } | null> {
  const found = await findInstalledSkillByContentHash(port, detail.contentHash);
  return found ? { skillId: found.skillId, skillName: found.skillName } : null;
}

/**
 * Finds a local custom skill whose bytes hash to `contentHash`. Exported for
 * the deep-link landing's installed-state detection (CAN-2361 v2), which
 * needs the same comparison the import dedupe uses without importing. The
 * scan is deliberately limited to `custom:app` — bundled/plugin skills are
 * never install targets — and the matched `sourceId` is returned so callers
 * manage/uninstall exactly the source that matched instead of assuming one.
 */
export async function findInstalledSkillByContentHash(
  port: SharedImportPort,
  contentHash: string,
): Promise<{ skillId: string; sourceId: string; skillName: string } | null> {
  const skillsResult = await port.skills.loadSkills();
  if (!skillsResult.success || !skillsResult.data) return null;

  const customs = skillsResult.data.filter(
    (skill) => skill.sourceId === CUSTOM_SKILL_SOURCE_ID,
  );

  for (const skill of customs) {
    try {
      const raw = await port.skills.readRawSkill(
        `${skill.sourceId}/${skill.name}`,
      );
      if (await contentHashMatches(raw, contentHash)) {
        return {
          skillId: `${skill.sourceId}/${skill.name}`,
          sourceId: skill.sourceId,
          skillName: skill.name,
        };
      }
    } catch {
      // Any read failure simply means we can't compare; treat as not-matched
      // and continue.
    }
  }

  return null;
}

/** What a recipient surface may offer for a team or organization share. */
export type SharedSkillInstallLookup =
  | { status: 'absent' }
  | {
      status: 'installed';
      skillId: string;
      sourceId: string;
      skillName: string;
      /** The copy's content or package differs from the share. */
      updateAvailable: boolean;
      /**
       * The copy differs from what was installed, or its install-time hash is
       * unknown. Replacing it needs the user's confirmation.
       */
      locallyEdited: boolean;
      /** SHA-256 of the exact local bytes compared. */
      localContentHash: string;
      /** SHA-256 of the share bytes compared, for an in-place update. */
      sourceContentHash: string;
    }
  /** A receipt names this share, but none of its copies is on disk. */
  | { status: 'missing-copy' }
  /** The installed state could not be verified; nothing may be offered. */
  | { status: 'unverified' };

/** An installed detail's local destination hint, never part of the share DTO. */
export interface InstalledSharedSkillTarget {
  readonly sourceId: string;
  readonly skillName: string;
}

/**
 * The installed copy of a team or organization share. Under context
 * enforcement the install receipt establishes installation and hashes only
 * establish currency (CAN-5307): a receipted copy whose bytes or package
 * changed is still installed, with an update available, so the recipient
 * reviews an update instead of installing a duplicate.
 *
 *   - An installed-detail destination selects only that receipted copy;
 *     disappearance or unreadability never substitutes a sibling.
 *   - Without a destination, a current copy wins; otherwise the first
 *     readable copy in local-id order. A missing copy never hides a sibling.
 *   - Without enforcement, or for a share with no receipt support, an
 *     identical copy counts, as the import reuses it; a packaged share then
 *     cannot be confirmed and reads as absent.
 *
 * Read, inventory, and hashing failures are `unverified`, never `absent`:
 * treating them as absence would offer an Install that creates a duplicate.
 */
export async function lookupInstalledSharedSkill(
  port: SharedImportPort,
  detail: Pick<
    SharedSkillDetail,
    'id' | 'rawSkill' | 'contentHash' | 'distributionMode' | 'package'
  > & { installedCopyIds?: readonly string[] },
  target?: InstalledSharedSkillTarget,
): Promise<SharedSkillInstallLookup> {
  if (target && target.sourceId !== CUSTOM_SKILL_SOURCE_ID)
    return { status: 'unverified' };
  if (!port.receiptsEnforced()) {
    if (target) return { status: 'unverified' };
    // No receipt records a package install here, so it cannot be confirmed.
    if (detail.distributionMode === 'package') return { status: 'absent' };
    const found = await findInstalledSkillByContentHash(
      port,
      detail.contentHash,
    );
    if (!found) return { status: 'absent' };
    const hash = detail.contentHash.toLowerCase();
    return {
      status: 'installed',
      ...found,
      updateAvailable: false,
      locallyEdited: false,
      localContentHash: hash,
      sourceContentHash: hash,
    };
  }
  try {
    const copyIds =
      detail.installedCopyIds ??
      (await port.skills.getShared(detail.id)).installedCopyIds;
    if (copyIds === undefined) return { status: 'unverified' };
    const skillsResult = await port.skills.loadSkills();
    if (!skillsResult.success || !skillsResult.data)
      return { status: 'unverified' };
    const receipted = skillsResult.data.filter(
      (skill) =>
        skill.sourceId === CUSTOM_SKILL_SOURCE_ID &&
        skill.installedFromShare?.remoteId === detail.id &&
        (target === undefined || skill.name === target.skillName) &&
        (copyIds === undefined ||
          copyIds.includes(`${skill.sourceId}/${skill.name}`)),
    );
    if (receipted.length === 0)
      // A targeted copy disappearing must not become a fresh Install or
      // silently select another receipted alias of the same source.
      return target
        ? { status: 'missing-copy' }
        : copyIds !== undefined && copyIds.length > 0
          ? { status: 'missing-copy' }
          : { status: 'absent' };
    const sourceContentHash = await sha256Hex(detail.rawSkill);
    if (!sourceContentHash) return { status: 'unverified' };
    let unreadable = false;
    let selected: Extract<
      SharedSkillInstallLookup,
      { status: 'installed' }
    > | null = null;
    const ordered = [...receipted].sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
    for (const skill of ordered) {
      const skillId = `${skill.sourceId}/${skill.name}`;
      let localContentHash: string;
      try {
        localContentHash = await sha256Hex(
          await port.skills.readRawSkill(skillId),
        );
      } catch {
        unreadable = true;
        continue;
      }
      if (!localContentHash) return { status: 'unverified' };
      const origin = skill.installedFromShare;
      const packageCurrent =
        detail.distributionMode !== 'package' ||
        (detail.package !== undefined &&
          origin?.packageDigest === detail.package.digest);
      const current =
        localContentHash === sourceContentHash &&
        packageCurrent &&
        origin?.replacementPending !== true;
      const candidate = {
        status: 'installed' as const,
        skillId,
        sourceId: skill.sourceId,
        skillName: skill.name,
        updateAvailable: !current,
        locallyEdited:
          origin?.contentHash === undefined ||
          origin.contentHash.toLowerCase() !== localContentHash,
        localContentHash,
        sourceContentHash,
      };
      if (current) return candidate;
      selected ??= candidate;
    }
    if (selected) return selected;
    return unreadable ? { status: 'unverified' } : { status: 'missing-copy' };
  } catch {
    return { status: 'unverified' };
  }
}

/** The typed reason main put in a rejected skill write, when it has one. */
export function sharedSkillWriteFailureCode(
  error: unknown,
): SkillWriteFailureCode | null {
  const match =
    /\((replacement-unsupported|invalid-replacement|review-required|missing-copy|local-conflict|source-conflict|recovery-required)\)/.exec(
      extractIpcErrorMessage(error),
    );
  switch (match?.[1]) {
    case 'replacement-unsupported':
    case 'invalid-replacement':
    case 'review-required':
    case 'missing-copy':
    case 'local-conflict':
    case 'source-conflict':
    case 'recovery-required':
      return match[1];
    default:
      return null;
  }
}

async function contentHashMatches(
  raw: string,
  remoteHash: string,
): Promise<boolean> {
  try {
    const localHash = await sha256Hex(raw);
    return localHash === remoteHash.toLowerCase();
  } catch {
    return false;
  }
}

async function sha256Hex(input: string): Promise<string> {
  const subtle =
    typeof globalThis !== 'undefined' &&
    typeof globalThis.crypto !== 'undefined'
      ? globalThis.crypto.subtle
      : undefined;
  if (!subtle) {
    // No crypto available — skip the deduplication optimization rather than
    // failing the import. Receipt lookups read this as unverified.
    return '';
  }
  const data = new TextEncoder().encode(input);
  const buffer = await subtle.digest('SHA-256', data);
  const bytes = new Uint8Array(buffer);
  let hex = '';
  for (let i = 0; i < bytes.length; i += 1) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return /^[a-f0-9]{64}$/.test(hex) ? hex : '';
}

/**
 * Copy the share's packaged supporting files beside the SKILL.md just written.
 *
 * Never fatal. A definition-only share has nothing to install, and a share
 * whose package cannot be fetched still leaves the recipient with a working
 * skill — which is exactly what every skill import produced before packaging
 * existed. The failure is reported through the absent result rather than
 * unwinding a skill the user can already use.
 */
async function installPackagedFiles(
  port: SharedImportPort,
  detail: SharedSkillImportSource,
  skillName: string,
): Promise<{
  packageInstall?: InstallSkillCapabilityPackageResult;
  packageInstallError?: string;
}> {
  if (
    detail.distributionMode !== 'package' ||
    detail.package === undefined ||
    detail.id === undefined
  ) {
    return {};
  }
  try {
    return {
      packageInstall: await port.skills.installCapabilityPackage({
        remoteId: detail.id,
        skillName,
        primaryRootName: detail.name,
        packageRef: { version: 1, digest: detail.package.digest },
        ...(detail.fromPublicShare === true ? { publicShare: true } : {}),
      }),
    };
  } catch (error) {
    // Not fatal: the skill is already written and usable, and unwinding it
    // would be strictly worse than the definition-only import every skill got
    // before packaging existed. But swallowing this entirely would leave the
    // recipient believing they received the whole skill, so the reason is
    // returned for the caller to surface.
    //
    // EVERY caller must read `packageInstallError`. This is a partial success,
    // so it cannot be signalled by rejecting — which means a caller that only
    // awaits the promise reports plain success. Current readers: the deep-link
    // lander, the Skills tab, the plugin entry detail modal, the Collection
    // installer, and the App Advisor dispatcher's action result.
    // Unwrapped: the rejection crosses IPC, so its raw message carries the
    // channel name and the main-side error class.
    const message = extractIpcErrorMessage(error);
    return {
      packageInstallError:
        message === 'Unknown error'
          ? 'The supporting files could not be installed.'
          : message,
    };
  }
}

/**
 * Pin a definition-only import to the share it came from, so the install
 * ledger knows where the skill originated even though no package was fetched.
 * A successful packaged import records its own pin as part of the package
 * install. A package failure still leaves a definition-only skill and needs
 * this fallback. Reused content takes the same path; the main-process handler
 * writes only when that local skill has no prior ledger record, preserving an
 * existing package or source pin.
 *
 * The pin names the share this import came from and nothing further back: a
 * re-shared skill belongs to the re-sharer, so attribution does not chain.
 *
 * Never fatal: the skill is written and usable whether or not the pin lands.
 */
async function recordDefinitionOnlyOrigin(
  port: SharedImportPort,
  detail: SharedSkillImportSource,
  skillName: string,
  result: {
    packageInstall?: InstallSkillCapabilityPackageResult;
    packageInstallError?: string;
  },
): Promise<void> {
  if (result.packageInstall !== undefined || detail.id === undefined) return;
  try {
    await port.skills.recordShareOrigin({
      localId: skillName,
      originExternalId: detail.id,
      contentHash: detail.contentHash,
    });
  } catch {
    // The pin is provenance only; a missing row leaves the skill as it was
    // before origins were recorded.
  }
}

/** One wording for a failed supporting-file install, on every surface. */
export const SKILL_FILES_NOT_INSTALLED_LABEL =
  'Skill added, but its supporting files could not be installed.';
export const SKILL_FILES_NOT_UPDATED_LABEL =
  'Skill updated, but its supporting files could not be installed.';

/**
 * What a caller must tell the recipient beyond "imported", or `null` when the
 * import was complete. Every case here is a partial success — the skill
 * landed — so every import path reports it through one notice rather than an
 * error or a plain success flash:
 *
 *   - the supporting files did not install at all;
 *   - some packaged files were not written because the recipient's own
 *     version was kept (a re-import never overwrites);
 *   - an invoked skill landed under a different name because the recipient
 *     already had a different skill by that name — the imported skill still
 *     calls the original name, which now runs the recipient's skill, so this
 *     one matters most;
 *   - packaged plugin skills, commands, or agents could not be added, because
 *     they belong to a plugin rather than to the skill library.
 */
export function describeSharedSkillImportNotice(
  result: {
    packageInstall?: InstallSkillCapabilityPackageResult;
    packageInstallError?: string;
  },
  outcome: 'installed' | 'updated' = 'installed',
): string | null {
  if (result.packageInstallError !== undefined) {
    return `${
      outcome === 'updated'
        ? SKILL_FILES_NOT_UPDATED_LABEL
        : SKILL_FILES_NOT_INSTALLED_LABEL
    } ${result.packageInstallError}`;
  }
  const install = result.packageInstall;
  if (!install) return null;
  const details: string[] = [];
  const kept = install.keptLocalFiles.length;
  if (kept === 1) {
    details.push('You already had one of its files, so your version was kept.');
  } else if (kept > 1) {
    details.push(
      `You already had ${kept} of its files, so your versions were kept.`,
    );
  }
  for (const dependency of install.installedDependencies) {
    if (dependency.localName === dependency.name) continue;
    details.push(
      `Its ${dependency.name} skill was added as ${dependency.localName}, because you already have a different ${dependency.name}.`,
    );
  }
  const plugin = install.uninstalledResourceLabels;
  if (plugin.length > 0) {
    details.push(
      `It also uses ${joinLabels(plugin)}, which come from a plugin and were not added.`,
    );
  }
  return details.length === 0
    ? null
    : [
        outcome === 'updated' ? 'Skill updated.' : 'Skill added.',
        ...details,
      ].join(' ');
}

function joinLabels(labels: readonly string[]): string {
  if (labels.length <= 1) return labels.join('');
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}

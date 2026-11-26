import type {
  SharedContainerCapabilityPackageCounts,
  SharedContainerRevisionPackage,
} from '@canopy/protocol/shared-containers';

/**
 * Pure copy for the capability package a shared container carries. The share
 * dialog and the fork confirmation each render copy from here; neither adds
 * controls. Display only — no fetching, no stores, no host APIs.
 */

const CATEGORIES: ReadonlyArray<{
  key: keyof SharedContainerCapabilityPackageCounts;
  singular: string;
  plural: string;
}> = [
  { key: 'skills', singular: 'skill', plural: 'skills' },
  { key: 'pipelines', singular: 'pipeline', plural: 'pipelines' },
  { key: 'agents', singular: 'model preset', plural: 'model presets' },
  { key: 'automations', singular: 'automation', plural: 'automations' },
  { key: 'hooks', singular: 'hook', plural: 'hooks' },
];

function joinPhrases(phrases: readonly string[]): string {
  if (phrases.length <= 1) return phrases.join('');
  return `${phrases.slice(0, -1).join(', ')} and ${phrases[phrases.length - 1]}`;
}

/**
 * `2 skills, 1 pipeline and 1 automation`. Zero categories are omitted; an
 * all-zero package returns null so callers render nothing.
 */
export function formatCapabilityPackageCounts(
  counts: SharedContainerCapabilityPackageCounts,
): string | null {
  const phrases = CATEGORIES.flatMap(({ key, singular, plural }) => {
    const count = counts[key];
    if (!Number.isSafeInteger(count) || count <= 0) return [];
    return [`${String(count)} ${count === 1 ? singular : plural}`];
  });
  return phrases.length === 0 ? null : joinPhrases(phrases);
}

/** Publisher line in the share dialog's Advanced details; null when empty. */
export function formatCapabilityPackageShareNote(
  counts: SharedContainerCapabilityPackageCounts,
): string | null {
  const summary = formatCapabilityPackageCounts(counts);
  if (summary === null) return null;
  const exception = counts.hooks > 0 ? ', except hooks' : '';
  return `This share also carries the ${summary} used here. They install only if a teammate makes a copy${exception}.`;
}

export interface CapabilityPackageForkDisclosure {
  /** One short line shown up front. */
  summary: string;
  /** Notes shown only when the recipient opens the details. */
  details: string[];
  /** Runnable scripts, named in full inside the details. */
  scripts: string[];
}

/**
 * Recipient disclosure in the fork confirmation; null for an empty package.
 * Making the copy is the consent to install, so the summary always counts
 * runnable scripts and the details name each one in full, even when every
 * category count is zero. Skills the share used directly join the
 * destination's default selections, so the details say new chats there start
 * with them turned on. Hooks are carried but never installed, because their
 * paused state cannot yet be guaranteed in every worktree of the destination.
 */
export function formatCapabilityPackageForkDisclosure(
  capabilityPackage: SharedContainerRevisionPackage,
): CapabilityPackageForkDisclosure | null {
  const { counts, executableFiles } = capabilityPackage;
  const scripts = [...executableFiles];
  const installed = formatCapabilityPackageCounts({ ...counts, hooks: 0 });
  const hasHooks = counts.hooks > 0;
  if (installed === null && !hasHooks && scripts.length === 0) return null;
  const scriptPhrase =
    scripts.length === 0
      ? null
      : `${String(scripts.length)} ${scripts.length === 1 ? 'script' : 'scripts'} that can run on this computer`;
  const hooksNote = "Hooks from this share aren't added.";
  const details: string[] = [];
  if (counts.skills > 0) {
    details.push(
      `New chats in the copy start with ${counts.skills === 1 ? 'this skill' : 'these skills'} turned on.`,
    );
  }
  if (counts.automations > 0) {
    details.push(
      counts.automations === 1
        ? 'The automation starts turned off.'
        : 'Automations start turned off.',
    );
  }
  let summary: string;
  if (installed !== null) {
    summary =
      scriptPhrase === null
        ? `Installs ${installed}.`
        : `Installs ${installed}, plus ${scriptPhrase}.`;
  } else if (scriptPhrase !== null) {
    summary = `Installs ${scriptPhrase}.`;
  } else {
    return { summary: hooksNote, details, scripts };
  }
  if (hasHooks) details.push(hooksNote);
  return { summary, details, scripts };
}

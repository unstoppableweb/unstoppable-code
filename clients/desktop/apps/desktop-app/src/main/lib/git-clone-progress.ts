import { repositoryNameFromCloneUrl } from '@canopy/protocol/remote-control/shell';
import type { CloneJobPhase } from '@canopy/desktop-shared/types';

/** One parsed `git clone --progress` status line. */
export interface GitCloneProgressUpdate {
  phase: Exclude<CloneJobPhase, 'starting' | 'finishing'>;
  percent: number | null;
  processed: number | null;
  total: number | null;
  received: string | null;
  throughput: string | null;
}

const PHASE_LABELS: ReadonlyArray<{
  label: string;
  phase: GitCloneProgressUpdate['phase'];
}> = [
  { label: 'Enumerating objects', phase: 'counting' },
  { label: 'Counting objects', phase: 'counting' },
  { label: 'Compressing objects', phase: 'compressing' },
  { label: 'Receiving objects', phase: 'receiving' },
  { label: 'Resolving deltas', phase: 'resolving' },
  { label: 'Updating files', phase: 'checkout' },
  { label: 'Checking out files', phase: 'checkout' },
  // Git LFS smudging during checkout.
  { label: 'Filtering content', phase: 'checkout' },
];

const PROGRESS_LINE_RE =
  /^(?:remote:\s+)?([A-Za-z ]+?):\s+(?:(\d{1,3})%\s+\((\d+)\/(\d+)\)|(\d+))(?:,\s+([\d.]+\s+[KMGT]?i?B)\s+\|\s+([\d.]+\s+[KMGT]?i?B\/s))?/;

/**
 * Parse one CR/LF-delimited line of `git clone --progress` stderr. Returns
 * null for anything that is not a recognized phase update.
 */
export function parseGitCloneProgressLine(
  line: string,
): GitCloneProgressUpdate | null {
  const match = PROGRESS_LINE_RE.exec(line.trim());
  if (!match) return null;
  const phase = PHASE_LABELS.find(
    (entry) => entry.label === match[1].trim(),
  )?.phase;
  if (!phase) return null;
  if (match[2] !== undefined) {
    const percent = Number(match[2]);
    if (percent > 100) return null;
    return {
      phase,
      percent,
      processed: Number(match[3]),
      total: Number(match[4]),
      received: match[6] ?? null,
      throughput: match[7] ?? null,
    };
  }
  return {
    phase,
    percent: null,
    processed: Number(match[5]),
    total: null,
    received: null,
    throughput: null,
  };
}

/**
 * True for stderr lines that only report progress, so failures can surface
 * the lines that explain them (`fatal: …`) without the progress noise.
 */
export function isGitCloneProgressLine(line: string): boolean {
  const trimmed = line.trim();
  return (
    trimmed.length === 0 ||
    trimmed.startsWith('Cloning into') ||
    parseGitCloneProgressLine(trimmed) !== null ||
    /^remote: (?:Total|Enumerating|Counting|Compressing)\b/.test(trimmed)
  );
}

// Share of the overall bar each phase occupies. Receiving dominates wall time
// for large repositories, so it gets the widest band.
const PHASE_BANDS: Record<CloneJobPhase, readonly [number, number]> = {
  starting: [0, 0],
  counting: [0, 5],
  compressing: [5, 10],
  receiving: [10, 80],
  resolving: [80, 92],
  checkout: [92, 99],
  finishing: [99, 99],
};

/** Estimate overall clone progress (0-99) from a phase and its percentage. */
export function estimateClonePercent(
  phase: CloneJobPhase,
  phasePercent: number | null,
): number {
  const [start, end] = PHASE_BANDS[phase];
  return start + ((end - start) * (phasePercent ?? 0)) / 100;
}

/**
 * Remove URI user info before a remote is broadcast to renderers. Preserve
 * scp-style (`git@host:path`) remotes and local paths.
 */
export function redactRemoteUrlCredentials(remoteUrl: string): string {
  const trimmed = remoteUrl.trim();
  if (!/^[a-z][a-z\d+.-]*:\/\//i.test(trimmed)) return trimmed;
  try {
    const url = new URL(trimmed);
    if (!url.username && !url.password) return trimmed;
    url.username = '';
    url.password = '';
    return url.toString();
  } catch {
    return redactRemoteUrlCredentialsInText(trimmed);
  }
}

/** A display and destination name derived only from the remote path. */
export function inferCloneRepoName(remoteUrl: string): string {
  return repositoryNameFromCloneUrl(redactRemoteUrlCredentials(remoteUrl));
}

/** Remove URI user info echoed inside git's explanatory stderr text. */
export function redactRemoteUrlCredentialsInText(text: string): string {
  return text.replace(/\b([a-z][a-z\d+.-]*:\/\/)[^\s/?#'"<>]+@/gi, '$1');
}

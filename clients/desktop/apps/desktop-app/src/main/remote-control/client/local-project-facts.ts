import { classifyError } from '@canopy/protocol/app-errors/classification';
import type { PairedComputerLocalProjectFacts } from '@canopy/desktop-shared/types';
import { repositoryKeyOf } from '@canopy/desktop-shared/lib/project-groups';
import { getRemoteUrlStrict } from '../../lib/git';
import { readWorkspaceConfigDetailed } from '../../lib/workspace-persistence';
import { validateId } from '../../lib/validation';

/**
 * What the main window needs to match this computer's projects with a paired
 * computer's copies (CAN-7766, over CAN-7762's `localProjectCopy`): each
 * project's cloud binding and its repositories' addresses. The window's
 * project list carries neither, so it asks here once its project list
 * changes, never on every sidebar update.
 *
 * Reads are cached: the manifest through the W5 image cache, and each
 * repository's `origin` for {@link REMOTE_TTL_MS}, so a burst of asks reads
 * Git once per repository. Remotes leave main only as credential-free
 * addresses (`https://<host>/<path>.git`), which normalize back to the same
 * repository key.
 */

/** How long a repository's address is reused before Git is asked again. */
const REMOTE_TTL_MS = 60_000;
/** The most projects one ask may name; the window sends the ones it lists. */
export const MAX_PROJECT_FACTS_IDS = 2000;

interface CachedRemote {
  readonly address: Promise<string | null | undefined>;
  readonly readAt: number;
}

export interface LocalProjectFactsReader {
  read(
    projectIds: unknown,
  ): Promise<Record<string, PairedComputerLocalProjectFacts>>;
}

export interface LocalProjectFactsDeps {
  readonly readConfig: typeof readWorkspaceConfigDetailed;
  readonly readRemote: (repoPath: string) => Promise<string | null>;
  readonly now: () => number;
}

const DEFAULT_DEPS: LocalProjectFactsDeps = {
  readConfig: readWorkspaceConfigDetailed,
  readRemote: getRemoteUrlStrict,
  now: Date.now,
};

function parseProjectIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_PROJECT_FACTS_IDS)
    throw new Error('Invalid project IDs.');
  const ids = new Set<string>();
  for (const id of value) {
    validateId(id, 'project ID');
    ids.add(id);
  }
  return Array.from(ids);
}

export function createLocalProjectFactsReader(
  deps: LocalProjectFactsDeps = DEFAULT_DEPS,
): LocalProjectFactsReader {
  const remotes = new Map<string, CachedRemote>();

  /** The address, null for no usable origin, or undefined when Git failed. */
  const addressOf = (repoPath: string): Promise<string | null | undefined> => {
    const cached = remotes.get(repoPath);
    const now = deps.now();
    if (cached && now - cached.readAt < REMOTE_TTL_MS) return cached.address;
    const address = deps.readRemote(repoPath).then(
      (remote) => {
        const key = remote === null ? null : repositoryKeyOf(remote);
        return key === null ? null : `https://${key}.git`;
      },
      () => {
        // Asked again next time.
        remotes.delete(repoPath);
        return undefined;
      },
    );
    remotes.set(repoPath, { address, readAt: now });
    return address;
  };

  const factsOf = async (
    projectId: string,
  ): Promise<PairedComputerLocalProjectFacts | null> => {
    const detail = await deps.readConfig(projectId);
    if (detail.authority !== 'ok' || detail.ownerMalformed) return null;
    const config = detail.config;
    const repositoryRemotes: (string | null)[] = [];
    if (config.type === 'single-repo' && config.repoPath) {
      repositoryRemotes.push((await addressOf(config.repoPath)) ?? null);
    } else if (config.type === 'multi-repo') {
      // A root folder that Git can't read is not a repository: left out.
      const root = config.sourceRepoPath
        ? await addressOf(config.sourceRepoPath)
        : undefined;
      if (root !== undefined) repositoryRemotes.push(root);
      const listed = await Promise.all(
        config.repos.map((repo) => addressOf(repo.repoPath)),
      );
      for (const address of listed) repositoryRemotes.push(address ?? null);
    }
    return {
      cloudBinding: config.cloudBinding ?? null,
      repositoryRemotes,
    };
  };

  return {
    async read(value) {
      const ids = parseProjectIds(value);
      const entries = await Promise.all(
        ids.map(async (id) => {
          try {
            return [id, await factsOf(id)] as const;
          } catch {
            // An unreadable project matches by nothing: it is left out.
            return [id, null] as const;
          }
        }),
      );
      const result: Record<string, PairedComputerLocalProjectFacts> = {};
      for (const [id, facts] of entries) if (facts !== null) result[id] = facts;
      return result;
    },
  };
}

export interface LocalProjectFactsGate<Sender> {
  /** main's own-window check (`ownWindowCheck`): not a bridge, not another computer's window. */
  readonly isOwnWindow: (sender: Sender) => boolean;
  /** main's read of the one-window switch. */
  readonly isOneWindowEnabled: () => boolean;
  readonly reader: LocalProjectFactsReader;
}

/**
 * `remote-control:computer-project-facts`: this computer's own windows only,
 * and only while the one-window switch is on, so nothing reads these for a
 * paired computer acting here or while the one-window work is off.
 */
export function localProjectFactsHandler<Sender>(
  gate: LocalProjectFactsGate<Sender>,
): (
  sender: Sender,
  projectIds: unknown,
) => Promise<Record<string, PairedComputerLocalProjectFacts>> {
  return async (sender, projectIds) => {
    if (!gate.isOwnWindow(sender) || !gate.isOneWindowEnabled())
      throw classifyError(
        new Error("Only this computer's main window reads these."),
        'input.not_accepted',
      );
    return gate.reader.read(projectIds);
  };
}

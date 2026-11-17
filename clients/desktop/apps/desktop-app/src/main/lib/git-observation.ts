import { AsyncLocalStorage } from 'node:async_hooks';

interface GitObservation {
  commonDirectories: Map<string, Promise<string>>;
  originUrls: Map<string, Promise<string | null>>;
  branchPresence: Map<string, Promise<boolean>>;
}

const observations = new AsyncLocalStorage<GitObservation>();

/** Advisory facts for one backend observation, never shared between requests. */
export function withGitObservation<T>(read: () => Promise<T>): Promise<T> {
  return observations.run(
    {
      commonDirectories: new Map(),
      originUrls: new Map(),
      branchPresence: new Map(),
    },
    read,
  );
}

function once<T>(
  cache: Map<string, Promise<T>> | undefined,
  key: string,
  read: () => Promise<T>,
  retain: (value: T) => boolean,
): Promise<T> {
  if (!cache) return read();
  const pending = cache.get(key);
  if (pending) return pending;
  const result = read().then(
    (value) => {
      if (!retain(value)) cache.delete(key);
      return value;
    },
    (error: unknown) => {
      cache.delete(key);
      throw error;
    },
  );
  cache.set(key, result);
  return result;
}

export function observeGitCommonDirectory(
  repoPath: string,
  read: () => Promise<string>,
): Promise<string> {
  return once(
    observations.getStore()?.commonDirectories,
    repoPath,
    read,
    Boolean,
  );
}

export function observeGitOriginUrl(
  repoPath: string,
  read: () => Promise<string | null>,
): Promise<string | null> {
  return once(observations.getStore()?.originUrls, repoPath, read, Boolean);
}

export function observeGitBranchPresence(
  repoPath: string,
  ref: string,
  read: () => Promise<boolean>,
): Promise<boolean> {
  return once(
    observations.getStore()?.branchPresence,
    `${repoPath}\0${ref}`,
    read,
    Boolean,
  );
}

/** Fetch can change refs; facts from before its effects cannot answer later reads. */
export function invalidateObservedGitRefs(): void {
  observations.getStore()?.branchPresence.clear();
}

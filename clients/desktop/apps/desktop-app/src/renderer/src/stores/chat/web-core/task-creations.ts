/**
 * Cloud tasks this window opened before the web core created them, by the
 * store's scope key (CAN-6098). The sidebar opens a new task at once and
 * records each create attempt here; the web core backend serves the task
 * empty until it exists, and a send waits for it.
 */
interface TaskCreation {
  /** The newest attempt: pending, or rejected with why the task is missing. */
  attempt: Promise<unknown>;
  /** Resolves once any attempt created the task. */
  readonly created: Promise<void>;
  readonly resolve: () => void;
}

const creations = new Map<string, TaskCreation>();

type Scope = { readonly projectId: string; readonly worktreeId: string };

const keyOf = (scope: Scope): string =>
  `${scope.projectId}/${scope.worktreeId}`;

/** Records a create attempt for a task this window opened (or retried). */
export function trackTaskCreation(
  scope: Scope,
  attempt: Promise<unknown>,
): void {
  const key = keyOf(scope);
  let creation = creations.get(key);
  if (creation === undefined) {
    let resolve = (): void => undefined;
    const created = new Promise<void>((done) => {
      resolve = done;
    });
    creation = { attempt, created, resolve };
    creations.set(key, creation);
  } else creation.attempt = attempt;
  const tracked = creation;
  void attempt.then(
    () => {
      if (creations.get(key) !== tracked || tracked.attempt !== attempt) return;
      creations.delete(key);
      tracked.resolve();
    },
    () => undefined,
  );
}

/** Whether the scope's task is one this window opened and is still creating. */
export function isTaskBeingCreated(scope: Scope): boolean {
  return creations.has(keyOf(scope));
}

/** Resolves once the scope's task exists: at once for a task not tracked here. */
export function taskCreated(scope: Scope): Promise<void> {
  return creations.get(keyOf(scope))?.created ?? Promise.resolve();
}

/**
 * Settles with the scope's newest create attempt: fulfilled once the task
 * exists (at once for a task not tracked here), rejected with why it doesn't.
 * A task the web core lists exists, whatever its attempt later says.
 */
export function taskCreationSettled(scope: Scope): Promise<void> {
  const creation = creations.get(keyOf(scope));
  return creation === undefined
    ? Promise.resolve()
    : Promise.race([creation.created, creation.attempt.then(() => undefined)]);
}

/**
 * The task exists, as the web core's own listing shows, whatever became of
 * its create attempts: one may have landed without an answer. Whatever waits
 * on it goes ahead.
 */
export function markTaskCreated(scope: Scope): void {
  const key = keyOf(scope);
  const creation = creations.get(key);
  if (creation === undefined) return;
  creations.delete(key);
  creation.resolve();
}

/** Forgets every task in creation: the connection that would create it is gone. */
export function clearTaskCreations(): void {
  creations.clear();
}

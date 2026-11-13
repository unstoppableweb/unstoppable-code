// Variables that tell Git which repository to use (`git rev-parse
// --local-env-vars`). Git exports them to hooks, so tests started from a hook
// would otherwise run their temp-repository `git init` / `git config` against
// the caller's repository instead. Git config environment overrides can also
// redirect worktrees or hooks, so remove both the parameter and numbered forms.
export const REPOSITORY_GIT_ENV_KEYS = Object.freeze([
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_CONFIG',
  'GIT_CONFIG_PARAMETERS',
  'GIT_CONFIG_COUNT',
  'GIT_DIR',
  'GIT_GRAFT_FILE',
  'GIT_IMPLICIT_WORK_TREE',
  'GIT_INTERNAL_SUPER_PREFIX',
  'GIT_INDEX_FILE',
  'GIT_NO_REPLACE_OBJECTS',
  'GIT_OBJECT_DIRECTORY',
  'GIT_PREFIX',
  'GIT_REPLACE_REF_BASE',
  'GIT_SHALLOW_FILE',
  'GIT_WORK_TREE',
]);

export function removeRepositoryGitEnv(env = process.env) {
  for (const key of REPOSITORY_GIT_ENV_KEYS) {
    delete env[key];
  }
  for (const key of Object.keys(env)) {
    if (/^GIT_CONFIG_(?:KEY|VALUE)_\d+$/i.test(key)) {
      delete env[key];
    }
  }
  return env;
}

export function withoutRepositoryGitEnv(env) {
  return removeRepositoryGitEnv({ ...env });
}

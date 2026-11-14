import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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

/**
 * Point Git at a global config that includes the developer's own (identity,
 * aliases and the rest still apply) and then turns commit and tag signing
 * off. Test repositories commit constantly; with a signing setup each commit
 * would ask the developer's signer (CAN-6349). A test that sets its own
 * `GIT_CONFIG_GLOBAL` still replaces this one. Returns a function that puts
 * `GIT_CONFIG_GLOBAL` back as it was and removes the config, so a second call
 * in the same process (Jest watch mode) includes the developer's own again.
 */
export function useUnsignedGitConfig(env = process.env) {
  const previous = env.GIT_CONFIG_GLOBAL;
  const home = env.HOME ?? env.USERPROFILE ?? os.homedir();
  const xdgHome = env.XDG_CONFIG_HOME ?? path.join(home, '.config');
  // Without GIT_CONFIG_GLOBAL, Git reads the XDG file and then ~/.gitconfig.
  const included =
    env.GIT_CONFIG_GLOBAL !== undefined && env.GIT_CONFIG_GLOBAL !== ''
      ? [env.GIT_CONFIG_GLOBAL]
      : [path.join(xdgHome, 'git', 'config'), path.join(home, '.gitconfig')];
  const dir = mkdtempSync(path.join(os.tmpdir(), 'canopy-test-gitconfig-'));
  const configPath = path.join(dir, 'gitconfig');
  const quoted = (value) =>
    `"${value.replaceAll('\\', '/').replaceAll('"', '\\"')}"`;
  writeFileSync(
    configPath,
    [
      ...included.flatMap((file) => ['[include]', `\tpath = ${quoted(file)}`]),
      // After the includes: Git keeps the last value of a key.
      '[commit]',
      '\tgpgsign = false',
      '[tag]',
      '\tgpgsign = false',
      '',
    ].join('\n'),
  );
  env.GIT_CONFIG_GLOBAL = configPath;
  return () => {
    if (env.GIT_CONFIG_GLOBAL === configPath) {
      if (previous === undefined) delete env.GIT_CONFIG_GLOBAL;
      else env.GIT_CONFIG_GLOBAL = previous;
    }
    rmSync(dir, { recursive: true, force: true });
  };
}

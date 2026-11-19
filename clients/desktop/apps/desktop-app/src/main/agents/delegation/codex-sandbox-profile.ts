import { delegationCommandPrivatePaths } from './native-policy';
import { getAgentSecretAmbientEnvDir } from '../../lib/paths';
import { hostOperatingSystem } from '@canopy/core-platform/host-platform';
import { DARWIN_DELEGATION_SHARED_TEMPORARY_ROOTS } from '@canopy/desktop-shared/node/delegation/command-environment';

/** The shell's profile while it may not write the task's grants. */
export const CODEX_DELEGATION_READ_ONLY_PROFILE = 'delegated_read_only';
/** The read-only profile plus the task's write grants. */
export const CODEX_DELEGATION_WRITE_PROFILE = 'delegated_write';

export type CodexDelegationSandboxProfileName =
  | typeof CODEX_DELEGATION_READ_ONLY_PROFILE
  | typeof CODEX_DELEGATION_WRITE_PROFILE;

type FilesystemAccess = 'read' | 'write' | 'deny';

// A type alias, not an interface, so the profile stays assignable to the
// JSON config of a thread request.
type CodexDelegationSandboxProfile = {
  readonly filesystem: Record<string, FilesystemAccess>;
  readonly network: { readonly enabled: false };
};

interface CodexDelegationSandboxOptions {
  readonly platform?: NodeJS.Platform;
  readonly cwd: string;
  /** Validated absolute write grants; they appear only in the write profile. */
  readonly writePaths?: readonly string[];
  readonly readRoots?: readonly string[];
  readonly gitRoots?: readonly string[];
  readonly gitPrivateRoots?: readonly string[];
  readonly runtimeRoots?: readonly string[];
  readonly toolchainReadRoots?: readonly string[];
  readonly temporaryDirectory?: string;
}

/** Exact private names directly under the working directory. */
const CWD_PRIVATE_NAMES = [
  '.env',
  '.codex',
  '.claude',
  '.ssh',
  '.aws',
  '.npmrc',
  '.netrc',
];

function readOnlyFilesystem(
  options: CodexDelegationSandboxOptions,
): Record<string, FilesystemAccess> {
  const platform = options.platform ?? hostOperatingSystem();
  const gitRoots = options.gitRoots ?? [];
  const entries = (
    paths: readonly string[] | undefined,
    access: FilesystemAccess,
  ): [string, FilesystemAccess][] =>
    (paths ?? []).map((entry) => [entry, access]);
  return {
    // Literal ancestors also cover future files. Explicit task roots below
    // (or equal to) them retain their established authorization semantics.
    ...Object.fromEntries(
      entries(
        platform === 'darwin' ? DARWIN_DELEGATION_SHARED_TEMPORARY_ROOTS : [],
        'deny',
      ),
    ),
    ...Object.fromEntries(
      entries(delegationCommandPrivatePaths(options.cwd, gitRoots), 'deny'),
    ),
    // Every chat's Full-access ambient secrets (agent-secrets/ambient-env.ts).
    [getAgentSecretAmbientEnvDir()]: 'deny',
    ':minimal': 'read',
    [options.cwd]: 'read',
    ...Object.fromEntries(entries(options.readRoots, 'read')),
    ...Object.fromEntries(entries(options.runtimeRoots, 'read')),
    // The tools on the login-shell PATH, so a delegated command can run the
    // same toolchains (Node, package managers, compilers) a Claude child's
    // Bash can. No deny globs sit beneath them: on macOS the sandbox profile
    // grows with deny patterns times read roots, and past the argument limit
    // the delegate cannot start.
    ...Object.fromEntries(
      entries(
        options.toolchainReadRoots?.filter(
          (root) =>
            platform !== 'darwin' ||
            !DARWIN_DELEGATION_SHARED_TEMPORARY_ROOTS.includes(root),
        ),
        'read',
      ),
    ),
    ...Object.fromEntries(
      entries(
        CWD_PRIVATE_NAMES.map((name) => `${options.cwd}/${name}`),
        'deny',
      ),
    ),
    // `delegationCommandPrivatePaths` emits the exact root `.git` deny only
    // when that metadata root was not explicitly validated. Validated
    // metadata roots therefore have one unambiguous exact entry instead of
    // depending on a later read entry overriding a conflicting deny. Nested
    // repositories remain denied above.
    ...Object.fromEntries(entries(gitRoots, 'read')),
    // Repository and selected linked-worktree config inherit the validated
    // metadata roots' read-only grants. Submodule metadata remains excluded
    // because it is outside the validated set.
    ...Object.fromEntries(
      entries(
        gitRoots.flatMap((root) =>
          ['modules', 'modules/**'].map((suffix) => `${root}/${suffix}`),
        ),
        'deny',
      ),
    ),
    // Literal collection roots from the resolver: a `worktrees/*` wildcard
    // does not enforce the macOS sibling boundary.
    ...Object.fromEntries(entries(options.gitPrivateRoots, 'deny')),
    ...(options.temporaryDirectory
      ? { [options.temporaryDirectory]: 'write' }
      : {}),
  };
}

/**
 * The delegated shell's named sandbox profiles. `delegated_read_only` reads
 * the worktree and writes only the private TMPDIR. With write grants,
 * `delegated_write` is the same profile plus each grant as a literal `write`
 * entry: every deny and Git metadata entry is unchanged, and no pattern is
 * added (on macOS each deny pattern expands against every root in the
 * Seatbelt profile, which has an argument-length limit). A grant never
 * replaces a deny or a validated Git metadata entry.
 */
export function buildCodexDelegationPermissionProfiles(
  options: CodexDelegationSandboxOptions,
): Partial<
  Record<CodexDelegationSandboxProfileName, CodexDelegationSandboxProfile>
> {
  const readOnly = readOnlyFilesystem(options);
  const gitRoots = new Set(options.gitRoots ?? []);
  const writes = (options.writePaths ?? []).filter(
    (entry) => readOnly[entry] !== 'deny' && !gitRoots.has(entry),
  );
  const network = { enabled: false } as const;
  return {
    [CODEX_DELEGATION_READ_ONLY_PROFILE]: { filesystem: readOnly, network },
    ...(writes.length
      ? {
          [CODEX_DELEGATION_WRITE_PROFILE]: {
            filesystem: {
              ...readOnly,
              ...Object.fromEntries(
                writes.map((entry): [string, FilesystemAccess] => [
                  entry,
                  'write',
                ]),
              ),
            },
            network,
          },
        }
      : {}),
  };
}

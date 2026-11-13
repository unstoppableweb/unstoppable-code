import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import {
  createPlatformEndpointServices,
  createLinuxColdPathMapper,
  createPlatformServices,
  observeLinuxColdProcesses,
  observeWindowsColdProcesses,
  WindowsColdInspectionError,
  WINDOWS_PROCESS_FILE,
  type NativeColdProcess,
} from '@canopy/core-platform';
import { InternalRootMigrationRefused } from '@canopy/core-runtime/node/internal-root-migration';
import { daemonName, type BrandCore } from '@canopy/protocol/brand';

type NativeOS = 'linux' | 'win32';
type ExecutableBrand = Pick<BrandCore, 'displayName' | 'cliName'>;

function normalize(file: string, os: NativeOS): string {
  if (os === 'linux') return path.posix.normalize(file);
  const dos = file.replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\/, '');
  return path.win32.normalize(dos).replace(/\\$/, '').toLowerCase();
}
function under(file: string, root: string, os: NativeOS): boolean {
  const candidate = normalize(file, os);
  const parent = normalize(root, os);
  const separator = os === 'win32' ? '\\' : '/';
  return (
    candidate === parent ||
    candidate.startsWith(
      parent.endsWith(separator) ? parent : `${parent}${separator}`,
    )
  );
}
async function canonical(file: string, os: NativeOS): Promise<string> {
  const host = os === 'win32' ? path.win32 : path.posix;
  // Node can reject the extended spelling of an existing drive root as UNKNOWN.
  // Only this exact form is equivalent without changing Win32 filename semantics.
  const target =
    os === 'win32' && /^\\\\\?\\[A-Za-z]:\\$/.test(file) ? file.slice(4) : file;
  try {
    return await realpath(target);
  } catch (error) {
    if (
      !(
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'ENOENT'
      ) ||
      host.dirname(target) === target
    )
      throw error;
    return host.join(
      await canonical(host.dirname(target), os),
      host.basename(target),
    );
  }
}

/** Additional conservative hints only. Missing registries never establish absence. */
export async function readInternalRootManagedPids(
  roots: readonly string[],
): Promise<ReadonlySet<number>> {
  const pids = new Set<number>();
  for (const root of roots) {
    for (const name of [
      'claude-process-pids.json',
      'codex-app-server-pids.json',
    ]) {
      const file = path.join(root, name);
      const before = await lstat(file).catch((error: unknown) => {
        if (
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          error.code === 'ENOENT'
        )
          return null;
        throw error;
      });
      if (!before) continue;
      if (
        !before.isFile() ||
        before.isSymbolicLink() ||
        before.nlink !== 1 ||
        before.size > 1024 * 1024
      )
        throw new Error('Unsafe managed process registry');
      const handle = await open(file, 'r');
      let raw: Buffer;
      try {
        const pinned = await handle.stat();
        if (
          pinned.ino !== before.ino ||
          pinned.dev !== before.dev ||
          !pinned.isFile()
        )
          throw new Error('Managed process registry changed');
        raw = await handle.readFile();
        const after = await handle.stat();
        if (
          after.size !== pinned.size ||
          after.mtimeMs !== pinned.mtimeMs ||
          after.ctimeMs !== pinned.ctimeMs
        )
          throw new Error('Managed process registry changed');
      } finally {
        await handle.close();
      }
      if (raw.length > 1024 * 1024)
        throw new Error('Managed process registry inspection incomplete');
      const value: unknown = JSON.parse(raw.toString('utf8'));
      if (
        typeof value !== 'object' ||
        value === null ||
        !('version' in value) ||
        value.version !== 1
      )
        throw new Error('Invalid managed process registry');
      const records: unknown = name.startsWith('claude')
        ? 'processes' in value
          ? value.processes
          : undefined
        : 'pids' in value
          ? value.pids
          : undefined;
      if (!Array.isArray(records) || records.length > 4096)
        throw new Error('Incomplete managed process registry');
      const entries: readonly unknown[] = records;
      for (const record of entries) {
        if (
          name.startsWith('claude') &&
          !(
            typeof record === 'object' &&
            record !== null &&
            'startedAtMs' in record &&
            typeof record.startedAtMs === 'number' &&
            Number.isFinite(record.startedAtMs) &&
            'executable' in record &&
            typeof record.executable === 'string' &&
            record.executable.length > 0
          )
        )
          throw new Error('Invalid managed process record');
        const pid: unknown =
          name.startsWith('claude') &&
          typeof record === 'object' &&
          record !== null &&
          'pid' in record
            ? record.pid
            : record;
        if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid < 2)
          throw new Error('Invalid managed process hint');
        pids.add(pid);
      }
    }
  }
  return pids;
}

/** Policy over complete host evidence, not a substitute process enumerator. */
export async function assertInternalRootNativeCold(options: {
  readonly os: NativeOS;
  readonly rows: readonly NativeColdProcess[];
  readonly roots: readonly string[];
  readonly brands: readonly ExecutableBrand[];
  readonly managedPids: ReadonlySet<number>;
  readonly selfPid?: number;
}): Promise<void> {
  const { os, rows, brands, managedPids } = options;
  const selfPid = options.selfPid ?? process.pid;
  if (
    !brands.length ||
    !options.roots.length ||
    !rows.some((row) => row.pid === selfPid && row.scope === 'same-user') ||
    new Set(rows.map((row) => row.pid)).size !== rows.length
  )
    throw new Error('Incomplete trusted cold evidence');
  const host = os === 'win32' ? path.win32 : path.posix;
  // Image and live-PID policy must win over unrelated path inspection failures.
  for (const row of rows) {
    if (row.scope === 'linux-root-principal' && os !== 'linux')
      throw new Error('Unexpected Linux process scope');
    if (
      (row.scope === 'post-t' && os !== 'win32') ||
      (os === 'win32' &&
        (row.scope === 'exited' || row.scope === 'post-t') &&
        !row.executable)
    )
      throw new Error('Unexpected Windows process scope');
    if (
      os === 'linux' &&
      row.scope === 'exited' &&
      (row.executable !== null || row.paths.length !== 0)
    )
      throw new Error('Unexpected exited process scope');
    if (row.scope !== 'exited' && managedPids.has(row.pid))
      throw new InternalRootMigrationRefused(
        'writer-active',
        `Managed process hint ${row.pid} is live or reused; stop it before retrying.`,
      );
    if (!row.executable) continue; // Exited rows and root-principal residuals have no image.
    const image = normalize(row.executable, os);
    const name = host
      .basename(image)
      .replace(os === 'linux' ? / \(deleted\)$/ : /$^/, '')
      .replace(os === 'win32' ? /\.exe$/ : /$^/, '');
    const crashHelper = [
      'chrome_crashpad_handler',
      'crashpad_handler',
    ].includes(name);
    if (os === 'win32' && crashHelper && !/[\\/]/.test(row.executable))
      throw new Error('Crash helper installation identity is incomplete');
    const brandedHelper = [
      'canopy-file-broker',
      'canopy-dictate',
      'canopy-process-identity',
    ].includes(name);
    if (
      row.pid !== selfPid &&
      (brandedHelper ||
        brands.some((brand) => {
          const names = [
            brand.cliName,
            daemonName(brand),
            `${brand.cliName}-desktop`,
            brand.displayName,
            `${brand.displayName} (Internal)`,
            `${brand.displayName} (RC)`,
          ];
          const brandPathCrashHelper =
            ['chrome_crashpad_handler', 'crashpad_handler'].includes(name) &&
            image
              .split(/[\\/]/)
              .some((part) =>
                [
                  brand.cliName.toLowerCase(),
                  brand.displayName.toLowerCase(),
                  `${brand.displayName} (Internal)`.toLowerCase(),
                  `${brand.displayName} (RC)`.toLowerCase(),
                ].includes(part.toLowerCase()),
              );
          return (
            brandPathCrashHelper ||
            names.some((product) => {
              const candidate =
                os === 'win32' ? product.toLowerCase() : product;
              return (
                name === candidate ||
                (os === 'linux' &&
                  crashHelper &&
                  row.executableDirectoryEntries?.includes(candidate)) ||
                (os === 'win32' && name === `${candidate}.exe`) ||
                name ===
                  `${candidate}${os === 'win32' ? ' helper' : ' Helper'}` ||
                name.startsWith(
                  `${candidate}${os === 'win32' ? ' helper (' : ' Helper ('}`,
                )
              );
            })
          );
        }))
    )
      throw new InternalRootMigrationRefused(
        'writer-active',
        `Product executable ${row.pid} remains; stop the app, CLI, daemon and helpers.`,
      );
    if (
      os === 'linux' &&
      crashHelper &&
      (!image.startsWith('/') ||
        image.endsWith(' (deleted)') ||
        !row.executableDirectoryEntries?.includes(name))
    )
      throw new Error(
        `Crash helper installation identity is incomplete: pid=${row.pid} exe=${JSON.stringify(row.executable)}`,
      );
  }

  async function inspectPath(
    file: string,
    pid = selfPid,
    affectedRoots?: readonly string[],
  ): Promise<string> {
    function unavailable(error: unknown): InternalRootMigrationRefused {
      return new InternalRootMigrationRefused(
        'cold-proof-unavailable',
        `Incomplete ${os} path inspection: pid=${pid} path=${JSON.stringify(file)}: ${error instanceof Error ? error.message : 'unknown failure'}`,
      );
    }
    try {
      return await canonical(file, os);
    } catch (error) {
      if (
        os !== 'win32' ||
        !affectedRoots ||
        !(
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          (error.code === 'EPERM' || error.code === 'EACCES')
        )
      )
        throw unavailable(error);
      // Native names are post-reparse. Unknown short-name suffixes are safe only
      // beneath an accessible canonical ancestor disjoint from every root.
      let ancestor = host.dirname(file);
      const suffix = [host.basename(file)];
      for (let depth = 0; depth < 256; ++depth) {
        let resolved: string | undefined;
        try {
          resolved = await realpath(ancestor);
        } catch (failure) {
          if (
            !(
              typeof failure === 'object' &&
              failure !== null &&
              'code' in failure &&
              ['EPERM', 'EACCES', 'ENOENT'].includes(String(failure.code))
            )
          )
            throw unavailable(failure);
        }
        if (resolved !== undefined) {
          const canonicalAncestor = resolved;
          if (
            affectedRoots.some(
              (root) =>
                under(canonicalAncestor, root, os) ||
                under(root, canonicalAncestor, os),
            )
          )
            throw unavailable(error);
          return host.join(resolved, ...suffix);
        }
        const parent = host.dirname(ancestor);
        if (parent === ancestor) break;
        suffix.unshift(host.basename(ancestor));
        ancestor = parent;
      }
      throw unavailable(error);
    }
  }
  const roots = await Promise.all(
    options.roots.map((root) => inspectPath(root)),
  );
  const snapshotMounts = rows.find(
    (row) => row.pid === selfPid,
  )?.linuxMountInfo;
  let linuxMapper: ReturnType<typeof createLinuxColdPathMapper> | undefined;
  function linuxPaths(
    file: string,
    row?: NativeColdProcess,
    affectedRoot = false,
  ): readonly { readonly device: string; readonly path: string }[] {
    try {
      if (!linuxMapper) {
        if (
          !snapshotMounts ||
          rows.some((entry) => entry.linuxMountInfo !== snapshotMounts)
        )
          throw new Error('Missing or inconsistent Linux mountinfo');
        linuxMapper = createLinuxColdPathMapper(snapshotMounts);
      }
      return affectedRoot ? linuxMapper.affected(file) : [linuxMapper(file)];
    } catch (error) {
      throw new InternalRootMigrationRefused(
        'cold-proof-unavailable',
        `Incomplete Linux path inspection: pid=${row?.pid ?? selfPid} comm=${JSON.stringify(row?.comm ?? null)} path=${JSON.stringify(file)}: ${error instanceof Error ? error.message : 'unknown failure'}`,
      );
    }
  }
  const linuxRoots =
    os === 'linux'
      ? roots.flatMap((root) => linuxPaths(root, undefined, true))
      : [];
  function affectedLinuxIdentity(identity: {
    readonly device: string;
    readonly path: string;
  }): boolean {
    return linuxRoots.some(
      (root) =>
        root.device === identity.device &&
        under(identity.path, root.path, 'linux'),
    );
  }
  function affected(file: string, row?: NativeColdProcess): boolean {
    if (os !== 'linux') return roots.some((root) => under(file, root, os));
    return linuxPaths(file, row).some(affectedLinuxIdentity);
  }
  const script = process.argv[1]
    ? await inspectPath(process.argv[1])
    : undefined;
  if (script && affected(script))
    throw new InternalRootMigrationRefused(
      'writer-active',
      'Run maintenance from a checkout outside the affected trees.',
    );
  for (const row of rows) {
    if (!row.executable) continue;
    if (
      row.scope === 'foreign' ||
      row.scope === 'linux-user-manager' ||
      row.scope === 'linux-root-principal' ||
      row.scope === 'exited'
    )
      continue;
    if (os === 'linux' && row.linuxExecutableRoot && !row.linuxPrivateMountUse)
      throw new InternalRootMigrationRefused(
        'cold-proof-unavailable',
        `Incomplete Linux roots-bound executable evidence: pid=${row.pid}`,
      );
    if (os === 'linux' && row.linuxPrivateMountUse) {
      const evidence = row.linuxPrivateMountUse;
      if (
        evidence.roots.length !== roots.length ||
        roots.some((root) => !evidence.roots.includes(root))
      )
        throw new InternalRootMigrationRefused(
          'cold-proof-unavailable',
          `Incomplete Linux target membership: pid=${row.pid}`,
        );
      if (evidence.affected)
        throw new InternalRootMigrationRefused(
          'writer-active',
          `Process ${row.pid} uses an affected tree (Linux object/mount evidence).`,
        );
    }
    if (
      os === 'linux' &&
      row.linuxMappingCandidates?.some(affectedLinuxIdentity)
    )
      throw new InternalRootMigrationRefused(
        'writer-active',
        `Process ${row.pid} maps an affected tree.`,
      );
    // Self's open coordination files are exempt; its cwd and script are not.
    // windowsUnlinkedFiles and NTFS windowsDeletedMappings are nameless, not paths.
    // Their holding process still passed the mandatory image/live-PID policy above.
    const files =
      (os === 'linux' && row.linuxExecutableRoot) ||
      (row.scope === 'post-t' && !/^(?:[A-Za-z]:\\|\\\\)/.test(row.executable))
        ? row.paths
        : [row.executable, ...row.paths];
    for (const file of files) {
      let resolved: string;
      try {
        resolved =
          os === 'linux' ? file : await inspectPath(file, row.pid, roots);
      } catch (error) {
        if (row.scope === 'post-t') continue;
        throw error;
      }
      if (affected(resolved, row))
        throw new InternalRootMigrationRefused(
          'writer-active',
          `Process ${row.pid} uses an affected tree.`,
        );
    }
  }
}

/** Probe the platform address even when daemon discovery/descriptor files are missing. */
export async function assertInternalRootNativeDaemonStopped(
  root: string,
  os: NativeOS,
): Promise<void> {
  const endpoints = createPlatformEndpointServices(os);
  const target = { dataRoot: root, endpointName: 'core' };
  const result =
    endpoints.semantics === 'first-instance-pipe'
      ? await endpoints.probe(endpoints.address(target))
      : await endpoints.probe(endpoints.address(target));
  if (result.state === 'live')
    throw new InternalRootMigrationRefused(
      'writer-active',
      'The daemon endpoint still accepts connections.',
    );
  if (result.state === 'ambiguous')
    throw new Error('Daemon endpoint inspection incomplete');
}

/** Trusted deployment selection only; no PATH search or fallback to another helper. */
export function internalRootColdHost(
  os: NativeOS,
  location:
    | { readonly kind: 'repository'; readonly root: string }
    | { readonly kind: 'desktop'; readonly resources: string }
    | { readonly kind: 'cli'; readonly executable: string },
): {
  readonly services: ReturnType<typeof createPlatformServices>;
  readonly observe: (
    roots?: readonly string[],
  ) => Promise<readonly NativeColdProcess[]>;
  readonly windowsProcessPath?: string;
} {
  const windowsProcessPath =
    location.kind === 'repository'
      ? path.win32.join(
          location.root,
          '.cache',
          'bin',
          'win32-x64',
          WINDOWS_PROCESS_FILE,
        )
      : location.kind === 'desktop'
        ? path.win32.join(location.resources, 'bin', WINDOWS_PROCESS_FILE)
        : path.win32.join(
            path.win32.dirname(location.executable),
            WINDOWS_PROCESS_FILE,
          );
  const endpoints = createPlatformEndpointServices(os);
  return {
    services: createPlatformServices(
      os,
      endpoints,
      os === 'win32' ? { windowsProcessPath } : {},
    ),
    ...(os === 'win32' ? { windowsProcessPath } : {}),
    observe:
      os === 'win32'
        ? async () => {
            try {
              return await observeWindowsColdProcesses(windowsProcessPath);
            } catch (error) {
              if (error instanceof WindowsColdInspectionError) throw error;
              const detail =
                error instanceof Error
                  ? error.message
                      .slice(0, 1024)
                      .split('')
                      .map((character) =>
                        character.charCodeAt(0) < 32 ||
                        character.charCodeAt(0) === 127
                          ? ' '
                          : character,
                      )
                      .join('')
                  : 'Unknown helper failure';
              throw Object.assign(
                new InternalRootMigrationRefused(
                  'cold-proof-unavailable',
                  `Windows process inspection is incomplete: ${detail}`,
                ),
                { cause: error },
              );
            }
          }
        : (roots) => observeLinuxColdProcesses({ roots }),
  };
}

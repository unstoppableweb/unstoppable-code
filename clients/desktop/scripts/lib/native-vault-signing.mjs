import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, join, resolve, win32 } from 'node:path';
import { NATIVE_VAULT_FILE } from '../../packages/core-platform/src/secret-protection/catalog.ts';
import { readCodeSignEntitlements } from './check-migration-role-package.mjs';
import { getWindowsArtifactSigningOptions } from './windows-artifact-signing.mjs';

/** Builder checks positive suffixes first: a broad .node defeats any exclusion. */
export function windowsNativeSigningExtensions(root, extraResources = []) {
  const names = new Set();
  const visited = new Set();
  function visit(file) {
    if (!existsSync(file)) return;
    const stat = statSync(file);
    if (stat.isDirectory()) {
      const resolved = realpathSync(file);
      if (visited.has(resolved)) return;
      visited.add(resolved);
      for (const name of readdirSync(file)) visit(join(file, name));
    } else if (stat.isFile()) {
      const name = basename(file);
      if (!name.endsWith('.node') || name === NATIVE_VAULT_FILE) return;
      if (NATIVE_VAULT_FILE.endsWith(name))
        throw new Error('Ambiguous native vault signing suffix.');
      names.add(name);
    }
  }
  for (const directory of [
    '.cache/bin/win32-x64',
    '.cache/cli/win32-x64',
    'node_modules',
    'out',
  ])
    visit(resolve(root, directory));
  for (const entry of extraResources) {
    const source = (
      typeof entry === 'string' ? entry : (entry.from ?? '.')
    ).replaceAll('${arch}', 'x64');
    if (typeof entry !== 'string') {
      visit(resolve(root, source));
      continue;
    }
    if (source.startsWith('!')) continue;
    // Builder strings are filters, not literal sources. Scan their static root;
    // a conservative superset cannot override the vault's ambiguity guard.
    const parts = source.replaceAll('\\', '/').split('/');
    const magic = parts.findIndex((part) => /[*?[\]{}()]/.test(part));
    const directory =
      magic === -1
        ? source
        : parts.slice(0, magic).join('/') ||
          (source.startsWith('/') ? '/' : '.');
    visit(resolve(root, directory));
  }
  return ['.exe', '.dll', ...[...names].sort(), `!${NATIVE_VAULT_FILE}`];
}

// Inherited PowerShell 7 module paths break 5.1's Security module autoload.
// Pin both the executable and modules to the admin-owned System32 directory.
export function windowsSignaturePowerShell(env = process.env) {
  const systemRoot = env.SystemRoot ?? env.SYSTEMROOT ?? '';
  if (!/^[A-Za-z]:\\/.test(systemRoot))
    throw new Error('SystemRoot is not absolute.');
  const powerShell = win32.join(
    systemRoot,
    'System32',
    'WindowsPowerShell',
    'v1.0',
  );
  return {
    file: win32.join(powerShell, 'powershell.exe'),
    env: {
      ...Object.fromEntries(
        Object.entries(env).filter(([key]) => !/^psmodulepath$/i.test(key)),
      ),
      PSModulePath: win32.join(powerShell, 'Modules'),
    },
  };
}

/** Finish signing before catalog creation. No downstream hook may re-sign it. */
export async function signNativeVaultBeforePin({ file, root, staging }) {
  if (process.platform === 'darwin') {
    const { createKeychain, findIdentity, removeKeychain } =
      await import('app-builder-lib/out/codeSign/macCodeSign.js');
    const { TmpDir } = await import('builder-util');
    const temporary = new TmpDir();
    let keychainFile;
    try {
      if (staging && process.env.CSC_LINK) {
        ({ keychainFile } = await createKeychain({
          tmpDir: temporary,
          cscLink: process.env.CSC_LINK,
          cscKeyPassword: process.env.CSC_KEY_PASSWORD ?? '',
          currentDir: root,
        }));
      }
      const configured =
        staging && (process.env.CSC_LINK || process.env.CSC_NAME);
      const discover =
        staging && process.env.CSC_IDENTITY_AUTO_DISCOVERY !== 'false';
      const identity =
        configured || discover
          ? await findIdentity(
              'Developer ID Application',
              process.env.CSC_NAME,
              keychainFile,
            )
          : null;
      if (configured && !identity)
        throw new Error('Native vault release signing identity unavailable.');
      execFileSync(
        '/usr/bin/codesign',
        [
          '--force',
          '--sign',
          identity?.hash ?? identity?.name ?? '-',
          '--options',
          'runtime',
          ...(identity ? ['--timestamp'] : ['--timestamp=none']),
          ...(keychainFile ? ['--keychain', keychainFile] : []),
          file,
        ],
        { stdio: 'inherit' },
      );
      execFileSync(
        '/usr/bin/codesign',
        ['--verify', '--strict', '--all-architectures', file],
        { stdio: 'inherit' },
      );
      let firstTeam;
      for (const arch of ['arm64', 'x86_64']) {
        const shown = spawnSync(
          '/usr/bin/codesign',
          ['-d', '--verbose=2', '--arch', arch, file],
          { encoding: 'utf8', timeout: 60_000 },
        );
        const text = `${shown.stdout ?? ''}${shown.stderr ?? ''}`;
        const team = /^TeamIdentifier=(.+)$/m.exec(text)?.[1];
        const flags = /^CodeDirectory .*flags=0x([0-9a-f]+)/m.exec(text)?.[1];
        const adhoc = /^Signature=adhoc$/m.test(text);
        if (
          shown.error ||
          shown.status !== 0 ||
          !team ||
          (identity
            ? team === 'not set' || adhoc
            : team !== 'not set' || !adhoc) ||
          (Number.parseInt(flags ?? '0', 16) & 0x10000) === 0 ||
          (firstTeam && team !== firstTeam) ||
          Object.keys(readCodeSignEntitlements(file, arch)).length !== 0
        )
          throw new Error(
            'Native vault signing properties failed before pinning.',
          );
        firstTeam = team;
      }
    } finally {
      if (keychainFile) await removeKeychain(keychainFile);
      await temporary.cleanup();
    }
  } else if (process.platform === 'win32' && staging) {
    const azureSignOptions = getWindowsArtifactSigningOptions();
    if (!azureSignOptions) return; // Unsigned development packaging is still byte-pinned.
    const { WindowsSignAzureManager } =
      await import('app-builder-lib/out/codeSign/windowsSignAzureManager.js');
    const { VmManager } = await import('app-builder-lib/out/vm/vm.js');
    const manager = new WindowsSignAzureManager({
      platformSpecificBuildOptions: { azureSignOptions },
      vm: { value: Promise.resolve(new VmManager()) },
    });
    await manager.initialize();
    await manager.signFile({ path: file, options: { azureSignOptions } });
    const powerShell = windowsSignaturePowerShell();
    execFileSync(
      powerShell.file,
      [
        '-NoProfile',
        '-NonInteractive',
        '-File',
        join(root, 'scripts/verify-windows-signatures.ps1'),
        '-Paths',
        file,
        '-PublisherName',
        azureSignOptions.publisherName,
      ],
      { stdio: 'inherit', env: powerShell.env },
    );
  }
}

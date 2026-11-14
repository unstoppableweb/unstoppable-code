import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

// Keep these options aligned with the resolved Electron package's install.js.
// Its own downloader retains mirror/proxy environment and cache/checksum policy.
export async function downloadElectronArtifact(
  electronPackageJsonPath,
  {
    env = process.env,
    hostPlatform = process.platform,
    hostArch = process.arch,
    spawn = spawnSync,
    downloadArtifact,
  } = {},
) {
  const electronRequire = createRequire(electronPackageJsonPath);
  const { version } = JSON.parse(readFileSync(electronPackageJsonPath, 'utf8'));
  const platform =
    env.ELECTRON_INSTALL_PLATFORM || env.npm_config_platform || hostPlatform;
  let arch = env.ELECTRON_INSTALL_ARCH || env.npm_config_arch || hostArch;
  if (
    platform === 'darwin' &&
    hostPlatform === 'darwin' &&
    arch === 'x64' &&
    env.npm_config_arch === undefined
  ) {
    try {
      const result = spawn('sysctl', ['-in', 'sysctl.proc_translated'], {
        env,
        encoding: 'utf8',
      });
      if (!result.error && result.status === 0 && result.stdout.trim() === '1')
        arch = 'arm64';
    } catch {
      // Match install.js: failed Rosetta detection retains the requested arch.
    }
  }
  const downloader =
    downloadArtifact ??
    (await import(pathToFileURL(electronRequire.resolve('@electron/get')).href))
      .downloadArtifact;
  return downloader({
    version,
    artifactName: 'electron',
    force: env.force_no_cache === 'true',
    cacheRoot: env.electron_config_cache,
    checksums:
      env.electron_use_remote_checksums ||
      env.npm_config_electron_use_remote_checksums
        ? undefined
        : electronRequire('./checksums.json'),
    platform,
    arch,
  });
}

if (import.meta.main) {
  // Reserve stdout for exactly one structured result, even if a dependency logs.
  console.log = console.error;
  try {
    const archivePath = await downloadElectronArtifact(process.argv[2]);
    process.stdout.write(JSON.stringify({ archivePath }));
  } catch (error) {
    console.error(error.stack ?? error.message);
    process.exitCode = 1;
  }
}

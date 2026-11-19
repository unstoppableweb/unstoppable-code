// Golden: the Antigravity manifest in the root package.json is the single
// source of the managed runtime's url, hashes and version, pinned to
// ANTIGRAVITY_RUNTIME_VERSION.
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getAntigravityRuntimeRootDir } from '@canopy/execution-engine/pipelines/config-paths';
import {
  ANTIGRAVITY_MANAGED_EXECUTABLE_NAME,
  getAntigravityRuntimeArtifact,
  managedAntigravityExecutable,
} from '../runtime-artifacts';
import { ANTIGRAVITY_RUNTIME_VERSION } from '../runtime-metadata';

const BASE =
  'https://github.com/google-antigravity/antigravity-cli/releases/download/1.5.1';

describe('Antigravity runtime artifacts', () => {
  it('manifest version equals ANTIGRAVITY_RUNTIME_VERSION', () => {
    expect(getAntigravityRuntimeArtifact('darwin', 'arm64')?.version).toBe(
      ANTIGRAVITY_RUNTIME_VERSION,
    );
    expect(getAntigravityRuntimeArtifact('darwin', 'x64')?.version).toBe(
      ANTIGRAVITY_RUNTIME_VERSION,
    );
  });

  it('returns the darwin-arm64 artifact with the pinned url, integrity, archiveBytes and executableSha256', () => {
    expect(getAntigravityRuntimeArtifact('darwin', 'arm64')).toEqual({
      version: '1.5.1',
      url: `${BASE}/agy_cli_mac_arm64.tar.gz`,
      integrity:
        'sha512-B4OZs5LDv85wvF2fsaRHpLCiomvUDDYUj0lEAouPIeNYiQ1bm+3N5pKWZ3sdosAmtOKDrpGII0KcE7kd3LkTzg==',
      archiveBytes: 63804999,
      executableSha256:
        '5ce7fbe126eb9abdc78634332a0a1bdd428327fba37ef7d1aeba7553eec55f3f',
    });
  });

  it('returns the darwin-x64 artifact', () => {
    expect(getAntigravityRuntimeArtifact('darwin', 'x64')).toEqual({
      version: '1.5.1',
      url: `${BASE}/agy_cli_mac_x64.tar.gz`,
      integrity:
        'sha512-c2oPEhC0LtxuwpLh+EOGlvYWv2kGrV6HjUFbGKpTrMxZpnggXDMuWvVk+rjTLKWsW0HJuq2M7Qp7wiSgzPzDtQ==',
      archiveBytes: 69355865,
      executableSha256:
        '1f72c9a1c29b768fedd6d33150ebe5baa0f0692242c6286bd1669a1d183ec2d9',
    });
  });

  it('returns undefined for win32 and linux', () => {
    expect(getAntigravityRuntimeArtifact('win32', 'x64')).toBeUndefined();
    expect(getAntigravityRuntimeArtifact('linux', 'arm64')).toBeUndefined();
    expect(getAntigravityRuntimeArtifact('darwin', 'ia32')).toBeUndefined();
  });

  it('managedAntigravityExecutable returns the versioned path when present', () => {
    const root = mkdtempSync(join(tmpdir(), 'agy-root-'));
    const artifact = getAntigravityRuntimeArtifact('darwin', 'arm64');
    if (!artifact) throw new Error('missing artifact');
    mkdirSync(join(root, '1.5.1'), { recursive: true });
    writeFileSync(join(root, '1.5.1', 'antigravity'), '');
    expect(ANTIGRAVITY_MANAGED_EXECUTABLE_NAME).toBe('antigravity');
    expect(managedAntigravityExecutable(root, artifact)).toBe(
      join(root, '1.5.1', 'antigravity'),
    );
  });

  it('getAntigravityRuntimeRootDir ends with antigravity-runtime under the data dir', () => {
    expect(getAntigravityRuntimeRootDir().endsWith('antigravity-runtime')).toBe(
      true,
    );
  });
});

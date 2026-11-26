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
  isAntigravityPlatformSupported,
  managedAntigravityExecutable,
} from '../runtime-artifacts';
import { ANTIGRAVITY_RUNTIME_VERSION } from '../runtime-metadata';

const BASE =
  'https://github.com/google-antigravity/antigravity-cli/releases/download/1.5.14';

describe('Antigravity runtime artifacts', () => {
  it('manifest version equals ANTIGRAVITY_RUNTIME_VERSION', () => {
    expect(getAntigravityRuntimeArtifact('darwin', 'arm64')?.version).toBe(
      ANTIGRAVITY_RUNTIME_VERSION,
    );
    expect(getAntigravityRuntimeArtifact('darwin', 'x64')?.version).toBe(
      ANTIGRAVITY_RUNTIME_VERSION,
    );
    expect(getAntigravityRuntimeArtifact('linux', 'x64')?.version).toBe(
      ANTIGRAVITY_RUNTIME_VERSION,
    );
    expect(getAntigravityRuntimeArtifact('linux', 'arm64')?.version).toBe(
      ANTIGRAVITY_RUNTIME_VERSION,
    );
  });

  it('returns the darwin-arm64 artifact with the pinned url, integrity, archiveBytes and executableSha256', () => {
    expect(getAntigravityRuntimeArtifact('darwin', 'arm64')).toEqual({
      version: '1.5.14',
      url: `${BASE}/agy_cli_mac_arm64.tar.gz`,
      integrity:
        'sha512-JoMP1Gv7kgDQc88+cb+UtwdVJVe0OA7AGv1umfOisDDmVCLasYZ/dzGAeGkt78hZp1R9F+xLCx6TafE8nDyupg==',
      archiveBytes: 85943943,
      executableSha256:
        'e8c2959bf4744580d0e5b8f938ec2dc3918a942b620a6262e53856400f14e5fb',
    });
  });

  it('returns the darwin-x64 artifact', () => {
    expect(getAntigravityRuntimeArtifact('darwin', 'x64')).toEqual({
      version: '1.5.14',
      url: `${BASE}/agy_cli_mac_x64.tar.gz`,
      integrity:
        'sha512-G2ofxtvka6bZ0EBdG2CVGJ816/xMPDPOsf0bbQyf1wK1KsELZLi1Ku0NjXGuAsXfPP/V4+PTdUnC2v/M4qhTxw==',
      archiveBytes: 91613810,
      executableSha256:
        '5f3832bb8e391820bb895a08d1f837bb9e1714d48cd5ba31edf9286af6e9ea21',
    });
  });

  // CAN-6718: Linux has no OS signature to check, so its launch check
  // compares the executable with these digests. They are Google's glibc
  // builds from the same 1.5.14 GitHub release.
  it('returns the linux-x64 artifact', () => {
    expect(getAntigravityRuntimeArtifact('linux', 'x64')).toEqual({
      version: '1.5.14',
      url: `${BASE}/agy_cli_linux_x64.tar.gz`,
      integrity:
        'sha512-gzEdPzVFZ2EtwWwa4uqbUD1vaDOqThONOaoinaPzu5mw5NfMoLzkeWsAYNalHYET63RJ7V3A55AL8hcQfqW/+Q==',
      archiveBytes: 101195950,
      executableSha256:
        '37873b8062391b6202a3d3199ec012abc9e53aab720d26cd65699441497d8c94',
    });
  });

  it('returns the linux-arm64 artifact', () => {
    expect(getAntigravityRuntimeArtifact('linux', 'arm64')).toEqual({
      version: '1.5.14',
      url: `${BASE}/agy_cli_linux_arm64.tar.gz`,
      integrity:
        'sha512-ybKbukdfY6GoAWGuk7pysiHHpYbZhR5NAGFUZwS6tm1rJ2CyXXFtGRck/HVk8yRkVu4VHiiqN69I281yvcbEYw==',
      archiveBytes: 92116379,
      executableSha256:
        '702b888abddc7d482ee30592fa153cda5785afae3188179d38b511b6ec360286',
    });
  });

  it('returns undefined for win32 and unpinned architectures', () => {
    expect(getAntigravityRuntimeArtifact('win32', 'x64')).toBeUndefined();
    expect(getAntigravityRuntimeArtifact('win32', 'arm64')).toBeUndefined();
    expect(getAntigravityRuntimeArtifact('linux', 'ia32')).toBeUndefined();
    expect(getAntigravityRuntimeArtifact('linux', 'arm')).toBeUndefined();
    expect(getAntigravityRuntimeArtifact('darwin', 'ia32')).toBeUndefined();
  });

  it('supports exactly the hosts with a pinned artifact', () => {
    expect(isAntigravityPlatformSupported('darwin', 'arm64')).toBe(true);
    expect(isAntigravityPlatformSupported('darwin', 'x64')).toBe(true);
    expect(isAntigravityPlatformSupported('linux', 'x64')).toBe(true);
    expect(isAntigravityPlatformSupported('linux', 'arm64')).toBe(true);
    expect(isAntigravityPlatformSupported('win32', 'x64')).toBe(false);
    expect(isAntigravityPlatformSupported('win32', 'arm64')).toBe(false);
    expect(isAntigravityPlatformSupported('linux', 'arm')).toBe(false);
  });

  it('managedAntigravityExecutable returns the versioned path when present', () => {
    const root = mkdtempSync(join(tmpdir(), 'agy-root-'));
    const artifact = getAntigravityRuntimeArtifact('darwin', 'arm64');
    if (!artifact) throw new Error('missing artifact');
    mkdirSync(join(root, '1.5.14'), { recursive: true });
    writeFileSync(join(root, '1.5.14', 'antigravity'), '');
    expect(ANTIGRAVITY_MANAGED_EXECUTABLE_NAME).toBe('antigravity');
    expect(managedAntigravityExecutable(root, artifact)).toBe(
      join(root, '1.5.14', 'antigravity'),
    );
  });

  it('getAntigravityRuntimeRootDir ends with antigravity-runtime under the data dir', () => {
    expect(getAntigravityRuntimeRootDir().endsWith('antigravity-runtime')).toBe(
      true,
    );
  });
});

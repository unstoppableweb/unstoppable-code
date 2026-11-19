export const PRODUCTION_BINARY_TARGETS = Object.freeze([
  'darwin-arm64',
  'darwin-x64',
  'win32-x64',
  'linux-x64',
  'linux-arm64',
]);

// Explicit VM build labelling only; product target availability is unconditional.
export function isLinuxArm64DevelopmentEnabled(env = process.env) {
  return env.CANOPY_ENABLE_LINUX_ARM64_DEVELOPMENT === '1';
}

export function assertReleaseTargetAllowed(target, env = process.env) {
  if (
    isLinuxArm64DevelopmentEnabled(env) ||
    env.CANOPY_LINUX_ARM64_DEVELOPMENT_BUILD === '1'
  ) {
    throw new Error(
      'VM development build labelling cannot be used for a product release.',
    );
  }
  if (target !== undefined && !PRODUCTION_BINARY_TARGETS.includes(target)) {
    throw new Error(`Unsupported release target: ${target}`);
  }
}

export function getHostTarget(binaryLabel, options = {}) {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;

  if (platform === 'darwin') {
    if (arch !== 'arm64' && arch !== 'x64') {
      throw new Error(
        `Unsupported ${binaryLabel} binary architecture: ${arch}`,
      );
    }
    return `darwin-${arch}`;
  }

  if (platform === 'win32') {
    if (arch !== 'x64') {
      throw new Error(
        `Unsupported ${binaryLabel} binary architecture: ${arch}; Windows ARM64 staging is not enabled until all bundled tools publish ARM64 Windows binaries.`,
      );
    }
    return 'win32-x64';
  }

  if (platform === 'linux') {
    if (arch === 'x64' || arch === 'arm64') {
      return `linux-${arch}`;
    }
    throw new Error(
      `Unsupported ${binaryLabel} binary architecture: ${arch}; Linux host staging supports x64 and arm64.`,
    );
  }

  throw new Error(`Unsupported ${binaryLabel} binary platform: ${platform}`);
}

export const CLAUDE_TARGETS = new Set([
  'darwin-arm64',
  'darwin-x64',
  'win32-x64',
  'linux-x64',
  'linux-arm64',
]);

export const CODEX_ASSET_SUFFIXES = Object.freeze({
  'darwin-arm64': 'aarch64-apple-darwin',
  'darwin-x64': 'x86_64-apple-darwin',
  'win32-x64': 'x86_64-pc-windows-msvc.exe',
  'linux-x64': 'x86_64-unknown-linux-musl',
  'linux-arm64': 'aarch64-unknown-linux-musl',
});

export const GH_ASSETS = Object.freeze({
  'darwin-arm64': { platform: 'macOS_arm64', extension: 'zip' },
  'darwin-x64': { platform: 'macOS_amd64', extension: 'zip' },
  'win32-x64': { platform: 'windows_amd64', extension: 'zip' },
  'linux-x64': { platform: 'linux_amd64', extension: 'tar.gz' },
  'linux-arm64': { platform: 'linux_arm64', extension: 'tar.gz' },
});

export const RG_ASSET_SUFFIXES = Object.freeze({
  'darwin-arm64': 'aarch64-apple-darwin',
  'darwin-x64': 'x86_64-apple-darwin',
  'win32-x64': 'x86_64-pc-windows-msvc',
  'linux-x64': 'x86_64-unknown-linux-musl',
  'linux-arm64': 'aarch64-unknown-linux-musl',
});

export const RTK_ASSETS = Object.freeze({
  'darwin-arm64': 'rtk-aarch64-apple-darwin.tar.gz',
  'darwin-x64': 'rtk-x86_64-apple-darwin.tar.gz',
  'win32-x64': 'rtk-x86_64-pc-windows-msvc.zip',
  'linux-x64': 'rtk-x86_64-unknown-linux-musl.tar.gz',
  'linux-arm64': 'rtk-aarch64-unknown-linux-gnu.tar.gz',
});

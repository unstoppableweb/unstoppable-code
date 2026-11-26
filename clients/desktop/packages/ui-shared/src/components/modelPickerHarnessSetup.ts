import { getModelCatalogProviderLabel } from '@canopy/protocol/models';

/** Harnesses whose models need a runtime the computer installs. */
export type ModelPickerManagedHarness =
  | 'antigravity'
  | 'cursor'
  | 'copilot'
  | 'opencode';

/**
 * Why a managed harness can't run models where the picker would send them.
 * Matches `RemoteControlProviderSetupState` without its `ready` and
 * `flag_off` states: a ready harness needs no reason, and an unreleased one
 * is not shown.
 */
export type ModelPickerHarnessSetupState =
  | 'unsupported_host'
  | 'not_installed'
  | 'disabled'
  | 'signed_out'
  | 'unavailable';

/**
 * Where the harness would run:
 * - `paired`: the computer a web or remote picker controls.
 * - `local`: the computer whose app shows the picker (which may itself be
 *   controlled from another computer); `platformName` names its operating
 *   system, as only that computer's support is in question.
 */
export type ModelPickerHarnessHost =
  | { readonly kind: 'paired' }
  | { readonly kind: 'local'; readonly platformName?: string };

/**
 * The sentence a picker shows for a harness that has no runnable models,
 * in place of a connect prompt. One source for the desktop and web pickers.
 */
export function modelPickerHarnessSetupReason(
  harness: ModelPickerManagedHarness,
  state: ModelPickerHarnessSetupState,
  host: ModelPickerHarnessHost,
): string {
  const label = getModelCatalogProviderLabel(harness);
  const there = host.kind === 'paired' ? ' on the paired computer' : '';
  switch (state) {
    case 'unsupported_host':
      return host.kind === 'paired'
        ? `${label} isn't available for the paired computer's operating system yet.`
        : `${label} isn't available on ${host.platformName ?? 'this operating system'} yet.`;
    case 'not_installed':
      return harness === 'antigravity'
        ? `Install the Antigravity CLI in Settings${there}.`
        : `Connect ${label} in Settings${there}.`;
    case 'disabled':
      return harness === 'antigravity'
        ? `Turn on Antigravity in Settings${there}.`
        : `Connect ${label} in Settings${there}.`;
    case 'signed_out':
      return `Sign in to ${label}${there}.`;
    case 'unavailable':
      return harness === 'antigravity'
        ? `Connect your personal Google account${there}.`
        : `Connect ${label}${there} to use it here.`;
  }
}

/** A display name for a Node or Electron `process.platform` value. */
export function modelPickerPlatformName(platform: string): string | undefined {
  if (platform === 'darwin') return 'macOS';
  if (platform === 'win32') return 'Windows';
  if (platform === 'linux') return 'Linux';
  return undefined;
}

import type { DesktopBrandRuntime } from '@canopy/protocol/brand';

export function linuxUpdateCopy(
  brand: Pick<DesktopBrandRuntime, 'displayName'> &
    Partial<Pick<DesktopBrandRuntime, 'id' | 'cliName'>>,
  flavor?: string,
): {
  apt: { command: string; introduction: string } | null;
  downloadLabel: string;
  downloadTooltip: string;
  manual: string;
  unsupported: string;
  unavailable: string;
  authentication: string;
  verification: string;
  packageManager: string;
  packageManagerVersion: string;
  relaunchBlockedByEdits: string;
  relaunchFirst: string;
  relaunchWaitForPackage: string;
  relaunchWaitForTerminal: string;
  openInTerminal: string;
  openInTerminalUnavailable: string;
  terminalTitle: string;
  installed: {
    label: string;
    title: string;
    status: (version: string) => string;
    relaunchNow: string;
    relaunchWhenIdle: string;
    queued: string;
  };
} {
  // Keep this browser-safe policy aligned with the public APT build contract.
  // Missing brand identity/flavor retains the original manual-download API.
  const apt =
    brand.id === 'unstoppable-code' && flavor === 'stable' && brand.cliName
      ? {
          command: `sudo apt update && sudo apt install --only-upgrade ${brand.cliName}-desktop`,
          introduction: `Update ${brand.displayName} with APT. Run in your terminal:`,
        }
      : null;
  return {
    apt,
    downloadLabel: apt ? 'Reinstall Linux package' : 'Download Linux update',
    // Sidebar tooltip only; the full verification guidance and checksum stay
    // in Settings, where there is room for them.
    downloadTooltip: 'Opens the official release site',
    manual: apt
      ? `${apt.introduction} ${apt.command}.`
      : `Linux updates must be installed manually. Download ${brand.displayName} from the official site and verify its published checksum before installing with your package manager.`,
    unsupported: `Linux update checks need ${brand.displayName} installed from its official .deb package (x64 or arm64) or pacman package (x64). Other installs and architectures are not supported.`,
    unavailable: `${brand.displayName} Linux updates are unavailable. Check your connection and try again. A verified .deb release for this architecture may not be published for this channel yet.`,
    authentication: `Connect GitHub in Settings > Account to check internal or RC Linux releases of ${brand.displayName}.`,
    verification: apt
      ? 'For the reinstall fallback, download the official Linux .deb matching your installed architecture. Verify its published checksum before installing with your package manager. The app never installs updates or requests administrator access.'
      : 'Download the Linux .deb matching your installed architecture from the official site. Verify its published checksum before installing with your package manager. The app never installs updates or requests administrator access.',
    packageManager: 'Update with your package manager:',
    packageManagerVersion:
      'Your package manager installs the newest published version. Specific versions are not available here.',
    relaunchBlockedByEdits:
      'Save or discard your workflow edits, then relaunch.',
    relaunchFirst: 'Relaunch to finish the installed update first.',
    // Package settlement can lag terminal completion, including external updates.
    relaunchWaitForPackage:
      'Wait for the package update to finish, then relaunch.',
    relaunchWaitForTerminal:
      'Wait for the update in the terminal to finish, or close that terminal, then relaunch.',
    openInTerminal: 'Open in terminal',
    openInTerminalUnavailable:
      'Open a local project to use the built-in terminal, or copy the command.',
    terminalTitle: `Update ${brand.displayName}`,
    installed: {
      label: 'Relaunch to finish',
      title: 'Update installed, relaunch to finish.',
      status: (version: string): string =>
        `Version ${version} is installed. Relaunch to finish.`,
      relaunchNow: 'Relaunch now',
      relaunchWhenIdle: 'Relaunch when idle',
      queued: 'This update will relaunch when all agents are idle.',
    },
  };
}

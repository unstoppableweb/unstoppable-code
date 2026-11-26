import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { BRAND } from '@canopy/brand/current';
import { hostPlatformOperatingSystem } from '@canopy/core-platform';
import { linuxUpdateCopy } from '@canopy/desktop-shared/lib/linux-update-copy';
import { getCanopyReleaseFlavor } from '../lib/app-identity';
import { detectLinuxInstallSource } from './linux-manual-update';

const UPDATE_MANAGER_PATH = '/usr/bin/update-manager';
const DESKTOP_SESSION_VARIABLES = [
  'DISPLAY',
  'XAUTHORITY',
  'WAYLAND_DISPLAY',
  'XDG_RUNTIME_DIR',
  'DBUS_SESSION_BUS_ADDRESS',
  'XDG_CURRENT_DESKTOP',
  'XDG_SESSION_TYPE',
  'XDG_DATA_DIRS',
  'HOME',
  'USER',
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'XMODIFIERS',
  'GTK_IM_MODULE',
];

function desktopSessionEnvironment(): NodeJS.ProcessEnv {
  // Only pass the desktop session variables, not the app's runtime environment.
  const env: NodeJS.ProcessEnv = { PATH: '/usr/sbin:/usr/bin:/sbin:/bin' };
  for (const name of DESKTOP_SESSION_VARIABLES) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

export async function systemUpdaterAvailable(): Promise<boolean> {
  try {
    if (hostPlatformOperatingSystem() !== 'linux') return false;
    if (!linuxUpdateCopy(BRAND, getCanopyReleaseFlavor()).apt) return false;
    if ((await detectLinuxInstallSource()).kind !== 'deb') return false;
    if (!(await stat(UPDATE_MANAGER_PATH)).isFile()) return false;
    await access(UPDATE_MANAGER_PATH, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** "Opened" means the process started, not that its GTK window connected. */
export async function openLinuxSystemUpdater(): Promise<{ opened: boolean }> {
  if (!(await systemUpdaterAvailable())) return { opened: false };

  return new Promise((resolve) => {
    try {
      const child = spawn(UPDATE_MANAGER_PATH, [], {
        detached: true,
        stdio: 'ignore',
        env: desktopSessionEnvironment(),
      });
      child.once('error', () => resolve({ opened: false }));
      child.once('spawn', () => {
        child.unref();
        resolve({ opened: true });
      });
    } catch {
      resolve({ opened: false });
    }
  });
}

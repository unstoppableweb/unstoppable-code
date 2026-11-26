import { execFile, spawn } from 'node:child_process';
import { posix, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostOperatingSystem } from '@canopy/core-platform/host-platform';
import { app, shell, type HandlerDetails } from 'electron';
import { isE2eBuild } from './e2e-gate';
import { getE2eExternalOpenCaptureUrl } from './e2e-mock-control-plane';
import { logMainProcessError } from './main-process-logging';

const LOOP_GUARD_TTL_MS = 10_000;

/**
 * Whether a window open came from ⌘+click (Ctrl+click on Windows and Linux),
 * which Chromium reports as a background tab. Such links skip the built-in
 * browser setting and open in the system browser (CAN-6378).
 */
export function isOpenExternallyClick(
  details: Pick<HandlerDetails, 'disposition'>,
): boolean {
  return details.disposition === 'background-tab';
}
const externalOpenLoopGuards = new Map<
  string,
  {
    count: number;
    expiresAt: number;
    fallbackInFlight?: Promise<boolean>;
  }
>();

function externalOpenLoopGuardKey(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    return parsed.href;
  } catch {
    return null;
  }
}

/**
 * Consumes one matching URL recently handed to the OS. When this app owns the
 * HTTP(S) default, the OS can immediately launch it back into us; consuming
 * that echo prevents an external-fallback loop.
 */
export function consumeExternalOpenLoopGuard(
  url: string,
): Promise<boolean | null> {
  const key = externalOpenLoopGuardKey(url);
  if (!key) return Promise.resolve(null);
  const guard = externalOpenLoopGuards.get(key);
  if (!guard) return Promise.resolve(null);
  if (guard.expiresAt < Date.now()) {
    externalOpenLoopGuards.delete(key);
    return Promise.resolve(null);
  }
  if (guard.fallbackInFlight) return guard.fallbackInFlight;
  // `shell.openExternal(httpUrl)` resolves through the current OS protocol
  // handler. If that handler is us, consuming the echo alone would make the
  // user's explicit external-open action disappear. Hand the echo to a
  // platform browser through a route that cannot resolve back to our HTTP(S)
  // registration.
  const fallback = openExternalLoopFallback(url)
    .then(() => {
      if (externalOpenLoopGuards.get(key) === guard) {
        if (guard.count <= 1) {
          externalOpenLoopGuards.delete(key);
        } else {
          guard.count -= 1;
        }
      }
      return true;
    })
    .catch(() => false)
    .finally(() => {
      if (
        externalOpenLoopGuards.get(key) === guard &&
        guard.fallbackInFlight === fallback
      ) {
        delete guard.fallbackInFlight;
      }
    });
  guard.fallbackInFlight = fallback;
  return fallback;
}

export function markExternalOpenLoopGuard(url: string): (() => void) | null {
  const key = externalOpenLoopGuardKey(url);
  if (!key) return null;
  const current = externalOpenLoopGuards.get(key);
  const nextGuard = {
    count: (current?.count ?? 0) + 1,
    expiresAt: Date.now() + LOOP_GUARD_TTL_MS,
  };
  externalOpenLoopGuards.set(key, nextGuard);
  const expiryTimer = setTimeout(() => {
    if (externalOpenLoopGuards.get(key) === nextGuard) {
      externalOpenLoopGuards.delete(key);
    }
  }, LOOP_GUARD_TTL_MS);
  expiryTimer.unref();
  return (): void => {
    if (externalOpenLoopGuards.get(key) !== nextGuard) return;
    if (nextGuard.count <= 1) {
      externalOpenLoopGuards.delete(key);
    } else {
      nextGuard.count -= 1;
    }
  };
}

function openExternalLoopFallback(url: string): Promise<void> {
  if (process.platform === 'darwin') {
    return new Promise<void>((resolve, reject) => {
      execFile(
        '/usr/bin/open',
        ['-b', 'com.apple.Safari', url],
        (error): void => {
          if (error) {
            reject(
              error instanceof Error
                ? error
                : new Error('Could not open the URL in Safari.'),
            );
          } else resolve();
        },
      );
    });
  }
  if (process.platform === 'win32') {
    return shell.openExternal(`microsoft-edge:${url}`);
  }
  return Promise.reject(
    new Error('No non-recursive external browser fallback is available.'),
  );
}

/**
 * UI-automation/E2E builds suppress the real browser/system handler and can
 * optionally send the target to a local test capture endpoint on a
 * best-effort basis. Returns `null` in production builds, where the caller
 * opens the target itself.
 */
function captureE2eExternalOpen(url: string): Promise<void> | null {
  if (!isE2eBuild()) return null;
  const captureUrl = getE2eExternalOpenCaptureUrl();
  if (!captureUrl) {
    return Promise.resolve();
  }
  return fetch(captureUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  })
    .then((response) => {
      if (!response.ok) {
        throw new Error(
          `E2E external-open capture responded ${String(response.status)}`,
        );
      }
    })
    .catch(() => undefined);
}

/**
 * Open an external target, unless running under the UI-automation/E2E build.
 * Build-gated via `__CANOPY_E2E__`, so production always opens it normally.
 */
export function openExternalGuarded(url: string): Promise<void> {
  const capture = captureE2eExternalOpen(url);
  if (capture) return capture;
  const rollbackLoopGuard = markExternalOpenLoopGuard(url);
  return shell.openExternal(url).catch((error: unknown) => {
    rollbackLoopGuard?.();
    throw error;
  });
}

const NO_DEFAULT_WEB_BROWSER_MESSAGE =
  "Couldn't find a default web browser to open this file.";
// Resolve the http(s) handler rather than the file type's handler, which may
// be an editor or preview app. Same probe shape as default-browser
// registration.
const DEFAULT_WEB_BROWSER_PROBE_URL = 'https://canopy-default-check.invalid';
const EDGE_PROTOCOL_PROBE_URL = 'microsoft-edge://canopy-default-check.invalid';

function noDefaultWebBrowserError(): Error {
  return new Error(NO_DEFAULT_WEB_BROWSER_MESSAGE);
}

async function resolveApplicationPath(probeUrl: string): Promise<string> {
  const { path: applicationPath } =
    await app.getApplicationInfoForProtocol(probeUrl);
  if (applicationPath.trim() === '') throw noDefaultWebBrowserError();
  return applicationPath;
}

/**
 * Whether a macOS handler path is the bundle containing this app (packaged or
 * the dev `Electron.app`).
 */
function isOwnMacApplicationPath(handlerPath: string): boolean {
  return process.execPath.startsWith(posix.resolve(handlerPath) + posix.sep);
}

/** Whether a Windows handler path is this app's running executable. */
function isOwnWindowsApplicationPath(handlerPath: string): boolean {
  return (
    win32.normalize(handlerPath).toLocaleLowerCase('en-US') ===
    win32.normalize(process.execPath).toLocaleLowerCase('en-US')
  );
}

function runMacOpen(args: string[]): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    execFile('/usr/bin/open', args, (error): void => {
      if (error) {
        reject(
          error instanceof Error ? error : new Error('Could not run open.'),
        );
      } else resolve();
    });
  });
}

function spawnWindowsBrowser(exePath: string, href: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    // No `windowsHide`: it sets SW_HIDE, which can hide a cold-started
    // browser's first window. A GUI executable opens no console anyway.
    const child = spawn(exePath, [href], { detached: true, stdio: 'ignore' });
    child.once('spawn', () => resolve());
    child.once('error', reject);
    child.unref();
  });
}

async function openFileInMacWebBrowser(fileUrl: URL): Promise<void> {
  // `open -a` names the application, bypassing the file-type association. The
  // absolute path starts with `/`, so it cannot be read as a flag. Passing a
  // path drops the URL's query and fragment; Windows keeps them.
  const absolutePath = fileURLToPath(fileUrl);
  const browserAppPath = await resolveApplicationPath(
    DEFAULT_WEB_BROWSER_PROBE_URL,
  );
  if (
    app.isDefaultProtocolClient('https') ||
    isOwnMacApplicationPath(browserAppPath)
  ) {
    await runMacOpen(['-b', 'com.apple.Safari', absolutePath]);
    return;
  }
  await runMacOpen(['-a', browserAppPath, absolutePath]);
}

async function openFileInWindowsWebBrowser(href: string): Promise<void> {
  // `isDefaultProtocolClient` is unreliable on Windows, so compare the
  // resolved handler with our executable instead.
  const browserExePath = await resolveApplicationPath(
    DEFAULT_WEB_BROWSER_PROBE_URL,
  );
  if (!isOwnWindowsApplicationPath(browserExePath)) {
    await spawnWindowsBrowser(browserExePath, href);
    return;
  }
  const edgeExePath = await resolveApplicationPath(EDGE_PROTOCOL_PROBE_URL);
  if (isOwnWindowsApplicationPath(edgeExePath)) {
    throw noDefaultWebBrowserError();
  }
  await spawnWindowsBrowser(edgeExePath, href);
}

/**
 * Open a local `file:` page in the user's default web browser, never in the
 * file type's registered handler. Fails closed: no `file:` URL is ever handed
 * to `shell.openExternal` or `shell.openPath`. Callers must already have bound
 * the URL to a page the user loaded; this only re-checks the scheme.
 */
export async function openFileInDefaultWebBrowser(
  fileUrl: string,
): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(fileUrl);
  } catch {
    throw noDefaultWebBrowserError();
  }
  if (parsed.protocol !== 'file:') throw noDefaultWebBrowserError();
  const capture = captureE2eExternalOpen(parsed.href);
  if (capture) return capture;
  const os = hostOperatingSystem();
  if (os !== 'darwin' && os !== 'win32') throw noDefaultWebBrowserError();
  try {
    if (os === 'darwin') {
      await openFileInMacWebBrowser(parsed);
    } else {
      await openFileInWindowsWebBrowser(parsed.href);
    }
  } catch (error) {
    logMainProcessError(
      'Failed to open a local file in the web browser',
      error,
    );
    throw noDefaultWebBrowserError();
  }
}

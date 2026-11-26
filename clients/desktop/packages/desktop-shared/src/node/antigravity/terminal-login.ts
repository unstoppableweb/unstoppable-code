import type {
  ProviderProcess,
  ProviderProcessOwner,
  ProviderProcessSpawner,
} from '../provider-process/spawn';
import { openAntigravityRuntime } from './runtime';
import { assertAntigravityExecutableIdentity } from './runtime-integrity';
import { antigravityEnvironment } from './runtime-resolution';

/**
 * Arguments for the pinned runtime's paste-code sign-in. 1.5.1 advertises it
 * as the ACP `terminal-login` auth method (type `terminal`, args `--login`),
 * which the client must launch itself. It prints a Google link whose redirect
 * is Google's hosted callback page, reads the code or landing-page URL from
 * stdin, stores the credential where `oauth-personal` reads it, and exits.
 * No loopback listener runs on this computer, so the link can be opened on
 * any computer.
 */
export function antigravityTerminalLoginArguments(profile: string): string[] {
  return ['acp', '--login', '--gemini-dir', profile, '--disable-telemetry'];
}

/** The Google authorization link in the sign-in output, if it has appeared. */
export function antigravitySignInLink(output: string): string | undefined {
  const match = /https:\/\/accounts\.google\.com\/o\/oauth2\/[^\s"'<>]+/.exec(
    output,
  );
  return match?.[0];
}

/**
 * Launches the verified runtime's paste-code sign-in, under the same launch
 * checks as every native process: workspace isolation, the resolved copy's
 * signature or pinned digest, the pinned version, and the unchanged-file
 * check just before spawn.
 *
 * The child gets no way to open a browser here. 1.5.1 also tries to open the
 * link itself as a convenience; without a display, a session bus or a
 * desktop name, the Linux openers (`xdg-open`, `gio open`, a portal) fail
 * quietly, and `BROWSER=true` makes one that honors it succeed without
 * opening anything. So a sign-in started from another computer never opens a
 * browser on this unattended screen. macOS has no such variables to withhold.
 */
export async function openAntigravityTerminalLogin(input: {
  cwd: string;
  profile: string;
  spawnProcess: ProviderProcessSpawner;
  assertEnabled: () => void | Promise<void>;
  owner: ProviderProcessOwner;
  signal?: AbortSignal;
  /** See `openAntigravityRuntime`; tests pass an empty directory. */
  managedRootDir?: string;
}): Promise<ProviderProcess> {
  // `acp --login` doesn't speak ACP, so it can't report its version. The
  // same file is opened as the runtime first, under every native launch's
  // checks: workspace isolation, the signature (macOS) or pinned digest
  // (Linux), the unchanged-file check, and the pinned version its handshake
  // reports. macOS accepts any Google-signed CLI, so that version answer is
  // what holds the sign-in to the pinned release there.
  const probe = await openAntigravityRuntime({
    cwd: input.cwd,
    profile: input.profile,
    spawnProcess: input.spawnProcess,
    assertEnabled: input.assertEnabled,
    owner: input.owner,
    signal: input.signal,
    managedRootDir: input.managedRootDir,
    onUpdate: () => undefined,
  });
  const { executable, executableIdentity } = probe;
  await probe.close();
  if (!executable || !executableIdentity)
    throw new Error('Google could not start.');
  input.signal?.throwIfAborted();
  await input.assertEnabled();
  // Exactly the file that reported the pinned version. The shared verdict
  // for the path isn't enough: another launch may have verified a different
  // file there while the version check closed.
  await assertAntigravityExecutableIdentity(executable, executableIdentity);
  // The window that asked may have gone while the file was checked.
  input.signal?.throwIfAborted();
  const env = antigravityEnvironment();
  delete env.DISPLAY;
  delete env.WAYLAND_DISPLAY;
  delete env.DBUS_SESSION_BUS_ADDRESS;
  delete env.XDG_CURRENT_DESKTOP;
  env.BROWSER = 'true';
  return input.spawnProcess({
    command: executable,
    args: antigravityTerminalLoginArguments(input.profile),
    cwd: input.cwd,
    env,
    owner: input.owner,
  });
}

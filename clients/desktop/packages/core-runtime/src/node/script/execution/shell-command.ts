import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import type { CoreScriptCommandShell } from '@canopy/protocol/canopy-core';

export type ScriptCommandShell = CoreScriptCommandShell;

/**
 * The host facts shell selection reads. Each is read when a command is
 * built, so a host's later PATH or environment changes apply to the next
 * run.
 */
export interface ScriptShellHost {
  /** The host operating system, as Node names it. */
  platform(): string;
  findExecutable(name: string): string | null;
  /** Git for Windows' `bash.exe`, when installed. */
  windowsGitBash(): string | null;
  /** Quote a script path for `cmd.exe /d /s /c`. */
  cmdCommandLine(scriptPath: string): string;
  /** The user's login shell (`SHELL`) on macOS and other POSIX hosts. */
  loginShell(): string | undefined;
  /** `ComSpec` on Windows. */
  comSpec(): string | undefined;
}

export interface ScriptShellCommand {
  command: string;
  args: string[];
  cleanup?: () => void;
}

function buildPowerShellScript(script: string): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    script,
    '$canopyLastSuccess = $?',
    '$canopyLastExitCode = $LASTEXITCODE',
    'if (-not $canopyLastSuccess) {',
    '  if ($canopyLastExitCode -is [int] -and $canopyLastExitCode -ne 0) { exit $canopyLastExitCode }',
    '  exit 1',
    '}',
    'exit 0',
    '',
  ].join('\n');
}

/**
 * The shell and arguments a script runs with (CAN-3189 and the CAN-5062
 * goldens):
 *
 * - Windows runs Git Bash only when `shell.windows` asks for it, and refuses
 *   without it; otherwise PowerShell (`pwsh.exe`, then `powershell.exe`)
 *   from a temporary script that maps failures to an exit code, or `cmd`
 *   when asked or when no PowerShell is found.
 * - Linux runs `shell.linux` from PATH (Bash by default, then `/bin/bash`)
 *   and refuses a missing zsh rather than falling back.
 * - macOS runs `shell.mac` from PATH, then `/bin/{shell}`; without one, and
 *   on other POSIX hosts, the absolute `SHELL` of the run's environment, then
 *   the host's login shell, then `/bin/bash`.
 * - POSIX shells start with `-li`, or `-l` when not interactive.
 */
export function buildScriptShellCommand(
  host: ScriptShellHost,
  script: string,
  shell?: ScriptCommandShell,
  options?: {
    interactive?: boolean;
    /** The run's own environment, which may name another shell than the host's. */
    environment?: Readonly<Record<string, string | undefined>>;
  },
): ScriptShellCommand {
  const platform = host.platform();
  if (platform === 'win32') {
    const requestedShell = shell?.windows;
    if (requestedShell === 'bash') {
      const bash = host.windowsGitBash();
      if (bash === null) {
        throw new Error('Git Bash is not available on this Windows machine.');
      }
      return { command: bash, args: ['-lc', script] };
    }

    const tempDir = mkdtempSync(join(tmpdir(), 'canopy-script-'));
    const cleanup = (): void => {
      rmSync(tempDir, { recursive: true, force: true });
    };
    const defaultPowerShell =
      requestedShell === undefined
        ? (host.findExecutable('pwsh.exe') ??
          host.findExecutable('powershell.exe'))
        : null;
    if (requestedShell === 'powershell' || defaultPowerShell) {
      const pwsh =
        requestedShell === 'powershell'
          ? (host.findExecutable('pwsh.exe') ??
            host.findExecutable('powershell.exe') ??
            'powershell.exe')
          : defaultPowerShell;
      const scriptPath = join(tempDir, 'canopy-script.ps1');
      writeFileSync(scriptPath, buildPowerShellScript(script), 'utf8');
      return {
        command: pwsh ?? 'powershell.exe',
        args: [
          '-NoLogo',
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          scriptPath,
        ],
        cleanup,
      };
    }
    const scriptPath = join(tempDir, 'canopy-script.cmd');
    writeFileSync(scriptPath, script, 'utf8');
    return {
      command: host.comSpec() || 'cmd.exe',
      args: ['/d', '/s', '/c', host.cmdCommandLine(scriptPath)],
      cleanup,
    };
  }

  if (platform === 'linux') {
    const requestedShell = shell?.linux ?? 'bash';
    const resolvedShell = host.findExecutable(requestedShell);
    if (requestedShell === 'zsh' && resolvedShell === null) {
      throw new Error(
        'zsh configured in shell.linux is not available on PATH. Install zsh or change shell.linux to "bash".',
      );
    }
    return {
      command: resolvedShell ?? '/bin/bash',
      args: [options?.interactive === false ? '-l' : '-li', '-c', script],
    };
  }

  const requestedShell = platform === 'darwin' ? shell?.mac : undefined;
  // A daemon started by launchd has no SHELL of its own, so the run's wins:
  // bash -l would rebuild PATH with path_helper and skip the user's setup.
  const runShell = options?.environment?.SHELL;
  const command = requestedShell
    ? (host.findExecutable(requestedShell) ?? `/bin/${requestedShell}`)
    : (runShell && isAbsolute(runShell) ? runShell : undefined) ||
      host.loginShell() ||
      '/bin/bash';
  return {
    command,
    args: [options?.interactive === false ? '-l' : '-li', '-c', script],
  };
}

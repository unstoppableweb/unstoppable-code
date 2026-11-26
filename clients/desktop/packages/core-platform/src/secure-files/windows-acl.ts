import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { lstat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { observeWindowsClosure } from '../supervision/windows-closure';
import {
  checkShape,
  fail,
  PATH_CHANGED_DURING_CHECK,
  PRIVATE,
  sameNode,
  type PermissionRequest,
  type PermissionResult,
} from './shared';

/** Returns the JSON receipt printed by `ACL_SCRIPT` for one path. */
export type WindowsAclReader = (target: string) => Promise<string>;

const PATH_VARIABLE = 'CANOPY_SECURE_FILE_PATH';
const MODULES = 'WindowsPowerShell/v1.0/Modules';

// Fixed script: the path is data (environment, passed to .NET), never code.
// .NET parses the descriptor; numeric ACE types avoid locale-dependent names.
// Cmdlets are never used: the first module autoload under a fresh module path
// builds PowerShell's analysis cache, which outlasts the timeout below on
// windows-2022. JSON is assembled by hand; every value is a SID, int or bool.
const ACL_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$PSModuleAutoLoadingPreference = 'None'",
  `$p = $env:${PATH_VARIABLE}`,
  '$attributes = [System.IO.File]::GetAttributes($p)',
  '$directory = ($attributes -band [System.IO.FileAttributes]::Directory) -ne 0',
  "$sections = [System.Security.AccessControl.AccessControlSections]'Owner, Access'",
  '$acl = if ($directory) { [System.IO.Directory]::GetAccessControl($p, $sections) } else { [System.IO.File]::GetAccessControl($p, $sections) }',
  '$sd = [System.Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorSddlForm($sections))',
  "function q($v) { if ($null -eq $v) { 'null' } else { '\"' + $v + '\"' } }",
  "function b($v) { if ($v) { 'true' } else { 'false' } }",
  `$aces = @(if ($null -ne $sd.DiscretionaryAcl) { foreach ($ace in $sd.DiscretionaryAcl) { '{"type":' + [int]$ace.AceType + ',"sid":' + (q $(if ($ace -is [System.Security.AccessControl.KnownAce]) { $ace.SecurityIdentifier.Value } else { $null })) + '}' } })`,
  `'{"user":' + (q ([System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value)) + ',"owner":' + (q $(if ($null -ne $sd.Owner) { $sd.Owner.Value } else { $null })) + ',"reparse":' + (b (($attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)) + ',"directory":' + (b $directory) + ',"dacl":' + (b ($null -ne $sd.DiscretionaryAcl)) + ',"aces":[' + ($aces -join ',') + ']}'`,
].join('\n');

// -NoProfile still permits PowerShell startup caches. Confine those to a
// disposable child profile without changing the parent's paths or token user.
export function windowsAclEnvironment(
  env: NodeJS.ProcessEnv,
  systemRoot: string,
  target: string,
  profile: string,
): NodeJS.ProcessEnv {
  const inherited = Object.entries(env).filter(
    ([key]) =>
      !/^(psmodulepath|psmoduleanalysiscachepath|home|userprofile|appdata|localappdata)$/i.test(
        key,
      ),
  );
  return {
    ...Object.fromEntries(inherited),
    HOME: profile,
    USERPROFILE: profile,
    APPDATA: path.win32.join(profile, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.win32.join(profile, 'AppData', 'Local'),
    PSModulePath: path.win32.join(systemRoot, 'System32', MODULES),
    PSModuleAnalysisCachePath: 'NUL',
    [PATH_VARIABLE]: target,
  };
}

interface WindowsAclInvocation {
  readonly profile: string;
  readonly file: string;
  readonly args: string[];
  readonly options: {
    readonly env: NodeJS.ProcessEnv;
    readonly encoding: 'utf8';
    readonly maxBuffer: number;
    readonly timeout: number;
    readonly windowsHide: boolean;
  };
}

function windowsAclInvocation(target: string): WindowsAclInvocation {
  const root = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? '';
  if (!/^[A-Za-z]:\\/.test(root)) throw new Error('SystemRoot is not absolute');
  const profile = mkdtempSync(path.join(tmpdir(), 'canopy-acl-'));
  return {
    profile,
    file: path.win32.join(
      root,
      'System32/WindowsPowerShell/v1.0/powershell.exe',
    ),
    args: [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(ACL_SCRIPT, 'utf16le').toString('base64'),
    ],
    options: {
      env: windowsAclEnvironment(process.env, root, target, profile),
      encoding: 'utf8',
      maxBuffer: 64 * 1024,
      timeout: 15_000,
      windowsHide: true,
    },
  };
}

export const readWindowsAcl: WindowsAclReader = async (target) => {
  const command = windowsAclInvocation(target);
  const closure = observeWindowsClosure('acl');
  try {
    const execution = promisify(execFile)(
      command.file,
      command.args,
      command.options,
    );
    execution.child.once('close', (code, signal) => {
      if (code !== 0 || signal !== null) closure?.unsafe();
      closure?.close();
    });
    const { stdout } = await execution;
    return stdout;
  } catch (error) {
    closure?.unsafe();
    throw error;
  } finally {
    await rm(command.profile, { recursive: true, force: true });
  }
};

/** Import-time startup admission uses the same bounded, read-only ACL receipt. */
export function readWindowsAclSync(target: string): string {
  const command = windowsAclInvocation(target);
  const closure = observeWindowsClosure('acl');
  try {
    return execFileSync(command.file, command.args, command.options);
  } catch (error) {
    closure?.unsafe();
    throw error;
  } finally {
    closure?.close();
    rmSync(command.profile, { recursive: true, force: true });
  }
}

// LocalSystem and BUILTIN\Administrators can take ownership of any file, so
// their grants do not widen access. No other trustee is accepted.
const PRIVILEGED_SIDS = new Set(['S-1-5-18', 'S-1-5-32-544']);
const [ACCESS_ALLOWED, ACCESS_DENIED] = [0, 1];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isSid = (value: unknown): value is string =>
  typeof value === 'string' && /^S-1(-\d+)+$/.test(value);

/**
 * Anything not provably private fails closed. `accept` admits other accounts'
 * allow entries only; every other refusal stands, including a later malformed
 * entry.
 */
export function evaluateWindowsAcl(
  text: string,
  kind: PermissionRequest['kind'],
  foreignTrustees: NonNullable<PermissionRequest['foreignTrustees']> = 'refuse',
): PermissionResult {
  let receipt: unknown;
  try {
    receipt = JSON.parse(text);
  } catch {
    receipt = undefined;
  }
  if (!isRecord(receipt) || !Array.isArray(receipt.aces)) {
    return fail(
      'unverifiable',
      'Windows ACL receipt is malformed',
      'unverifiable',
    );
  }
  const { user, owner, reparse, directory, dacl } = receipt;
  if (!isSid(user) || !isSid(owner)) {
    return fail(
      'unverifiable',
      'Windows owner or user identity is missing',
      'unverifiable',
    );
  }
  if (reparse !== false)
    return fail('insecure', 'path may be a reparse point', 'reparse_point');
  if (directory !== (kind === 'directory')) {
    return fail('insecure', `path is not a ${kind}`, 'wrong_kind');
  }
  if (owner !== user)
    return fail('insecure', 'owned by another account', 'foreign_owner');
  if (dacl !== true)
    return fail('insecure', 'null DACL grants everyone', 'null_dacl');
  const accepted = new Set<string>();
  for (const ace of receipt.aces) {
    if (!isRecord(ace) || !isSid(ace.sid)) {
      return fail(
        'unverifiable',
        'Windows ACL entry is malformed',
        'unverifiable',
      );
    }
    if (ace.type === ACCESS_DENIED) continue;
    if (ace.type !== ACCESS_ALLOWED) {
      return fail(
        'unverifiable',
        `unsupported ACE type ${String(ace.type)}`,
        'unverifiable',
      );
    }
    if (ace.sid === user || PRIVILEGED_SIDS.has(ace.sid)) continue;
    if (foreignTrustees !== 'accept') {
      return fail(
        'insecure',
        `ACL grants access to ${ace.sid}`,
        'foreign_trustee',
      );
    }
    accepted.add(ace.sid);
  }
  return accepted.size === 0
    ? PRIVATE
    : {
        state: 'private',
        accepted: {
          cause: 'accepted_foreign_trustee',
          trustees: [...accepted],
        },
      };
}

/** Read-only: mode bits prove nothing here and insecure ACLs are never repaired. */
export async function windowsPermissions(
  request: PermissionRequest,
  read: WindowsAclReader,
): Promise<PermissionResult> {
  const stats = await lstat(request.path, { bigint: true });
  let result =
    checkShape(stats, request.kind) ??
    evaluateWindowsAcl(
      await read(request.path),
      request.kind,
      request.foreignTrustees,
    );
  if (result.state === 'private') {
    const after = await lstat(request.path, { bigint: true });
    result = !sameNode(stats, after)
      ? fail('unverifiable', PATH_CHANGED_DURING_CHECK, 'path_changed')
      : (checkShape(after, request.kind) ?? result);
  }
  return result.state === 'private' || request.action === 'verify'
    ? result
    : { ...result, reason: `${result.reason}; Windows ACLs are not repaired` };
}

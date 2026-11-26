import { spawn } from 'node:child_process';
import type { BigIntStats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { fail, type PermissionResult } from './shared';

export type DarwinAclProbe = (
  handle: FileHandle,
  clear: boolean,
) => Promise<string>;

// Fixed JXA calls public SDK functions on inherited fd 3; no pathname reaches it.
// fstatx supplies identity and ACL together. The mode-valid bit rejects incomplete reads.
const SCRIPT = String.raw`
ObjC.import('Foundation');
const bind = (name, ret, args) => ObjC.bindFunction(name, [ret, args]);
bind('malloc', 'void *', ['unsigned long']);
bind('free', 'void', ['void *']);
bind('filesec_init', 'void *', []);
bind('filesec_free', 'void', ['void *']);
bind('filesec_set_property', 'int', ['void *', 'int', 'unsigned long']);
bind('filesec_query_property', 'int', ['void *', 'int', 'void *']);
bind('filesec_get_property', 'int', ['void *', 'int', 'void *']);
// x86_64 exports the legacy 32-bit-inode fstatx_np; fstatx64_np has the 64-bit layout and is absent on arm64.
let fstatx = 'fstatx64_np';
try { bind(fstatx, 'int', ['int', 'void *', 'void *']); } catch (e) { fstatx = 'fstatx_np'; bind(fstatx, 'int', ['int', 'void *', 'void *']); }
bind('fchmodx_np', 'int', ['int', 'void *']);
bind('acl_valid', 'int', ['void *']);
bind('acl_get_entry', 'int', ['void *', 'int', 'void *']);
bind('acl_free', 'int', ['void *']);
const FD = 3, MODE = 4, ACL = 5, REMOVE_ACL = 1;
const must = (ok, what) => { if (!ok) throw new Error(what); };
const pointer = (p, what) => { must(!Ref.equals(p, null), what); return p; };
const has = (fsec, property) => {
  const valid = Ref('int');
  must($.filesec_query_property(fsec, property, valid) === 0, 'query');
  return valid[0] !== 0;
};
function clear() {
  const fsec = pointer($.filesec_init(), 'filesec_init');
  try {
    must($.filesec_set_property(fsec, ACL, REMOVE_ACL) === 0, 'set');
    must($.fchmodx_np(FD, fsec) === 0, 'fchmodx_np');
  } finally { $.filesec_free(fsec); }
}
function inspect() {
  const fsec = pointer($.filesec_init(), 'filesec_init');
  const sb = pointer($.malloc(256), 'malloc');
  try {
    must($[fstatx](FD, sb, fsec) === 0, 'fstatx_np');
    must(has(fsec, MODE), 'stat receipt incomplete');
    let entries = null;
    if (has(fsec, ACL)) {
      const acl = Ref('void *');
      must($.filesec_get_property(fsec, ACL, acl) === 0, 'acl');
      const handle = pointer(acl[0], 'acl');
      try {
        must($.acl_valid(handle) === 0, 'acl_valid');
        const entry = Ref('void *');
        for (entries = 0; entries < 1024; entries++) {
          if ($.acl_get_entry(handle, entries === 0 ? 0 : -1, entry) !== 0) break;
        }
      } finally { $.acl_free(handle); }
    }
    const st = $.NSData.dataWithBytesLength(sb, 24).base64EncodedStringWithOptions(0).js;
    return JSON.stringify({ st, entries });
  } finally { $.free(sb); $.filesec_free(fsec); }
}
function run(argv) {
  must(argv.length === 0 || (argv.length === 1 && argv[0] === 'clear'), 'usage');
  if (argv.length === 1) clear();
  return inspect();
}
`;

export const probeDarwinAcl: DarwinAclProbe = (handle, clear) =>
  new Promise((resolve, reject) => {
    const child = spawn(
      '/usr/bin/osascript',
      ['-l', 'JavaScript', '-e', SCRIPT, ...(clear ? ['clear'] : [])],
      {
        stdio: ['ignore', 'pipe', 'pipe', handle.fd],
        env: { LC_ALL: 'C' },
        timeout: 15000,
        killSignal: 'SIGKILL',
      },
    );
    let output = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      output += chunk;
      if (output.length > 4096) child.kill('SIGKILL');
    });
    child.stderr?.resume();
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0 && output.length <= 4096) resolve(output.trim());
      else
        reject(
          Object.assign(new Error('ACL probe failed'), {
            code: 'ACL_PROBE_FAILED',
          }),
        );
    });
  });

export function checkDarwinAcl(
  text: string,
  opened: BigIntStats,
): PermissionResult | null {
  let receipt: unknown;
  try {
    receipt = JSON.parse(text);
  } catch {
    return fail('unverifiable', 'malformed ACL receipt', 'unverifiable');
  }
  if (
    typeof receipt !== 'object' ||
    receipt === null ||
    !('st' in receipt) ||
    typeof receipt.st !== 'string' ||
    !('entries' in receipt) ||
    !(
      receipt.entries === null ||
      (typeof receipt.entries === 'number' &&
        Number.isInteger(receipt.entries) &&
        receipt.entries >= 0 &&
        receipt.entries <= 1024)
    )
  ) {
    return fail('unverifiable', 'malformed ACL receipt', 'unverifiable');
  }
  const stat = Buffer.from(receipt.st, 'base64');
  if (
    stat.length !== 24 ||
    stat.toString('base64') !== receipt.st ||
    BigInt.asUintN(64, BigInt(stat.readInt32LE(0))) !== opened.dev ||
    stat.readBigUInt64LE(8) !== opened.ino
  ) {
    return fail(
      'unverifiable',
      'ACL receipt identity mismatch',
      'unverifiable',
    );
  }
  return receipt.entries !== null && receipt.entries > 0
    ? fail('insecure', 'extended ACL is present', 'extended_acl')
    : null;
}

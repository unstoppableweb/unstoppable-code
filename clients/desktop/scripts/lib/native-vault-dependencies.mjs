import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/** PE32+ normal and RVA-based delay imports, bounded to backed section bytes. */
export function nativeVaultPeImports(bytes) {
  const fail = () => {
    throw new Error('Invalid native vault PE dependency table.');
  };
  if (bytes.length < 0x40) fail();
  const pe = bytes.readUInt32LE(0x3c);
  if (
    pe + 264 > bytes.length ||
    bytes.toString('ascii', pe, pe + 4) !== 'PE\0\0' ||
    bytes.readUInt16LE(pe + 24) !== 0x20b
  )
    fail();
  const optional = pe + 24;
  const sections = optional + bytes.readUInt16LE(pe + 20);
  const count = bytes.readUInt16LE(pe + 6);
  const rvaOffset = (rva, size) => {
    for (let index = 0; index < count; index++) {
      const at = sections + index * 40;
      if (at + 40 > bytes.length) fail();
      const address = bytes.readUInt32LE(at + 12);
      const length = bytes.readUInt32LE(at + 16);
      const raw = bytes.readUInt32LE(at + 20);
      if (
        rva >= address &&
        rva - address + size <= length &&
        raw + rva - address + size <= bytes.length
      )
        return raw + rva - address;
    }
    fail();
  };
  const string = (rva) => {
    let text = '';
    for (let index = 0; index < 256; index++) {
      const char = bytes[rvaOffset(rva + index, 1)];
      if (char === 0) return text.toLowerCase();
      if (char < 0x20 || char > 0x7e) fail();
      text += String.fromCharCode(char);
    }
    fail();
  };
  const imports = (entry, stride, nameOffset) => {
    if (bytes.readUInt32LE(optional + 108) <= entry) return [];
    const rva = bytes.readUInt32LE(optional + 112 + entry * 8);
    const length = bytes.readUInt32LE(optional + 116 + entry * 8);
    if (!rva && !length) return [];
    if (!rva || length < stride || length > 64 * 1024) fail();
    const names = [];
    for (let at = 0; at + stride <= length; at += stride) {
      const start = rvaOffset(rva + at, stride);
      if (bytes.subarray(start, start + stride).every((value) => value === 0))
        return names;
      if (entry === 13 && bytes.readUInt32LE(start) !== 1) fail();
      names.push(string(bytes.readUInt32LE(start + nameOffset)));
    }
    fail();
  };
  return { normal: imports(1, 20, 12), delay: imports(13, 32, 4) };
}

export function assertNativeVaultDependencies(
  file,
  target,
  run = (command, args) =>
    execFileSync(command, args, {
      encoding: 'utf8',
      timeout: 30_000,
      env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LC_ALL: 'C' },
    }),
) {
  if (target.startsWith('win32-')) {
    const imports = nativeVaultPeImports(readFileSync(file));
    const system = new Set([
      'kernel32.dll',
      'advapi32.dll',
      'secur32.dll',
      'bcrypt.dll',
      'ntdll.dll',
    ]);
    if (
      !imports.normal.length ||
      !imports.normal.every((name) => system.has(name)) ||
      JSON.stringify(imports.delay) !== JSON.stringify(['node.exe'])
    )
      throw new Error(
        'Native vault requires system-only normal imports, static CRT and node.exe-only delay loading.',
      );
    return;
  }
  if (target.startsWith('darwin-')) {
    for (const arch of ['arm64', 'x86_64']) {
      const loadCommands = run('/usr/bin/otool', ['-arch', arch, '-l', file]);
      if (/cmd LC_(?:RPATH|LOAD_DYLINKER|DYLD_ENVIRONMENT)/.test(loadCommands))
        throw new Error(
          'Native vault must not supply loader search paths or environment.',
        );
      const output = run('/usr/bin/otool', ['-arch', arch, '-L', file]);
      const libraries = [
        ...output.matchAll(/^\s+(\S+) \(compatibility version /gm),
      ].map((match) => match[1]);
      const allowed = new Set([
        '/System/Library/Frameworks/Security.framework/Versions/A/Security',
        '/System/Library/Frameworks/CoreFoundation.framework/Versions/A/CoreFoundation',
        '/usr/lib/libSystem.B.dylib',
      ]);
      if (
        !libraries.length ||
        libraries.some((library) => !allowed.has(library))
      )
        throw new Error('Native vault has a non-system Darwin dependency.');
    }
    return;
  }
  if (target.startsWith('linux-')) {
    const output = run('/usr/bin/readelf', ['--dynamic', '--wide', file]);
    if (/\((?:RPATH|RUNPATH|AUDIT|DEPAUDIT|FILTER|AUXILIARY)\)/.test(output))
      throw new Error(
        'Native vault must not supply dynamic search paths or loader extensions.',
      );
    const libraries = [...output.matchAll(/\(NEEDED\).*\[([^\]]+)\]/g)].map(
      (match) => match[1],
    );
    const allowed = new Set([
      'libsecret-1.so.0',
      'libgio-2.0.so.0',
      'libgobject-2.0.so.0',
      'libglib-2.0.so.0',
      'libc.so.6',
      'libpthread.so.0',
    ]);
    // AArch64 glibc exports the stack protector's __stack_chk_guard from ld.so.
    if (target === 'linux-arm64') allowed.add('ld-linux-aarch64.so.1');
    if (
      !libraries.includes('libsecret-1.so.0') ||
      libraries.some((library) => !allowed.has(library))
    )
      throw new Error('Native vault has an unqualified Linux dependency.');
    return;
  }
  throw new Error('Unsupported native vault dependency policy.');
}

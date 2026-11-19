// Shared standalone CLI format validation. Release targets remain the
// packager's responsibility; accepting ELF here does not enable an archive.
export function assertCliExecutable(target, bytes, label) {
  const supportedTargets = new Set([
    'darwin-arm64',
    'darwin-x64',
    'win32-x64',
    'linux-x64',
    'linux-arm64',
  ]);
  if (!supportedTargets.has(target)) {
    throw new Error(`Unsupported CLI executable target ${target} at ${label}`);
  }
  if (bytes.length === 0) {
    throw new Error(`CLI binary is empty: ${label} (${target})`);
  }

  if (target.startsWith('win32-')) {
    if (bytes[0] !== 0x4d || bytes[1] !== 0x5a) {
      throw new Error(`Expected PE executable at ${label} (${target})`);
    }
    return;
  }

  if (target.startsWith('linux-')) {
    const fail = (property, expected, actual) => {
      throw new Error(
        `Invalid ELF ${property} at ${label} (${target}): expected ${expected}, actual ${actual}`,
      );
    };
    if (bytes.length < 64)
      fail('header (truncated)', 'at least 64 bytes', bytes.length);
    const magic = bytes.subarray(0, 4).toString('hex');
    if (magic !== '7f454c46') fail('magic', '7f454c46', magic);
    for (const [property, offset, expected] of [
      ['EI_CLASS', 4, 2],
      ['EI_DATA', 5, 1],
      ['EI_VERSION', 6, 1],
    ]) {
      if (bytes[offset] !== expected) fail(property, expected, bytes[offset]);
    }
    const machine = target === 'linux-x64' ? 62 : 183;
    if (bytes.readUInt16LE(18) !== machine)
      fail('e_machine', machine, bytes.readUInt16LE(18));
    if (bytes.readUInt32LE(20) !== 1)
      fail('e_version', 1, bytes.readUInt32LE(20));
    if (bytes.readUInt16LE(52) !== 64)
      fail('e_ehsize', 64, bytes.readUInt16LE(52));
    const type = bytes.readUInt16LE(16);
    if (type !== 2 && type !== 3)
      fail('e_type', 'ET_EXEC (2) or ET_DYN (3)', type);
    return;
  }

  const magic = bytes.subarray(0, 4).toString('hex');
  const machOMagics = new Set(['feedface', 'feedfacf', 'cefaedfe', 'cffaedfe']);
  if (!machOMagics.has(magic)) {
    throw new Error(`Expected Mach-O executable at ${label} (${target})`);
  }
}

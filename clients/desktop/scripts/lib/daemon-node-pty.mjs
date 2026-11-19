/**
 * Node-ABI node-pty for the core daemon (CAN-5068). The daemon is a Node
 * single executable, so the Electron rebuild in node_modules is not its
 * runtime. This builds node-pty from source for the running Node's headers in
 * a private copy, never touching node_modules, and stages it as real files in
 * a `node-pty` directory beside the daemon: upstream's `package.json` and
 * `lib/` JavaScript, plus the target's native files in `build/Release/`, where
 * upstream's loader looks first. Windows stages ConPTY only (`conpty.node`
 * and `conpty_console_list.node`); winpty and the bundled OpenConsole are not
 * shipped. Linux copies of the JavaScript have their source-map comments
 * blanked, which the Linux package policy refuses outside the app ASAR. A
 * manifest records the package, target, Node and every file's size and
 * SHA-256.
 *
 * Builds are cached under `.cache/native/daemon-node-pty/<target>/` and reused
 * only when the recorded inputs and output hashes match exactly.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { delimiter, dirname, join, posix, relative, sep } from 'node:path';
import { blankSourceMapDirectives } from './source-map-directives.mjs';

/** The staged directory's name beside the daemon executable. */
export const DAEMON_NODE_PTY_DIRECTORY = 'node-pty';
/** The manifest inside the staged directory. */
export const DAEMON_NODE_PTY_MANIFEST = 'daemon-staging.json';

const SCHEMA_VERSION = 1;
// Bump when the build recipe or the staged file selection changes.
const RECIPE = 1;

const NATIVE_FILES = Object.freeze({
  darwin: Object.freeze([
    { name: 'pty.node', kind: 'native' },
    { name: 'spawn-helper', kind: 'executable' },
  ]),
  linux: Object.freeze([{ name: 'pty.node', kind: 'native' }]),
  win32: Object.freeze([
    { name: 'conpty.node', kind: 'native' },
    { name: 'conpty_console_list.node', kind: 'native' },
  ]),
});

const TARGETS = new Set([
  'darwin-arm64',
  'darwin-x64',
  'linux-arm64',
  'linux-x64',
  'win32-arm64',
  'win32-x64',
]);

const SIGNABLE = new Set(['native', 'executable']);

function splitTarget(target) {
  if (!TARGETS.has(target))
    throw new Error(`Unsupported daemon node-pty target: ${target}`);
  const [platform, arch] = target.split('-');
  return { platform, arch };
}

/** The native files staged for a target, under `build/Release/`. */
export function nativeFilesFor(target) {
  return NATIVE_FILES[splitTarget(target).platform].map((file) => ({
    path: `build/Release/${file.name}`,
    kind: file.kind,
  }));
}

/**
 * Only macOS cross-builds, between its two architectures: Linux and Windows
 * build for the host they run on.
 */
export function assertBuildableTarget(target, host) {
  const wanted = splitTarget(target);
  const current = splitTarget(host);
  if (wanted.platform !== current.platform)
    throw new Error(
      `Daemon node-pty for ${target} must build on ${wanted.platform}; this host is ${host}.`,
    );
  if (wanted.arch !== current.arch && wanted.platform !== 'darwin')
    throw new Error(
      `Daemon node-pty for ${target} must build on a ${target} host; this host is ${host}.`,
    );
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function readHeader(path, length) {
  const bytes = Buffer.alloc(length);
  const descriptor = openSync(path, 'r');
  try {
    return bytes.subarray(0, readSync(descriptor, bytes, 0, length, 0));
  } finally {
    closeSync(descriptor);
  }
}

const MACH_O = new Map([
  [0x0100000c, 'arm64'],
  [0x01000007, 'x64'],
]);
const ELF = new Map([
  [183, 'arm64'],
  [62, 'x64'],
]);
const PE = new Map([
  [0xaa64, 'arm64'],
  [0x8664, 'x64'],
]);

/**
 * The binary format and architectures of a file's header, or `null` when it
 * is not a thin or fat Mach-O, a little-endian ELF64 or a PE image.
 */
export function binaryArchitecture(bytes) {
  if (bytes.length >= 8 && bytes.readUInt32LE(0) === 0xfeedfacf)
    return {
      format: 'mach-o',
      arches: [MACH_O.get(bytes.readUInt32LE(4)) ?? 'unknown'],
    };
  if (bytes.length >= 8 && bytes.readUInt32BE(0) === 0xcafebabe) {
    const count = bytes.readUInt32BE(4);
    if (bytes.length < 8 + count * 20) return null;
    return {
      format: 'mach-o',
      arches: Array.from(
        { length: count },
        (_, index) =>
          MACH_O.get(bytes.readUInt32BE(8 + index * 20)) ?? 'unknown',
      ),
    };
  }
  if (
    bytes.length >= 20 &&
    bytes.readUInt32BE(0) === 0x7f454c46 &&
    bytes[4] === 2 &&
    bytes[5] === 1
  )
    return {
      format: 'elf',
      arches: [ELF.get(bytes.readUInt16LE(18)) ?? 'unknown'],
    };
  if (bytes.length >= 64 && bytes.toString('latin1', 0, 2) === 'MZ') {
    const offset = bytes.readUInt32LE(0x3c);
    if (
      offset + 6 <= bytes.length &&
      bytes.toString('latin1', offset, offset + 4) === 'PE\0\0'
    )
      return {
        format: 'pe',
        arches: [PE.get(bytes.readUInt16LE(offset + 4)) ?? 'unknown'],
      };
  }
  return null;
}

const FORMATS = { darwin: 'mach-o', linux: 'elf', win32: 'pe' };

/** `null` when the file is a binary for exactly this target, else the reason. */
export function binaryMismatch(path, target) {
  const { platform, arch } = splitTarget(target);
  const found = binaryArchitecture(readHeader(path, 4096));
  if (found === null) return 'is not a recognized binary';
  if (found.format !== FORMATS[platform])
    return `is ${found.format}, expected ${FORMATS[platform]}`;
  if (found.arches.length !== 1 || found.arches[0] !== arch)
    return `is ${found.arches.join(' ')}, expected ${arch}`;
  return null;
}

/** Every regular file below `directory`, as sorted POSIX relative paths. */
function listFiles(directory, problems) {
  const files = [];
  const visit = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      const name = relative(directory, path).split(sep).join(posix.sep);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.push(name);
      else problems.push(`${name} is not a regular file`);
    }
  };
  visit(directory);
  return files.sort();
}

function describeFile(directory, path, kind) {
  const bytes = readFileSync(join(directory, ...path.split(posix.sep)));
  return { path, kind, size: bytes.length, sha256: sha256(bytes) };
}

/** Upstream's runtime JavaScript: `lib/**.js` without tests or maps. */
function runtimeScripts(packageDirectory) {
  return listFiles(join(packageDirectory, 'lib'), [])
    .filter((path) => path.endsWith('.js') && !path.endsWith('.test.js'))
    .map((path) => `lib/${path}`);
}

function digestSources(packageDirectory, entries) {
  const hash = createHash('sha256');
  for (const entry of entries) {
    const absolute = join(packageDirectory, entry);
    const paths = statSync(absolute).isDirectory()
      ? listFiles(absolute, []).map((path) => `${entry}/${path}`)
      : [entry];
    for (const path of paths) {
      hash.update(`${path}\0`);
      hash.update(readFileSync(join(packageDirectory, ...path.split('/'))));
      hash.update('\0');
    }
  }
  return hash.digest('hex');
}

function resolveSources(root) {
  const packageJsonPath = createRequire(join(root, 'package.json')).resolve(
    'node-pty/package.json',
  );
  const addonPackagePath = createRequire(packageJsonPath).resolve(
    'node-addon-api/package.json',
  );
  return {
    packageDirectory: dirname(packageJsonPath),
    packageJson: JSON.parse(readFileSync(packageJsonPath, 'utf8')),
    addonDirectory: dirname(addonPackagePath),
    addonVersion: JSON.parse(readFileSync(addonPackagePath, 'utf8')).version,
  };
}

const isDeepEqual = (left, right) =>
  JSON.stringify(left) === JSON.stringify(right);

function cachedOutputs(buildDirectory, key, natives) {
  const receiptPath = join(buildDirectory, 'build.json');
  if (!existsSync(receiptPath)) return null;
  let receipt;
  try {
    receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
  } catch {
    return null;
  }
  if (!isDeepEqual(receipt?.key, key)) return null;
  const release = join(buildDirectory, 'source', 'build', 'Release');
  for (const { path } of natives) {
    const name = posix.basename(path);
    const recorded = receipt.outputs?.[name];
    const file = join(release, name);
    if (
      typeof recorded !== 'string' ||
      !existsSync(file) ||
      sha256(readFileSync(file)) !== recorded
    )
      return null;
  }
  return release;
}

function buildFromSource({
  root,
  target,
  sources,
  key,
  natives,
  log,
  run,
  host,
}) {
  const { platform, arch } = splitTarget(target);
  const buildDirectory = join(
    root,
    '.cache',
    'native',
    'daemon-node-pty',
    target,
  );
  const cached = cachedOutputs(buildDirectory, key, natives);
  if (cached) {
    log(`Reusing the cached daemon node-pty build for ${target}.`);
    return cached;
  }
  rmSync(buildDirectory, { recursive: true, force: true });
  const source = join(buildDirectory, 'source');
  mkdirSync(source, { recursive: true });
  for (const entry of [
    'binding.gyp',
    'src',
    ...(platform === 'win32' ? ['deps'] : []),
  ])
    cpSync(join(sources.packageDirectory, entry), join(source, entry), {
      recursive: true,
    });
  // binding.gyp asks `node` for node-addon-api's include and target paths.
  cpSync(
    sources.addonDirectory,
    join(source, 'node_modules', 'node-addon-api'),
    {
      recursive: true,
    },
  );
  const nodeGyp = createRequire(join(root, 'package.json')).resolve(
    'node-gyp/bin/node-gyp.js',
  );
  log(
    `Building node-pty ${sources.packageJson.version} for ${target} (Node ${process.versions.node})…`,
  );
  run(
    process.execPath,
    [
      nodeGyp,
      'rebuild',
      `--directory=${source}`,
      `--target=${process.versions.node}`,
      `--arch=${arch}`,
      '--jobs=max',
    ],
    {
      cwd: source,
      stdio: 'inherit',
      // The `node` binding.gyp runs is this one.
      env: {
        ...process.env,
        PATH: [dirname(process.execPath), process.env.PATH ?? ''].join(
          delimiter,
        ),
      },
      timeout: 15 * 60_000,
      killSignal: 'SIGKILL',
    },
  );
  const release = join(source, 'build', 'Release');
  const outputs = {};
  for (const { path } of natives) {
    const name = posix.basename(path);
    const file = join(release, name);
    if (!existsSync(file) || statSync(file).size === 0)
      throw new Error(`node-gyp produced no ${name} for ${target}.`);
    // Signing matches the daemon's local build: ad hoc on a macOS host.
    if (platform === 'darwin' && host.startsWith('darwin-'))
      run('codesign', ['--sign', '-', '--force', file], { stdio: 'inherit' });
    const mismatch = binaryMismatch(file, target);
    if (mismatch) throw new Error(`Built ${name} ${mismatch} for ${target}.`);
    outputs[name] = sha256(readFileSync(file));
  }
  writeFileSync(
    join(buildDirectory, 'build.json'),
    `${JSON.stringify({ key, outputs }, null, 2)}\n`,
  );
  return release;
}

/**
 * Builds node-pty for `target` and stages it at `destination` (a directory
 * named `node-pty` beside the daemon), replacing whatever was there. A failed
 * build leaves nothing at `destination`. Returns the manifest.
 */
export function stageDaemonNodePty({
  root,
  target,
  destination,
  host = `${process.platform}-${process.arch}`,
  log = console.log,
  run = execFileSync,
}) {
  assertBuildableTarget(target, host);
  rmSync(destination, { recursive: true, force: true });
  const sources = resolveSources(root);
  const natives = nativeFilesFor(target);
  const { platform } = splitTarget(target);
  const key = {
    recipe: RECIPE,
    target,
    node: process.versions.node,
    nodePty: sources.packageJson.version,
    nodeAddonApi: sources.addonVersion,
    sources: digestSources(sources.packageDirectory, [
      'binding.gyp',
      'src',
      ...(platform === 'win32' ? ['deps'] : []),
    ]),
  };
  const release = buildFromSource({
    root,
    target,
    sources,
    key,
    natives,
    log,
    run,
    host,
  });

  const working = join(
    dirname(destination),
    `.${DAEMON_NODE_PTY_DIRECTORY}-staging-${process.pid}`,
  );
  rmSync(working, { recursive: true, force: true });
  try {
    const scripts = runtimeScripts(sources.packageDirectory);
    const copied = [
      { path: 'package.json', kind: 'package' },
      { path: 'LICENSE', kind: 'license' },
      ...scripts.map((path) => ({ path, kind: 'script' })),
    ];
    for (const { path, kind } of copied) {
      const from = join(sources.packageDirectory, ...path.split('/'));
      const to = join(working, ...path.split('/'));
      mkdirSync(dirname(to), { recursive: true });
      // The Linux package policy refuses loose source-map comments (CAN-4966).
      if (platform === 'linux' && kind === 'script')
        writeFileSync(
          to,
          blankSourceMapDirectives(readFileSync(from, 'utf8'), path),
        );
      else copyFileSync(from, to);
      chmodSync(to, 0o644);
    }
    mkdirSync(join(working, 'build', 'Release'), { recursive: true });
    for (const { path, kind } of natives) {
      const to = join(working, ...path.split('/'));
      copyFileSync(join(release, posix.basename(path)), to);
      chmodSync(to, kind === 'executable' ? 0o755 : 0o644);
    }
    const manifest = {
      schemaVersion: SCHEMA_VERSION,
      package: 'node-pty',
      version: sources.packageJson.version,
      target,
      build: 'node-gyp-source',
      node: {
        version: process.version,
        modules: process.versions.modules,
        napi: process.versions.napi,
      },
      files: [...copied, ...natives]
        .map(({ path, kind }) => describeFile(working, path, kind))
        .sort((left, right) => left.path.localeCompare(right.path)),
    };
    writeFileSync(
      join(working, DAEMON_NODE_PTY_MANIFEST),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    renameSync(working, destination);
    return manifest;
  } finally {
    rmSync(working, { recursive: true, force: true });
  }
}

const KINDS = new Set(['package', 'license', 'script', 'native', 'executable']);

function readManifest(directory, problems) {
  const path = join(directory, DAEMON_NODE_PTY_MANIFEST);
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    problems.push(`manifest is unreadable: ${error.message}`);
    return null;
  }
  if (
    typeof manifest !== 'object' ||
    manifest === null ||
    manifest.schemaVersion !== SCHEMA_VERSION ||
    manifest.package !== 'node-pty' ||
    typeof manifest.version !== 'string' ||
    !TARGETS.has(manifest.target) ||
    typeof manifest.node?.version !== 'string' ||
    !Array.isArray(manifest.files) ||
    !manifest.files.every(
      (file) =>
        typeof file?.path === 'string' &&
        KINDS.has(file.kind) &&
        Number.isSafeInteger(file.size) &&
        /^[0-9a-f]{64}$/.test(file.sha256 ?? ''),
    )
  ) {
    problems.push('manifest is malformed');
    return null;
  }
  return manifest;
}

/**
 * Checks a staged `node-pty` directory against its manifest: exactly the
 * listed files, each with its recorded size and hash, the target's native
 * files built for that target, and the expected target and Node when given.
 * `signed` accepts changed bytes in native files, which release signing
 * rewrites; their formats and architectures are still checked.
 */
export function inspectStagedDaemonNodePty(
  directory,
  { target, node, signed = false } = {},
) {
  const problems = [];
  if (!existsSync(directory) || !lstatSync(directory).isDirectory())
    return { manifest: null, problems: [`${directory} is not a directory`] };
  const manifest = readManifest(directory, problems);
  if (manifest === null) return { manifest, problems };
  if (target !== undefined && manifest.target !== target)
    problems.push(`staged for ${manifest.target}, expected ${target}`);
  if (node !== undefined && manifest.node.version !== node)
    problems.push(`built for Node ${manifest.node.version}, expected ${node}`);
  const listed = new Map(manifest.files.map((file) => [file.path, file]));
  for (const required of [
    { path: 'package.json', kind: 'package' },
    { path: 'lib/index.js', kind: 'script' },
    ...nativeFilesFor(manifest.target),
  ])
    if (listed.get(required.path)?.kind !== required.kind)
      problems.push(`manifest lacks ${required.kind} ${required.path}`);
  for (const file of manifest.files)
    if (SIGNABLE.has(file.kind) && !file.path.startsWith('build/Release/'))
      problems.push(`${file.path} is native outside build/Release`);
  const present = listFiles(directory, problems).filter(
    (path) => path !== DAEMON_NODE_PTY_MANIFEST,
  );
  for (const path of present)
    if (!listed.has(path)) problems.push(`${path} is not in the manifest`);
  for (const file of manifest.files) {
    const absolute = join(directory, ...file.path.split('/'));
    if (!present.includes(file.path)) {
      problems.push(`${file.path} is missing`);
      continue;
    }
    if (SIGNABLE.has(file.kind)) {
      const mismatch = binaryMismatch(absolute, manifest.target);
      if (mismatch) problems.push(`${file.path} ${mismatch}`);
      if (
        file.kind === 'executable' &&
        process.platform !== 'win32' &&
        (statSync(absolute).mode & 0o111) === 0
      )
        problems.push(`${file.path} is not executable`);
      if (signed) continue;
    }
    const actual = describeFile(directory, file.path, file.kind);
    if (actual.size !== file.size || actual.sha256 !== file.sha256)
      problems.push(`${file.path} differs from the manifest`);
  }
  return { manifest, problems };
}

/** Throws with every problem unless the staged directory checks out. */
export function assertStagedDaemonNodePty(directory, options) {
  const { manifest, problems } = inspectStagedDaemonNodePty(directory, options);
  if (problems.length > 0)
    throw new Error(
      `Staged daemon node-pty at ${directory} is invalid:\n${problems.map((problem) => `- ${problem}`).join('\n')}`,
    );
  return manifest;
}

/** `codesign -dv` facts for one file; `null` when it is unsigned. */
function readSignature(path) {
  const result = spawnSync('codesign', ['-d', '--verbose=2', path], {
    encoding: 'utf8',
  });
  if (result.status !== 0) return null;
  const text = `${result.stdout}${result.stderr}`;
  const team = /^TeamIdentifier=(.+)$/m.exec(text)?.[1] ?? 'not set';
  const flags = /^CodeDirectory .*flags=0x([0-9a-f]+)/m.exec(text)?.[1];
  return {
    team,
    runtime:
      flags !== undefined && (Number.parseInt(flags, 16) & 0x10000) !== 0,
  };
}

function verifySignature(path) {
  const result = spawnSync('codesign', ['--verify', '--strict', path], {
    encoding: 'utf8',
  });
  return result.status === 0 ? null : `${result.stderr}`.trim();
}

/**
 * The finished-app check for node-pty beside a staged daemon (afterSign).
 * The daemon keeps library validation, so every native file must carry the
 * daemon's Team ID; none may carry an entitlement in `forbidden`; and when the
 * daemon has the hardened runtime, so must they. JavaScript and the manifest
 * must match the staged bytes. Returns the problems found.
 */
export function inspectSignedDaemonNodePty({
  daemonPath,
  forbidden,
  readEntitlements,
  signature = readSignature,
  verify = verifySignature,
}) {
  const directory = join(dirname(daemonPath), DAEMON_NODE_PTY_DIRECTORY);
  const { manifest, problems } = inspectStagedDaemonNodePty(directory, {
    signed: true,
  });
  if (manifest === null) return problems;
  const daemon = signature(daemonPath);
  if (daemon === null) return [...problems, 'the daemon is unsigned'];
  for (const file of manifest.files) {
    if (!SIGNABLE.has(file.kind)) continue;
    const path = join(directory, ...file.path.split('/'));
    const facts = signature(path);
    if (facts === null) {
      problems.push(`${file.path} is unsigned`);
      continue;
    }
    const invalid = verify(path);
    if (invalid) problems.push(`${file.path} fails verification: ${invalid}`);
    if (facts.team !== daemon.team)
      problems.push(
        `${file.path} has Team ID ${facts.team}; the daemon has ${daemon.team}`,
      );
    if (daemon.runtime && !facts.runtime)
      problems.push(`${file.path} lacks the hardened runtime`);
    let entitlements;
    try {
      entitlements = readEntitlements(path);
    } catch (error) {
      problems.push(
        `${file.path} entitlements are unreadable: ${error.message}`,
      );
      continue;
    }
    for (const key of forbidden)
      if (Object.hasOwn(entitlements, key))
        problems.push(`${file.path} carries the main-app entitlement ${key}`);
  }
  return problems;
}

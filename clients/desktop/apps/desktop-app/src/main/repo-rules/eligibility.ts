import { lstat, realpath, readlink } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { hostOperatingSystem } from '@canopy/core-platform/host-platform';
import ignore, { type Ignore } from 'ignore';
import { readBounded, MAX_ENTRIES, safePath } from './safety';

/** Git metadata is read by the worker port only. No Git process on session reads. */
async function gitDir(root: string): Promise<string> {
  const marker = join(root, '.git');
  const stat = await lstat(marker);
  if (stat.isSymbolicLink()) throw new Error('unsupported-git');
  if (stat.isDirectory()) return realpath(marker);
  const text = await readBounded(root, '.git', 4096);
  const match = /^gitdir: ([^\r\n]+)\s*$/.exec(text);
  if (!match?.[1]) throw new Error('unsupported-git');
  return realpath(resolve(root, match[1]));
}
async function optional(
  root: string,
  path: string,
  limit = 65536,
): Promise<string> {
  try {
    return await readBounded(root, path, limit);
  } catch (e) {
    if (
      typeof e === 'object' &&
      e !== null &&
      'code' in e &&
      (e.code === 'ENOENT' || e.code === 'ENOTDIR')
    )
      return '';
    throw e;
  }
}
async function externalMetadata(path: string): Promise<string> {
  const stat = await lstat(path).catch(() => null);
  if (!stat) return '';
  // User config commonly aliases a regular dotfile. Canonicalize the trusted
  // metadata root rather than treating it as an instruction reference.
  const target = stat.isSymbolicLink()
    ? resolve(dirname(path), await readlink(path))
    : path;
  return optional(await realpath(dirname(target)), basename(target), 65536);
}
export function parseGitIndex(data: Buffer): Set<string> {
  if (data.length < 32 || data.toString('ascii', 0, 4) !== 'DIRC')
    throw new Error('unsupported-git');
  const version = data.readUInt32BE(4);
  const count = data.readUInt32BE(8);
  if (![2, 3, 4].includes(version) || count > 100000)
    throw new Error('unsupported-git');
  let offset = 12;
  let previous: Buffer = Buffer.alloc(0);
  const files = new Set<string>();
  for (let i = 0; i < count; i++) {
    const start = offset;
    if (offset + 62 > data.length - 20) throw new Error('unsupported-git');
    const flags = data.readUInt16BE(offset + 60);
    offset += 62;
    if ((flags & 0x4000) !== 0) offset += 2;
    let strip = 0;
    if (version === 4) {
      let byte = data[offset++];
      if (byte === undefined) throw new Error('unsupported-git');
      strip = byte & 0x7f;
      let n = 0;
      while ((byte & 0x80) !== 0) {
        byte = data[offset++];
        if (byte === undefined || n++ > 5) throw new Error('unsupported-git');
        strip = (strip + 1) * 128 + (byte & 0x7f);
      }
      if (strip > previous.length) throw new Error('unsupported-git');
    }
    const end = data.indexOf(0, offset);
    if (end < 0 || end - offset > 2048) throw new Error('unsupported-git');
    // V4 prefix compression can split a UTF-8 character; join bytes first.
    const suffix = data.subarray(offset, end);
    previous =
      version === 4
        ? Buffer.concat([previous.subarray(0, previous.length - strip), suffix])
        : suffix;
    files.add(previous.toString('utf8'));
    offset =
      version === 4 ? end + 1 : start + Math.ceil((end + 1 - start) / 8) * 8;
  }
  // Split and sparse indexes require another index/tree. Fail closed instead
  // of interpreting incomplete tracking metadata as an untracked checkout.
  const extensionEnd = data.length - 20;
  while (offset < extensionEnd) {
    if (offset + 8 > extensionEnd) throw new Error('unsupported-git');
    const signature = data.toString('ascii', offset, offset + 4);
    const size = data.readUInt32BE(offset + 4);
    if (
      signature === 'link' ||
      signature === 'sdir' ||
      offset + 8 + size > extensionEnd
    )
      throw new Error('unsupported-git');
    offset += 8 + size;
  }
  return files;
}
/** Decode supported single-line Git values; continuations fail closed. */
function parseGitConfigValue(value: string): string {
  let quoted = false;
  let escaped = false;
  let whitespace = '';
  let result = '';
  for (const character of value) {
    if (escaped) {
      switch (character) {
        case 'n':
          result += '\n';
          break;
        case 't':
          result += '\t';
          break;
        case 'b':
          result += '\b';
          break;
        case '\\':
        case '"':
          result += character;
          break;
        default:
          throw new Error('unsupported-git');
      }
      escaped = false;
      continue;
    }
    if (!quoted && (character === '#' || character === ';')) break;
    if (!quoted && (character === ' ' || character === '\t')) {
      if (result.length) whitespace += ' ';
      continue;
    }
    result += whitespace;
    whitespace = '';
    if (character === '"') quoted = !quoted;
    else if (character === '\\') escaped = true;
    else result += character;
  }
  if (quoted || escaped) throw new Error('unsupported-git');
  return result;
}
export interface Eligibility {
  ignorecase: boolean;
  tracked: Set<string>;
  global: Ignore;
  directories: Map<string, Ignore>;
  reads: number;
}
/**
 * The Git settings that change which rule files a session read may use, as
 * lower-case `section.key`. A system config or `includeIf` target that sets
 * one fails closed; add a key here when the reader starts to depend on it.
 */
export const GIT_ELIGIBILITY_KEYS: readonly string[] = Object.freeze([
  'core.excludesfile',
  'core.ignorecase',
  'extensions.objectformat',
  'extensions.worktreeconfig',
]);
/** Git's own `include.path` nesting limit. */
const MAX_INCLUDE_DEPTH = 10;
/** Config files one eligibility read follows through includes. */
const MAX_INCLUDED_FILES = 32;
const SECTION_HEADER = /^\s*\[([^\]]+)\]/;
const SETTING_KEY = /^\s*([A-Za-z][A-Za-z0-9-]*)(?=[ \t=#;]|$)/;

/** A section header's `section` or `section.subsection` name. */
function sectionName(header: string): string {
  const match = /^\s*([^\s"]+)\s*(?:"((?:[^"\\]|\\.)*)")?\s*$/.exec(header);
  if (!match?.[1]) return header.trim().toLowerCase();
  const name = match[1].toLowerCase();
  return match[2] === undefined ? name : `${name}.${match[2]}`;
}
function setsEligibilityKey(config: string): boolean {
  let section = '';
  for (const rawLine of config.split(/\r?\n/)) {
    const header = SECTION_HEADER.exec(rawLine);
    if (header) section = sectionName(header[1] ?? '');
    const line = header ? rawLine.slice(header[0].length) : rawLine;
    const key = SETTING_KEY.exec(line)?.[1]?.toLowerCase();
    if (key && GIT_ELIGIBILITY_KEYS.includes(`${section}.${key}`)) return true;
  }
  return false;
}
/** Where Git looks for an `include.path` value given in `file`. */
function includeTarget(value: string, file: string, home: string): string {
  if (value === '~' || value.startsWith('~/'))
    return join(home, value.slice(2));
  if (value.startsWith('~') || value.startsWith('%(prefix)'))
    throw new Error('unsupported-git');
  return resolve(dirname(file), value);
}
/**
 * The config with its includes followed as Git does: an `[include]` file's
 * settings take its place, relative paths resolve from the including file and
 * missing files are skipped. An `[includeIf]` target is read but its condition
 * is not evaluated: one that sets no eligibility key cannot change the result
 * and is left out, and one that does fails closed. So does a cycle (Git's
 * depth limit) or an include form this reader does not model.
 */
async function withIncludes(
  config: string,
  file: string,
  home: string,
  budget: { files: number },
  depth = 0,
): Promise<string> {
  const output: string[] = [];
  let header = '';
  let kind: 'include' | 'includeIf' | undefined;
  for (const rawLine of config.split(/\r?\n/)) {
    const section = SECTION_HEADER.exec(rawLine);
    let line = rawLine;
    if (section) {
      header = section[0].trim();
      const name = sectionName(section[1] ?? '');
      kind =
        name === 'include'
          ? 'include'
          : name.startsWith('includeif.')
            ? 'includeIf'
            : undefined;
      // Git ignores `[include "x"]`; other spellings are not modelled here.
      if (!kind && /^includeif\b/.test(name))
        throw new Error('unsupported-git');
      output.push(header);
      line = rawLine.slice(section[0].length);
    }
    const path = kind
      ? /^\s*path(?:\s*=\s*(.*)|\s*(?:[#;].*)?)$/i.exec(line)
      : null;
    if (!path) {
      if (!section || line.trim()) output.push(line);
      continue;
    }
    const value =
      path[1] === undefined ? undefined : parseGitConfigValue(path[1]);
    if (!value) throw new Error('unsupported-git');
    if (depth + 1 > MAX_INCLUDE_DEPTH) throw new Error('unsupported-git');
    if (++budget.files > MAX_INCLUDED_FILES) throw new Error('limit');
    const target = includeTarget(value, file, home);
    const included = await withIncludes(
      await externalMetadata(target),
      target,
      home,
      budget,
      depth + 1,
    );
    if (kind === 'includeIf') {
      if (setsEligibilityKey(included)) throw new Error('unsupported-git');
      continue;
    }
    // Lines after the include still belong to the including section.
    output.push(included, header);
  }
  return output.join('\n');
}
export async function eligibility(root: string): Promise<Eligibility> {
  const configCount = process.env['GIT_CONFIG_COUNT'];
  if (
    (configCount !== undefined && !/^0*$/.test(configCount)) ||
    process.env['GIT_CONFIG_PARAMETERS'] ||
    ['GIT_INDEX_FILE', 'GIT_DIR', 'GIT_COMMON_DIR', 'GIT_WORK_TREE'].some(
      (name) => process.env[name] !== undefined,
    )
  )
    throw new Error('unsupported-git');
  // Git finds ~/.gitconfig and expands ~/ from $HOME.
  const home = process.env['HOME'] || homedir();
  const budget = { files: 0 };
  const noSystem = process.env['GIT_CONFIG_NOSYSTEM'] ?? '';
  if (!/^(true|yes|on|1)$/i.test(noSystem)) {
    if (!/^(false|no|off|0)?$/i.test(noSystem))
      throw new Error('unsupported-git');
    const systemOverride = process.env['GIT_CONFIG_SYSTEM'];
    const executable = process.env['CANOPY_GIT_EXECUTABLE'];
    const operatingSystem = hostOperatingSystem();
    const systemPaths =
      systemOverride !== undefined
        ? systemOverride
          ? [resolve(root, systemOverride)]
          : []
        : [
            ...(operatingSystem === 'win32'
              ? process.env['ProgramData']
                ? [join(process.env['ProgramData'], 'Git/config')]
                : []
              : [
                  '/etc/gitconfig',
                  '/usr/local/etc/gitconfig',
                  ...(operatingSystem === 'darwin'
                    ? ['/opt/homebrew/etc/gitconfig']
                    : []),
                ]),
            ...(executable
              ? [
                  join(dirname(dirname(executable)), 'etc/gitconfig'),
                  join(dirname(dirname(dirname(executable))), 'etc/gitconfig'),
                ]
              : []),
          ];
    // System eligibility settings are unsupported, also through includes;
    // benign settings such as credential helpers must not disable optional
    // project rules.
    for (const path of Array.from(new Set(systemPaths))) {
      const config = await withIncludes(
        await externalMetadata(path),
        path,
        home,
        budget,
      );
      if (setsEligibilityKey(config)) throw new Error('unsupported-git');
    }
  }
  const git = await gitDir(root);
  let common = git;
  const commonPath = (await optional(git, 'commondir', 4096)).trim();
  if (commonPath) common = await realpath(resolve(git, commonPath));
  const tracked = await readIndex(git);
  const xdgHome = resolve(
    root,
    process.env['XDG_CONFIG_HOME'] || join(home, '.config'),
  );
  const globalPath = process.env['GIT_CONFIG_GLOBAL'];
  const globalFile =
    globalPath === undefined
      ? join(home, '.gitconfig')
      : resolve(root, globalPath);
  const xdgFile = join(xdgHome, 'git/config');
  const globalConfig =
    globalPath === ''
      ? ''
      : await withIncludes(
          await externalMetadata(globalFile),
          globalFile,
          home,
          budget,
        );
  const xdgConfig =
    globalPath === undefined
      ? await withIncludes(
          await externalMetadata(xdgFile),
          xdgFile,
          home,
          budget,
        )
      : '';
  const localConfig = await withIncludes(
    await optional(common, 'config'),
    join(common, 'config'),
    home,
    budget,
  );
  const config = `${xdgConfig}\n${globalConfig}\n${localConfig}`;
  if (/objectformat\s*=\s*sha256/i.test(config))
    throw new Error('unsupported-git');
  let exclude = join(xdgHome, 'git/ignore');
  // Only core.excludesfile has filesystem meaning here; includes are inlined.
  let sectionName = '';
  let worktreeConfig = false;
  let ignorecase = false;
  for (const rawLine of config.split(/\r?\n/)) {
    const section = /^\s*\[([^\]]+)\]/.exec(rawLine);
    if (section) sectionName = section[1]?.trim().toLowerCase() ?? '';
    const line = section ? rawLine.slice(section[0].length) : rawLine;
    // Worktree overrides are not part of this bounded metadata reader.
    if (
      sectionName === 'extensions' &&
      /^\s*worktreeconfig(?:[ \t=#;]|$)/i.test(line)
    ) {
      const value = /^\s*worktreeconfig\s*=\s*(.*)$/i.exec(line)?.[1];
      worktreeConfig =
        value === undefined ||
        !/^(false|no|off|0)?$/i.test(parseGitConfigValue(value));
    }
    const core = sectionName === 'core';
    const setting = core
      ? /^\s*(ignorecase|excludesfile)(?:\s*=\s*(.*)|\s*(?:[#;].*)?)$/i.exec(
          line,
        )
      : null;
    if (!setting?.[1]) {
      if (core && /^\s*(ignorecase|excludesfile)(?:[ \t=]|$)/i.test(line))
        throw new Error('unsupported-git');
      continue;
    }
    const value =
      setting[2] === undefined ? undefined : parseGitConfigValue(setting[2]);
    if (setting[1].toLowerCase() === 'ignorecase') {
      if (value === undefined || /^(true|yes|on|1)$/i.test(value))
        ignorecase = true;
      else if (/^(false|no|off|0)?$/i.test(value)) ignorecase = false;
      else throw new Error('unsupported-git');
    } else {
      if (value === undefined) throw new Error('unsupported-git');
      if (
        (value.startsWith('~') && !value.startsWith('~/')) ||
        value.startsWith('%(prefix)')
      )
        throw new Error('unsupported-git');
      exclude = value ? resolve(root, value.replace(/^~\//, `${home}/`)) : '';
    }
  }
  if (worktreeConfig) throw new Error('unsupported-git');
  const patterns = `${exclude ? await externalMetadata(exclude) : ''}\n${await optional(common, 'info/exclude')}`;
  return {
    tracked,
    ignorecase,
    global: ignore({ ignorecase }).add(patterns),
    directories: new Map(),
    reads: 0,
  };
}
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
async function readIndex(git: string): Promise<Set<string>> {
  const path = await safePath(git, 'index').catch((e: unknown) => {
    if (
      typeof e === 'object' &&
      e !== null &&
      'code' in e &&
      e.code === 'ENOENT'
    )
      return null;
    throw e;
  });
  if (!path) return new Set();
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 16 * 1024 * 1024)
      throw new Error('unsupported-git');
    const data = Buffer.alloc(stat.size + 1);
    let size = 0;
    while (size < data.length) {
      const result = await handle.read(data, size, data.length - size, size);
      if (!result.bytesRead) break;
      size += result.bytesRead;
    }
    const after = await handle.stat();
    if (size !== stat.size || stat.mtimeMs !== after.mtimeMs)
      throw new Error('changed');
    return parseGitIndex(data.subarray(0, size));
  } finally {
    await handle.close();
  }
}
export async function eligible(
  root: string,
  path: string,
  state: Eligibility,
): Promise<boolean> {
  if (state.tracked.has(path)) return true;
  let ignored = state.global.ignores(path);
  const parts = path.split('/');
  for (let n = 0; n < parts.length; n++) {
    const dir = parts.slice(0, n).join('/');
    if (n > 0) {
      // Git never consults a child .gitignore inside an ignored directory.
      // Root patterns may unignore that directory before traversal continues.
      let directoryIgnored = state.global.ignores(`${dir}/`);
      for (let parent = 0; parent < n; parent++) {
        const parentMatcher = state.directories.get(
          parts.slice(0, parent).join('/'),
        );
        const result = parentMatcher?.test(
          `${parts.slice(parent, n).join('/')}/`,
        );
        if (result?.ignored) directoryIgnored = true;
        if (result?.unignored) directoryIgnored = false;
      }
      if (directoryIgnored) return false;
    }
    let matcher = state.directories.get(dir);
    if (!matcher) {
      if (++state.reads > MAX_ENTRIES) throw new Error('limit');
      matcher = ignore({ ignorecase: state.ignorecase }).add(
        await optional(root, dir ? `${dir}/.gitignore` : '.gitignore'),
      );
      state.directories.set(dir, matcher);
    }
    const result = matcher.test(parts.slice(n).join('/'));
    if (result.ignored) ignored = true;
    if (result.unignored) ignored = false;
  }
  return !ignored;
}

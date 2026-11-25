/**
 * What a pipeline step's own declared environment may not hand a managed
 * harness runtime (Cursor, Copilot, OpenCode). These names make the dynamic
 * loader or a shell run code while the vendor process starts, before any
 * approval hook or plugin is in place, so a step could step outside its
 * permission preset:
 *
 * - loader and libc: `LD_*` (`LD_PRELOAD`, `LD_AUDIT`, `LD_LIBRARY_PATH`),
 *   `DYLD_*`, `GCONV_PATH`, `GLIBC_TUNABLES`;
 * - shell startup, which Cursor's Linux and macOS `cursor-agent` bash launcher
 *   reads: `BASH_ENV`, `ENV`, `SHELLOPTS`, `BASHOPTS`, `PS4` (expanded for
 *   each traced command under `xtrace`) and exported functions
 *   (`BASH_FUNC_*`).
 *
 * Only step-declared values are refused. The app's own inherited environment is
 * the person's login session (Linux CUDA or conda setups rely on its
 * `LD_LIBRARY_PATH`), so hosts merge it in unfiltered.
 */
const STARTUP_NAMES: readonly string[] = [
  'GCONV_PATH',
  'GLIBC_TUNABLES',
  'BASH_ENV',
  'ENV',
  'SHELLOPTS',
  'BASHOPTS',
  'PS4',
];

/**
 * A name a child process would not read as written. The OS keeps the
 * environment as `name=value` strings and a child takes the name up to the
 * first `=`, so a step key `BASH_ENV=/x` reaches it as `BASH_ENV`; a NUL ends
 * the string early the same way, and an empty name is never valid. Such a key
 * is refused whatever it spells.
 */
function isMalformedEnvironmentName(name: string): boolean {
  return name === '' || name.includes('=') || name.includes('\0');
}

/** `name` is compared upper-cased: Windows environment names ignore case. */
export function isStepStartupInjectionName(name: string): boolean {
  if (isMalformedEnvironmentName(name)) return true;
  const upper = name.toUpperCase();
  return (
    upper.startsWith('LD_') ||
    upper.startsWith('DYLD_') ||
    upper.startsWith('BASH_FUNC_') ||
    STARTUP_NAMES.includes(upper)
  );
}

/**
 * How a withheld step name is reported: upper-cased, and for a malformed key
 * only the part a child would read as the name, followed by `=…`, so the rest
 * of the key never reaches a transcript.
 */
export function stepEnvironmentNameLabel(name: string): string {
  if (!isMalformedEnvironmentName(name)) return name.toUpperCase();
  const read = name.split(/[=\0]/, 1)[0] ?? '';
  return read ? `${read.toUpperCase()}=…` : '(empty name)';
}

/** The step-declared names `withoutStepStartupInjection` drops, sorted. */
export function stepStartupInjectionNames(
  environment: Readonly<Record<string, string>> | undefined,
): string[] {
  return Array.from(
    new Set(
      Object.keys(environment ?? {})
        .filter(isStepStartupInjectionName)
        .map(stepEnvironmentNameLabel),
    ),
  ).sort();
}

/**
 * A step-declared environment without loader or shell-startup names, and
 * without any key a child would read as a different name.
 */
export function withoutStepStartupInjection(
  environment: Readonly<Record<string, string>>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).filter(
      ([name]) => !isStepStartupInjectionName(name),
    ),
  );
}

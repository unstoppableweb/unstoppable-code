import {
  BLOCKED_NAMES,
  BLOCKED_PREFIXES,
} from '@canopy/core-runtime/node/trusted-node-environment';
export { cleanTrustedNodeEnvironment } from '@canopy/core-runtime/node/trusted-node-environment';

function posixPattern(name: string): string {
  return name.replace(
    /[A-Z]/g,
    (letter) => `[${letter}${letter.toLowerCase()}]`,
  );
}

// Builtins only: an external filter could itself consume loader injection.
// Bash's readonly SHELLOPTS/BASHOPTS must be de-exported when unset refuses them.
export const TRUSTED_NODE_POSIX_SCRUB = `for entry in $(set); do
  name=\${entry%%=*}
  case "$name" in ${[
    ...BLOCKED_NAMES.map(posixPattern),
    ...BLOCKED_PREFIXES.map((prefix) => `${posixPattern(prefix)}*`),
  ].join(
    '|',
  )}) unset "$name" 2>/dev/null || export -n "$name" 2>/dev/null || exit 2 ;; esac
done`;

export const TRUSTED_NODE_WINDOWS_SCRUB = [
  ...BLOCKED_NAMES.map((name) => `set "${name}="`),
  ...BLOCKED_PREFIXES.map(
    (prefix) =>
      `for /f "tokens=1 delims==" %%V in ('set ${prefix} 2^>nul') do set "%%V="`,
  ),
].join('\r\n');

export function quoteTrustedNodePosixArg(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

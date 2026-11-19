export const BLOCKED_PREFIXES = ['NODE_', 'LD_', 'DYLD_', 'BASH_FUNC_'];
export const BLOCKED_NAMES = [
  'ELECTRON_RUN_AS_NODE',
  'ELECTRON_NO_ASAR',
  'BASH_ENV',
  'ENV',
  'SHELLOPTS',
  'BASHOPTS',
  'GCONV_PATH',
  'GLIBC_TUNABLES',
  'PYTHONSTARTUP',
  'PYTHONPATH',
  'OPENSSL_CONF',
  'OPENSSL_MODULES',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NPM_CONFIG_NODE_OPTIONS',
];

/** Only trusted application helpers, never authorized pipeline/MCP payloads. */
export function cleanTrustedNodeEnvironment(
  source: Readonly<NodeJS.ProcessEnv>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    const upper = name.toUpperCase();
    if (
      value !== undefined &&
      !BLOCKED_NAMES.includes(upper) &&
      !BLOCKED_PREFIXES.some((prefix) => upper.startsWith(prefix))
    )
      result[name] = value;
  }
  return result;
}

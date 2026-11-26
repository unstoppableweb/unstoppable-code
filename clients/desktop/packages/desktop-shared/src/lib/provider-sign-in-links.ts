/**
 * The sign-in pages providers send people to. The computer that runs a
 * sign-in checks each address before it publishes it, and a computer that
 * controls it through Remote Control checks again before it opens it, so a
 * controlled computer can never point a controller's browser elsewhere.
 */
export type ProviderSignInLinkKind = 'codex' | 'cursor';

const SIGN_IN_HOSTS: Readonly<Record<ProviderSignInLinkKind, string>> = {
  codex: 'auth.openai.com',
  cursor: 'cursor.com',
};

/**
 * Every host a remote sign-in may send a controller's browser to: the
 * published Codex and Cursor pages, GitHub's device page (Copilot and the
 * GitHub CLI), and the links Claude Code and Antigravity print.
 */
const REMOTE_SIGN_IN_HOSTS: ReadonlySet<string> = new Set([
  ...Object.values(SIGN_IN_HOSTS),
  'github.com',
  'claude.ai',
  'claude.com',
  'platform.claude.com',
  'console.anthropic.com',
  'accounts.google.com',
]);

function httpsUrl(value: string): URL | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  return url.protocol === 'https:' &&
    url.username === '' &&
    url.password === '' &&
    url.port === ''
    ? url
    : null;
}

/** Whether `value` is an https page on the provider's own sign-in host. */
export function isProviderSignInLink(
  kind: ProviderSignInLinkKind,
  value: string,
): boolean {
  return httpsUrl(value)?.hostname === SIGN_IN_HOSTS[kind];
}

/** Whether `value` is an https page on any provider's sign-in host. */
export function isRemoteSignInLink(value: string): boolean {
  const url = httpsUrl(value);
  return url !== null && REMOTE_SIGN_IN_HOSTS.has(url.hostname);
}

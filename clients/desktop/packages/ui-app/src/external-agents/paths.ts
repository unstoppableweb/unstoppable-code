export const EXTERNAL_AGENTS_PATH = '/account/external-agents';

export function externalAgentPath(connectionId: string): string {
  return `${EXTERNAL_AGENTS_PATH}/${encodeURIComponent(connectionId)}`;
}

/** The page where the person confirms or declines one waiting request. */
export function externalAgentConfirmationPath(pendingActionId: string): string {
  return `${EXTERNAL_AGENTS_PATH}/confirm/${encodeURIComponent(pendingActionId)}`;
}

export const EXTERNAL_AGENTS_LABEL = 'External agents (MCP)';

/** The web page that offers the desktop app download. */
export const DESKTOP_DOWNLOAD_PATH = '/download';

/**
 * Query parameter the desktop account menu adds when it opens the External
 * agents page, so the web host can hide the desktop download link. Cosmetic
 * and settable by anyone: nothing but that link may depend on it.
 */
export const EXTERNAL_AGENTS_FROM_PARAM = 'from';
export const EXTERNAL_AGENTS_FROM_DESKTOP = 'desktop';

/**
 * Adds `from=desktop` to `path`, using `&` when it already has a query and
 * keeping any `#fragment` last.
 */
export function externalAgentsPathFromDesktop(path: string): string {
  const hashIndex = path.indexOf('#');
  const base = hashIndex === -1 ? path : path.slice(0, hashIndex);
  const fragment = hashIndex === -1 ? '' : path.slice(hashIndex);
  const separator = base.includes('?') ? '&' : '?';
  return `${base}${separator}${EXTERNAL_AGENTS_FROM_PARAM}=${EXTERNAL_AGENTS_FROM_DESKTOP}${fragment}`;
}

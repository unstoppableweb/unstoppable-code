/**
 * Open an apps/web page already signed in. Main exchanges the desktop cloud
 * credential for a one-time code and opens the authenticated URL; when that
 * hand-off is unavailable (flag off, no cloud token, offline, mint failure, or
 * an older build without the handler) this falls back to a plain,
 * unauthenticated open. Failing to open the browser is never surfaced.
 */
export function openAuthenticatedCloudPage(path: string): void {
  const openUnauthenticated = (): void => {
    void window.api
      .getCanopyCloudBaseUrl()
      .then((base) => {
        if (!base) return;
        void window.api.browser
          .openExternal({ url: `${base}${path}` })
          .catch(() => {
            // No-op: failing to open the browser should not surface an error.
          });
      })
      .catch(() => {
        // No-op: base URL unavailable, nothing to open.
      });
  };

  try {
    void window.api.openAuthenticatedCloudPage(path).catch(openUnauthenticated);
  } catch {
    openUnauthenticated();
  }
}

/**
 * Open an apps/web page already signed in, reporting whether it opened.
 * Resolves `false` when the signed-in hand-off is unavailable or fails;
 * unlike {@link openAuthenticatedCloudPage} there is no unauthenticated
 * fallback, so callers can show that the page could not open.
 */
export async function openAuthenticatedCloudPageReported(
  path: string,
): Promise<boolean> {
  try {
    return await window.api.openAuthenticatedCloudPage(path);
  } catch {
    return false;
  }
}

/**
 * Open a full URL on the account's cloud already signed in, through
 * {@link openAuthenticatedCloudPage}. A URL that is not under the cloud base
 * goes to `openOther` instead, so no other site is ever opened signed in.
 */
export function openAuthenticatedCloudUrl(
  url: string,
  openOther: () => void,
): void {
  void window.api
    .getCanopyCloudBaseUrl()
    .then((base) => {
      const prefix = base ? base.replace(/\/+$/, '') : '';
      const path =
        prefix && url.startsWith(prefix) ? url.slice(prefix.length) : '';
      if (
        path.startsWith('/') &&
        !path.startsWith('//') &&
        !path.startsWith('/\\')
      ) {
        openAuthenticatedCloudPage(path);
        return;
      }
      openOther();
    })
    .catch(openOther);
}

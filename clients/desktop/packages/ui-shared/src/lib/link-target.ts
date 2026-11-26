/**
 * True for an absolute web URL, which opens in a new tab; in-app links are
 * relative. It reads only `href`, so server and browser render the same. The
 * desktop main process routes every navigation itself.
 */
export function opensInNewTab(href: string): boolean {
  return /^https?:\/\//i.test(href);
}

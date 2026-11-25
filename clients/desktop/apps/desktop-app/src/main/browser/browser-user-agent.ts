import { app, session, type Session } from 'electron';

/**
 * The user agent without Electron's own product token, so sites that refuse
 * embedded browsers (Google sign-in among them) see an ordinary Chromium.
 */
export function withoutElectronUserAgentToken(userAgent: string): string {
  return userAgent
    .split(/\s+/)
    .filter((product) => !/^Electron\/[^\s]+$/.test(product))
    .join(' ');
}

let fallbackStripped = false;

/**
 * A page popup's first request and its `navigator.userAgent` come from the
 * app-wide fallback, not from its session or its own `setUserAgent` (checked
 * on Electron 45, CAN-6497). The fallback drops the token once; the app's own
 * default session keeps the user agent it had, so the app renderer's
 * requests are unchanged. Every other session that never sets its own user
 * agent (Remote Control windows, visual previews, the cloud settings
 * partition) also drops the token once the first Browser tab session exists.
 */
function stripUserAgentFallback(): void {
  if (fallbackStripped) return;
  fallbackStripped = true;
  const appSession = session.defaultSession;
  appSession.setUserAgent(appSession.getUserAgent());
  app.userAgentFallback = withoutElectronUserAgentToken(app.userAgentFallback);
}

/**
 * Gives a Browser tab session the browser user agent, covering sub-resource,
 * service worker, and popup requests as well as the view's own. Idempotent:
 * stripping an already stripped value changes nothing.
 */
export function useBrowserUserAgent(tabSession: Session): void {
  stripUserAgentFallback();
  tabSession.setUserAgent(
    withoutElectronUserAgentToken(tabSession.getUserAgent()),
  );
}

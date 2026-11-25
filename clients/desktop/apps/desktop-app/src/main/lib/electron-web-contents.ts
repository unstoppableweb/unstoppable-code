import { webContents, type WebContents } from 'electron';

/**
 * Whether `value` is a live `WebContents` from Electron's own registry. A
 * window-open `createWindow` callback receives the guest inside untrusted
 * options; checking it against the registry keeps anything else from being
 * adopted as a view.
 */
export function isElectronWebContents(value: unknown): value is WebContents {
  if (typeof value !== 'object' || value === null) return false;
  const id: unknown = Reflect.get(value, 'id');
  if (typeof id !== 'number' || !Number.isSafeInteger(id)) return false;
  return webContents.fromId(id) === value;
}

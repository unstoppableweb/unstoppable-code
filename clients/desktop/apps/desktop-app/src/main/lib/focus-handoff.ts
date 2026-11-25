/** The parts of a `BrowserWindow` a focus hand-off reads. */
export interface FocusHandoffWindow {
  isDestroyed(): boolean;
  isFocused(): boolean;
  on(event: 'focus', listener: () => void): unknown;
  removeListener(event: 'focus', listener: () => void): unknown;
}

/** The parts of a `WebContents` a focus hand-off drives. */
export interface FocusHandoffContents {
  focus(): void;
  isDestroyed?(): boolean;
}

const pendingHandoffs = new WeakMap<FocusHandoffWindow, () => void>();

/**
 * Moves keyboard focus to `contents` inside `window` without bringing the
 * app forward.
 *
 * On macOS `webContents.focus()` also focuses the owning window, which
 * activates the whole app and puts it in front of whatever the person is
 * working in. A page can stay its window's first responder while the app is
 * in the background, so `webContents.isFocused()` is not a guard against
 * that. When the window does not hold OS focus, the hand-off waits for the
 * person to come back to it, and is dropped if `stillWanted` no longer holds
 * by then (they clicked somewhere else on the way in).
 */
export function handFocusWithoutActivating(
  window: FocusHandoffWindow,
  contents: FocusHandoffContents,
  stillWanted: () => boolean = () => true,
): void {
  if (window.isDestroyed() || contents.isDestroyed?.() === true) return;
  const previous = pendingHandoffs.get(window);
  if (previous) {
    window.removeListener('focus', previous);
    pendingHandoffs.delete(window);
  }
  if (window.isFocused()) {
    contents.focus();
    return;
  }
  const onFocus = (): void => {
    window.removeListener('focus', onFocus);
    if (pendingHandoffs.get(window) === onFocus) {
      pendingHandoffs.delete(window);
    }
    if (
      window.isDestroyed() ||
      contents.isDestroyed?.() === true ||
      !stillWanted()
    ) {
      return;
    }
    contents.focus();
  };
  pendingHandoffs.set(window, onFocus);
  window.on('focus', onFocus);
}

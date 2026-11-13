/**
 * The macOS dictionary lookup ("Look up") for a renderer's own right-click
 * menus. The chat message menu is rendered in the page, so it cancels the
 * native menu, and with it the lookup macOS offers there; its Look up row
 * asks main to show the dictionary instead.
 *
 * Panel pull-outs are `about:blank` windows that the main window's renderer
 * draws into, so their menus reach main from the main window's contents. The
 * lookup goes to the focused contents when it is the sender or a window the
 * sender opened, which is where the selection the menu was opened on lives.
 */

/** The part of a frame the lookup compares; `WebFrameMain` satisfies it. */
interface LookUpFrame {
  readonly frameToken: string;
  readonly top: { readonly frameToken: string } | null;
}

/** The part of an Electron `WebContents` the lookup uses. */
export interface LookUpContents {
  isDestroyed(): boolean;
  showDefinitionForSelection(): void;
  readonly mainFrame: { readonly frameToken: string };
  readonly opener: LookUpFrame | null;
}

/**
 * The contents whose selection the lookup reads: the focused contents when
 * the sender is it or opened it, else the sender.
 */
export function lookUpSelectionTarget<T extends LookUpContents>(
  sender: T,
  focused: T | null,
): T {
  if (focused === null || focused === sender || focused.isDestroyed()) {
    return sender;
  }
  const openerTop = focused.opener?.top ?? null;
  return openerTop !== null &&
    openerTop.frameToken === sender.mainFrame.frameToken
    ? focused
    : sender;
}

/** Shows the dictionary for the selection; only macOS has the lookup. */
export function lookUpSelection<T extends LookUpContents>(
  sender: T,
  focused: T | null,
  platform: NodeJS.Platform,
): void {
  if (platform !== 'darwin' || sender.isDestroyed()) return;
  lookUpSelectionTarget(sender, focused).showDefinitionForSelection();
}

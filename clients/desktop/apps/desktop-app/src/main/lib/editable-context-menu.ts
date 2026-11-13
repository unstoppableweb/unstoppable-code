import { clipboard, ipcMain, Menu } from 'electron';
import type {
  BrowserWindow,
  ContextMenuParams,
  MenuItemConstructorOptions,
  WebContents,
} from 'electron';
import { isE2eBuild } from './e2e-gate';

/**
 * Right-click menu for text fields (CAN-3378): Cut, Copy, Paste and Select
 * All in every editable field of every app window (main window, App Advisor
 * popout, panel pull-outs). Non-editable areas keep showing nothing.
 *
 * Attached from `browser-window-created`, which in-app browser tabs
 * (`WebContentsView`) never fire, so they keep their own behavior. A renderer
 * that cancels the DOM `contextmenu` event (the integrated terminal, Monaco)
 * never reaches the `context-menu` event here.
 *
 * Items call the emitting `webContents`' own edit commands rather than using
 * Electron roles, so the template is plain data and Paste dispatches a real
 * DOM `paste` event: composers attach pasted images exactly as for Cmd/Ctrl+V.
 *
 * E2E seam: `Menu.popup()` runs a native (modal on macOS) loop that would hang
 * a hidden Playwright window. In an E2E build (`isE2eBuild()`, a build-time
 * constant that is `false` in production) the menu is not shown. Instead each
 * presented menu is recorded on
 * `globalThis.__CANOPY_E2E_EDITABLE_CONTEXT_MENU__` as `{ count, windowId,
 * items }`, and specs choose an item by emitting
 * {@link E2E_EDITABLE_CONTEXT_MENU_CLICK_CHANNEL} on `ipcMain` with the item
 * id, which runs it against the window that presented the last menu.
 */

export type EditableContextMenuAction = 'cut' | 'copy' | 'paste' | 'selectAll';

export interface EditableContextMenuItem {
  id: EditableContextMenuAction;
  /** The labels of the app's own Edit menu (`role: 'editMenu'`). */
  label: string;
  /** Windows only: a display hint, as Chromium's own menu shows. */
  accelerator?: string;
  enabled: boolean;
}

export interface EditableContextMenuEnvironment {
  clipboardHasContent: boolean;
  platform: NodeJS.Platform;
}

interface EditableContextMenuE2eRecord {
  count: number;
  windowId: number;
  items: EditableContextMenuItem[];
}

declare global {
  // Evidence for the Electron UI automation spec; written only in E2E builds.
  var __CANOPY_E2E_EDITABLE_CONTEXT_MENU__:
    | EditableContextMenuE2eRecord
    | undefined;
}

export const E2E_EDITABLE_CONTEXT_MENU_CLICK_CHANNEL =
  'e2e:editable-context-menu-click';

const MENU_ITEMS: ReadonlyArray<{
  id: EditableContextMenuAction;
  label: string;
  accelerator: string;
}> = [
  { id: 'cut', label: 'Cut', accelerator: 'CmdOrCtrl+X' },
  { id: 'copy', label: 'Copy', accelerator: 'CmdOrCtrl+C' },
  { id: 'paste', label: 'Paste', accelerator: 'CmdOrCtrl+V' },
  { id: 'selectAll', label: 'Select All', accelerator: 'CmdOrCtrl+A' },
];

/**
 * The menu for a right-click, or `null` outside editable fields. Blink sets
 * `canPaste` whenever the field is editable, so Paste also requires clipboard
 * content, as in Chrome's own menu.
 */
export function buildEditableContextMenuItems(
  params: Pick<ContextMenuParams, 'isEditable' | 'editFlags'>,
  environment: EditableContextMenuEnvironment,
): EditableContextMenuItem[] | null {
  if (!params.isEditable) return null;
  const { editFlags } = params;
  const enabled: Record<EditableContextMenuAction, boolean> = {
    cut: editFlags.canCut,
    copy: editFlags.canCopy,
    paste: editFlags.canPaste && environment.clipboardHasContent,
    selectAll: editFlags.canSelectAll,
  };
  // macOS context menus show no shortcuts.
  const showAccelerators = environment.platform === 'win32';
  return MENU_ITEMS.map(
    ({ id, label, accelerator }): EditableContextMenuItem => ({
      id,
      label,
      ...(showAccelerators ? { accelerator } : {}),
      enabled: enabled[id],
    }),
  );
}

export function isEditableContextMenuAction(
  value: unknown,
): value is EditableContextMenuAction {
  return MENU_ITEMS.some((item) => item.id === value);
}

export function runEditableContextMenuAction(
  contents: WebContents,
  id: EditableContextMenuAction,
): void {
  if (contents.isDestroyed()) return;
  switch (id) {
    case 'cut':
      contents.cut();
      return;
    case 'copy':
      contents.copy();
      return;
    case 'paste':
      contents.paste();
      return;
    case 'selectAll':
      contents.selectAll();
      return;
  }
}

let e2eLastMenuContents: WebContents | null = null;
let e2eClickListenerRegistered = false;

/** Once per process: a per-window listener would run each click per window. */
function registerE2eClickListener(): void {
  if (e2eClickListenerRegistered) return;
  e2eClickListenerRegistered = true;
  ipcMain.on(
    E2E_EDITABLE_CONTEXT_MENU_CLICK_CHANNEL,
    (_event: unknown, id: unknown): void => {
      if (!isEditableContextMenuAction(id) || e2eLastMenuContents === null) {
        return;
      }
      runEditableContextMenuAction(e2eLastMenuContents, id);
    },
  );
}

function presentEditableContextMenu(
  window: BrowserWindow,
  contents: WebContents,
  items: EditableContextMenuItem[],
): void {
  if (isE2eBuild()) {
    e2eLastMenuContents = contents;
    globalThis.__CANOPY_E2E_EDITABLE_CONTEXT_MENU__ = {
      count: (globalThis.__CANOPY_E2E_EDITABLE_CONTEXT_MENU__?.count ?? 0) + 1,
      windowId: window.id,
      items,
    };
    return;
  }
  const template = items.map(
    (item): MenuItemConstructorOptions => ({
      label: item.label,
      enabled: item.enabled,
      ...(item.accelerator
        ? { accelerator: item.accelerator, registerAccelerator: false }
        : {}),
      click: (): void => {
        runEditableContextMenuAction(contents, item.id);
      },
    }),
  );
  // No x/y: the menu opens at the pointer, so renderer coordinates never need
  // converting under the app's page zoom.
  Menu.buildFromTemplate(template).popup({ window });
}

/**
 * A window's own page, or a page hosted in a view rather than in a window's
 * contents (early access: App Advisor's page, which moves between windows),
 * with the window holding it when the menu opens.
 */
type EditableContextMenuTarget =
  | BrowserWindow
  | {
      readonly contents: WebContents;
      readonly hostWindow: () => BrowserWindow | null;
    };

export function attachEditableContextMenu(
  target: EditableContextMenuTarget,
): void {
  const contents = 'contents' in target ? target.contents : target.webContents;
  const hostWindow =
    'contents' in target ? target.hostWindow : (): BrowserWindow => target;
  if (isE2eBuild()) registerE2eClickListener();
  // Every context-menu event supersedes a clipboard read still in flight, so
  // a slow read never opens a menu for an earlier click.
  let latestRequest = 0;
  contents.on('context-menu', (_event, params): void => {
    const request = ++latestRequest;
    if (!params.isEditable) return;
    void clipboardHasContent().then((hasContent): void => {
      if (request !== latestRequest || contents.isDestroyed()) return;
      const items = buildEditableContextMenuItems(params, {
        clipboardHasContent: hasContent,
        platform: process.platform,
      });
      if (items === null) return;
      const window = hostWindow();
      if (!window) return;
      presentEditableContextMenu(window, contents, items);
    });
  });
}

/** An unreadable clipboard leaves Paste to Blink's own `canPaste`. */
async function clipboardHasContent(): Promise<boolean> {
  try {
    const items = await clipboard.read();
    return items.some((item) => item.types.length > 0);
  } catch {
    return true;
  }
}

/** {@link attachEditableContextMenu} for a page hosted in a view. */
export function attachEditableContextMenuToContents(
  contents: WebContents,
  hostWindow: () => BrowserWindow | null,
): void {
  attachEditableContextMenu({ contents, hostWindow });
}

// ---------------------------------------------------------------------------
// Browser agent action contract
// ---------------------------------------------------------------------------
//
// The target, input, and command shapes that `@canopy/agent-actions`
// validates and the desktop host executes, plus the drawer tab discriminator
// that preferences persist. The rest of the in-app browser contract (the
// preload API, IPC payloads, and host-local fields) stays in
// `@canopy/execution-engine/types/browser`, which re-exports this module.

import type { BrowserProfileSelection } from '../browser-profiles';

/**
 * Compatibility discriminator retained by the current-UI-state wire shape.
 * `'browser'` identifies a relevant visible Browser panel.
 */
export type BrowserDrawerTabId = 'terminal' | 'browser';

// ---------------------------------------------------------------------------
// Console / network types
// ---------------------------------------------------------------------------

/** Severity of a captured console message. */
export type BrowserConsoleLevel =
  | 'log'
  | 'info'
  | 'warning'
  | 'error'
  | 'debug';

export interface BrowserJavaScriptDialogResponse {
  accept: boolean;
  promptText?: string;
}

// ---------------------------------------------------------------------------
// Automation types
// ---------------------------------------------------------------------------
//
// Backs {@link BrowserApi.automation} (called by the renderer UI and the App
// Advisor renderer dispatcher). The agent-facing `browser.*` actions reach the
// same `BrowserService` methods through `DispatchAction` and return an
// `AppAdvisorActionResponse` (backend plan), not a
// {@link BrowserAutomationResponse}. The command kinds below intentionally
// match the embedded-preload command `type` set (backend plan).

export type BrowserMouseButton = 'left' | 'right' | 'middle';
export type BrowserKeyModifier = 'Alt' | 'Control' | 'Meta' | 'Shift';
export type BrowserWaitForState =
  | 'visible'
  | 'hidden'
  | 'attached'
  | 'detached';
export type BrowserLoadState = 'load' | 'domcontentloaded' | 'network_idle';
export type BrowserScrollDirection = 'down' | 'up' | 'left' | 'right';

/**
 * An element target: a snapshot `ref`, or a `locator` optionally scoped by
 * `frame` (a frame ref or an iframe CSS selector).
 */
export type BrowserElementTarget =
  | { ref: string; locator?: never; frame?: never }
  | { locator: string; frame?: string; ref?: never };

/** No element target: the fields of {@link BrowserElementTarget} are absent. */
export interface BrowserNoElementTarget {
  ref?: never;
  locator?: never;
  frame?: never;
}

/** A file input: an element target, or the input a pending chooser belongs to. */
export type BrowserFileInputTarget =
  | (BrowserElementTarget & { chooserId?: never })
  | (BrowserNoElementTarget & { chooserId: string });

/**
 * Which options to choose: exactly one of `values`, `labels`, or `indexes`,
 * each a non-empty array. More than one entry is for a multiple select only.
 */
export type BrowserOptionChoice =
  | { values: string[]; labels?: never; indexes?: never }
  | { labels: string[]; values?: never; indexes?: never }
  | { indexes: number[]; values?: never; labels?: never };

/**
 * Where a drag ends: an element, a point, or an offset from the drag's start
 * point. Points (finite, non-negative) and offsets (finite, signed) are CSS
 * pixels in the top-level viewport.
 */
export type BrowserDragDestination =
  | (BrowserElementTarget & { x?: never; y?: never; dx?: never; dy?: never })
  | (BrowserNoElementTarget & { x: number; y: number; dx?: never; dy?: never })
  | (BrowserNoElementTarget & { dx: number; dy: number; x?: never; y?: never });

/**
 * One scroll mode. By amount: `direction`, with `pages` (0.1 to 10; 1 when
 * neither is given) or `pixels` (a positive integer up to 100,000), and an
 * optional element target that is the scroll container (the page when
 * absent). Into view: `intoView: true` and an element target. To text:
 * `toText`, searched in every frame or the `frame` scope.
 */
export type BrowserScrollMode =
  | ((BrowserElementTarget | BrowserNoElementTarget) & {
      direction: BrowserScrollDirection;
      pages?: number;
      pixels?: never;
      intoView?: never;
      toText?: never;
    })
  | ((BrowserElementTarget | BrowserNoElementTarget) & {
      direction: BrowserScrollDirection;
      pixels: number;
      pages?: never;
      intoView?: never;
      toText?: never;
    })
  | (BrowserElementTarget & {
      intoView: true;
      direction?: never;
      pages?: never;
      pixels?: never;
      toText?: never;
    })
  | {
      toText: string;
      /** Frame ref or iframe CSS selector; scopes the search. */
      frame?: string;
      ref?: never;
      locator?: never;
      direction?: never;
      pages?: never;
      pixels?: never;
      intoView?: never;
    };

/** Fields every receipt-producing command accepts. */
export interface BrowserActionCommonFields {
  /** Caller-supplied idempotency key, retained for the browser runtime's life. */
  actionId?: string;
  /** Bounds actionability and settle (or the wait, for wait_for). */
  timeoutMs?: number;
}

export type BrowserAutomationCommand =
  | (BrowserActionCommonFields & {
      kind: 'click';
      ref?: string;
      locator?: string;
      /** Frame ref or iframe CSS selector; scopes the locator only. */
      frame?: string;
      x?: number;
      y?: number;
      button?: BrowserMouseButton;
      clickCount?: number;
      modifiers?: BrowserKeyModifier[];
      /** Relative to the element's top-left corner. */
      position?: { x: number; y: number };
      /** Skip actionability and use the direct element action. */
      force?: boolean;
      dialogResponse?: BrowserJavaScriptDialogResponse;
    })
  | (BrowserActionCommonFields & {
      kind: 'fill';
      ref?: string;
      locator?: string;
      /** Frame ref or iframe CSS selector; scopes the locator only. */
      frame?: string;
      text: string;
    })
  | (BrowserActionCommonFields & {
      kind: 'press';
      key: string;
      ref?: string;
      locator?: string;
      /** Frame ref or iframe CSS selector; scopes the locator only. */
      frame?: string;
      dialogResponse?: BrowserJavaScriptDialogResponse;
    })
  | (BrowserActionCommonFields & {
      kind: 'focus';
      ref?: string;
      locator?: string;
      /** Frame ref or iframe CSS selector; scopes the locator only. */
      frame?: string;
    })
  | (BrowserActionCommonFields & {
      kind: 'wait_for';
      /** Exactly one of locator, text, url, or loadState. */
      locator?: string;
      /** Frame ref or iframe CSS selector; scopes locator or text only. */
      frame?: string;
      text?: string;
      /** Applies to locator and text; defaults to visible. */
      state?: BrowserWaitForState;
      /** A substring, or a glob when it contains `*`. */
      url?: string;
      loadState?: BrowserLoadState;
      /**
       * A download to finish. Without `downloadId`, the next download this
       * browser starts after the wait begins.
       */
      download?: { downloadId?: string };
      /** An upload to be attached, or to end without attaching. */
      upload?: { uploadId: string };
    })
  | (BrowserActionCommonFields & { kind: 'hover' } & (
        | (BrowserElementTarget & { x?: never; y?: never })
        /** A point: CSS pixels in the top-level viewport. */
        | (BrowserNoElementTarget & { x: number; y: number })
      ))
  | (BrowserActionCommonFields & { kind: 'scroll' } & BrowserScrollMode)
  | (BrowserActionCommonFields & {
      kind: 'drag';
      from: BrowserElementTarget;
      to: BrowserDragDestination;
      /** Interpolated pointer moves, an integer from 1 to 100 (default 10). */
      steps?: number;
      modifiers?: BrowserKeyModifier[];
    })
  | (BrowserActionCommonFields &
      BrowserElementTarget & {
        kind: 'set_checked';
        checked: boolean;
      })
  | (BrowserActionCommonFields &
      BrowserElementTarget &
      BrowserOptionChoice & {
        kind: 'select_option';
        /** Typed into a combobox before its options are read. */
        searchText?: string;
      })
  | (BrowserActionCommonFields &
      BrowserFileInputTarget & {
        kind: 'upload_files';
        /** Each a workspace-relative path, a finished task download, or a chat attachment. */
        /** Replaces the files the input holds. */
        files: BrowserUploadSource[];
      })
  | (BrowserActionCommonFields &
      BrowserElementTarget & {
        /** Drops the files on the target, as a user dragging them there would. */
        kind: 'drop_files';
        files: BrowserUploadSource[];
      })
  | (Pick<BrowserActionCommonFields, 'actionId'> &
      BrowserFileInputTarget & {
        /** Asks the user to choose files for the input; no timeout, like an approval. */
        kind: 'request_files';
        /** Why the agent asks, shown to the user as the agent's words. */
        purpose?: string;
      })
  | (BrowserActionCommonFields &
      (BrowserElementTarget | BrowserNoElementTarget) & {
        kind: 'type';
        text: string;
        /** Pause between characters, 0 to 500 ms; 0 when absent. */
        delayMs?: number;
      })
  | {
      kind: 'inspect';
      ref?: string;
      locator?: string;
      /** Frame ref or iframe CSS selector; scopes the locator only. */
      frame?: string;
      x?: number;
      y?: number;
    };

// ---------------------------------------------------------------------------
// Transfers (task files)
// ---------------------------------------------------------------------------

export type BrowserTransferStatus =
  | 'in_progress'
  | 'paused'
  | 'complete'
  | 'cancelled'
  | 'interrupted'
  | 'failed';

/** A file an agent names for upload. */
export type BrowserUploadSource =
  | { path: string; downloadId?: never; attachmentId?: never }
  | { downloadId: string; path?: never; attachmentId?: never }
  | {
      /** A file the user attached to the calling chat, by its file name. */
      attachmentId: string;
      path?: never;
      downloadId?: never;
    };

/** Paper sizes `browser.save_pdf` offers. */
export type BrowserPdfPaperFormat =
  | 'letter'
  | 'legal'
  | 'a4'
  | 'a3'
  | 'tabloid';

export interface BrowserSavePdfRequest {
  browserId: string;
  expectedRuntimeGeneration?: number;
  /** The file's name before `.pdf`; the page title when absent. */
  fileName?: string;
  landscape?: boolean;
  /** Prints backgrounds; on unless set to false. */
  printBackground?: boolean;
  /** 0.1 to 2; 1 when absent. */
  scale?: number;
  /** `letter` when absent. */
  paperFormat?: BrowserPdfPaperFormat;
  /** Pages to print, such as `1-3, 5`; all when absent. */
  pageRanges?: string;
  /** Adds the page URL and page numbers in the margins. */
  displayHeaderFooter?: boolean;
  actionId?: string;
  /** How long printing may take, up to 60,000 ms; 30,000 when absent. */
  timeoutMs?: number;
}

export interface BrowserProfileSwitchRequest {
  operationId: string;
  browserId: string;
  expectedRuntimeGeneration: number;
  selection: BrowserProfileSelection;
  mode: 'replace' | 'new-tab';
}

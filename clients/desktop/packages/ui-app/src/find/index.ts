export {
  hasClosestMethod,
  isBehindModal,
  isDialogTarget,
  isMacPlatform,
  isShortcutEvent,
  readTargetOwnerDocument,
  type ClosestCapableTarget,
  type ShortcutEventLike,
} from './shortcut-target';
export {
  EMPTY_FIND_CONTROLLER_STATE,
  SURFACE_FIND_BAR_SELECTOR,
  findControllerKey,
  getActiveFindController,
  getAvailableFindModes,
  getFindScopes,
  isHtmlElementInAnyRealm,
  isInsideSurfaceFindBar,
  useSurfaceFindStore,
  type FindController,
  type FindControllerState,
  type FindScopeOption,
  type FindSurfaceMode,
  type SurfaceFindState,
} from './surface-find-store';
export {
  readFindSurfaceElement,
  resolveFallbackFindTarget,
  resolveFindTarget,
  runFindShortcut,
  type FindShortcutEvent,
  type FindTarget,
} from './find-shortcut';
export { SurfaceFindHost } from './SurfaceFindHost';
export {
  CHAT_FIND_DEBOUNCE_MS,
  CHAT_FIND_MIN_LENGTH,
  CHAT_TRANSCRIPT_FIND_SELECTOR,
  useChatTranscriptFind,
  type ChatTranscriptFind,
  type ChatTranscriptFindOptions,
} from './useChatTranscriptFind';
export {
  DOM_TEXT_FIND_DEBOUNCE_MS,
  DOM_TEXT_FIND_MIN_LENGTH,
  useDomTextFind,
  type DomTextFind,
  type DomTextFindMode,
  type DomTextFindOptions,
  type DomTextFindSurfaceProps,
} from './useDomTextFind';
export type { DiagramSearchHandle } from './diagram-search-handle';
export {
  DIAGRAM_FIND_DEBOUNCE_MS,
  DIAGRAM_FIND_MIN_LENGTH,
  useDiagramFind,
  type DiagramFind,
  type DiagramFindOptions,
  type DiagramFindSurfaceProps,
} from './useDiagramFind';
export {
  TERMINAL_FIND_DEBOUNCE_MS,
  TERMINAL_FIND_MIN_LENGTH,
  useTerminalFind,
  type TerminalFind,
  type TerminalFindDecorations,
  type TerminalFindEntry,
  type TerminalFindOptions,
  type TerminalFindSurfaceProps,
} from './useTerminalFind';
export {
  EMPTY_PREVIEW_SEARCH_STATE,
  findFileTitle,
  useFilePreviewFindController,
  type FilePreviewFind,
  type FilePreviewFindOptions,
  type FilePreviewFindViewerProps,
} from './useFilePreviewFindController';
export { useFindShortcut } from './useFindShortcut';
export { useFindSurfaceShown } from './useFindSurfaceShown';
export {
  FindableFileViewer,
  type FindableFileViewerProps,
} from './FindableFileViewer';

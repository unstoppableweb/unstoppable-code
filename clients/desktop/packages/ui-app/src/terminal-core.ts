export {
  dataTransferHasFiles,
  formatFilePathsForTerminalPaste,
  resolveDroppedFilePaths,
  type TerminalFileDataTransfer,
} from './code/terminal/terminal-file-drop';
export {
  __resetTerminalFocusIntentForTests,
  clearTerminalFocusRequest,
  consumeTerminalFocusRequest,
  getTerminalFocusRequestRevision,
  requestTerminalFocus,
  subscribeTerminalFocusRequests,
} from './code/terminal/terminal-focus-intent';
export {
  consumePendingTerminalSpawn,
  requestTerminalSpawn,
  subscribeTerminalSpawnRequests,
  terminalSpawnRequestTargets,
  TERMINAL_SPAWN_REQUEST_TTL_MS,
  type TerminalSpawnRequest,
  type TerminalSpawnRequestMode,
} from './code/terminal/terminal-spawn-requests';
export {
  isUsableTerminalResizeCandidate,
  MIN_TERMINAL_RESIZE_COLS,
  MIN_TERMINAL_RESIZE_HEIGHT_PX,
  MIN_TERMINAL_RESIZE_ROWS,
  MIN_TERMINAL_RESIZE_WIDTH_PX,
  type TerminalResizeCandidate,
} from './code/terminal/terminal-resize-guard';
export { isTerminalTarget } from './code/terminal/terminal-dom';
export { TerminalSelectionMenu } from './code/terminal/TerminalSelectionMenu';
export {
  useTerminalCompletionNotices,
  type TerminalCompletionNotice,
  type TerminalCompletionNoticesOptions,
} from './code/terminal/useTerminalCompletionNotices';
export type { TerminalPanelHost } from './code/terminal/terminal-panel-host';

export { terminalPanelIdFor } from './code/terminal/terminal-panel-identity';
export { useTerminalRename } from './code/terminal/TerminalRenameDialog';

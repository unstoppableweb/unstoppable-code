// `core.update.*` (remote host updates): the status a desktop host reports,
// admission of check, download and apply, and the events stream. The host
// supplies the installer through `CoreUpdateHost`.
export {
  UPDATE_CHANNEL_FOR_FLAVOR,
  createCoreUpdateHandlers,
  type CoreUpdateHandlerOptions,
  type CoreUpdateHandlers,
  type CoreUpdateRemotePolicy,
} from './handlers';
export type {
  CoreUpdateHost,
  DesktopReleaseFlavor,
  DesktopFailedUpdateAttempt,
  DesktopUpdateAttempt,
  DesktopUpdateBlockers,
  DesktopUpdatePhase,
  DesktopUpdateSnapshot,
  DesktopUpdateSupport,
} from './ports';

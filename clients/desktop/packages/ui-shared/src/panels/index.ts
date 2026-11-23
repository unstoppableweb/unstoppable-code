/**
 * Canopy panels engine, ported from VS Code OSS (commit c4632cac).
 *
 * Framework-agnostic layout/geometry primitives shared by the desktop app and
 * the web app: sash (draggable divider), split view (1D resizable split), grid
 * (recursive 2D split tree with serialization), drag-and-drop observation,
 * drop-zone geometry, and the in-process drag transfer singleton.
 *
 * This subtree must stay pure: no React, no stores, no `window.api`, no
 * Electron, no Node APIs, and no runtime dependencies (type-only imports of
 * `@canopy/protocol` wire unions are allowed — they erase at compile time).
 * Serialized grid shapes are engine-level and unversioned; persist them
 * wrapped in the versioned envelope defined in `@canopy/protocol`.
 */

export * from './grid';

export * from './collapse-eligibility';
export * from './grid-leaf-adapter';
export * from './registry-types';

export {
  Sash,
  SashState,
  OrthogonalEdge,
  setGlobalSashSize,
  setGlobalHoverDelay,
  type IBoundarySashes,
  type IHorizontalSashLayoutProvider,
  type IHorizontalSashOptions,
  type ISashEvent,
  type ISashOptions,
  type IVerticalSashLayoutProvider,
  type IVerticalSashOptions,
} from './sash';

export {
  SplitView,
  type ISashItem,
  type ISplitViewDescriptor,
  type ISplitViewOptions,
  type ISplitViewStyles,
  type IView as ISplitViewView,
} from './splitview';

export { setPanelErrorSink, type PanelErrorSink } from './panel-error-sink';
export * from './dnd-observer';
export * from './drop-geometry';
export * from './panel-content-adoption';
export * from './transfer';
export * from './disposable';
export * from './emitter';
export * from './window-registry';

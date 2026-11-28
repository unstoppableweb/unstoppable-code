/**
 * Per-worktree panel-layout persistence transport (VS Code-style panel grid,
 * Phase 5).
 *
 * The persisted grid file shape itself lives in `@canopy/protocol/panels`
 * (`SerializablePanelLayoutFile`, version-gated and read exclusively through
 * `migratePanelLayout`). This module defines the separate layout-mode file
 * shape, both sets of IPC request/response wrappers, and the renderer-facing
 * `window.api.panelLayout` surface. The grid's on-disk location is
 * `workspaces/{workspaceId}/worktree-data/{worktreeId}/panel-layout.json` (see
 * `getWorktreePanelLayoutFilePath` in the desktop app's paths module).
 */
import type { SerializablePanelLayoutFile } from '@canopy/protocol/panels';
import {
  isWorkspaceLayoutMode,
  type WorkspaceLayoutMode,
} from '@canopy/protocol/preferences';

export {
  WORKSPACE_LAYOUT_MODES,
  isWorkspaceLayoutMode,
} from '@canopy/protocol/preferences';
export type { WorkspaceLayoutMode } from '@canopy/protocol/preferences';

export interface PanelLayoutModeFileV1 {
  version: 1;
  mode: WorkspaceLayoutMode;
}

export function isPanelLayoutModeFileV1(
  value: unknown,
): value is PanelLayoutModeFileV1 {
  return (
    typeof value === 'object' &&
    value !== null &&
    'version' in value &&
    value.version === 1 &&
    'mode' in value &&
    isWorkspaceLayoutMode(value.mode)
  );
}

export interface LoadWorktreeModeRequest {
  projectId: string;
  worktreeId: string;
}

export interface LoadWorktreeModeResponse {
  mode: WorkspaceLayoutMode | null;
}

export interface InitializeWorktreeModeRequest {
  projectId: string;
  worktreeId: string;
  mode: WorkspaceLayoutMode;
}

export interface InitializeWorktreeModeResponse {
  mode: WorkspaceLayoutMode;
}

export interface SaveWorktreeModeRequest {
  projectId: string;
  worktreeId: string;
  mode: WorkspaceLayoutMode;
}

export type SaveWorktreeModeResponse = void;

export interface LoadWorktreePanelLayoutRequest {
  projectId: string;
  worktreeId: string;
}

export interface LoadWorktreePanelLayoutResponse {
  /**
   * The raw parsed persisted layout, or `null` when no readable JSON file
   * exists. The renderer must run legacy pre-validation transforms before
   * validating with `migratePanelLayout`.
   */
  layout: unknown;
}

export interface SaveWorktreePanelLayoutRequest {
  projectId: string;
  worktreeId: string;
  layout: SerializablePanelLayoutFile;
  /** False only for automatic hydration/container geometry saves. */
  hasUserChanges?: boolean;
}

export interface DeleteWorktreePanelLayoutRequest {
  projectId: string;
  worktreeId: string;
}

/**
 * Which UX surface a default panel-layout template belongs to. Code worktrees
 * and Cowork workspaces keep independent default templates: `'code'` maps to
 * the original `default-panel-layout.json` (read-compat with defaults saved
 * before surfaces existed), `'cowork'` to `default-panel-layout.cowork.json`.
 */
export const PANEL_LAYOUT_SURFACES = ['code', 'cowork'] as const;
export type PanelLayoutSurface = (typeof PANEL_LAYOUT_SURFACES)[number];

export function isPanelLayoutSurface(
  value: unknown,
): value is PanelLayoutSurface {
  return value === 'code' || value === 'cowork';
}

/**
 * Save the current layout as the per-surface default template used to seed
 * newly created worktrees (or cowork workspaces) of that surface. The layout
 * is a templatized `SerializablePanelLayoutFile` (instance-bound content
 * genericized by the renderer before it reaches here); the main store
 * validates it with `migratePanelLayout` before writing.
 */
export interface SaveDefaultPanelLayoutRequest {
  surface: PanelLayoutSurface;
  layout: SerializablePanelLayoutFile;
}

export interface LoadDefaultPanelLayoutRequest {
  surface: PanelLayoutSurface;
}

export interface LoadDefaultPanelLayoutResponse {
  /**
   * The validated default layout template for the requested surface, or
   * `null` when no default has been saved or the file failed validation (the
   * renderer then builds the hardcoded default layout for that surface).
   */
  layout: SerializablePanelLayoutFile | null;
}

/**
 * Renderer-facing panel-layout persistence API exposed on
 * `window.api.panelLayout`.
 */
export interface PanelLayoutApi {
  loadWorktreeLayout(
    request: LoadWorktreePanelLayoutRequest,
  ): Promise<LoadWorktreePanelLayoutResponse>;
  saveWorktreeLayout(request: SaveWorktreePanelLayoutRequest): Promise<void>;
  deleteWorktreeLayout(
    request: DeleteWorktreePanelLayoutRequest,
  ): Promise<void>;
  loadWorktreeMode(
    request: LoadWorktreeModeRequest,
  ): Promise<LoadWorktreeModeResponse>;
  initializeWorktreeMode(
    request: InitializeWorktreeModeRequest,
  ): Promise<InitializeWorktreeModeResponse>;
  saveWorktreeMode(
    request: SaveWorktreeModeRequest,
  ): Promise<SaveWorktreeModeResponse>;
  saveDefaultLayout(request: SaveDefaultPanelLayoutRequest): Promise<void>;
  loadDefaultLayout(
    request: LoadDefaultPanelLayoutRequest,
  ): Promise<LoadDefaultPanelLayoutResponse>;
}

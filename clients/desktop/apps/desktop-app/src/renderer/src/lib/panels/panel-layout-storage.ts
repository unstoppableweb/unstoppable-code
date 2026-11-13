import {
  isWorkspaceLayoutMode,
  type LoadWorktreeModeRequest,
  type LoadWorktreeModeResponse,
  type LoadWorktreePanelLayoutRequest,
  type LoadWorktreePanelLayoutResponse,
  type SaveWorktreeModeRequest,
  type SaveWorktreePanelLayoutRequest,
  type WorkspaceLayoutMode,
} from '@canopy/desktop-shared/types';
import { reportClientAppError } from '@canopy/desktop-instrumentation/client';

const STORAGE_KEY = 'canopy.webCorePanelLayouts.v1';
/** Layouts kept for cloud tasks; the least recently saved drop first. */
const STORED_LAYOUT_LIMIT = 200;

interface StoredScope {
  layout?: unknown;
  mode?: WorkspaceLayoutMode;
}

type StoredScopes = Record<string, StoredScope>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function readScopes(): StoredScopes {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw === null ? null : JSON.parse(raw);
    if (!isRecord(parsed)) return {};
    const scopes: StoredScopes = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (!isRecord(value)) continue;
      scopes[key] = {
        ...('layout' in value ? { layout: value.layout } : {}),
        ...(isWorkspaceLayoutMode(value.mode) ? { mode: value.mode } : {}),
      };
    }
    return scopes;
  } catch (error) {
    reportClientAppError(error);
    return {};
  }
}

function writeScope(key: string, patch: StoredScope): void {
  const scopes = readScopes();
  const next: StoredScope = { ...scopes[key], ...patch };
  delete scopes[key];
  const kept = Object.entries(scopes).slice(-(STORED_LAYOUT_LIMIT - 1));
  try {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(Object.fromEntries([...kept, [key, next]])),
    );
  } catch (error) {
    // Storage full or unavailable: the layout still holds for this session.
    reportClientAppError(error);
  }
}

function scopeKey(request: { projectId: string; worktreeId: string }): string {
  return `${request.projectId}/${request.worktreeId}`;
}

/**
 * A cloud task's panel layout and layout mode, kept in this renderer's
 * storage (CAN-6175 D5). Main resolves layout files from local project and
 * worktree ids and must never receive a web core id; callers use this for a
 * web core scope and `window.api.panelLayout` otherwise.
 */
export const webCorePanelLayouts = {
  loadLayout: (
    request: LoadWorktreePanelLayoutRequest,
  ): LoadWorktreePanelLayoutResponse => ({
    layout: readScopes()[scopeKey(request)]?.layout ?? null,
  }),
  saveLayout: (request: SaveWorktreePanelLayoutRequest): void => {
    writeScope(scopeKey(request), {
      layout: {
        ...request.layout,
        hasUserChanges: request.hasUserChanges !== false,
      },
    });
  },
  loadMode: (request: LoadWorktreeModeRequest): LoadWorktreeModeResponse => ({
    mode: readScopes()[scopeKey(request)]?.mode ?? null,
  }),
  saveMode: (request: SaveWorktreeModeRequest): void => {
    writeScope(scopeKey(request), { mode: request.mode });
  },
};

import type { CanopyCapabilities } from '@canopy/app-core';
import type { SearchPaletteScope } from '@canopy/ui-shared/components';
import type {
  SearchPaletteItem,
  SearchPaletteItemKind,
} from './search-palette-items';

/**
 * The palette's scopes, the tabs along its bottom edge. `all` searches every
 * kind; the others narrow results to a few kinds. Agents, plugins and skills
 * are reachable from All only.
 */
export type SearchPaletteScopeId =
  | 'all'
  | 'actions'
  | 'chats'
  | 'worktrees'
  | 'workflows'
  | 'content';

const SEARCH_PALETTE_SCOPES: readonly SearchPaletteScope<SearchPaletteScopeId>[] =
  [
    { value: 'all', label: 'All', dataTestId: 'command-palette-scope-all' },
    {
      value: 'actions',
      label: 'Actions',
      dataTestId: 'command-palette-scope-actions',
    },
    {
      value: 'chats',
      label: 'Chats',
      dataTestId: 'command-palette-scope-chats',
    },
    {
      value: 'worktrees',
      label: 'Worktrees',
      dataTestId: 'command-palette-scope-worktrees',
    },
    {
      value: 'workflows',
      label: 'Workflows',
      dataTestId: 'command-palette-scope-workflows',
    },
    {
      value: 'content',
      label: 'Content',
      dataTestId: 'command-palette-scope-content',
    },
  ];

/** The field's placeholder names what the current scope searches. */
const SCOPE_PLACEHOLDER: Readonly<Record<SearchPaletteScopeId, string>> = {
  all: 'Search chats, workspaces, plugins, settings, and more',
  actions: 'Search actions and settings',
  chats: 'Search chats',
  worktrees: 'Search worktrees',
  workflows: 'Search workflows and scheduled workflows',
  content: 'Search text in chats and plans',
};

/** All on a host that lists only chats and worktrees. */
const SNAPSHOT_ONLY_ALL_PLACEHOLDER = 'Search chats and worktrees';

/** Says why a scope is unavailable: only the desktop app can search it. */
const UNAVAILABLE_SCOPE_TOOLTIP = 'Search this in the desktop app';

type CapabilityScope = 'actions' | 'workflows' | 'content';

function isCapabilityScope(
  scope: SearchPaletteScopeId,
): scope is CapabilityScope {
  return scope === 'actions' || scope === 'workflows' || scope === 'content';
}

/**
 * The tabs a host can search. Chats and worktrees come from the sidebar
 * every host has; Actions, Workflows and Content need the host's
 * `searchPalette` capability and otherwise render unavailable, with a
 * tooltip saying where they work.
 */
export function searchPaletteScopesFor(
  capabilities: CanopyCapabilities | undefined,
): readonly SearchPaletteScope<SearchPaletteScopeId>[] {
  const served = capabilities?.searchPalette;
  return SEARCH_PALETTE_SCOPES.map((scope) =>
    isCapabilityScope(scope.value) && served?.[scope.value] !== true
      ? { ...scope, unavailable: true, tooltip: UNAVAILABLE_SCOPE_TOOLTIP }
      : scope,
  );
}

/** The field's placeholder for `scope`, naming only what the host lists. */
export function searchPalettePlaceholder(
  scopes: readonly SearchPaletteScope<SearchPaletteScopeId>[],
  scope: SearchPaletteScopeId,
): string {
  if (
    scope === 'all' &&
    scopes.every(
      (entry) => !isCapabilityScope(entry.value) || entry.unavailable === true,
    )
  ) {
    return SNAPSHOT_ONLY_ALL_PLACEHOLDER;
  }
  return SCOPE_PLACEHOLDER[scope];
}

const SCOPE_KINDS: Readonly<
  Record<
    Exclude<SearchPaletteScopeId, 'all'>,
    ReadonlySet<SearchPaletteItemKind>
  >
> = {
  actions: new Set(['command', 'setting']),
  chats: new Set(['chat', 'archive']),
  worktrees: new Set(['worktree']),
  workflows: new Set(['pipeline', 'automation', 'watcher']),
  content: new Set(['plan', 'chat-content']),
};

/** Whether the deferred content search runs in `scope`. */
export function searchPaletteScopeSearchesContent(
  scope: SearchPaletteScopeId,
): boolean {
  return scope === 'all' || scope === 'content';
}

/** The items `scope` lists; All keeps every item. */
export function filterSearchPaletteItemsByScope<T extends SearchPaletteItem>(
  items: readonly T[],
  scope: SearchPaletteScopeId,
): readonly T[] {
  if (scope === 'all') return items;
  const kinds = SCOPE_KINDS[scope];
  return items.filter((item) => kinds.has(item.kind));
}

/**
 * The scope after `scope` among `scopes`, wrapping, one step backwards with
 * `reverse`. Unavailable scopes are stepped over, as in the tabs.
 */
export function nextSearchPaletteScope(
  scopes: readonly SearchPaletteScope<SearchPaletteScopeId>[],
  scope: SearchPaletteScopeId,
  reverse: boolean,
): SearchPaletteScopeId {
  const index = scopes.findIndex((entry) => entry.value === scope);
  const step = reverse ? -1 : 1;
  for (let offset = 1; offset <= scopes.length; offset += 1) {
    const next =
      scopes[
        (((index + step * offset) % scopes.length) + scopes.length) %
          scopes.length
      ];
    if (next !== undefined && next.unavailable !== true) return next.value;
  }
  return scope;
}

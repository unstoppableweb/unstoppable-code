import type { SearchPaletteScope } from '@canopy/ui-shared/components';
import {
  PALETTE_SECTION_BY_KIND,
  PALETTE_SECTION_CAP,
  PALETTE_SECTION_ORDER,
  type PaletteItem,
  type PaletteItemKind,
} from './paletteItems';
import {
  type PaletteFlatEntry,
  type PaletteRanking,
  type PaletteSection,
  type RankedPaletteItem,
} from './paletteRanking';

/**
 * The palette's scopes, the tabs along its bottom edge. `all` searches every
 * kind; the others narrow results to a few kinds. Agents, plugins and skills
 * are reachable from All only.
 */
export type PaletteScope =
  | 'all'
  | 'actions'
  | 'chats'
  | 'worktrees'
  | 'workflows'
  | 'content';

export const PALETTE_SCOPES: readonly SearchPaletteScope<PaletteScope>[] = [
  { value: 'all', label: 'All', dataTestId: 'command-palette-scope-all' },
  {
    value: 'actions',
    label: 'Actions',
    dataTestId: 'command-palette-scope-actions',
  },
  { value: 'chats', label: 'Chats', dataTestId: 'command-palette-scope-chats' },
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
export const PALETTE_SCOPE_PLACEHOLDER: Readonly<Record<PaletteScope, string>> =
  {
    all: 'Search chats, workspaces, plugins, settings, and more',
    actions: 'Search actions and settings',
    chats: 'Search chats',
    worktrees: 'Search worktrees',
    workflows: 'Search workflows and scheduled workflows',
    content: 'Search text in chats and plans',
  };

const SCOPE_KINDS: Readonly<
  Record<Exclude<PaletteScope, 'all'>, ReadonlySet<PaletteItemKind>>
> = {
  actions: new Set(['command', 'setting']),
  chats: new Set(['chat', 'archive']),
  worktrees: new Set(['worktree']),
  workflows: new Set(['pipeline', 'automation', 'watcher']),
  content: new Set(['plan', 'chat-content']),
};

/** Whether `kind` is listed in `scope`. */
export function isKindInScope(
  kind: PaletteItemKind,
  scope: PaletteScope,
): boolean {
  return scope === 'all' || SCOPE_KINDS[scope].has(kind);
}

/** Whether the deferred transcript and plan-text search runs in `scope`. */
export function scopeSearchesContent(scope: PaletteScope): boolean {
  return scope === 'all' || scope === 'content';
}

/** The items `scope` lists; All keeps every item. */
export function filterItemsByScope(
  items: readonly PaletteItem[],
  scope: PaletteScope,
): readonly PaletteItem[] {
  if (scope === 'all') return items;
  return items.filter((item) => isKindInScope(item.kind, scope));
}

/** The scope after `scope`, wrapping, one step backwards with `reverse`. */
export function nextPaletteScope(
  scope: PaletteScope,
  reverse: boolean,
): PaletteScope {
  const index = PALETTE_SCOPES.findIndex((entry) => entry.value === scope);
  const step = reverse ? -1 : 1;
  const next =
    PALETTE_SCOPES[
      (index + step + PALETTE_SCOPES.length) % PALETTE_SCOPES.length
    ];
  return next?.value ?? 'all';
}

/**
 * The empty-query view of a narrowed scope: its kinds in canonical section
 * order, newest first (commands with shortcuts first, then by name), capped
 * like a search result section. All keeps the Recent + Commands view.
 */
export function rankScopeWithoutQuery(
  items: readonly PaletteItem[],
  expandedSectionIds: ReadonlySet<string>,
): PaletteRanking {
  const sections: PaletteSection[] = [];
  for (const kind of PALETTE_SECTION_ORDER) {
    const ranked: RankedPaletteItem[] = items
      .filter((item) => item.kind === kind)
      // Equal scores keep the default selection on the first displayed row;
      // timestamps sort only within each canonical section below.
      .map((item) => ({ item, score: 0, titleIndices: [] }))
      .sort((a, b) =>
        kind === 'command'
          ? Number(Boolean(b.item.shortcut)) -
              Number(Boolean(a.item.shortcut)) ||
            a.item.title.localeCompare(b.item.title)
          : (b.item.timestamp ?? 0) - (a.item.timestamp ?? 0),
      );
    if (ranked.length === 0) continue;
    const meta = PALETTE_SECTION_BY_KIND[kind];
    const visible = expandedSectionIds.has(meta.id)
      ? ranked
      : ranked.slice(0, PALETTE_SECTION_CAP);
    sections.push({
      id: meta.id,
      label: meta.label,
      items: visible,
      truncated: ranked.length - visible.length,
    });
  }
  return {
    sections,
    flat: sections.flatMap((section): PaletteFlatEntry[] => [
      ...section.items.map(
        (ranked): PaletteFlatEntry => ({
          type: 'item',
          id: ranked.item.id,
          ranked,
        }),
      ),
      ...(section.truncated > 0
        ? [
            {
              type: 'show-more' as const,
              id: `show-more:${section.id}`,
              sectionId: section.id,
              count: section.truncated,
              visibleItemCount: section.items.length,
            },
          ]
        : []),
    ]),
  };
}

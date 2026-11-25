/**
 * Reopens an activity rail that Canopy — not the user — collapsed by default
 * (CAN-2836), the first time a code worktree produces work worth showing.
 * Cowork rails never reopen themselves (CAN-4793): a finished reply must not
 * narrow the chat, so the user opens the rail from its collapsed edge bar.
 *
 * The decision lives on the persisted `collapsed` descriptor itself
 * (`PanelCollapsedState.auto`), so it needs no side-channel marker and no
 * module-level latch: the flag IS the latch, and whichever expand spends it —
 * this one or the user's own click — clears `collapsed` outright. A rail the
 * user collapsed by hand carries no flag and is never reopened.
 *
 * The hook lives in `SharedActivityPanelAdapter` so the content signal and the
 * rendered rail cannot drift: it consumes the very same `sectionHasContent`
 * map the shared panel renders from. That works while the rail is shut because
 * a collapsed group's content stays mounted — the body is hidden with CSS only
 * (`PanelContentRoot`/`panels.css`). A rail that is shut when its worktree is
 * shown mounts a moment later, once the browser is idle
 * (`useHiddenRailContentMounted`), so the first check runs then.
 * `usePanelPlacement()` supplies the
 * real group id, which is what makes Minimal (Work) mode work through the same
 * code path even though its rail is `group-extras`.
 *
 * Scope: the full rail only. A single activity section dragged out as its own
 * `activity-card` panel has no adapter, so it neither triggers nor receives an
 * auto-expand.
 */

import { useEffect } from 'react';
import {
  isActivitySectionVisibleForWorkspaceType,
  isWorkActivitySection,
} from '@canopy/app-state';
import type {
  ActivitySectionId,
  ActivitySurface,
} from '@canopy/desktop-shared/types';
import { usePanelPlacement } from '@/lib/panels/panel-placement-context';
import { expandActivityRailFromContent } from '@/lib/panels/persistence-bridge';
import { usePanelLayoutStore } from '@/stores/panelLayoutStore';

export interface AutoExpandActivityRailOptions {
  /** Which activity surface the adapter is rendering. */
  readonly surface: ActivitySurface;
  /** The adapter's own per-section content map, consumed verbatim. */
  readonly sectionHasContent: Partial<Record<ActivitySectionId, boolean>>;
}

/**
 * Whether any section that counts as *work this worktree produced* currently
 * reports content, ignoring sections this surface does not render.
 *
 * Ambient workspace configuration (plugins, scripts, hooks, MCP servers,
 * notes, prompts, memory, terminals) deliberately does not count — see
 * `WORK_ACTIVITY_SECTION_IDS`, which owns that line for every client. In
 * Cowork, `attachments` joins them via `COWORK_AMBIENT_ACTIVITY_SECTION_IDS`
 * because it resolves to one workspace-level directory shared by every Work
 * Entry rather than per-entry storage.
 */
export function hasWorkActivityContent(
  sectionHasContent: Partial<Record<ActivitySectionId, boolean>>,
  surface: ActivitySurface,
): boolean {
  const workspaceType = surface === 'cowork' ? 'cowork' : undefined;
  for (const [sectionId, hasContent] of Object.entries(sectionHasContent)) {
    if (hasContent !== true) continue;
    // Pass the workspace type: `attachments` is per-worktree work in a code
    // workspace but resolves to ONE workspace-level directory in Cowork, so it
    // would otherwise reopen the rail on every brand-new Work Entry.
    if (!isWorkActivitySection(sectionId, workspaceType)) continue;
    if (!isActivitySectionVisibleForWorkspaceType(sectionId, workspaceType)) {
      continue;
    }
    return true;
  }
  return false;
}

/**
 * Expands this panel's group once it gains work content, if — and only if —
 * the group is currently carrying Canopy's own default collapse and the
 * surface is a code worktree. On the Cowork surface it never asks, and leaves
 * the `auto` flag for the user's own expand to spend.
 *
 * Every layout precondition (hydration, maximize, the `auto` flag itself) and
 * the persistence ordering belong to `expandActivityRailFromContent`; this
 * hook owns only the content signal and the retry cadence. Subscribing to the
 * layout revision is what supplies that retry: a pass skipped because a group
 * was maximized, or because the layout had not hydrated yet, runs again on the
 * next revision instead of being lost.
 */
export function useAutoExpandActivityRail({
  surface,
  sectionHasContent,
}: AutoExpandActivityRailOptions): void {
  const placement = usePanelPlacement();
  const layoutKey = placement?.layoutKey ?? null;
  const groupId = placement?.groupId ?? null;
  const revision = usePanelLayoutStore((state) =>
    layoutKey === null ? null : (state.layouts[layoutKey]?.revision ?? null),
  );
  const hasWorkContent = hasWorkActivityContent(sectionHasContent, surface);

  useEffect(() => {
    if (surface === 'cowork') return;
    if (!hasWorkContent) return;
    if (layoutKey === null || groupId === null || revision === null) return;
    expandActivityRailFromContent(layoutKey, groupId);
  }, [surface, hasWorkContent, layoutKey, groupId, revision]);
}

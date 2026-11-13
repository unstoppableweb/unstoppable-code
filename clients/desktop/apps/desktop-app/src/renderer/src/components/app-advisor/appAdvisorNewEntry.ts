import { dismissPageLikeViewers } from '@/lib/dismissPageLikeViewers';
import { useStandaloneChatStore } from '@/stores/standaloneChatStore';

/**
 * A fresh Orchestrator entry, from the docked page's New chat. Like the full
 * window's titlebar New chat, it first closes the page-like viewers (the
 * archived overview and viewer, Empty trash), which would otherwise keep
 * covering the new entry's composer.
 */
export async function startAppAdvisorNewEntry(): Promise<void> {
  dismissPageLikeViewers();
  await useStandaloneChatStore.getState().createWorkEntry();
}

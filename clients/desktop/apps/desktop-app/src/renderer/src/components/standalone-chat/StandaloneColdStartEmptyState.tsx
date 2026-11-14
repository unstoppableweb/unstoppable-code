import type { JSX } from 'react';
import { Button } from '@canopy/ui-shared/components';
import { usesNativeWindowFrame } from '@canopy/desktop-shared/platform-capabilities';
import {
  localPlatform,
  needsPageTitlebarDragRegion,
} from '@/lib/local-platform';
import { CHAT_UNIT_LABEL, CHAT_UNIT_LABEL_PLURAL } from '@canopy/protocol';
import { PlusIcon as AppCatalogPlusIcon } from '@canopy/ui-shared/icons/AppIcons';
import { EmptyState } from '@canopy/ui-shared/components';

interface StandaloneColdStartEmptyStateProps {
  onNewChat: () => void;
}

/**
 * Full-area cold-start empty state for the Cowork tab shown when the user has
 * no chat activity yet (no message has been sent). An empty chat tab is
 * auto-provisioned on first load, so the gate keys on activity rather than on
 * chats literally not existing — see the cold-start gate in `StandaloneChatPage`.
 * Replaces the entire split layout (conversation pane, workspace panel) with
 * a single centered CTA so a brand-new user sees no sidebar or other visual
 * noise.
 *
 * Distinct from the grid's empty chat state, which handles the "chats exist but none
 * is selected" case inside the conversation pane and still keeps the sidebar.
 */
export function StandaloneColdStartEmptyState({
  onNewChat,
}: StandaloneColdStartEmptyStateProps): JSX.Element {
  return (
    <div
      data-testid="cowork-empty-state"
      className="flex h-full flex-1 flex-col"
    >
      {/* Keep the title-bar row the conversation header (not rendered in the
          cold-start view) would take. It only drags the window where the
          shell draws no title-bar strip of its own (CAN-5711). */}
      {!usesNativeWindowFrame(localPlatform()) && (
        <div
          className={
            needsPageTitlebarDragRegion(localPlatform())
              ? 'electron-drag h-10 shrink-0'
              : 'h-10 shrink-0'
          }
        />
      )}
      <div className="flex flex-1 flex-col items-center justify-center p-8">
        <EmptyState
          inset="none"
          title={`No ${CHAT_UNIT_LABEL_PLURAL.toLowerCase()} yet`}
          subtitle={`Start a new ${CHAT_UNIT_LABEL.toLowerCase()} to get started.`}
          action={
            <Button
              variant="primary"
              onClick={onNewChat}
              data-testid="empty-new-chat"
            >
              <AppCatalogPlusIcon size="sm" aria-hidden="true" />
              New {CHAT_UNIT_LABEL}
            </Button>
          }
        />
      </div>
    </div>
  );
}

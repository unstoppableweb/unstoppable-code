'use client';

import { useCallback, useContext, type JSX, type ReactNode } from 'react';
import type { SidebarItemGroup } from '@canopy/protocol/sidebar';
import {
  CodeSidebarItemGroups,
  buildSidebarItemGroupBlocks,
  WorktreeSortableStateContext,
  type CodeSidebarItemGroupCommands,
} from '@canopy/ui-app/sidebar';
import {
  WorkEntryRow,
  WorktreeActionMenuItems,
  type WorkEntryRowMenuContext,
  type WorktreeMenuItem,
  useIsMobile,
  EmptyStateRow,
} from '@canopy/ui-shared/components';
import { ThinkingSpinner } from '@canopy/ui-shared/components';

import { OrchestratorNavControls } from './OrchestratorNavControls';
import { OrchestratorNavFrame } from './OrchestratorNavFrame';
export interface OrchestratorWorkEntrySummary {
  id: string;
  title: string;
  createdAt?: string;
  lastMessageAt?: string;
  order?: number;
  providerType?: string;
  turnActive: boolean;
  /** Any chat in the entry has output the user hasn't read (turn-state 41c). */
  hasUnread: boolean;
  /** Any chat in the entry waits on a question for the user (turn-state 41c). */
  hasQuestion: boolean;
  chatCount: number;
}

export interface OrchestratorNavProps {
  groups?: readonly SidebarItemGroup[];
  itemGroupCommands?: CodeSidebarItemGroupCommands;
  onGroupError?: (error: unknown) => void;
  entries: OrchestratorWorkEntrySummary[];
  selectedWorkEntryId?: string;
  onSelect: (workEntryId: string) => void;
  onBack: () => void;
  onToggleCollapsed: () => void;
  onOpenSettings?: () => void;
  onCreateWorkEntry: (groupId?: string) => void;
}

/**
 * Portal counterpart to desktop `AppAdvisorNav`: Work Entries are the
 * persistent vertical navigation, while their chat tabs stay in the content
 * pane. The input is already in desktop registry order.
 */
export function OrchestratorNav({
  entries,
  selectedWorkEntryId,
  onSelect,
  onBack,
  onToggleCollapsed,
  onOpenSettings,
  onCreateWorkEntry,
  groups = [],
  itemGroupCommands,
  onGroupError,
}: OrchestratorNavProps): JSX.Element {
  const blocks = buildSidebarItemGroupBlocks(
    entries.map((entry) => ({ rootId: entry.id, itemIds: [entry.id] })),
    groups,
    'manual',
    selectedWorkEntryId,
  );
  return (
    <OrchestratorNavFrame
      presentation="rail"
      testId="remote-control-app-advisor-nav"
      controls={
        <OrchestratorNavControls
          collapsed={false}
          onBack={onBack}
          onToggleCollapsed={onToggleCollapsed}
          onOpenSettings={onOpenSettings}
          onCreateWorkEntry={onCreateWorkEntry}
        />
      }
    >
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 py-2">
        {entries.length === 0 && blocks.length === 0 ? (
          <div className="px-2">
            <EmptyStateRow title="No chats yet" />
          </div>
        ) : (
          <div className="flex flex-col gap-px">
            {groups.length > 0 || itemGroupCommands ? (
              <div className="pl-2">
                <CodeSidebarItemGroups
                  blocks={blocks}
                  groups={groups}
                  selectedItemId={selectedWorkEntryId}
                  mode="manual"
                  rowGap="hairline"
                  itemGap="hairline"
                  commands={itemGroupCommands}
                  unitLabel={{ singular: 'work entry', plural: 'work entries' }}
                  renderRow={(id, menu) => {
                    const entry = entries.find((entry) => entry.id === id);
                    return entry ? (
                      <AdvisorNavRow
                        entry={entry}
                        selected={entry.id === selectedWorkEntryId}
                        onSelect={onSelect}
                        menu={menu}
                      />
                    ) : null;
                  }}
                  renderPreview={(id) => {
                    const entry = entries.find((entry) => entry.id === id);
                    return entry ? (
                      <AdvisorNavRow
                        entry={entry}
                        selected={false}
                        onSelect={() => {}}
                        menu={[]}
                      />
                    ) : null;
                  }}
                  onCreate={(groupId) => onCreateWorkEntry(groupId)}
                  onError={(error) => onGroupError?.(error)}
                  canDragRow={() => true}
                  renderStatus={(block) =>
                    block.units.some(
                      (unit) =>
                        entries.find((entry) => entry.id === unit.rootId)
                          ?.turnActive,
                    ) ? (
                      <ThinkingSpinner tone="accent" />
                    ) : null
                  }
                />
              </div>
            ) : (
              entries.map((entry) => (
                <AdvisorNavRow
                  key={entry.id}
                  entry={entry}
                  selected={entry.id === selectedWorkEntryId}
                  onSelect={onSelect}
                  menu={[]}
                />
              ))
            )}
          </div>
        )}
      </div>
    </OrchestratorNavFrame>
  );
}

/**
 * One App Advisor entry: the shared Work Entry row the Chats section uses.
 * The provider icon and sub-chat count of the earlier Portal row have no
 * slot on the shared row and are not shown.
 */
function AdvisorNavRow({
  entry,
  selected,
  onSelect,
  menu,
}: {
  entry: OrchestratorWorkEntrySummary;
  selected: boolean;
  onSelect: (id: string) => void;
  menu: readonly WorktreeMenuItem[];
}): JSX.Element {
  // The group list's drag wrapper owns the pointer sensor; the row only
  // carries the sortable attributes.
  const sortable = useContext(WorktreeSortableStateContext);
  // The mobile layout shows this nav in the drawer, where the Chats rows it
  // replaces take the touch height.
  const touchTarget = useIsMobile();
  const renderMenuItems = useCallback(
    (rowMenu: WorkEntryRowMenuContext): ReactNode => (
      <WorktreeActionMenuItems
        items={menu}
        onSelect={(item): void => {
          rowMenu.close();
          item.onSelect?.();
        }}
      />
    ),
    [menu],
  );
  return (
    <WorkEntryRow
      title={entry.title}
      testId={`remote-control-app-advisor-nav-entry-${entry.id}`}
      entryId={entry.id}
      selected={selected}
      working={entry.turnActive}
      hasPendingQuestion={entry.hasQuestion}
      hasUnread={entry.hasUnread}
      drag={
        sortable === null
          ? undefined
          : { attributes: sortable.attributes, isDragging: sortable.isDragging }
      }
      touchTarget={touchTarget}
      onOpen={() => onSelect(entry.id)}
      renderMenuItems={menu.length > 0 ? renderMenuItems : undefined}
      menuLabel={entry.title}
    />
  );
}

import { ControlButton } from '../Button';
import { useId, type JSX, type ReactNode } from 'react';
import type {
  PanelCollapseEdge,
  PanelGroupModel,
  PanelIntentCallbacks,
  PanelTabModel,
} from '../../panels/registry-types';
import { TitlebarIconButton } from '../TitlebarIconButton';
import { Tooltip } from '../Tooltip';
import { REPLAY_MASK_CLASS } from '../../lib/replay-privacy';
import {
  ChevronRightMediumIcon,
  ChevronDownMediumIcon,
  ChevronLeftMediumIcon,
  ChevronTopMediumIcon,
} from '../../icons/AppIcons';
import { clearPanelTabDrag, readPanelTabDrag } from './panel-dnd';

export interface PanelBranchCollapsedBarProps {
  groups: readonly PanelGroupModel[];
  edge: PanelCollapseEdge;
  callbacks: PanelIntentCallbacks;
  renderTabIcon?: (tab: PanelTabModel) => ReactNode;
  getTabTitle?: (tab: PanelTabModel) => string;
  isTabTitlePrivate?: (tab: PanelTabModel) => boolean;
  renderTabAccessibleStatus?: (tab: PanelTabModel) => ReactNode;
  renderTabTooltip?: (tab: PanelTabModel) => ReactNode | null;
}

/** A compact subtree retains separate, addressable groups in depth-first order. */
export function PanelBranchCollapsedBar({
  groups,
  edge,
  callbacks,
  renderTabIcon,
  getTabTitle,
  isTabTitlePrivate,
  renderTabAccessibleStatus,
  renderTabTooltip,
}: PanelBranchCollapsedBarProps): JSX.Element {
  const statusIdPrefix = useId();
  const vertical = edge === 'left' || edge === 'right';
  const ExpandIcon =
    edge === 'left'
      ? ChevronRightMediumIcon
      : edge === 'right'
        ? ChevronLeftMediumIcon
        : edge === 'top'
          ? ChevronDownMediumIcon
          : ChevronTopMediumIcon;
  return (
    <div
      className={`canopy-panel-collapsed-bar canopy-panel-collapsed-bar-${vertical ? 'vertical' : 'horizontal'}`}
      style={{
        overflow: 'auto',
        alignItems: 'center',
        justifyContent: 'flex-start',
      }}
      data-testid={`panel-branch-bar-${groups[0]?.groupId}`}
      data-edge={edge}
    >
      {groups.map((group) => {
        const tabTitles = group.tabs
          .map((tab) => getTabTitle?.(tab) ?? tab.title)
          .join(', ');
        const label = tabTitles || 'Empty panel group';
        // The group's labels list every title, so one private title masks
        // them all; the group shows only icons.
        const mask = group.tabs.some((tab) => isTabTitlePrivate?.(tab) === true)
          ? ` ${REPLAY_MASK_CLASS}`
          : '';
        // Masked names are labels, not `aria-label` values, which click
        // events copy past the mask.
        const nameId = (part: string): string =>
          `${statusIdPrefix}-${group.groupId}-${part}`;
        const name = (
          part: string,
          text: string,
        ): { 'aria-label': string } | { 'aria-labelledby': string } =>
          mask === ''
            ? { 'aria-label': text }
            : { 'aria-labelledby': nameId(part) };
        return (
          <div
            key={group.groupId}
            role="group"
            {...name('label', label)}
            className={`ring-[length:var(--border-hairline)] ring-inset ring-line-base${mask}`}
            style={{
              display: 'flex',
              flexDirection: vertical ? 'column' : 'row',
              alignItems: 'center',
              flexShrink: 0,
              padding: 4,
              gap: 2,
            }}
            onDragOver={(event) => {
              const dragged = readPanelTabDrag();
              // A move the layout owner would refuse is not a drop target.
              if (
                dragged !== null &&
                callbacks.canDropPanel?.(
                  dragged.panelId,
                  group.groupId,
                  'center',
                ) !== false
              ) {
                event.preventDefault();
                event.stopPropagation();
              }
            }}
            onDrop={(event) => {
              const dragged = readPanelTabDrag();
              if (dragged === null) return;
              if (
                callbacks.canDropPanel?.(
                  dragged.panelId,
                  group.groupId,
                  'center',
                ) === false
              ) {
                return;
              }
              event.preventDefault();
              event.stopPropagation();
              clearPanelTabDrag();
              // The expand is incidental: it makes room for the dropped tab,
              // which then becomes active. The user never asked to see what
              // this group already contained, so layout owners must not treat
              // it as a reveal gesture.
              callbacks.onCollapseGroup?.(group.groupId, false, {
                gesture: 'move',
              });
              callbacks.onMovePanel(dragged.panelId, group.groupId, 'center');
            }}
          >
            {mask === '' ? null : (
              <>
                <span className="sr-only" id={nameId('label')}>
                  {label}
                </span>
                <span className="sr-only" id={nameId('expand')}>
                  Expand {label}
                </span>
                {group.tabs.map((tab) => (
                  <span
                    key={tab.panelId}
                    className="sr-only"
                    id={nameId(`tab-${tab.panelId}`)}
                  >
                    {getTabTitle?.(tab) ?? tab.title}
                  </span>
                ))}
              </>
            )}
            <TitlebarIconButton
              surface="panelChrome"
              icon={ExpandIcon}
              data-testid={`panel-branch-expand-${group.groupId}`}
              {...name('expand', `Expand ${label}`)}
              {...(mask === ''
                ? {}
                : {
                    tooltipLabel: (
                      <span className={REPLAY_MASK_CLASS}>Expand {label}</span>
                    ),
                  })}
              onClick={() => callbacks.onCollapseGroup?.(group.groupId, false)}
            />
            {group.tabs.map((tab) => (
              <Tooltip
                key={tab.panelId}
                label={
                  renderTabTooltip?.(tab) ?? (
                    <span className={mask.trim() || undefined}>
                      {getTabTitle?.(tab) ?? tab.title}
                    </span>
                  )
                }
              >
                <ControlButton
                  type="button"
                  presentation="panel-collapsed-tab"
                  data-testid={`panel-branch-tab-${tab.panelId}`}
                  {...name(
                    `tab-${tab.panelId}`,
                    getTabTitle?.(tab) ?? tab.title,
                  )}
                  aria-describedby={
                    renderTabAccessibleStatus
                      ? `${statusIdPrefix}-${tab.panelId}`
                      : undefined
                  }
                  onClick={() =>
                    callbacks.onExpandGroupToTab?.(group.groupId, tab.panelId)
                  }
                >
                  {renderTabIcon?.(tab) ?? tab.title.slice(0, 1)}
                  {renderTabAccessibleStatus ? (
                    <span
                      className="sr-only"
                      id={`${statusIdPrefix}-${tab.panelId}`}
                    >
                      {renderTabAccessibleStatus(tab)}
                    </span>
                  ) : null}
                </ControlButton>
              </Tooltip>
            ))}
          </div>
        );
      })}
    </div>
  );
}

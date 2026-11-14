'use client';

import { forwardRef, useRef, useState, type JSX, type ReactNode } from 'react';
import {
  MoreHorizontalIcon,
  PlusMediumIcon,
  SettingsIcon,
} from '../icons/AppIcons';
import {
  RailSectionHeaderFrame,
  type RailSectionHeaderFrameProps,
} from './Disclosure';
import { RailIconButton } from './RailIconButton';
import { Dot } from './Badge';
import { FloatingMenu } from './FloatingMenu';
import { ActionMenuRowStyle } from './ActionMenuItems';

export interface RailSectionHeaderProps extends RailSectionHeaderFrameProps {
  readonly renderMenuItems?: (close: () => void) => ReactNode;
  readonly menuOpen?: boolean;
  readonly onMenuOpenChange?: (open: boolean) => void;
  readonly menuTestId?: string;
  readonly menuContentTestId?: string;
  readonly menuFiltered?: boolean;
  readonly actionsDisabled?: boolean;
  readonly onCreate?: () => void;
  readonly createRevealed?: boolean;
  readonly createTestId?: string;
  readonly createDataAttrs?: Record<`data-${string}`, string>;
  readonly onSettings?: () => void;
  readonly settingsTestId?: string;
}

/** Complete production section chrome; hosts supply actions and persistence. */
export const RailSectionHeader = forwardRef<
  HTMLDivElement,
  RailSectionHeaderProps
>(function RailSectionHeader(
  {
    renderMenuItems,
    menuOpen: controlledOpen,
    onMenuOpenChange,
    menuTestId,
    menuContentTestId,
    menuFiltered = false,
    actionsDisabled = false,
    onCreate,
    createRevealed = false,
    createTestId,
    createDataAttrs,
    onSettings,
    settingsTestId,
    actions,
    kind,
    label,
    ...props
  },
  ref,
): JSX.Element {
  const [localOpen, setLocalOpen] = useState(false);
  const menuOpen = controlledOpen ?? localOpen;
  const setMenuOpen = (open: boolean): void => {
    setLocalOpen(open);
    onMenuOpenChange?.(open);
  };
  const menuRef = useRef<HTMLButtonElement>(null);
  const projects = kind === 'projects';
  const createLabel = projects ? 'Add project' : 'New chat';
  const controls =
    renderMenuItems || onCreate || onSettings ? (
      <span
        // 2px from the edge, as every sidebar row's controls; the header's
        // 4px side padding still holds its label.
        className="-mr-0.5 ml-auto flex shrink-0 items-center gap-0.5"
      >
        {onSettings && (
          <RailIconButton
            icon={SettingsIcon}
            onClick={onSettings}
            aria-label={`${label} settings`}
            title="Settings"
            data-testid={settingsTestId}
            tone="section"
            hoverSurface
            revealOnItemHover
            disabled={actionsDisabled}
          />
        )}
        {renderMenuItems && (
          <span className="relative inline-flex">
            <RailIconButton
              ref={menuRef}
              icon={MoreHorizontalIcon}
              aria-label={`More actions for ${label}`}
              title="More actions"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              data-testid={menuTestId}
              data-active={menuFiltered || undefined}
              disabled={actionsDisabled}
              tone="section"
              hoverSurface
              revealOnItemHover={!menuFiltered}
              onClick={(): void => setMenuOpen(!menuOpen)}
            />
            {menuFiltered && (
              <Dot
                tone="filter"
                data-testid={`${menuTestId}-active-dot`}
                className="pointer-events-none absolute right-0.5 top-0.5"
              />
            )}
            <FloatingMenu
              open={!actionsDisabled && menuOpen}
              onOpenChange={setMenuOpen}
              anchorRef={menuRef}
              placement="bottom-left"
              className="w-45"
              aria-label={`${label} actions`}
              data-testid={menuContentTestId}
              closeOnSelect={!projects}
            >
              <ActionMenuRowStyle>
                {renderMenuItems(() => setMenuOpen(false))}
              </ActionMenuRowStyle>
            </FloatingMenu>
          </span>
        )}
        {onCreate && (
          <RailIconButton
            icon={PlusMediumIcon}
            onClick={onCreate}
            aria-label={createLabel}
            title={createLabel}
            data-testid={createTestId}
            {...createDataAttrs}
            tone="section"
            hoverSurface
            revealOnItemHover={!createRevealed}
            coarsePointerTarget={projects}
          />
        )}
      </span>
    ) : undefined;
  return (
    <RailSectionHeaderFrame
      {...props}
      ref={ref}
      kind={kind}
      label={label}
      actions={actions ?? controls}
    />
  );
});

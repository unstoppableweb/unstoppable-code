'use client';
import type { JSX } from 'react';
import { ORCHESTRATOR_LABEL } from '@canopy/protocol';
import {
  Button,
  Tooltip,
  TitlebarIconButton,
} from '@canopy/ui-shared/components';
import {
  BackIcon,
  PlusMediumIcon,
  SettingsIcon,
  SidebarHiddenLeftWideIcon,
} from '@canopy/ui-shared/icons/AppIcons';

export interface OrchestratorNavControlsProps {
  presentation?: 'toolbar' | 'titlebar';
  collapsed: boolean;
  onBack?: () => void;
  onToggleCollapsed: () => void;
  onOpenSettings?: () => void;
  onCreateWorkEntry: () => void;
}

/** Exact web counterpart of desktop AppAdvisorTitlebarCorner controls. */
export function OrchestratorNavControls({
  presentation = 'toolbar',
  collapsed,
  onBack,
  onToggleCollapsed,
  onOpenSettings,
  onCreateWorkEntry,
}: OrchestratorNavControlsProps): JSX.Element {
  if (presentation === 'titlebar') {
    return (
      <>
        <TitlebarIconButton
          onClick={onToggleCollapsed}
          icon={SidebarHiddenLeftWideIcon}
          aria-label={collapsed ? 'Expand navigation' : 'Collapse navigation'}
          aria-expanded={!collapsed}
          data-testid="app-advisor-nav-collapse"
          tooltipLabel=""
        />
        <TitlebarIconButton
          onClick={onOpenSettings}
          icon={SettingsIcon}
          iconSize={14}
          aria-label={`${ORCHESTRATOR_LABEL} settings`}
          tooltipLabel="Settings"
          data-testid="app-advisor-nav-settings"
        />
        <TitlebarIconButton
          onClick={onCreateWorkEntry}
          icon={PlusMediumIcon}
          iconSize={14}
          aria-label="New work entry"
          data-testid="app-advisor-nav-new-entry"
        />
      </>
    );
  }
  return (
    <div
      className="flex items-center"
      data-testid="remote-control-app-advisor-nav-controls"
    >
      <Tooltip label="Back">
        <Button
          variant="ghost"
          size="compact"
          iconOnly
          onClick={onBack}
          aria-label="Back to projects"
          data-testid="remote-control-app-advisor-back"
        >
          <BackIcon size={16} aria-hidden="true" />
        </Button>
      </Tooltip>
      <Button
        variant="ghost"
        size="compact"
        iconOnly
        onClick={onToggleCollapsed}
        aria-label={collapsed ? 'Expand navigation' : 'Collapse navigation'}
        aria-expanded={!collapsed}
        data-testid="remote-control-app-advisor-nav-collapse"
      >
        <SidebarHiddenLeftWideIcon size={16} aria-hidden="true" />
      </Button>
      <Tooltip label="Settings">
        <Button
          variant="ghost"
          size="compact"
          iconOnly
          onClick={onOpenSettings}
          aria-label={`${ORCHESTRATOR_LABEL} settings`}
          data-testid="remote-control-app-advisor-nav-settings"
        >
          <SettingsIcon size={14} aria-hidden="true" />
        </Button>
      </Tooltip>
      <Tooltip label="New work entry">
        <Button
          variant="ghost"
          size="compact"
          iconOnly
          onClick={() => onCreateWorkEntry()}
          aria-label="New work entry"
          data-testid="remote-control-app-advisor-nav-new-entry"
        >
          <PlusMediumIcon size={14} aria-hidden="true" />
        </Button>
      </Tooltip>
    </div>
  );
}

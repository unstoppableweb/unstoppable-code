'use client';

import type { JSX, MouseEvent } from 'react';
import {
  SIDEBAR_NAV_ICON_CLASSNAME,
  sidebarNavItemClassName,
} from '@canopy/ui-shared/components';
import { AttentionDot } from '@canopy/ui-shared/components/settings/AttentionDot';
import { Badge } from '@canopy/ui-shared/primitives/Badge';
import { SidebarPageNavGroup } from '../../sidebar';
import type { SettingsLinkComponent } from '../host';
import type { SettingsNavGroup, SettingsNavRow } from './settings-nav-model';

const ROW_CLASSNAME_SUFFIX = 'text-left pointer-coarse:min-h-11';

function RowContent({
  row,
  testIdPrefix,
}: {
  readonly row: SettingsNavRow;
  readonly testIdPrefix: string;
}): JSX.Element {
  const Icon = row.icon;
  return (
    <>
      <span className={SIDEBAR_NAV_ICON_CLASSNAME}>
        <Icon size={16} />
      </span>
      {row.attention ? (
        // Outside any truncating span: the dot overhangs its label and a
        // clipping ancestor would hide it.
        <AttentionDot
          label="Billing needs attention"
          testId={`${testIdPrefix}${row.key}-attention-dot`}
        >
          {row.label}
        </AttentionDot>
      ) : (
        <span className="min-w-0 truncate">{row.label}</span>
      )}
      {row.tag === 'new' ? (
        <Badge tone="info" data-testid={`${testIdPrefix}${row.key}-new`}>
          New
        </Badge>
      ) : null}
    </>
  );
}

export interface SettingsNavGroupsProps {
  readonly groups: readonly SettingsNavGroup<string>[];
  /** The one selected row key, or `null`. */
  readonly currentKey: string | null;
  /** The host's link: `next/link` on web, an in-overlay link on desktop. */
  readonly LinkComponent: SettingsLinkComponent;
  /** Runs when a row is chosen, before the link navigates. */
  readonly onNavigate?: (row: SettingsNavRow, event: MouseEvent) => void;
  /**
   * Test-id prefix for rows (`<prefix><row key>`) and groups
   * (`<prefix>group-<group id>`). Web keeps `remote-control-settings-nav-`; desktop
   * uses `settings-nav-`.
   */
  readonly testIdPrefix: string;
}

/**
 * The hosted settings rail groups for the current scope (the account's pages,
 * or the browsed organization's). Hosts own the surrounding `SidebarPageNav`,
 * Back, the scope picker above these groups, and any groups of their own:
 * web appends Admin, desktop appends its local settings groups.
 */
export function SettingsNavGroups({
  groups,
  currentKey,
  LinkComponent,
  onNavigate,
  testIdPrefix,
}: SettingsNavGroupsProps): JSX.Element {
  return (
    <>
      {groups.map((group) => (
        <SidebarPageNavGroup
          key={group.id}
          label={group.label}
          ariaLabel={group.ariaLabel}
          testId={`${testIdPrefix}group-${group.id}`}
        >
          {group.rows.map((row) => {
            const selected = row.key === currentKey;
            const testId = `${testIdPrefix}${row.key}`;
            if (row.disabled) {
              return (
                <span
                  key={row.key}
                  role="link"
                  aria-disabled="true"
                  aria-current={selected ? 'page' : undefined}
                  data-testid={testId}
                  data-disabled="true"
                  data-sidebar-nav-row=""
                  className={`${sidebarNavItemClassName(selected)} ${ROW_CLASSNAME_SUFFIX} cursor-not-allowed opacity-50`}
                >
                  <RowContent row={row} testIdPrefix={testIdPrefix} />
                </span>
              );
            }
            return (
              <LinkComponent
                key={row.key}
                href={row.href}
                aria-current={selected ? 'page' : undefined}
                data-testid={testId}
                data-sidebar-nav-row=""
                className={`${sidebarNavItemClassName(selected)} ${ROW_CLASSNAME_SUFFIX}`}
                onClick={(event) => onNavigate?.(row, event)}
              >
                <RowContent row={row} testIdPrefix={testIdPrefix} />
              </LinkComponent>
            );
          })}
        </SidebarPageNavGroup>
      ))}
    </>
  );
}

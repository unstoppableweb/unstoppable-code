'use client';

import { ControlButton } from '@canopy/ui-shared/components';
import { useId, useMemo, useRef, useState, type JSX } from 'react';
import {
  MenuDivider,
  MenuItem,
  MenuItemIcon,
  MenuItemTrailing,
  MenuLabel,
  Menu,
} from '@canopy/ui-shared/components';
import {
  BuildingIcon,
  CheckIcon,
  ChevronsUpDown,
  Plus,
} from '@canopy/ui-shared/icons/AppIcons';
import type { SettingsNavModel } from '@canopy/protocol/settings';
import { useOptionalSettingsHost } from '../host/settings-host';
import { MemberAvatar } from '../organization/MemberAvatar';
import { OrganizationLogo } from '../organization/OrganizationLogo';
import { ROLE_LABEL } from '../organization/team-role-label';
import {
  accountScopeHref,
  currentSettingsNavScope,
  organizationScopeHref,
  settingsNavScopeOrganizations,
} from './settings-nav-scope';

const ORGANIZATIONS_PATH = '/organization';
const CREATE_ORGANIZATION_PATH = `${ORGANIZATIONS_PATH}?create=1`;

export interface SettingsScopePickerProps {
  readonly model: SettingsNavModel;
  /** The current settings path with its query, e.g. `/account/billing`. */
  readonly currentPath: string;
  /** Opens a settings path in the host (router push). */
  readonly onNavigate: (href: string) => void;
  /**
   * Explicitly choosing an organization selects it in the main sidebar, as
   * the organization header's switcher did.
   */
  readonly onSelectOrganization?: (organizationId: string) => void;
  /** Test-id prefix shared with the rail rows. */
  readonly testIdPrefix: string;
  /**
   * Session-replay mask for user-authored organization names (desktop). The
   * account scope shows a person's name, which takes the host's block class.
   */
  readonly maskClassName?: string;
}

/**
 * The top of the settings rail: which scope the rows below belong to, your
 * account or one organization, with a menu to switch. Switching keeps the
 * page when both scopes have it (Billing, Integrations) and otherwise opens
 * the scope's first page. The menu also leads to the full Organizations list
 * and to creating an organization.
 */
export function SettingsScopePicker({
  model,
  currentPath,
  onNavigate,
  onSelectOrganization,
  testIdPrefix,
  maskClassName = '',
}: SettingsScopePickerProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const blockClassName =
    useOptionalSettingsHost()?.privacy.blockClassName ?? '';
  const anchorRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const scope = currentSettingsNavScope(model);
  const organizations = useMemo(
    () => settingsNavScopeOrganizations(model),
    [model],
  );
  const viewerName =
    model.viewer?.name?.trim() || model.viewer?.email || 'Personal account';
  const onListPage = currentPath.split(/[?#]/, 1)[0] === ORGANIZATIONS_PATH;

  const go = (href: string): void => {
    setOpen(false);
    onNavigate(href);
  };

  const title = scope.kind === 'account' ? viewerName : scope.name;
  // A person's name or email is blocked in replay, and is not repeated in a
  // title attribute, which replay records unmasked.
  const titleClassName =
    scope.kind === 'account' ? blockClassName : maskClassName;
  const subtitle =
    scope.kind === 'account'
      ? 'Personal account'
      : scope.isPersonal
        ? 'Your activity and usage'
        : scope.role === null
          ? 'Organization'
          : `Organization · ${ROLE_LABEL[scope.role]}`;

  return (
    <div className="pt-2">
      <div ref={anchorRef} className="relative">
        <ControlButton
          ref={triggerRef}
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          aria-haspopup="menu"
          aria-controls={open ? menuId : undefined}
          data-settings-control="picker"
          data-testid={`${testIdPrefix}scope-picker`}
          presentation="settings-scope-picker"
        >
          {scope.kind === 'account' ? (
            <MemberAvatar
              name={viewerName}
              image={model.viewer?.image ?? null}
              size="md"
            />
          ) : (
            <OrganizationLogo
              name={scope.name}
              logoUrl={scope.logoUrl}
              size="md"
            />
          )}
          <span className="flex min-w-0 flex-1 flex-col">
            <span
              className={`truncate text-s font-medium fg-primary ${titleClassName}`}
              title={scope.kind === 'account' ? undefined : title}
              data-testid={`${testIdPrefix}scope-title`}
            >
              {title}
            </span>
            <span className="truncate text-xs fg-tertiary">{subtitle}</span>
          </span>
          <ChevronsUpDown
            size={14}
            aria-hidden="true"
            className="shrink-0 fg-tertiary"
          />
        </ControlButton>
        <Menu
          id={menuId}
          open={open}
          onOpenChange={setOpen}
          anchorRef={anchorRef}
          returnFocusRef={triggerRef}
          placement="bottom-left"
          aria-label="Switch settings"
          data-testid={`${testIdPrefix}scope-menu`}
          // The menu spans the trigger, as wide as the rail's rows.
          className="w-[var(--floating-menu-anchor-width)] min-w-60 pointer-coarse:[&_.canopy-dropdown-menu-item]:min-h-11"
        >
          <MenuItem
            role="menuitemradio"
            aria-checked={scope.kind === 'account' && !onListPage}
            data-testid={`${testIdPrefix}scope-option-account`}
            onClick={() => go(accountScopeHref(currentPath, model.account))}
          >
            <MenuItemIcon>
              <MemberAvatar
                name={viewerName}
                image={model.viewer?.image ?? null}
                size="xs"
              />
            </MenuItemIcon>
            <span className="min-w-0 flex-1 truncate">Personal account</span>
            {scope.kind === 'account' && !onListPage ? (
              <CheckIcon size={16} aria-hidden="true" className="shrink-0" />
            ) : null}
          </MenuItem>
          {organizations.length > 0 ? (
            <>
              <MenuDivider />
              <MenuLabel>Organizations</MenuLabel>
              {organizations.map((organization) => {
                const selected =
                  scope.kind === 'organization' &&
                  scope.organizationId === organization.id;
                return (
                  <MenuItem
                    key={organization.id}
                    role="menuitemradio"
                    aria-checked={selected}
                    data-testid={`${testIdPrefix}scope-option-${organization.id}`}
                    onClick={() => {
                      if (selected) {
                        setOpen(false);
                        return;
                      }
                      onSelectOrganization?.(organization.id);
                      go(organizationScopeHref(currentPath, organization));
                    }}
                  >
                    <MenuItemIcon>
                      {organization.logoUrl ? (
                        <OrganizationLogo
                          name={organization.name}
                          logoUrl={organization.logoUrl}
                          size="xs"
                        />
                      ) : (
                        <BuildingIcon size="xl" />
                      )}
                    </MenuItemIcon>
                    <span
                      className={`min-w-0 flex-1 truncate ${maskClassName}`}
                    >
                      {organization.name}
                    </span>
                    <MenuItemTrailing>
                      {ROLE_LABEL[organization.role]}
                    </MenuItemTrailing>
                    {selected ? (
                      <CheckIcon
                        size={16}
                        aria-hidden="true"
                        className="shrink-0"
                      />
                    ) : null}
                  </MenuItem>
                );
              })}
            </>
          ) : null}
          <MenuDivider />
          <MenuItem
            role="menuitemradio"
            aria-checked={onListPage}
            data-testid={`${testIdPrefix}scope-all-organizations`}
            onClick={() => go(ORGANIZATIONS_PATH)}
          >
            <MenuItemIcon>
              <BuildingIcon size="xl" />
            </MenuItemIcon>
            <span className="min-w-0 flex-1 truncate">All organizations</span>
            {onListPage ? (
              <CheckIcon size={16} aria-hidden="true" className="shrink-0" />
            ) : null}
          </MenuItem>
          <MenuItem
            data-testid={`${testIdPrefix}scope-create-organization`}
            onClick={() => go(CREATE_ORGANIZATION_PATH)}
          >
            <MenuItemIcon>
              <Plus size="xl" />
            </MenuItemIcon>
            Create an organization
          </MenuItem>
        </Menu>
      </div>
    </div>
  );
}

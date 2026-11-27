import { type JSX, useRef, useState } from 'react';
import { MenuItem, MenuItemIcon } from '../primitives/MenuItem';
import { Menu } from '../primitives/Menu';
import { ActionMenuRowStyle } from '../primitives/ActionMenuItems';
import { Button } from '../primitives/Button';
import { menuDismissalSwallowsClick } from '../lib/menu-open-body-flag';
import {
  AgentIcon,
  BundleIcon,
  ChevronDownMediumIcon,
  GitHubIcon,
  McpServerIcon,
  SquarePlusIcon,
  StorefrontIcon,
} from '../icons/AppIcons';

/**
 * Custom-add actions supported by a Customize host, always behind one "Add
 * custom" menu so every host reads the same. The host owns each dialog and
 * supplies callbacks for available actions.
 */
export interface PluginsAddCustomMenuProps {
  onAddMarketplace?: () => void;
  onAddMcpServer?: () => void;
  onInstallSkillsFromGitHub?: () => void;
  onCreateCustomSkill?: () => void;
  /**
   * Opens the collection editor in create mode. Collections used to be
   * creatable only from Installed > Collections, which left the Marketplace's
   * own Collections tab with no way forward; hosts without a collection
   * editor omit this and the item is not rendered.
   */
  onCreateCollection?: () => void;
  /**
   * Opens the host's agent editor in create mode. Only hosts that manage local
   * agents supply it; the item is not rendered otherwise.
   */
  onCreateAgent?: () => void;
}

export function PluginsAddCustomMenu({
  onAddMarketplace,
  onAddMcpServer,
  onInstallSkillsFromGitHub,
  onCreateCustomSkill,
  onCreateCollection,
  onCreateAgent,
}: PluginsAddCustomMenuProps): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);

  if (
    ![
      onAddMarketplace,
      onAddMcpServer,
      onInstallSkillsFromGitHub,
      onCreateCustomSkill,
      onCreateCollection,
      onCreateAgent,
    ].some(Boolean)
  )
    return null;

  // One "Add custom" menu on every host (CAN-4261), even when custom MCP
  // servers are its only item, so desktop and web read the same.
  return (
    // The desktop Plugins page seats this in the title bar's drag region;
    // the class is inert on the web.
    <div className="electron-no-drag relative inline-block">
      <Button
        ref={anchorRef}
        variant="primary"
        size="compact"
        data-testid="plugins-add-custom-menu"
        aria-haspopup="menu"
        aria-expanded={open}
        onPointerDown={(event) => {
          // A card menu open on this page dismisses on pointerdown and
          // swallows the click that press completes, so opening on click alone
          // would cost the user a second press to reach these items.
          if (
            !open &&
            menuDismissalSwallowsClick(
              event.currentTarget.ownerDocument,
              event.target,
            )
          ) {
            setOpen(true);
          }
        }}
        onClick={() => setOpen((value) => !value)}
      >
        <span>Add custom</span>
        {/* The chevron sits 2px past the label, inside the button's gap. */}
        <ChevronDownMediumIcon size={16} aria-hidden="true" className="-ml-1" />
      </Button>
      <Menu
        open={open}
        onOpenChange={setOpen}
        anchorRef={anchorRef}
        outsidePressSwallowsClick={false}
        placement="bottom-right"
        gap={12}
        sizing="custom"
        className="w-56"
      >
        <ActionMenuRowStyle>
          {onAddMcpServer && (
            <MenuItem
              data-testid="plugins-add-custom-mcp"
              onClick={onAddMcpServer}
            >
              <MenuItemIcon data-testid="plugins-add-custom-mcp-icon">
                <McpServerIcon />
              </MenuItemIcon>
              Add custom MCP server…
            </MenuItem>
          )}
          {onAddMarketplace && (
            <MenuItem
              data-testid="plugins-add-custom-marketplace"
              onClick={onAddMarketplace}
            >
              <MenuItemIcon data-testid="plugins-add-custom-marketplace-icon">
                <StorefrontIcon />
              </MenuItemIcon>
              Add marketplace…
            </MenuItem>
          )}
          {onInstallSkillsFromGitHub && (
            <MenuItem
              data-testid="plugins-add-custom-skills-github"
              onClick={onInstallSkillsFromGitHub}
            >
              <MenuItemIcon data-testid="plugins-add-custom-skills-github-icon">
                <GitHubIcon />
              </MenuItemIcon>
              Install skills from GitHub…
            </MenuItem>
          )}
          {onCreateCustomSkill && (
            <MenuItem
              data-testid="plugins-add-custom-skill-custom"
              onClick={onCreateCustomSkill}
            >
              <MenuItemIcon data-testid="plugins-add-custom-skill-custom-icon">
                <SquarePlusIcon />
              </MenuItemIcon>
              Create custom skill…
            </MenuItem>
          )}
          {onCreateCollection && (
            <MenuItem
              data-testid="plugins-add-custom-collection"
              onClick={onCreateCollection}
            >
              <MenuItemIcon data-testid="plugins-add-custom-collection-icon">
                <BundleIcon />
              </MenuItemIcon>
              Add collection…
            </MenuItem>
          )}
          {onCreateAgent && (
            <MenuItem
              data-testid="plugins-add-custom-agent"
              onClick={onCreateAgent}
            >
              <MenuItemIcon data-testid="plugins-add-custom-agent-icon">
                <AgentIcon />
              </MenuItemIcon>
              New model preset…
            </MenuItem>
          )}
        </ActionMenuRowStyle>
      </Menu>
    </div>
  );
}

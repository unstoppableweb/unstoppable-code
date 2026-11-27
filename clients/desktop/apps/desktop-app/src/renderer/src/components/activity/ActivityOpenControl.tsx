import {
  Fragment,
  useCallback,
  useId,
  useMemo,
  useRef,
  useState,
  type JSX,
} from 'react';
import type { DevServerHit } from '@/lib/scriptDevServerDetection';
import { ChevronIcon, GlobeIcon } from '@canopy/ui-shared/icons';
import { MenuDivider, MenuLabel, Menu } from '@canopy/ui-shared';
import {
  ActionMenuRowStyle,
  HeaderActionButton,
} from '@canopy/ui-shared/components';
import { DevServerMenuItem } from './DevServerMenuItem';
import {
  getDevServerOpenAriaLabel,
  getDevServerOpenButtonText,
  openDevServerHit,
  type DevServerOpenContext,
} from './devServerOpen';
import { Tooltip } from '@canopy/ui-shared';

/** The trigger's 6px gap; the menu is 280px (`w-70`). */
const MENU_GAP = 6;

export interface ActivityOpenSection {
  scriptKey: string;
  scriptLabel: string;
  /**
   * Optional repo / workspace-root tag rendered above the script label in
   * the dropdown header. Populated only for multi-repo workspaces so single
   * repo headers stay uncluttered.
   */
  repoContext?: string;
  hits: DevServerHit[];
}

interface ActivityOpenControlProps {
  sections: ActivityOpenSection[];
  /** Worktree context used to route `in-app` opens to the Browser tab. */
  context: DevServerOpenContext;
  variant?: 'header' | 'collapsed';
}

export function ActivityOpenControl({
  sections,
  context,
  variant = 'header',
}: ActivityOpenControlProps): JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuId = useId();

  const totalHits = useMemo(
    () => sections.reduce((sum, section) => sum + section.hits.length, 0),
    [sections],
  );

  const singleHit = useMemo((): DevServerHit | null => {
    if (totalHits !== 1) return null;
    for (const section of sections) {
      if (section.hits.length > 0) {
        return section.hits[0];
      }
    }
    return null;
  }, [sections, totalHits]);

  const closeMenu = useCallback((): void => setMenuOpen(false), []);

  if (totalHits === 0) {
    return <></>;
  }

  // The header's accent action, like the Create PR button it sits beside.
  const triggerClass = variant === 'collapsed' ? 'w-full' : undefined;

  const globeSizeClass = variant === 'collapsed' ? 'h-3 w-3' : 'h-4 w-4';

  if (singleHit) {
    return (
      <Tooltip label={singleHit.url}>
        <HeaderActionButton
          tone="accent"
          onClick={(): void => openDevServerHit(singleHit, context)}
          aria-label={getDevServerOpenAriaLabel(singleHit)}
          className={triggerClass}
        >
          <GlobeIcon className={globeSizeClass} aria-hidden="true" />
          {getDevServerOpenButtonText(singleHit)}
        </HeaderActionButton>
      </Tooltip>
    );
  }

  const showSectionHeaders = sections.length > 1;

  return (
    <div className={variant === 'collapsed' ? 'w-full' : 'inline-flex'}>
      <HeaderActionButton
        ref={triggerRef}
        tone="accent"
        onClick={(): void => setMenuOpen((prev) => !prev)}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-controls={menuOpen ? menuId : undefined}
        className={triggerClass}
      >
        <GlobeIcon className={globeSizeClass} aria-hidden="true" />
        <span>Open</span>
        <ChevronIcon open={menuOpen} />
      </HeaderActionButton>
      <Menu
        id={menuId}
        open={menuOpen}
        onOpenChange={setMenuOpen}
        anchorRef={triggerRef}
        placement="bottom-left"
        gap={MENU_GAP}
        interaction="menu"
        className="w-70"
      >
        <ActionMenuRowStyle>
          {sections.map((section, sectionIndex) => (
            <Fragment key={`${section.scriptKey}-${sectionIndex}`}>
              {showSectionHeaders && sectionIndex > 0 && <MenuDivider />}
              {showSectionHeaders && (
                <MenuLabel>
                  {section.repoContext && (
                    <span className="block truncate">
                      {section.repoContext}
                    </span>
                  )}
                  <span className="block truncate">{section.scriptLabel}</span>
                </MenuLabel>
              )}
              {/* Every row opens a dev server: one icon per section,
                  shown on its first row. */}
              {section.hits.map((hit, hitIndex) => (
                <DevServerMenuItem
                  key={`${section.scriptKey}-${hit.url}`}
                  hit={hit}
                  context={context}
                  icon={
                    hitIndex === 0 ? (
                      <GlobeIcon size="sm" aria-hidden="true" />
                    ) : null
                  }
                  onSelect={closeMenu}
                />
              ))}
            </Fragment>
          ))}
        </ActionMenuRowStyle>
      </Menu>
    </div>
  );
}

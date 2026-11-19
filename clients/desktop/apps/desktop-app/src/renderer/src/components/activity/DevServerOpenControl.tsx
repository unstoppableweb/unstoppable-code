import { useId, useRef, useState, type JSX } from 'react';
import type { DevServerHit } from '@/lib/scriptDevServerDetection';
import { GlobeIcon } from '@canopy/ui-shared/icons';
import {
  ActionMenuRowStyle,
  Button,
  FloatingMenu,
} from '@canopy/ui-shared/components';
import { DevServerMenuItem } from './DevServerMenuItem';
import {
  getDevServerOpenAriaLabel,
  getDevServerOpenButtonText,
  openDevServerHit,
  type DevServerOpenContext,
} from './devServerOpen';

interface DevServerOpenControlProps {
  hits: DevServerHit[];
  /** Worktree context used to route `in-app` opens to the Browser tab. */
  context: DevServerOpenContext;
}

/**
 * "Open dev server URL" affordance rendered inside the live script ribbon and
 * the enlarged run modal. A single hit renders as a direct button; two or
 * more hits render as an `Open (N)` trigger that opens a small menu of
 * deduped URLs.
 *
 * Only hits already validated by detection (http/https) are rendered, but
 * each open click defensively re-checks the protocol; non-http(s) URLs are
 * ignored.
 */
export function DevServerOpenControl({
  hits,
  context,
}: DevServerOpenControlProps): JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuId = useId();

  if (hits.length === 0) {
    return <></>;
  }

  if (hits.length === 1) {
    const [hit] = hits;
    return (
      <Button
        variant="ghost"
        size="compact"
        onClick={(): void => openDevServerHit(hit, context)}
        aria-label={getDevServerOpenAriaLabel(hit)}
      >
        <GlobeIcon size="sm" aria-hidden="true" />
        {getDevServerOpenButtonText(hit)}
      </Button>
    );
  }

  return (
    <div className="inline-flex">
      <Button
        ref={triggerRef}
        variant="ghost"
        size="compact"
        onClick={(): void => setMenuOpen((prev) => !prev)}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-controls={menuOpen ? menuId : undefined}
      >
        <GlobeIcon size="sm" aria-hidden="true" />
        Open ({hits.length})
      </Button>
      <FloatingMenu
        id={menuId}
        open={menuOpen}
        onOpenChange={setMenuOpen}
        anchorRef={triggerRef}
        placement="bottom-right"
        interaction="menu"
        className="min-w-48 max-w-96"
      >
        <ActionMenuRowStyle>
          {hits.map((hit, index) => (
            <DevServerMenuItem
              key={hit.url}
              hit={hit}
              context={context}
              icon={
                index === 0 ? <GlobeIcon size="sm" aria-hidden="true" /> : null
              }
              onSelect={(): void => setMenuOpen(false)}
            />
          ))}
        </ActionMenuRowStyle>
      </FloatingMenu>
    </div>
  );
}

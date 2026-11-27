import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type JSX,
} from 'react';
import {
  ActionMenuRowStyle,
  Button,
  MenuItem,
  MenuItemIcon,
  Menu,
  PlanCopyAction,
  PlanOpenImplementationAction,
  planCopyStateFromMarkdown,
} from '@canopy/ui-shared';
import { ChatIcon, PipelineIcon } from '@canopy/ui-shared/icons/AppIcons';
import {
  ChevronDownMediumIcon,
  MoreHorizontalIcon,
  SearchIcon,
  ShareIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import { Tooltip } from '@canopy/ui-shared';

/**
 * Below this control-row width the labelled Explore/Share buttons stop fitting
 * alongside the Execute dropdown, so they collapse to icon-only. The Execute
 * dropdown keeps its label at all sizes. Extremely narrow rows wrap instead of
 * overflowing (see `flex-wrap` on the wrapper).
 */
const COMPACT_WIDTH = 248;

export interface PlanActionControlsProps {
  onExplore: () => void;
  onImplement: () => void;
  onPipeline: () => void;
  /** Plan markdown for Copy plan, beside Share (CAN-5354). */
  planContent: string;
  /** Disable Explore when no plan id is available yet. */
  exploreDisabled?: boolean;
  /** Hide the Explore button entirely (e.g. when already inside Explore). */
  showExplore?: boolean;
  /**
   * Open the share flow. When provided, a Share button renders before the
   * Execute control. The caller owns the label/disabled/busy state machine.
   */
  onShare?: () => void;
  /** Visible label for the Share button (e.g. `Share`, `Shared`, `Retry share`). */
  shareLabel?: string;
  /** Tooltip for the Share button (e.g. why it is disabled). */
  shareTitle?: string;
  /** Disable the Share button (e.g. while viewing an old revision). */
  shareDisabled?: boolean;
  /** Reflect an in-flight share so the button cannot be re-triggered. */
  shareBusy?: boolean;
  /** Disable execution choices after a plan has already been acted on. */
  executeDisabled?: boolean;
  /** Tooltip for Execute, such as why its choices are disabled. */
  executeTitle?: string;
  /**
   * Execute is the primary action while a plan awaits review and secondary
   * once it is approved, implementing, implemented, or dismissed. Emphasis
   * only: eligibility and the disabled rules are unchanged.
   */
  executeEmphasis?: 'primary' | 'secondary';
  /**
   * `open` replaces Execute with Open for the selected implementation
   * attempt, and its menu moves behind an overflow button as retries. Needs
   * `onOpen` and `openVenue`; otherwise Execute stays.
   */
  primaryAction?: 'execute' | 'open';
  /** Where the selected attempt runs, naming Open chat or Open run. */
  openVenue?: 'chat' | 'pipeline';
  /** Navigate to exactly the selected attempt. */
  onOpen?: () => void;
  implementLabel?: string;
  dataTestIdPrefix: string;
}

export function PlanActionControls({
  onExplore,
  onImplement,
  onPipeline,
  planContent,
  exploreDisabled = false,
  showExplore = true,
  onShare,
  shareLabel = 'Share',
  shareTitle,
  shareDisabled = false,
  shareBusy = false,
  executeDisabled = false,
  executeTitle,
  executeEmphasis = 'primary',
  primaryAction = 'execute',
  openVenue,
  onOpen,
  implementLabel = 'Implement',
  dataTestIdPrefix,
}: PlanActionControlsProps): JSX.Element {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [compact, setCompact] = useState(false);

  const closeMenu = useCallback((): void => {
    setMenuOpen(false);
    triggerRef.current?.focus();
  }, []);

  // Collapse Explore/Share to icon-only when the available row width narrows.
  // We measure the parent, not the wrapper itself: the wrapper is a shrink-to-fit
  // flex item, so measuring it would latch to compact once the buttons collapse
  // (smaller content -> smaller wrapper -> stays compact). The parent fills the
  // available width independent of how the buttons render.
  useLayoutEffect(() => {
    const target = wrapperRef.current?.parentElement;
    if (!target || typeof ResizeObserver === 'undefined') {
      return;
    }
    const observer = new ResizeObserver((entries): void => {
      const width = entries[0]?.contentRect.width;
      if (typeof width === 'number') {
        setCompact(width < COMPACT_WIDTH);
      }
    });
    observer.observe(target);
    return (): void => {
      observer.disconnect();
    };
  }, []);

  const handleExplore = useCallback((): void => {
    if (exploreDisabled) {
      return;
    }
    onExplore();
  }, [exploreDisabled, onExplore]);

  const handleToggleMenu = useCallback((): void => {
    setMenuOpen((open) => !open);
  }, []);

  const handlePipeline = useCallback((): void => {
    if (executeDisabled) {
      return;
    }
    closeMenu();
    onPipeline();
  }, [executeDisabled, onPipeline, closeMenu]);

  const handleImplement = useCallback((): void => {
    if (executeDisabled) {
      return;
    }
    closeMenu();
    onImplement();
  }, [executeDisabled, onImplement, closeMenu]);

  const handleShare = useCallback((): void => {
    if (shareDisabled || shareBusy) {
      return;
    }
    onShare?.();
  }, [onShare, shareBusy, shareDisabled]);

  const showOpen = primaryAction === 'open' && onOpen && openVenue;

  // Shared placement and focus apply to Execute and the retry overflow trigger.
  const executeMenu = (
    <Menu
      key={showOpen ? 'retry' : 'execute'}
      open={menuOpen}
      onOpenChange={setMenuOpen}
      anchorRef={triggerRef}
      placement="bottom-right"
      interaction="menu"
      className="min-w-40"
      data-testid={`${dataTestIdPrefix}-execute-menu`}
    >
      <ActionMenuRowStyle>
        <MenuItem
          onClick={handlePipeline}
          disabled={executeDisabled}
          data-testid={`${dataTestIdPrefix}-execute-pipeline`}
        >
          <MenuItemIcon>
            <PipelineIcon />
          </MenuItemIcon>
          {showOpen ? 'Run again as workflow' : 'Workflow'}
        </MenuItem>
        <MenuItem
          onClick={handleImplement}
          disabled={executeDisabled}
          data-testid={`${dataTestIdPrefix}-execute-implement`}
        >
          <MenuItemIcon>
            <ChatIcon />
          </MenuItemIcon>
          {showOpen ? 'Implement again in chat' : implementLabel}
        </MenuItem>
      </ActionMenuRowStyle>
    </Menu>
  );

  return (
    <div
      ref={wrapperRef}
      className="relative flex flex-wrap items-center gap-2"
    >
      {/* The app's shared buttons, in the 28px compact size: Explore and
          Share on the secondary surface, Execute as the primary action
          (secondary while the plan cannot run or no longer awaits review). */}
      {showExplore && (
        <Tooltip label="Explore" suppressed={!compact}>
          {compact ? (
            <Button
              size="compact"
              variant="secondary"
              iconOnly
              aria-label="Explore"
              onClick={handleExplore}
              disabled={exploreDisabled}
              data-testid={`${dataTestIdPrefix}-explore`}
            >
              <SearchIcon size="sm" />
            </Button>
          ) : (
            <Button
              size="compact"
              variant="secondary"
              onClick={handleExplore}
              disabled={exploreDisabled}
              data-testid={`${dataTestIdPrefix}-explore`}
            >
              <SearchIcon size="sm" />
              Explore
            </Button>
          )}
        </Tooltip>
      )}

      {onShare && (
        <Tooltip
          label={shareTitle ?? (compact ? shareLabel : undefined)}
          suppressed={shareTitle === undefined && !compact}
        >
          {compact ? (
            <Button
              size="compact"
              variant="secondary"
              iconOnly
              aria-label={shareLabel}
              onClick={handleShare}
              disabled={shareDisabled || shareBusy}
              aria-busy={shareBusy}
              data-testid={`${dataTestIdPrefix}-share`}
            >
              <ShareIcon size="sm" />
            </Button>
          ) : (
            <Button
              size="compact"
              variant="secondary"
              onClick={handleShare}
              disabled={shareDisabled || shareBusy}
              aria-label={shareLabel}
              aria-busy={shareBusy}
              data-testid={`${dataTestIdPrefix}-share`}
            >
              <ShareIcon size="sm" />
              {shareLabel}
            </Button>
          )}
        </Tooltip>
      )}

      {/* Copy plan stays in view beside Share, the same shared action as the
          web plan card's; the Execute menu no longer repeats it. */}
      <PlanCopyAction
        state={planCopyStateFromMarkdown(planContent)}
        appearance="control"
        compact={compact}
        dataTestId={`${dataTestIdPrefix}-copy`}
      />

      {showOpen ? (
        <>
          {/* Open goes to the selected attempt; retries keep Execute's
              choices, restrictions and in-flight guards behind the menu. */}
          <PlanOpenImplementationAction
            venue={openVenue}
            onOpen={onOpen}
            compact={compact}
            dataTestIdPrefix={dataTestIdPrefix}
          />
          <Tooltip label="More actions">
            <Button
              ref={triggerRef}
              size="compact"
              variant="secondary"
              iconOnly
              aria-label="More actions"
              onClick={handleToggleMenu}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              data-testid={`${dataTestIdPrefix}-more`}
            >
              <MoreHorizontalIcon size="md" aria-hidden />
            </Button>
          </Tooltip>
        </>
      ) : (
        <Tooltip label={executeTitle} suppressed={executeTitle === undefined}>
          <Button
            ref={triggerRef}
            size="compact"
            variant={
              executeDisabled || executeEmphasis === 'secondary'
                ? 'secondary'
                : 'primary'
            }
            onClick={handleToggleMenu}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            data-testid={`${dataTestIdPrefix}-execute`}
          >
            Execute
            <ChevronDownMediumIcon
              size="sm"
              aria-hidden
              className={`shrink-0 transition-transform ${menuOpen ? 'rotate-180' : ''}`}
            />
          </Button>
        </Tooltip>
      )}

      {executeMenu}
    </div>
  );
}

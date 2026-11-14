'use client';

import {
  forwardRef,
  useCallback,
  useEffect,
  useRef,
  useState,
  type JSX,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { CheckIcon, CopyIcon } from '../icons/AppIcons';
import { Button } from './Button';
import { FloatingMenu, FloatingMenuPointAnchor } from './FloatingMenu';
import type { PopoverAnchorRect } from './Popover';
import { Tooltip } from './Tooltip';

const COPIED_DURATION_MS = 1500;
/** Clear of the selection, and of the window's edges. */
const SELECTION_GAP = 6;

interface SelectionPillActionBase {
  readonly key: string;
  /** Hover help; also the accessible name of Copy. */
  readonly tooltip: string;
  readonly testId: string;
}

/** A plain action: an icon, a label and a handler. */
export interface SelectionPillButtonAction extends SelectionPillActionBase {
  readonly label: string;
  readonly icon: ReactNode;
  readonly shortcut?: string;
  readonly onSelect: () => void;
}

/** Copy: shows Copied for a moment once `onCopy` reports it worked. */
export interface SelectionPillCopyAction extends SelectionPillActionBase {
  readonly onCopy: () => boolean | Promise<boolean>;
}

export type SelectionPillAction =
  | SelectionPillButtonAction
  | SelectionPillCopyAction;

export type SelectionActionPillPlacement =
  /**
   * Floats above the selection's box, right-aligned to it, and flips below
   * when there is more room below. If neither side fits, the pill may
   * overlap the selection to keep every action visible. For selections in
   * an editor whose layers would otherwise cover the pill.
   */
  | {
      readonly kind: 'window';
      readonly rect: PopoverAnchorRect;
      readonly ownerDocument: Document;
    }
  /**
   * At these offsets inside the positioned pane that renders it, so it stays
   * under the pane's dialogs and hides with the pane: a terminal keeps its
   * pill alive while its tab is in the background.
   */
  | { readonly kind: 'pane'; readonly top: number; readonly left: number };

export interface SelectionActionPillProps {
  readonly placement: SelectionActionPillPlacement;
  /** In order. Presses keep the text selected. */
  readonly actions: readonly SelectionPillAction[];
  /** `menu` also gives each action the `menuitem` role. */
  readonly role?: 'menu';
  readonly 'aria-label'?: string;
  readonly 'data-testid'?: string;
}

function isCopyAction(
  action: SelectionPillAction,
): action is SelectionPillCopyAction {
  return 'onCopy' in action;
}

/** A press on the pill must not clear the selection it acts on. */
function keepSelection(event: MouseEvent<HTMLButtonElement>): void {
  event.preventDefault();
  event.stopPropagation();
}

function CopyAction({
  action,
  itemRole,
}: {
  action: SelectionPillCopyAction;
  itemRole: 'menuitem' | undefined;
}): JSX.Element {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearTimer = useCallback((): void => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);
  useEffect((): (() => void) => clearTimer, [clearTimer]);

  const label = copied ? 'Copied' : action.tooltip;
  return (
    <Tooltip label={label}>
      <Button
        variant="ghost"
        size="compact"
        role={itemRole}
        data-testid={action.testId}
        aria-label={label}
        onMouseDown={keepSelection}
        onClick={(event): void => {
          keepSelection(event);
          void (async (): Promise<void> => {
            if (!(await action.onCopy())) return;
            clearTimer();
            setCopied(true);
            timerRef.current = setTimeout((): void => {
              setCopied(false);
              timerRef.current = null;
            }, COPIED_DURATION_MS);
          })();
        }}
      >
        {copied ? (
          <CheckIcon aria-hidden="true" />
        ) : (
          <CopyIcon aria-hidden="true" />
        )}
        <span>{copied ? 'Copied' : 'Copy'}</span>
      </Button>
    </Tooltip>
  );
}

function ButtonAction({
  action,
  itemRole,
}: {
  action: SelectionPillButtonAction;
  itemRole: 'menuitem' | undefined;
}): JSX.Element {
  return (
    <Tooltip label={action.tooltip}>
      <Button
        variant="ghost"
        size="compact"
        role={itemRole}
        data-testid={action.testId}
        shortcut={action.shortcut}
        onMouseDown={keepSelection}
        onClick={(event): void => {
          keepSelection(event);
          action.onSelect();
        }}
      >
        {action.icon}
        <span>{action.label}</span>
      </Button>
    </Tooltip>
  );
}

function ignoreOpenChange(): void {}

/**
 * The compact row of actions on a text selection, as the file editor and
 * the terminal both draw it. The editor keeps focus, so it reads no keys; the
 * owner decides when it goes by not rendering it. The returned ref is the
 * pill itself, for the owner's outside-press check.
 */
export const SelectionActionPill = forwardRef<
  HTMLDivElement,
  SelectionActionPillProps
>(function SelectionActionPill(
  {
    placement,
    actions,
    role,
    'aria-label': ariaLabel,
    'data-testid': dataTestId,
  },
  ref,
): JSX.Element {
  const anchorRef = useRef<HTMLSpanElement>(null);
  const itemRole = role === 'menu' ? 'menuitem' : undefined;
  const pill = (
    <div
      ref={ref}
      role={role}
      aria-label={ariaLabel}
      data-testid={dataTestId}
      className="flex gap-0.5 whitespace-nowrap rounded-full bg-card/95 p-0.5 fg-primary shadow-xl backdrop-blur"
      onMouseDown={(event): void => event.stopPropagation()}
    >
      {actions.map((action) =>
        isCopyAction(action) ? (
          <CopyAction key={action.key} action={action} itemRole={itemRole} />
        ) : (
          <ButtonAction key={action.key} action={action} itemRole={itemRole} />
        ),
      )}
    </div>
  );

  if (placement.kind === 'pane') {
    return (
      <div
        className="absolute z-20"
        style={{ top: placement.top, left: placement.left }}
      >
        {pill}
      </div>
    );
  }
  const { rect, ownerDocument } = placement;
  return (
    <>
      <FloatingMenuPointAnchor
        ref={anchorRef}
        x={rect.left}
        y={rect.top}
        width={rect.width}
        height={rect.height}
        ownerDocument={ownerDocument}
      />
      <FloatingMenu
        open
        onOpenChange={ignoreOpenChange}
        anchorRef={anchorRef}
        anchorRect={rect}
        ownerDocument={ownerDocument}
        placement="top-right"
        preserveHeightOnCollision
        gap={SELECTION_GAP}
        viewportPadding={SELECTION_GAP}
        interaction="passive"
        motion="none"
        role="presentation"
        shell="bare"
        padding="none"
        className="w-max"
      >
        {pill}
      </FloatingMenu>
    </>
  );
});

SelectionActionPill.displayName = 'SelectionActionPill';

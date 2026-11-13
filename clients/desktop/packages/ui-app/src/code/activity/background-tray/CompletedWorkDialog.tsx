'use client';
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type JSX,
  type ReactNode,
  type RefObject,
} from 'react';
import {
  DialogModal,
  OverlayScrollArea,
  Count,
} from '@canopy/ui-shared/components';
import { ChevronRightIcon } from '@canopy/ui-shared/icons/AppIcons';
import { drawerReducedMotion } from '../../ComposerWorkDrawer';
import {
  DRAWER_ROW_LIST_CLASS,
  DrawerRowPresentationContext,
} from './drawer-presentation';

export function CompletedWorkTrigger({
  count,
  onOpen,
  restoreFocusRef,
}: {
  readonly count: number;
  readonly onOpen: () => void;
  readonly restoreFocusRef: RefObject<HTMLElement | null>;
}): JSX.Element {
  return (
    <button
      type="button"
      data-testid="background-tray-completed"
      onClick={(event): void => {
        restoreFocusRef.current =
          event.currentTarget
            .closest('[data-testid="composer-work-drawer"]')
            ?.querySelector<HTMLButtonElement>(
              '[data-testid="composer-work-pill"][aria-expanded="true"]',
            ) ?? null;
        onOpen();
      }}
      className="focus-ring focus-ring-inset flex h-9 w-full min-w-0 items-center gap-2.5 rounded-drawer-row pl-2.75 pr-1 text-left text-s fg-secondary hover:bg-subtle"
    >
      <span aria-hidden="true" className="w-3.5 shrink-0" />
      <span className="flex flex-1 items-center gap-1.5">
        View completed <Count value={count} />
      </span>
      <span className="flex h-7 w-7 items-center justify-center">
        <ChevronRightIcon size={14} />
      </span>
    </button>
  );
}

export function CompletedWorkDialog({
  count,
  children,
  expandedKeys,
  shown,
  onClose,
  restoreFocusRef,
}: {
  readonly count: number;
  readonly children: ReactNode;
  readonly expandedKeys: ReadonlySet<string>;
  readonly shown: boolean;
  readonly onClose: () => void;
  readonly restoreFocusRef: RefObject<HTMLElement | null>;
}): JSX.Element | null {
  const [animate, setAnimate] = useState(false);
  const body = useRef<HTMLDivElement>(null);
  const previous = useRef<number | null>(null);
  const motion = useRef<Animation | null>(null);
  useLayoutEffect(() => {
    if (!shown) {
      motion.current?.cancel();
      previous.current = null;
      return;
    }
    const card = body.current?.closest('[role="dialog"]');
    if (!(card instanceof HTMLElement)) return;
    const from =
      motion.current?.playState === 'running'
        ? card.getBoundingClientRect().height
        : previous.current;
    motion.current?.cancel();
    const to = card.getBoundingClientRect().height;
    previous.current = to;
    if (
      from === null ||
      from === to ||
      !animate ||
      drawerReducedMotion() ||
      typeof card.animate !== 'function'
    )
      return;
    motion.current = card.animate(
      [{ height: `${String(from)}px` }, { height: `${String(to)}px` }],
      { duration: 200, easing: 'cubic-bezier(0.215,0.61,0.355,1)' },
    );
  }, [shown, expandedKeys, animate]);
  useEffect(() => (): void => motion.current?.cancel(), []);
  if (count === 0) return null;
  return (
    <>
      {shown && (
        <DialogModal
          inset="flush"
          title="Completed work"
          maxWidth="md"
          headerAlignment="center"
          closeButtonAppearance="compact"
          placement="center"
          scrollableBody={false}
          trapFocus
          restoreFocusRef={restoreFocusRef}
          onClose={onClose}
          dataTestId="completed-work-dialog"
        >
          <OverlayScrollArea
            className="flex-1"
            viewportClassName="overscroll-contain"
          >
            <div
              ref={body}
              onClickCapture={(event): void => setAnimate(event.detail > 0)}
              onKeyDownCapture={(): void => setAnimate(false)}
              className="p-2"
            >
              <DrawerRowPresentationContext.Provider value="modal">
                <ul className={DRAWER_ROW_LIST_CLASS}>{children}</ul>
              </DrawerRowPresentationContext.Provider>
            </div>
          </OverlayScrollArea>
        </DialogModal>
      )}
    </>
  );
}

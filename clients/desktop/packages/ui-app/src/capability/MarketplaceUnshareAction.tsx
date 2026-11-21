import type { MarketplaceShareLinkKind } from '@canopy/protocol/marketplace';
import {
  useCallback,
  useRef,
  useState,
  type JSX,
  type ReactNode,
  type RefObject,
} from 'react';
import type { DetailMoreMenuItem } from '@canopy/ui-shared/components/DetailMoreMenu';
import { Button } from '@canopy/ui-shared/components/Button';
import { ConfirmDialog } from '@canopy/ui-shared/components/ConfirmDialog';
import { Tooltip } from '@canopy/ui-shared/components/Tooltip';
import { UnshareIcon } from '@canopy/ui-shared/icons/AppIcons';
import { REPLAY_MASK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import {
  MARKETPLACE_UNSHARE_BUSY_LABEL,
  MARKETPLACE_UNSHARE_LABEL,
  MarketplaceUnshareError,
  marketplaceUnshareErrorMessage,
  marketplaceUnshareMessage,
} from '@canopy/ui-shared/lib/marketplace-unshare';

export interface MarketplaceUnshareActionProps {
  readonly kind: MarketplaceShareLinkKind;
  /** The share's user-authored name, masked for session replay. */
  readonly name: string;
  /** The organization or team it is shared with, when known. */
  readonly ownerName?: string | null;
  /**
   * Deletes the account share. Resolves only once the server acknowledged
   * the delete; rejects with a `MarketplaceUnshareError` for a refusal the
   * dialog can explain, or anything else for a generic retry.
   */
  readonly onUnshare: () => Promise<void>;
  /**
   * Runs once after a confirmed delete: refresh inventories, navigate away,
   * notify. Its own failures are not reported as a failed Unshare.
   */
  readonly onUnshared: () => void;
  readonly dataTestId?: string;
  /** Compact row trigger; detail buttons keep their visible label. */
  readonly iconOnly?: boolean;
  readonly renderTrigger?: (unshare: MarketplaceUnshare) => ReactNode;
}

export type UseMarketplaceUnshareOptions = Omit<
  MarketplaceUnshareActionProps,
  'dataTestId'
> & {
  readonly dataTestId?: string;
  /** Where focus returns when the confirmation closes. */
  readonly restoreFocusRef?: RefObject<HTMLElement | null>;
};

export interface MarketplaceUnshare {
  /** Opens the confirmation. */
  readonly open: () => void;
  /** True while the delete is in flight or after it completed. */
  readonly disabled: boolean;
  /**
   * The ⋯ More menu item: last, destructive, with the broken-link glyph
   * (CAN-4266). Hosts that use it render {@link dialog} beside the menu.
   */
  readonly item: DetailMoreMenuItem;
  /** The confirmation, or `null` while closed. */
  readonly dialog: ReactNode;
}

/**
 * The owner's Unshare flow without its trigger: a confirmation that waits
 * for the server and keeps itself open with a retryable error on refusal.
 * {@link MarketplaceUnshareAction} renders it as a button; a detail header
 * puts its `item` last in the ⋯ More menu.
 */
export function useMarketplaceUnshare({
  kind,
  name,
  ownerName,
  onUnshare,
  onUnshared,
  dataTestId = 'marketplace-unshare',
  restoreFocusRef,
}: UseMarketplaceUnshareOptions): MarketplaceUnshare {
  const [isOpen, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  // `refused`: the server explained why it would not delete (the page is out
  // of date, or shared collections still use it), a state to act on rather
  // than a failure to record. `alreadyReported`: the adapter recorded it.
  const [error, setError] = useState<{
    readonly message: string;
    readonly refused: boolean;
    readonly alreadyReported: boolean;
  } | null>(null);
  const [completed, setCompleted] = useState(false);
  // A ref, not state: a second confirm in the same frame must not send a
  // second delete before `pending` re-renders the trigger disabled.
  const inFlight = useRef(false);

  const open = useCallback((): void => setOpen(true), []);
  const close = useCallback((): void => {
    if (inFlight.current) return;
    setOpen(false);
    setError(null);
  }, []);

  const confirm = useCallback((): void => {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setError(null);
    onUnshare().then(
      () => {
        setCompleted(true);
        inFlight.current = false;
        setPending(false);
        setOpen(false);
        try {
          onUnshared();
        } catch {
          // The share is gone; a refresh or navigation failure afterwards
          // must not read as a failed delete or invite another one.
        }
      },
      (reason: unknown) => {
        inFlight.current = false;
        setPending(false);
        const failure =
          reason instanceof MarketplaceUnshareError ? reason.reason : 'unknown';
        setError({
          message: marketplaceUnshareErrorMessage(kind, failure),
          refused: failure !== 'unknown',
          alreadyReported:
            reason instanceof MarketplaceUnshareError && reason.alreadyReported,
        });
      },
    );
  }, [kind, onUnshare, onUnshared]);

  const disabled = pending || completed;
  return {
    open,
    disabled,
    item: {
      id: 'unshare',
      label: MARKETPLACE_UNSHARE_LABEL,
      testId: dataTestId,
      onSelect: open,
      disabled,
      destructive: true,
      icon: <UnshareIcon size="sm" aria-hidden />,
    },
    dialog: isOpen ? (
      <ConfirmDialog
        title={
          <>
            Unshare “<span className={REPLAY_MASK_CLASS}>{name}</span>”?
          </>
        }
        message={marketplaceUnshareMessage(kind, ownerName)}
        confirmLabel={MARKETPLACE_UNSHARE_LABEL}
        busyLabel={MARKETPLACE_UNSHARE_BUSY_LABEL}
        busy={pending}
        {...(error?.refused || error?.alreadyReported
          ? {
              errorMessage: error.message,
              errorRecordingDisabled: true as const,
            }
          : {
              errorMessage: error?.message ?? null,
              errorSource: 'marketplace-unshare',
            })}
        destructive
        restoreFocusRef={restoreFocusRef}
        onConfirm={confirm}
        onCancel={close}
        dataTestId={`${dataTestId}-dialog`}
        confirmTestId={`${dataTestId}-confirm`}
        cancelTestId={`${dataTestId}-cancel`}
      />
    ) : null,
  };
}

/**
 * The owner's Unshare on a shared Marketplace detail as a visible button,
 * for a host that has no ⋯ More menu. Hosts gate it on the viewer's
 * `canDelete` verdict.
 */
export function MarketplaceUnshareAction({
  dataTestId = 'marketplace-unshare',
  iconOnly = false,
  renderTrigger,
  ...options
}: MarketplaceUnshareActionProps): JSX.Element {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const unshare = useMarketplaceUnshare({
    ...options,
    dataTestId,
    restoreFocusRef: triggerRef,
  });
  return (
    <>
      {renderTrigger ? (
        renderTrigger(unshare)
      ) : iconOnly ? (
        <Tooltip label={MARKETPLACE_UNSHARE_LABEL}>
          <Button
            ref={triggerRef}
            iconOnly
            size="sm"
            variant="ghost"
            aria-label={MARKETPLACE_UNSHARE_LABEL}
            onClick={unshare.open}
            disabled={unshare.disabled}
            data-testid={dataTestId}
          >
            <UnshareIcon size={16} aria-hidden />
          </Button>
        </Tooltip>
      ) : (
        <Button
          ref={triggerRef}
          type="button"
          size="compact"
          onClick={unshare.open}
          disabled={unshare.disabled}
          data-testid={dataTestId}
        >
          <UnshareIcon size="sm" aria-hidden />
          {MARKETPLACE_UNSHARE_LABEL}
        </Button>
      )}
      {unshare.dialog}
    </>
  );
}

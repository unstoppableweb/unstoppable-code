'use client';

import { useEffect, useRef, useState, type JSX, type RefObject } from 'react';
import {
  ChoiceField,
  ConfirmDialog,
  Button,
  Tooltip,
  Notice,
  Fact,
  FactList,
} from '@canopy/ui-shared/components';
import { WatchingIcon, TrashIcon } from '@canopy/ui-shared/icons/AppIcons';
import { REPLAY_BLOCK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import { DrawerRow } from './DrawerRow';

/** A subscribing chat's watcher, projected by its host without execution state. */
export interface BackgroundTrayWatcher {
  readonly id: string;
  readonly name: string;
  readonly watching: string;
  readonly trigger: string;
  readonly status: 'active' | 'delivery_failed';
  readonly details: readonly {
    readonly label: string;
    readonly value: string;
  }[];
  readonly followUpInstruction?: string;
  readonly deliveryError?: string;
}

export type DeleteBackgroundTrayWatcher = (
  watcherId: string,
  notifySubscriber: boolean,
) => Promise<
  { readonly ok: true } | { readonly ok: false; readonly error: string }
>;

export function WatcherRow({
  watcher,
  open,
  onToggle,
  onDelete,
  listRef,
}: {
  readonly watcher: BackgroundTrayWatcher;
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly onDelete?: DeleteBackgroundTrayWatcher;
  readonly listRef: RefObject<HTMLDivElement | null>;
}): JSX.Element {
  const [confirming, setConfirming] = useState(false);
  const [notifySubscriber, setNotifySubscriber] = useState(false);
  const [busy, setBusy] = useState(false);
  const [deleted, setDeleted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const testId = `background-tray-watcher-${watcher.id}`;
  useEffect(() => {
    if (!onDelete) setConfirming(false);
  }, [onDelete]);
  const remove = async (): Promise<void> => {
    if (!onDelete || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await onDelete(watcher.id, notifySubscriber);
      if (result.ok) {
        setDeleted(true);
        setConfirming(false);
      } else setError(result.error);
    } catch {
      setError('Could not delete the watcher. Try again.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <DrawerRow
        rowKey={`watcher:${watcher.id}`}
        testId={testId}
        glyph={<WatchingIcon size="sm" className="fg-info" />}
        name={<span className={REPLAY_BLOCK_CLASS}>{watcher.name}</span>}
        detail={<span className={REPLAY_BLOCK_CLASS}>{watcher.watching}</span>}
        status={
          watcher.status === 'delivery_failed' ? 'Delivery failed' : undefined
        }
        attention={watcher.status === 'delivery_failed'}
        listRef={listRef}
        topInset={0}
        action={
          onDelete ? (
            <Tooltip label="Delete watcher">
              <Button
                variant="ghost-overlay"
                size="compact"
                iconOnly
                aria-label="Delete watcher"
                data-testid={`${testId}-delete`}
                disabled={deleted || busy}
                onClick={(event): void => {
                  restoreFocusRef.current =
                    event.currentTarget
                      .closest('[data-testid="composer-work-drawer"]')
                      ?.querySelector<HTMLButtonElement>(
                        '[data-testid="composer-work-pill"][aria-expanded="true"]',
                      ) ?? null;
                  setNotifySubscriber(false);
                  setError(null);
                  setConfirming(true);
                }}
              >
                <TrashIcon size="sm" />
              </Button>
            </Tooltip>
          ) : undefined
        }
        inspector={{
          open,
          onToggle,
          render: (): JSX.Element => (
            <div className="flex min-w-0 flex-col gap-3">
              <FactList
                layout="stacked"
                columns={1}
                size="s"
                rowGap="3"
                labelTone="tertiary"
                valueTone="primary"
              >
                {watcher.details
                  .filter(
                    (detail) =>
                      detail.label === 'Context' &&
                      detail.value !== watcher.watching,
                  )
                  .map((detail, index) => (
                    <Fact key={`context:${index}`} label="About">
                      <span className={REPLAY_BLOCK_CLASS}>{detail.value}</span>
                    </Fact>
                  ))}
                <Fact label="Notify when">
                  <span className={REPLAY_BLOCK_CLASS}>
                    {watcher.details.find(
                      (detail) => detail.label === 'Notifies on',
                    )?.value ?? watcher.trigger}
                  </span>
                </Fact>
                {watcher.details
                  .filter(
                    (detail) =>
                      !['Context', 'Notifies on'].includes(detail.label) &&
                      detail.value !== watcher.watching,
                  )
                  .map((detail, index) => (
                    <Fact key={`${detail.label}:${index}`} label={detail.label}>
                      <span className={REPLAY_BLOCK_CLASS}>{detail.value}</span>
                    </Fact>
                  ))}
                {watcher.followUpInstruction?.trim() && (
                  <Fact label="Follow-up" testId="watcher-follow-up-field">
                    <span
                      className={`${REPLAY_BLOCK_CLASS} whitespace-pre-wrap`}
                    >
                      {watcher.followUpInstruction}
                    </span>
                  </Fact>
                )}
              </FactList>
              {watcher.deliveryError && (
                <Notice
                  errorSource="watcher-row"
                  intent="destructive"
                  role="none"
                  title="Follow-up wasn’t delivered"
                >
                  <span className={REPLAY_BLOCK_CLASS}>
                    {watcher.deliveryError}
                  </span>
                </Notice>
              )}
            </div>
          ),
        }}
      />
      {confirming && (
        <ConfirmDialog
          title="Delete watcher?"
          message="This chat will stop waiting for this watcher."
          confirmLabel="Delete watcher"
          busyLabel="Deleting…"
          destructive
          busy={busy}
          errorMessage={error}
          onConfirm={(): void => {
            void remove();
          }}
          onCancel={(): void => setConfirming(false)}
          restoreFocusRef={restoreFocusRef}
          dataTestId={`${testId}-delete-dialog`}
          confirmTestId={`${testId}-delete-confirm`}
        >
          <ChoiceField
            label="Notify subscribing chat"
            checked={notifySubscriber}
            disabled={busy}
            onChange={(event): void =>
              setNotifySubscriber(event.target.checked)
            }
          />
        </ConfirmDialog>
      )}
    </>
  );
}

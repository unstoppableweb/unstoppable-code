'use client';

import {
  useEffect,
  useLayoutEffect,
  useId,
  useRef,
  useState,
  type JSX,
} from 'react';
import {
  Button,
  ComponentSection,
  CopyLinkButton,
  DataTableBody,
  DataTableCell,
  DataTableFrame,
  DataTableHead,
  DataTableHeaderCell,
  DataTableRow,
  ErrorBanner,
  ShareAudienceLabel,
} from '@canopy/ui-shared/components';
import { formatMonthDay } from '@canopy/ui-shared/lib/billing-format';
import type { SharedByYouRow } from '../sharing/sharedByYouRow';
import {
  copyMarketplaceLink,
  marketplaceLinkCopiedNotice,
  type SharedLinkKind,
} from '../sharing/marketplaceShareLink';
import { RemovePublicLinkConfirmDialog } from '../sharing/RemovePublicLinkConfirmDialog';
import { useMarketplaceUnshare } from './MarketplaceUnshareAction';

export function MarketplaceOwnerRow(props: {
  kind: SharedLinkKind;
  name: string;
  row: SharedByYouRow | null;
  onUnshared: (mode: 'delete' | 'revoke') => void;
}): JSX.Element | null {
  return props.row ? (
    <OwnerRow key={props.row.identity} {...props} row={props.row} />
  ) : null;
}
function OwnerRow({
  kind,
  name,
  row,
  onUnshared,
}: {
  kind: SharedLinkKind;
  name: string;
  row: SharedByYouRow;
  onUnshared: (mode: 'delete' | 'revoke') => void;
}): JSX.Element {
  const [removing, setRemoving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [removed, setRemoved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const active = useRef(true);
  const current = useRef(row);
  useLayoutEffect(() => {
    current.current = row;
  }, [row]);
  useEffect(() => {
    active.current = true;
    return (): void => {
      active.current = false;
    };
  }, []);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const reasonId = useId();
  const unshare = useMarketplaceUnshare({
    kind,
    name,
    dataTestId: 'shared-by-you-unshare',
    ownerName: row.name,
    onUnshare: async () => {
      if (!current.current.action.available)
        throw new Error('Sharing access changed. Refresh and try again.');
      await current.current.action.run();
    },
    onUnshared: (): void => {
      if (active.current) onUnshared('delete');
    },
    restoreFocusRef: trigger,
  });
  const revoke = async (): Promise<void> => {
    if (inFlight.current || !current.current.action.available) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      await current.current.action.run();
      if (active.current) {
        setRemoved(true);
        setRemoving(false);
        try {
          onUnshared('revoke');
        } catch {
          /* A confirmed removal remains successful. */
        }
      }
    } catch {
      if (active.current)
        setError('Couldn’t remove the public link. Try again.');
    } finally {
      inFlight.current = false;
      if (active.current) setBusy(false);
    }
  };
  const refresh = async (): Promise<void> => {
    if (inFlight.current || !current.current.refresh?.available) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      await current.current.refresh.run();
    } catch {
      if (active.current)
        setError('Couldn’t update the public link. Refresh and try again.');
    } finally {
      inFlight.current = false;
      if (active.current) setBusy(false);
    }
  };
  const copy = row.copy;
  return (
    <div data-testid="shared-by-you">
      <ComponentSection title="Shared by you">
        <DataTableFrame caption="Shared by you" layout="fixed">
          <DataTableHead>
            <DataTableHeaderCell width="34%">Shared with</DataTableHeaderCell>
            <DataTableHeaderCell width="18%">Access</DataTableHeaderCell>
            <DataTableHeaderCell width="16%">Since</DataTableHeaderCell>
            <DataTableHeaderCell align="right">Actions</DataTableHeaderCell>
          </DataTableHead>
          <DataTableBody>
            <DataTableRow
              data-testid="shared-by-you-row"
              data-access={row.audience}
            >
              <DataTableCell tone="primary" replay="mask" overflow="truncate">
                {row.name}
              </DataTableCell>
              <DataTableCell>
                <ShareAudienceLabel audience={row.audience} />
              </DataTableCell>
              <DataTableCell>
                {row.sinceIso ? formatMonthDay(row.sinceIso) : ''}
              </DataTableCell>
              <DataTableCell align="right" overflow="wrap">
                <div className="flex items-center justify-end gap-3">
                  {copy && (
                    <CopyLinkButton
                      key={`${copy.link}:${marketplaceLinkCopiedNotice(copy.access)}`}
                      url={copy.link}
                      dataTestId="shared-by-you-copy-link"
                      write={() =>
                        copyMarketplaceLink(
                          copy.link,
                          copy.access,
                          copy.port,
                          () =>
                            active.current &&
                            current.current.copy?.link === copy.link &&
                            JSON.stringify(current.current.copy?.access) ===
                              JSON.stringify(copy.access),
                        )
                      }
                    />
                  )}
                  {!row.action.available && (
                    <span id={reasonId} className="text-xs fg-tertiary">
                      {row.action.reason}
                    </span>
                  )}
                  <Button
                    ref={trigger}
                    size="compact"
                    variant="ghost-destructive"
                    data-testid="shared-by-you-unshare"
                    disabled={
                      !row.action.available ||
                      busy ||
                      removed ||
                      unshare.disabled
                    }
                    aria-describedby={
                      row.action.available ? undefined : reasonId
                    }
                    onClick={() =>
                      row.mode === 'delete' ? unshare.open() : setRemoving(true)
                    }
                  >
                    Unshare
                  </Button>
                </div>
              </DataTableCell>
            </DataTableRow>
            {row.audience === 'public' && (
              <DataTableRow>
                <DataTableCell colSpan={4} overflow="wrap">
                  <div
                    className="flex items-center gap-3 text-xs fg-secondary"
                    data-testid="shared-by-you-public-version"
                  >
                    <span>
                      {row.publicLinkPinnedAt
                        ? `Public link shows the version from ${formatMonthDay(row.publicLinkPinnedAt)}`
                        : 'Public link shows a pinned version.'}
                    </span>
                    {row.refresh?.available && (
                      <Button
                        data-testid="shared-by-you-public-update"
                        size="compact"
                        variant="ghost"
                        disabled={busy || removed}
                        onClick={() => void refresh()}
                      >
                        Update
                      </Button>
                    )}
                  </div>
                </DataTableCell>
              </DataTableRow>
            )}
          </DataTableBody>
        </DataTableFrame>
        <ErrorBanner
          errorSource="owner-row-removing"
          error={removing ? null : error}
        />
        {row.mode === 'delete' && unshare.dialog}
        {removing && (
          <RemovePublicLinkConfirmDialog
            testIdPrefix="shared-by-you"
            trapFocus
            restoreFocusRef={trigger}
            busy={busy}
            onCancel={() => {
              if (!inFlight.current) {
                setRemoving(false);
                setError(null);
              }
            }}
            onConfirm={() => void revoke()}
            errorMessage={error}
          />
        )}
      </ComponentSection>
    </div>
  );
}

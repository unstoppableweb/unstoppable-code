'use client';

import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import { Trash2 } from '@canopy/ui-shared/icons/AppIcons';
import {
  Button,
  ErrorBanner,
  Stack,
  StatusBadge,
  Heading,
  Tooltip,
} from '@canopy/ui-shared/components';
import { SETTINGS_GROUP_CLASS } from '@canopy/ui-shared/components/settings/SettingsCard';
import { formatDate, recordSurfacedError } from '@canopy/ui-shared/lib';
import { createAppError } from '@canopy/protocol/app-errors';
import type { OrganizationExternalShare } from '@canopy/protocol/settings/organization';
import {
  SettingsConfirmDialog,
  useSettingsClient,
  useSettingsPrivacy,
} from '../host';
import { useSettingsErrorCopy, type SettingsFailure } from '../errors';
import { joinClassNames } from './join-class-names';
import {
  listOrganizationExternalShares,
  removeOrganizationExternalShare,
} from './team-api';

const EXTERNAL_SHARES_ERROR_SCOPE = 'settings.organization.external-shares';

interface TeamExternalSharesListProps {
  orgId: string;
}

function recipientLabel(share: OrganizationExternalShare): string {
  return share.recipient.kind === 'email'
    ? share.recipient.email
    : (share.recipient.name ?? 'Someone outside the organization');
}

function containerKindLabel(share: OrganizationExternalShare): string {
  return share.container.kind === 'work_entry' ? 'Work Entry' : 'Worktree';
}

/**
 * Owners and Admins: every share of the organization's worktrees and Work
 * Entries with people outside it, with a confirmed Remove per share
 * (CAN-3420). Shown under "Allow sharing outside the organization".
 */
export function TeamExternalSharesList({
  orgId,
}: TeamExternalSharesListProps): JSX.Element {
  const client = useSettingsClient();
  const { blockClassName } = useSettingsPrivacy();
  const errorCopy = useSettingsErrorCopy(EXTERNAL_SHARES_ERROR_SCOPE);
  const [shares, setShares] = useState<OrganizationExternalShare[] | null>(
    null,
  );
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<SettingsFailure | null>(null);
  const [pending, setPending] = useState<OrganizationExternalShare | null>(
    null,
  );
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<SettingsFailure | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  // Fences a page that lands after a newer reload or an organization change.
  const loadVersion = useRef(0);

  const loadFirstPage = useCallback(async (): Promise<void> => {
    const version = ++loadVersion.current;
    try {
      setError(null);
      const page = await listOrganizationExternalShares(client, orgId);
      if (version !== loadVersion.current) return;
      setShares(page.items);
      setNextCursor(page.nextCursor);
    } catch (err) {
      if (version !== loadVersion.current) return;
      setShares([]);
      setNextCursor(null);
      setError(errorCopy.loadFailure(err));
    }
  }, [client, orgId, errorCopy]);

  useEffect(() => {
    setShares(null);
    void loadFirstPage();
  }, [loadFirstPage]);

  const loadMore = async (): Promise<void> => {
    if (nextCursor === null) return;
    const version = loadVersion.current;
    try {
      setLoadingMore(true);
      const page = await listOrganizationExternalShares(
        client,
        orgId,
        nextCursor,
      );
      if (version !== loadVersion.current) return;
      setShares((current) => [...(current ?? []), ...page.items]);
      setNextCursor(page.nextCursor);
    } catch (err) {
      if (version === loadVersion.current) setError(errorCopy.loadFailure(err));
    } finally {
      setLoadingMore(false);
    }
  };

  const remove = async (share: OrganizationExternalShare): Promise<void> => {
    try {
      setRemovingId(share.id);
      setRemoveError(null);
      await removeOrganizationExternalShare(client, orgId, share.id);
      // Removal is immediate; drop the row and close.
      setShares(
        (current) => current?.filter((item) => item.id !== share.id) ?? null,
      );
      setPending(null);
    } catch (err) {
      recordSurfacedError({
        chokePoint: 'notice',
        surface: 'inline',
        identifier: 'team-external-share-remove',
        // A structured error reaches the handler each time, so repeats count
        // instead of being dropped as duplicate text sightings.
        error: createAppError('app.unexpected'),
      });
      setRemoveError(
        errorCopy.actionFailure(err, { action: 'remove the share' }),
      );
    } finally {
      setRemovingId(null);
    }
  };

  return (
    <Stack gap="item" data-testid="team-external-shares">
      <Stack gap="tight">
        <Heading level={3} variant="title">
          Shared outside the organization
        </Heading>
        <p className="text-xs fg-secondary">
          Worktrees and Work Entries members have shared with people outside
          this organization. Removing a share takes effect right away.
        </p>
      </Stack>
      <ErrorBanner
        errorSource="team-external-shares"
        className=""
        error={error?.copy}
        details={error?.details}
      />
      {shares === null ? null : shares.length === 0 ? (
        error ? null : (
          <p
            className="text-xs fg-secondary"
            data-testid="team-external-shares-empty"
          >
            Nothing is shared outside the organization.
          </p>
        )
      ) : (
        <ul ref={listRef} className={SETTINGS_GROUP_CLASS}>
          {shares.map((share) => (
            <li
              key={share.id}
              data-testid="team-external-share-row"
              className="flex items-center justify-between gap-3"
            >
              <div className="flex min-w-0 flex-1 items-center gap-3">
                <Stack gap="tight" className="min-w-0">
                  <div className="flex min-w-0 items-center gap-2">
                    <p
                      className={joinClassNames(
                        'truncate text-s font-medium fg-primary',
                        blockClassName,
                      )}
                    >
                      {recipientLabel(share)}
                    </p>
                    {share.recipient.status === 'invited' ? (
                      <StatusBadge variant="warning" label="Invited" />
                    ) : (
                      <StatusBadge variant="success" label="Joined" />
                    )}
                  </div>
                  <span
                    className={joinClassNames(
                      'text-xs fg-secondary',
                      blockClassName,
                    )}
                  >
                    {containerKindLabel(share)} “{share.container.title}”{' · '}
                    shared by {share.owner.name ?? 'a member'}
                    {' · '}
                    {formatDate(share.sharedAt)}
                  </span>
                </Stack>
              </div>
              <Tooltip label="Remove share">
                <Button
                  iconOnly
                  variant="ghost"
                  size="compact"
                  className="shrink-0"
                  aria-label={`Remove ${recipientLabel(share)} from ${share.container.title}`}
                  onClick={() => {
                    setRemoveError(null);
                    setPending(share);
                  }}
                  disabled={removingId === share.id}
                  data-testid="team-external-share-remove"
                >
                  <Trash2 size={14} />
                </Button>
              </Tooltip>
            </li>
          ))}
        </ul>
      )}
      {nextCursor !== null && (
        <div>
          <Button
            size="compact"
            onClick={() => void loadMore()}
            loading={loadingMore}
            data-testid="team-external-shares-more"
          >
            Show more
          </Button>
        </div>
      )}
      {pending && (
        <SettingsConfirmDialog
          title="Remove this share?"
          message={
            <>
              <span
                className={joinClassNames(
                  'font-medium fg-primary',
                  blockClassName,
                )}
              >
                {recipientLabel(pending)}
              </span>{' '}
              loses access to “{pending.container.title}” right away, and they
              no longer appear in {pending.owner.name ?? 'the owner'}’s
              recipients.
            </>
          }
          confirmLabel="Remove share"
          busyLabel="Removing…"
          busy={removingId === pending.id}
          destructive
          dataTestId="confirm-remove-external-share"
          errorMessage={removeError?.copy ?? null}
          // remove records this failure.
          errorRecordingDisabled
          errorDetails={removeError?.details}
          onConfirm={() => void remove(pending)}
          onCancel={() => {
            setPending(null);
            setRemoveError(null);
          }}
          // Confirming drops the row holding the Remove button.
          restoreFocusRef={listRef}
        />
      )}
    </Stack>
  );
}

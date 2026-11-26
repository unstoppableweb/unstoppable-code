import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type JSX,
  type ReactNode,
  type Ref,
} from 'react';
import { Button } from '@canopy/ui-shared/primitives/Button';
import { ComponentSection } from '@canopy/ui-shared/components/ComponentSection';
import {
  DataTableBody,
  DataTableCell,
  DataTableFrame,
  DataTableHead,
  DataTableHeaderCell,
  DataTableRow,
} from '@canopy/ui-shared/primitives/DataTable';
import { CopyLinkButton } from '@canopy/ui-shared/components/CopyLinkButton';
import { ShareAudienceLabel } from '@canopy/ui-shared/components/ShareAudienceLabel';
import { MARKETPLACE_UNSHARE_LABEL } from '@canopy/ui-shared/lib/marketplace-unshare';
import type { MarketplaceUnshareKind } from '@canopy/ui-shared/lib/marketplace-unshare';
import {
  SHARED_BY_YOU_REMOVE_LINK_ERROR,
  SHARED_BY_YOU_TITLE,
  sharedByYouCopyLinkAriaLabel,
  sharedByYouRemoveLinkAriaLabel,
  sharedByYouSinceLabel,
  sharedByYouUnshareAriaLabel,
} from '@canopy/ui-shared/lib/shared-by-you';
import { RemovePublicLinkConfirmDialog } from '../sharing/RemovePublicLinkConfirmDialog';
import type {
  SharedByYouAccountCopyLink,
  SharedByYouAudience,
} from '../sharing/sharedByYouAudiences';
import {
  notifyScopedLinkCopied,
  scopedLinkWriter,
} from '../sharing/sharedByYouScopedLink';
import { useMarketplaceUnshare } from './MarketplaceUnshareAction';

type AccountAudience = Extract<SharedByYouAudience, { id: 'account' }>;
type PublicAudience = Extract<SharedByYouAudience, { id: 'public' }>;

export interface SharedByYouSectionProps {
  readonly kind: MarketplaceUnshareKind;
  /** The shared item's user-authored name, masked for session replay. */
  readonly name: string;
  readonly audiences: readonly SharedByYouAudience[];
  /** Runs once after an audience was removed. */
  readonly onUnshared: (audience: SharedByYouAudience) => void;
  readonly dataTestId?: string;
}

const ACCOUNT_PERSONAL_NAME = 'Personal';

/**
 * "Shared by you" (CAN-4842): one row per audience the owner shared an item
 * with, each with its own Unshare. The account row deletes the share (its
 * public link goes too); the public-link row removes only the link. A host
 * that cannot run an action supplies it disabled with a reason.
 */
export function SharedByYouSection({
  kind,
  name,
  audiences,
  onUnshared,
  dataTestId = 'shared-by-you',
}: SharedByYouSectionProps): JSX.Element | null {
  if (audiences.length === 0) return null;
  return (
    <div data-testid={dataTestId}>
      <ComponentSection title={SHARED_BY_YOU_TITLE}>
        <DataTableFrame caption="Shared by you" layout="fixed">
          <DataTableHead>
            <DataTableHeaderCell width="34%">Shared with</DataTableHeaderCell>
            <DataTableHeaderCell width="18%">Access</DataTableHeaderCell>
            <DataTableHeaderCell width="16%">Since</DataTableHeaderCell>
            <DataTableHeaderCell align="right">Actions</DataTableHeaderCell>
          </DataTableHead>
          <DataTableBody>
            {audiences.map((audience) =>
              audience.id === 'account' ? (
                <SharedByYouAccountRow
                  key={audience.id}
                  kind={kind}
                  name={name}
                  audience={audience}
                  onUnshared={onUnshared}
                />
              ) : (
                <SharedByYouPublicLinkRow
                  // Keyed on the link's identity: a re-published link is a new
                  // row, so a removed link's disabled state never carries over.
                  key={`${audience.id}:${audience.linkId ?? audience.sinceIso ?? ''}`}
                  name={name}
                  audience={audience}
                  onUnshared={onUnshared}
                />
              ),
            )}
          </DataTableBody>
        </DataTableFrame>
      </ComponentSection>
    </div>
  );
}

function RowSince({
  id,
  sinceIso,
}: {
  id: SharedByYouAudience['id'];
  sinceIso?: string;
}): JSX.Element | null {
  if (sinceIso === undefined) return null;
  return (
    <span
      data-testid={`shared-by-you-since-${id}`}
      className="shrink-0 text-xs fg-tertiary"
    >
      {sharedByYouSinceLabel(sinceIso).replace(/^Since /, '')}
    </span>
  );
}

function RowUnshare({
  id,
  ariaLabel,
  action,
  disabled = false,
  onClick,
  buttonRef,
  leading,
}: {
  id: SharedByYouAudience['id'];
  ariaLabel: string;
  action: SharedByYouAudience['action'];
  disabled?: boolean;
  onClick: () => void;
  buttonRef?: Ref<HTMLButtonElement>;
  /** A row action shown before Unshare, such as Copy link. */
  leading?: ReactNode;
}): JSX.Element {
  const reasonId = useId();
  return (
    <div className="flex items-center justify-end gap-3">
      {leading}
      {!action.available && (
        <span
          id={reasonId}
          data-testid={`shared-by-you-reason-${id}`}
          className="text-xs fg-tertiary"
        >
          {action.reason}
        </span>
      )}
      <Button
        ref={buttonRef}
        variant="ghost-destructive"
        size="compact"
        data-testid={`shared-by-you-unshare-${id}`}
        aria-label={ariaLabel}
        aria-describedby={action.available ? undefined : reasonId}
        disabled={!action.available || disabled}
        onClick={action.available ? onClick : undefined}
      >
        {MARKETPLACE_UNSHARE_LABEL}
      </Button>
    </div>
  );
}

const NOTHING_TO_RUN = (): Promise<void> => Promise.resolve();

/**
 * The account row's Copy link (CAN-5452): the member link through the
 * shared control, so `Copied` and the notice show only after the write
 * succeeds. A failed write warns through the host instead.
 */
function RowCopyLink({
  name,
  audienceName,
  copyLink,
}: {
  name: string;
  audienceName: string;
  copyLink: SharedByYouAccountCopyLink;
}): JSX.Element {
  const { link, port } = copyLink;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return (): void => {
      mounted.current = false;
    };
  }, []);
  const write = useMemo(
    () => scopedLinkWriter(port, () => mounted.current),
    [port],
  );
  const onCopy = useCallback(
    (): void => notifyScopedLinkCopied(port, link),
    [link, port],
  );
  return (
    <CopyLinkButton
      url={link.url}
      dataTestId="shared-by-you-copy-link-account"
      ariaLabel={sharedByYouCopyLinkAriaLabel(name, audienceName)}
      write={write}
      onCopy={onCopy}
    />
  );
}

function SharedByYouAccountRow({
  kind,
  name,
  audience,
  onUnshared,
}: {
  kind: MarketplaceUnshareKind;
  name: string;
  audience: AccountAudience;
  onUnshared: (audience: SharedByYouAudience) => void;
}): JSX.Element {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const { action } = audience;
  const displayName = audience.personal ? ACCOUNT_PERSONAL_NAME : audience.name;
  const unshare = useMarketplaceUnshare({
    kind,
    name,
    ownerName: displayName,
    onUnshare: action.available ? action.run : NOTHING_TO_RUN,
    onUnshared: () => onUnshared(audience),
    dataTestId: 'shared-by-you-unshare-account',
    restoreFocusRef: triggerRef,
  });
  return (
    <DataTableRow data-testid="shared-by-you-row-account">
      <DataTableCell tone="primary" replay="mask" overflow="truncate">
        {displayName}
      </DataTableCell>
      <DataTableCell>
        <ShareAudienceLabel audience={audience.audience} />
      </DataTableCell>
      <DataTableCell>
        <RowSince id="account" sinceIso={audience.sinceIso} />
      </DataTableCell>
      <DataTableCell align="right" overflow="wrap">
        <RowUnshare
          id="account"
          ariaLabel={sharedByYouUnshareAriaLabel(name, displayName)}
          action={action}
          disabled={unshare.disabled}
          onClick={unshare.open}
          buttonRef={triggerRef}
          leading={
            audience.copyLink ? (
              <RowCopyLink
                key={`${audience.copyLink.link.url}:${audience.copyLink.link.audienceName}:${String(audience.copyLink.link.hasPublicLink)}:${String(audience.copyLink.link.personal)}`}
                name={name}
                audienceName={displayName}
                copyLink={audience.copyLink}
              />
            ) : undefined
          }
        />
        {unshare.dialog}
      </DataTableCell>
    </DataTableRow>
  );
}

function SharedByYouPublicLinkRow({
  name,
  audience,
  onUnshared,
}: {
  name: string;
  audience: PublicAudience;
  onUnshared: (audience: SharedByYouAudience) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [removed, setRemoved] = useState(false);
  // A ref, not state: a second confirm in the same frame must not run twice.
  const inFlight = useRef(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const { action } = audience;

  const close = useCallback((): void => {
    if (inFlight.current) return;
    setOpen(false);
    setError(null);
  }, []);

  const confirm = useCallback((): void => {
    if (!action.available || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    action.run().then(
      () => {
        inFlight.current = false;
        setBusy(false);
        setRemoved(true);
        setOpen(false);
        try {
          onUnshared(audience);
        } catch {
          // The link is gone; a refresh failure must not read as a failed
          // removal or invite another one.
        }
      },
      () => {
        inFlight.current = false;
        setBusy(false);
        setError(SHARED_BY_YOU_REMOVE_LINK_ERROR);
      },
    );
  }, [action, audience, onUnshared]);

  return (
    <DataTableRow data-testid="shared-by-you-row-public">
      <DataTableCell tone="primary" overflow="truncate">
        {audience.name}
      </DataTableCell>
      <DataTableCell>Public link</DataTableCell>
      <DataTableCell>
        <RowSince id="public" sinceIso={audience.sinceIso} />
      </DataTableCell>
      <DataTableCell align="right" overflow="wrap">
        <RowUnshare
          id="public"
          ariaLabel={sharedByYouRemoveLinkAriaLabel(name)}
          action={action}
          disabled={busy || removed}
          onClick={(): void => setOpen(true)}
          buttonRef={triggerRef}
        />
        {open && (
          <RemovePublicLinkConfirmDialog
            testIdPrefix="shared-by-you"
            trapFocus
            restoreFocusRef={triggerRef}
            {...(audience.remainingAudience
              ? { remainingAudience: audience.remainingAudience }
              : {})}
            busy={busy}
            onCancel={close}
            onConfirm={confirm}
            errorMessage={error}
          />
        )}
      </DataTableCell>
    </DataTableRow>
  );
}

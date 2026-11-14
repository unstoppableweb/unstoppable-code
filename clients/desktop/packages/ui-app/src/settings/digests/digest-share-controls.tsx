'use client';

import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import {
  Button,
  CloseButton,
  copyTextToClipboard,
  FloatingMenu,
  FLOATING_PICKER_GAP,
  TextInput,
  CopyDetailsButton,
  ToggleSwitch,
  Heading,
} from '@canopy/ui-shared/components';
import {
  CopyIcon,
  RefreshIcon,
  ShareIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import type {
  DigestProfileAudience,
  DigestProfileFeatureResponse,
} from '@canopy/protocol/settings';
import { useSettingsErrorCopy, type SettingsFailure } from '../errors';
import {
  SettingsConfirmDialog,
  useSettingsClient,
  useSettingsHost,
  useSettingsPrivacy,
} from '../host';
import {
  setDigestProfileFeature,
  updateDigestSharing,
  type DigestOwner,
  type DigestShareUpdate,
  type DigestShareUpdateResult,
} from './digest-api';
import { joinClassNames } from './digest-class-names';
import { Divider } from '@canopy/ui-shared/components';

export interface DigestShareControlsProps {
  /**
   * Whose digest this is. The account owner updates sharing through
   * `account.digests.share.update`; an organization through
   * `organization.digests.sharing.update`.
   */
  owner: DigestOwner;
  /** The digest's external id. */
  digestId: string;
  initialSharePath: string;
  initialSharingEnabled: boolean;
  /**
   * The owner's current organizations and whether this digest is featured on
   * each one's member profile. Personal digests only — organization digests
   * omit it and keep the link-only popover exactly as it was.
   *
   * INITIAL STATE ONLY. Every successful mutation response becomes the local
   * authoritative value; this prop is not re-read after mount.
   */
  initialAudiences?: DigestProfileAudience[];
}

/**
 * Both link-invalidating actions confirm first.
 *
 * Turning sharing off rotates the slug server-side, so it is destructive in
 * exactly the way "Rotate link" is: every URL already pasted into a channel,
 * doc, or email stops resolving, permanently, and turning sharing back on does
 * not restore them. The status line said so only AFTER the mutation, which is
 * the wrong order for an action with no undo. Confirming consequential and
 * irreversible actions is the established convention here — see
 * `team-members-section`, `team-billing-section`, and
 * `team-github-connection-section`.
 */
type PendingShareAction = 'disable-sharing' | 'rotate';

const SHARE_CONFIRMATIONS: Record<
  PendingShareAction,
  { title: string; message: string; confirmLabel: string }
> = {
  'disable-sharing': {
    title: 'Turn off sharing?',
    message:
      'This also replaces the share link. Anyone you have already sent it to will lose access, and turning sharing back on will not restore the old link.',
    confirmLabel: 'Turn off sharing',
  },
  rotate: {
    title: 'Create a new share link?',
    message:
      'The current link stops working immediately. Anyone you have already sent it to will need the new link.',
    confirmLabel: 'Rotate link',
  },
};

/**
 * Ties the trigger's `aria-controls` to the popover surface. A literal rather
 * than `useId` because only one share popover exists per digest detail page,
 * and `FloatingMenu` honours a caller-supplied `id` (`idProp ?? generatedId`).
 */
const SHARE_POPOVER_ID = 'digest-share-popover';

/**
 * `sharePath` is optional because `serializeDigest` omits the share link for
 * viewers who cannot manage sharing. Only editors can reach this mutation, so
 * it is present in practice — but typing it as required would hide the drift,
 * and `new URL(undefined, origin)` silently yields `/undefined` rather than
 * failing.
 */
type ShareMutationResponse = DigestShareUpdateResult;

/**
 * The digest detail page's primary share affordance: a top-right trigger that
 * opens an anchored popover holding the whole sharing surface.
 *
 * Placement is the point. This shipped as a card pinned below the report and
 * the older/newer nav, which put a first-class action below the fold on every
 * real digest. The behavior — the PATCH contract, both confirmations, and the
 * honest "turning sharing off rotates the slug" copy — is unchanged.
 */
export function DigestShareControls({
  owner,
  digestId,
  initialSharePath,
  initialSharingEnabled,
  initialAudiences,
}: DigestShareControlsProps): JSX.Element {
  const client = useSettingsClient();
  const host = useSettingsHost();
  const errorCopy = useSettingsErrorCopy('digests');
  const { blockClassName } = useSettingsPrivacy();
  const [sharePath, setSharePath] = useState(initialSharePath);
  const [sharingEnabled, setSharingEnabled] = useState(initialSharingEnabled);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<SettingsFailure | null>(null);
  // A status line that is not a failure: our sentence, nothing to copy.
  const say = (copy: string): void => setStatus({ copy });
  const [pendingAction, setPendingAction] = useState<PendingShareAction | null>(
    null,
  );
  // Sorted once at mount: the server already orders by name, but the local
  // authoritative copy is rebuilt on every mutation and must not reorder under
  // the user's cursor mid-session.
  const [audiences, setAudiences] = useState<DigestProfileAudience[]>(() =>
    [...(initialAudiences ?? [])].sort((a, b) =>
      a.organizationName.localeCompare(b.organizationName),
    ),
  );
  // A separate slot from `pendingAction` rather than a widened union: the two
  // confirmations can never coexist (every toggle is disabled while `saving`,
  // and requesting either closes the popover first), and the link actions'
  // destructive framing does not apply to featuring.
  const [pendingFeature, setPendingFeature] =
    useState<DigestProfileAudience | null>(null);
  const [open, setOpen] = useState(false);
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const switchRef = useRef<HTMLButtonElement | null>(null);
  const copyRef = useRef<HTMLButtonElement | null>(null);

  // The link the user pastes elsewhere must open the web app, never the host
  // the controls happen to render in, so it resolves against the web origin.
  // An unparsable origin falls back to the relative capability path.
  const shareUrl = useMemo((): string => {
    try {
      return new URL(sharePath, host.webOrigin()).href;
    } catch {
      return sharePath;
    }
  }, [host, sharePath]);

  // "Copied" is a claim about the current URL, so deriving it from the URL that
  // was actually written makes a rotated link invalidate the label without a
  // synchronous state reset effect.
  const copied = copiedUrl === shareUrl;

  // The Copy button reverts on its own; the effect owns the timer so an unmount
  // clears it rather than setting state on a dead tree.
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopiedUrl(null), 2000);
    return (): void => window.clearTimeout(timer);
  }, [copied]);

  function mutate(update: DigestShareUpdate): Promise<ShareMutationResponse> {
    return updateDigestSharing(client, owner, digestId, update);
  }

  /**
   * Both confirmations portal to `document.body`, exactly as this popover
   * does, so an open popover reads the dialog as an outside press and
   * dismisses itself mid-interaction. Closing first is the same sequencing
   * `subscription-actions-menu` uses.
   *
   * Closing unmounts the control that was just activated — the switch or
   * Rotate — which is the current `document.activeElement`. Parking focus on
   * the trigger keeps it off `<body>` for the moment between the popover
   * unmounting and the dialog mounting; `ConfirmDialog` then pulls focus into
   * itself and traps it, so the trigger is a waypoint rather than a resting
   * place while a modal is open. The trigger is `aria-expanded` false by then,
   * so this does not trip `useOverlayEscape`'s escape boundary.
   *
   * Deliberately NOT routed through `dismiss()`: the status line has to
   * survive the confirm round-trip and the reopen that follows it, since it is
   * the only feedback either action produces.
   */
  function requestConfirmation(action: PendingShareAction): void {
    setOpen(false);
    triggerRef.current?.focus();
    setPendingAction(action);
  }

  /**
   * The single ordinary-dismissal path. Every way the user can put the popover
   * away — the trigger toggle, the visible close button, Escape, an outside
   * press — has to land here, or the next session opens replaying the last
   * one's outcome: a stale "Share link copied.", or worse a lingering "Couldn't
   * update sharing" error reading as current state. Clearing `copied` with
   * it keeps the Copy button from claiming a link is on the clipboard when the
   * 2s timer is still pending from a previous session.
   */
  function dismiss(): void {
    setOpen(false);
    setStatus(null);
    setCopiedUrl(null);
    // Unconditional on purpose. An earlier revision gated this on "does the
    // popover currently hold focus", meaning to stop `focus()` from scrolling
    // the trigger back into view on an outside press. That guard could never
    // fire: the outside-press path runs on `pointerdown`, which precedes the
    // browser's focus change (pointerdown → mousedown → focus), and `trapFocus`
    // keeps focus inside the surface until then — so the condition was always
    // true and the code only looked like it handled a case it did not.
    // Returning focus to the trigger is the right outcome anyway: it is where
    // the user was, and it is what every keyboard dismissal needs.
    triggerRef.current?.focus();
  }

  // Only the OFF transition destroys links; turning sharing on is additive and
  // needs no confirmation.
  function requestToggleSharing(): void {
    if (sharingEnabled) {
      requestConfirmation('disable-sharing');
      return;
    }
    void toggleSharing();
  }

  // The dialog stays mounted for the duration of the request, so `busy` is
  // real: it disables both buttons (no double-submit) and shows `busyLabel`.
  // Clearing `pendingAction` first would unmount it on the same tick the PATCH
  // fires, leaving those props inert.
  //
  // Reopening the popover afterwards is not decoration: the status line lives
  // inside it, so dismissing to a bare page would swallow the only feedback
  // either action produces, and it puts the freshly rotated link one click from
  // Copy — which is what the user wanted next.
  async function confirmPendingAction(): Promise<void> {
    const action = pendingAction;
    try {
      if (action === 'disable-sharing') await toggleSharing();
      else if (action === 'rotate') await rotateLink();
    } finally {
      setPendingAction(null);
      setOpen(true);
    }
  }

  function cancelPendingAction(): void {
    setPendingAction(null);
    setOpen(true);
  }

  /**
   * Turning a profile audience ON confirms first, because it grants every
   * current member of that org read access to a report that may describe work
   * done elsewhere. Turning it OFF is immediate: it only removes access, and it
   * is reversible with one more click.
   */
  function requestToggleFeature(audience: DigestProfileAudience): void {
    if (audience.featured) {
      void setFeature(audience, false);
      return;
    }
    setOpen(false);
    triggerRef.current?.focus();
    setPendingFeature(audience);
  }

  async function confirmPendingFeature(): Promise<void> {
    const audience = pendingFeature;
    try {
      if (audience) await setFeature(audience, true);
    } finally {
      setPendingFeature(null);
      setOpen(true);
    }
  }

  function cancelPendingFeature(): void {
    setPendingFeature(null);
    setOpen(true);
  }

  /**
   * PUT features, DELETE unfeatures — both idempotent server-side, so a retry
   * of either converges rather than conflicting. There is deliberately NO
   * automatic retry: a failure leaves the previous toggle state intact and
   * surfaces a retryable message, because silently re-issuing a sharing grant
   * the user cannot see the outcome of is worse than making them press again.
   */
  async function setFeature(
    audience: DigestProfileAudience,
    featured: boolean,
  ): Promise<void> {
    setSaving(true);
    setStatus(null);
    try {
      let next: DigestProfileFeatureResponse;
      try {
        next = await setDigestProfileFeature(
          client,
          digestId,
          audience.organizationId,
          featured,
        );
      } catch (error) {
        // Only the statuses this route actually raises for irreversible state
        // are treated as terminal. The route answers 404 when the digest is no
        // longer READY, the membership was revoked, or the org was
        // soft-deleted; 403 when the org lost its `teams` capability. None of
        // those recover on retry, so telling the user to "try again" sends
        // them into a loop that cannot succeed.
        //
        // Deliberately NOT all of 4xx. A 401 from an expired session is the
        // most likely 4xx on a detail page left open, and it IS retryable
        // after re-auth — as are 408 and 429. Calling those permanent would be
        // a confident false statement, which is worse than the generic
        // message. A failure with no response at all stays retryable too.
        //
        // The toggle keeps its PRIOR state — `setAudiences` never runs — so
        // the UI does not claim a grant that the server refused.
        const terminal = `This digest can no longer be shared with ${audience.organizationName}. Refresh to see its current state.`;
        setStatus(
          errorCopy.actionFailure(error, {
            action: 'update profile sharing',
            known: [
              { status: 404, copy: terminal },
              { status: 403, copy: terminal },
            ],
          }),
        );
        return;
      }
      // The RESPONSE is authoritative, not the requested value: if membership
      // or the digest changed underneath this render, the server's answer is
      // what the next reader will see.
      setAudiences((current) =>
        current.map((item) =>
          item.organizationId === audience.organizationId
            ? { ...item, featured: next.featured }
            : item,
        ),
      );
      say(
        next.featured
          ? `Shared on your ${audience.organizationName} profile.`
          : `Removed from your ${audience.organizationName} profile.`,
      );
    } finally {
      setSaving(false);
    }
  }

  async function toggleSharing(): Promise<void> {
    setSaving(true);
    setStatus(null);
    try {
      const next = await mutate({
        action: 'set-sharing',
        sharingEnabled: !sharingEnabled,
      });
      setSharingEnabled(next.sharingEnabled);
      if (next.sharePath !== undefined) setSharePath(next.sharePath);
      // Turning sharing off ROTATES the slug server-side, so this is
      // destructive in the same way "Rotate link" is. Saying nothing here
      // would let it read as a reversible switch.
      say(
        next.sharingEnabled
          ? 'Sharing is on. Anyone with the link can view this digest.'
          : 'Sharing is off. Previously shared links no longer work, even if you turn sharing back on.',
      );
    } catch (error) {
      setStatus(errorCopy.actionFailure(error, { action: 'update sharing' }));
    } finally {
      setSaving(false);
    }
  }

  async function rotateLink(): Promise<void> {
    setSaving(true);
    setStatus(null);
    try {
      const next = await mutate({ action: 'rotate' });
      setSharingEnabled(next.sharingEnabled);
      // No `sharePath` means the old one was just revoked and we do not know
      // the new one — announcing success would leave "Copy share link" copying
      // a dead URL. Both mutate paths serialize with `includeShareLink`, so
      // this cannot currently fire; saying so out loud keeps it that way.
      if (next.sharePath === undefined) {
        say('Link rotated, but the new link could not be read. Reload.');
        return;
      }
      setSharePath(next.sharePath);
      say('A new share link is ready. Previous links no longer work.');
    } catch (error) {
      setStatus(errorCopy.actionFailure(error, { action: 'rotate the link' }));
    } finally {
      setSaving(false);
    }
  }

  async function copyLink(): Promise<void> {
    // Clear first, as both mutations do. Copy is the most repeated action here,
    // and a polite live region announces nothing when the text it already holds
    // is written again — so without this, the second copy is the one press that
    // produces no feedback at all (the button already reads "Copied").
    setStatus(null);
    // `copyTextToClipboard` falls back to the hidden-textarea `execCommand`
    // path when `navigator.clipboard` is missing (non-secure origin) and
    // reports failure rather than throwing, so the outcome is always named —
    // every other action here reports its own.
    const wrote = await copyTextToClipboard(shareUrl);
    setCopiedUrl(wrote ? shareUrl : null);
    say(wrote ? 'Share link copied.' : 'Unable to copy the link.');
  }

  // The trigger answers "is this digest shared with ANYONE", not "is the
  // anonymous link on". A digest featured on an org profile with the link off
  // is still shared, and reading "Share" would misrepresent it.
  const isShared = sharingEnabled || audiences.some((a) => a.featured);
  const showAudiences = audiences.length > 0;

  return (
    <div className="shrink-0" data-testid="digest-share-controls">
      <Button
        ref={triggerRef}
        variant="secondary"
        size="compact"
        aria-haspopup="dialog"
        aria-expanded={open}
        // Only while the surface exists: `aria-controls` pointing at an id
        // that is not in the document is a dangling reference, which some AT
        // and validators report as an error rather than ignoring.
        aria-controls={open ? SHARE_POPOVER_ID : undefined}
        data-testid="digest-share-trigger"
        onClick={(): void => (open ? dismiss() : setOpen(true))}
      >
        <ShareIcon size={16} aria-hidden="true" />
        {isShared && (
          <span
            aria-hidden="true"
            className="h-1.5 w-1.5 rounded-full bg-accent"
          />
        )}
        {isShared ? 'Shared' : 'Share'}
      </Button>

      <FloatingMenu
        id={SHARE_POPOVER_ID}
        open={open}
        // Escape and outside-press arrive here; both are ordinary dismissals.
        onOpenChange={(next: boolean): void => {
          if (next) setOpen(true);
          else dismiss();
        }}
        anchorRef={triggerRef}
        placement="bottom-right"
        gap={FLOATING_PICKER_GAP}
        interaction="manual"
        trapFocus
        initialFocusRef={sharingEnabled ? copyRef : switchRef}
        role="dialog"
        aria-label="Share this digest"
        data-testid="digest-share-popover"
        padding="content"
        className="w-80"
      >
        <div className="flex flex-col gap-3">
          <div className="flex items-start justify-between gap-2">
            <Heading level={2} variant="title">
              Share this digest
            </Heading>
            {/*
              `trapFocus` makes Escape or an outside press the only keyboard
              way out, so the exit has to be visible on the surface itself.
            */}
            <CloseButton onClick={dismiss} />
          </div>

          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-s font-medium fg-primary">
                Anyone with the link
              </p>
              <p className="mt-0.5 text-xs fg-secondary">
                They can read the complete report.
              </p>
            </div>
            <ToggleSwitch
              ref={switchRef}
              checked={sharingEnabled}
              label="Anyone with the link"
              disabled={saving}
              onChange={requestToggleSharing}
              dataTestId="digest-sharing-toggle"
            />
          </div>

          {sharingEnabled ? (
            <>
              <div className="flex items-center gap-2">
                <div
                  className={joinClassNames('min-w-0 flex-1', blockClassName)}
                >
                  <TextInput
                    readOnly
                    density="settings"
                    value={shareUrl}
                    aria-label="Share link"
                    data-testid="digest-share-link"
                    onFocus={(event): void => event.currentTarget.select()}
                  />
                </div>
                <Button
                  ref={copyRef}
                  variant="secondary"
                  size="compact"
                  disabled={saving}
                  onClick={(): void => void copyLink()}
                  data-testid="digest-copy-share-link"
                >
                  <CopyIcon size={14} aria-hidden="true" />
                  {copied ? 'Copied' : 'Copy'}
                </Button>
              </div>
              <div>
                <Button
                  variant="secondary"
                  size="compact"
                  disabled={saving}
                  onClick={(): void => requestConfirmation('rotate')}
                  data-testid="digest-rotate-share-link"
                >
                  <RefreshIcon size={14} aria-hidden="true" />
                  Rotate link
                </Button>
              </div>
            </>
          ) : (
            /*
              Nothing to rotate while sharing is off: the OFF transition already
              rotated the slug server-side. Hiding the action is honest; a
              disabled Rotate button would imply a link still exists.
            */
            <p className="text-xs fg-secondary">
              Turn on sharing to create a link you can send.
            </p>
          )}

          {showAudiences && (
            <div>
              <Divider />
              <div
                className="flex flex-col gap-2 pt-3"
                data-testid="digest-profile-audiences"
              >
                <div>
                  <p className="text-s font-medium fg-primary">
                    Organization profiles
                  </p>
                  <p className="mt-0.5 text-xs fg-secondary">
                    Turn on an organization to let its current members open this
                    from your member profile.
                  </p>
                </div>
                {/*
                Bounded height rather than growing with the membership list: a
                user in a dozen organizations would otherwise push the
                popover's own controls past the viewport edge with no way back.
              */}
                <ul className="-mr-1 flex max-h-40 flex-col gap-2 overflow-y-auto pr-1">
                  {audiences.map((audience) => (
                    <li
                      key={audience.organizationId}
                      className="flex items-center justify-between gap-4"
                    >
                      <span className="min-w-0 truncate text-s fg-primary">
                        {audience.organizationName}
                        {audience.lapsed && (
                          <span
                            className="block truncate text-xs fg-secondary"
                            id={`digest-profile-audience-lapsed-${audience.organizationId}`}
                            data-testid={`digest-profile-audience-lapsed-${audience.organizationId}`}
                          >
                            {audience.featured
                              ? 'Members cannot open this while the subscription is inactive'
                              : 'Unavailable while the subscription is inactive'}
                          </span>
                        )}
                      </span>
                      <ToggleSwitch
                        // Ties the lapse explanation to the control it explains.
                        // Without it a screen-reader user meets a disabled toggle
                        // whose `aria-label` says nothing about why, and the
                        // reason is only available as unassociated adjacent text.
                        // `aria-describedby` on a disabled native button is
                        // still announced by major screen readers, so this does
                        // reach the user.
                        describedBy={
                          audience.lapsed
                            ? `digest-profile-audience-lapsed-${audience.organizationId}`
                            : undefined
                        }
                        // Every audience toggle is disabled while ANY mutation is
                        // in flight, so two overlapping requests cannot resolve
                        // out of order into a state neither press asked for.
                        //
                        // A lapsed org disables only the OFF→ON direction. The
                        // server rejects granting into an org whose members
                        // cannot read the result, but revocation stays available
                        // in both layers — an owner must never be stuck unable to
                        // withdraw a grant because someone else's billing failed.
                        disabled={
                          saving || (audience.lapsed && !audience.featured)
                        }
                        checked={audience.featured}
                        label={`Share on your ${audience.organizationName} profile`}
                        onChange={(): void => requestToggleFeature(audience)}
                        dataTestId={`digest-profile-audience-toggle-${audience.organizationId}`}
                      />
                    </li>
                  ))}
                </ul>
                {/*
                Stated up front, not only in the confirmation: a personal digest
                is assembled from the user's work, which is not necessarily the
                selected org's work.
              */}
                <p className="text-xs fg-secondary">
                  Personal digests can include work from outside the selected
                  organization.
                </p>
              </div>
            </div>
          )}

          {/*
            The VISIBLE status line. Announcement is not its job — that belongs
            to the live region on the wrapper below (see there for why it cannot
            live in here). It is deliberately NOT `aria-hidden`: this is the
            only record of what a rotate did, and hiding it from the
            accessibility tree left a screen-reader user who missed the polite
            announcement with no way to re-read the outcome. The cost is that
            browse-mode traversal encounters the sentence twice, which is the
            accepted trade for static-text-plus-live-region.
          */}
          {status && <p className="text-xs fg-secondary">{status.copy}</p>}
          {status?.details !== undefined ? (
            <CopyDetailsButton details={status.details} />
          ) : null}
        </div>
      </FloatingMenu>

      {/*
        The live region lives HERE, on the always-mounted wrapper, not inside
        the popover.

        A live region is only announced when text changes inside a region the
        screen reader was already tracking. Both confirmed actions close the
        popover, run the mutation while it is unmounted, and reopen it with the
        status already present — so a region inside the portal is created with
        its content every time and announces nothing, which is exactly the case
        the status line exists for (it is the only feedback a rotate produces).
        Out here the node is stable across the whole confirm round-trip, so the
        mutation is a real text change.

        `sr-only` because the visible copy is rendered inside the popover;
        this one is for assistive tech only.
      */}
      <p role="status" aria-live="polite" className="sr-only">
        {status?.copy ?? ''}
      </p>

      {pendingAction && (
        <SettingsConfirmDialog
          title={SHARE_CONFIRMATIONS[pendingAction].title}
          message={SHARE_CONFIRMATIONS[pendingAction].message}
          confirmLabel={SHARE_CONFIRMATIONS[pendingAction].confirmLabel}
          busyLabel="Working…"
          busy={saving}
          destructive
          onConfirm={() => void confirmPendingAction()}
          onCancel={cancelPendingAction}
          dataTestId="digest-share-confirm-dialog"
        />
      )}

      {/*
        Not `destructive`: granting access is additive and one click reverses
        it. The copy carries the weight instead — naming the cross-org risk,
        the exact audience, what stays hidden, and what this is NOT (a public
        link), since those are the four things a user could otherwise assume
        wrongly.
      */}
      {pendingFeature && (
        <SettingsConfirmDialog
          title={`Share on your ${pendingFeature.organizationName} profile?`}
          message={`This personal digest may include work from outside ${pendingFeature.organizationName}. Every current member of ${pendingFeature.organizationName} will be able to open the report from your member profile. Costs and sensitive raw metrics stay hidden. This does not create a public link.`}
          confirmLabel="Share on profile"
          busyLabel="Sharing…"
          busy={saving}
          onConfirm={() => void confirmPendingFeature()}
          onCancel={cancelPendingFeature}
          dataTestId="digest-feature-confirm-dialog"
        />
      )}
    </div>
  );
}

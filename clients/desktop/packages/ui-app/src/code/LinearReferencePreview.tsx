'use client';

import {
  forwardRef,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type ComponentPropsWithoutRef,
  type JSX,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import {
  LINEAR_PREVIEW_CACHE_LIMITS,
  linearPreviewKey,
  linearTitleSlot,
  useCapabilities,
  useLinearPreviewStore,
  type LinearTeamCatalog,
} from '@canopy/app-state';
import type {
  LinearIssuePreviewRequest,
  ReferenceEnrichmentMode,
} from '@canopy/protocol/reference-previews';
import {
  TextLink,
  chatMessageLinkUrlProps,
  InlineMeasuredSkeleton,
  LinearIssuePreviewCard,
  linearStatusGlyph,
  HoverCard,
  WordBoundaryTruncatedText,
  type LinearIssuePreviewCardView,
  INLINE_CHIP_CLASS,
  INLINE_CHIP_ICON_CLASS,
  PREVIEW_CARD_SURFACE,
} from '@canopy/ui-shared/components';
import { LinearIcon } from '@canopy/ui-shared/icons/AppIcons';
import { useWatchWhileVisible } from './reference-preview-visibility';

const OPEN_DELAY_MS = 250;

/**
 * The team-key catalog for a transcript block that contains Linear
 * candidates; `null` on hosts without the capability. Loads it on first use
 * and again after an identity reset; the store coalesces and rate-bounds
 * those loads.
 */
export function useLinearTeamCatalog(enabled = true): LinearTeamCatalog | null {
  const supported = useCapabilities().referencePreviews === true;
  const catalog = useLinearPreviewStore((state) =>
    supported && enabled ? state.teamCatalog : null,
  );
  const ensure = useLinearPreviewStore((state) => state.ensureTeamCatalog);
  const idle = catalog?.status === 'idle';
  useEffect(() => {
    if (supported && enabled) ensure();
  }, [enabled, ensure, idle, supported]);
  return catalog;
}

/** Queue a title read while the label is on screen; release when it leaves. */
function useVisibleTitleRead(
  ref: RefObject<HTMLElement | null>,
  request: LinearIssuePreviewRequest,
  enabled: boolean,
): number {
  const watch = useLinearPreviewStore((state) => state.watch);
  // An identity reset drops every registration; register again.
  const epoch = useLinearPreviewStore((state) => state.epoch);
  useWatchWhileVisible(ref, watch, request, epoch, enabled);
  return epoch;
}

/** Mounted only while the card is open; hover and focus load immediately. */
function LinearReferencePreviewContent({
  request,
}: {
  request: LinearIssuePreviewRequest;
}): JSX.Element {
  const view = useLinearPreviewStore(
    (state) => state.views[linearPreviewKey(request)],
  );
  const load = useLinearPreviewStore((state) => state.load);
  const missing = view === undefined;
  const loadedRef = useRef(false);
  // Load on every open: the store serves fresh entries without a read and
  // refreshes stale or expired-negative ones. Load again if an invalidation
  // clears the view while the card is open.
  useEffect(() => {
    if (loadedRef.current && !missing) return;
    loadedRef.current = true;
    void load(request);
  }, [load, missing, request]);
  const cardView: LinearIssuePreviewCardView =
    !view || view.status === 'loading'
      ? { status: 'loading' }
      : view.status === 'unavailable'
        ? view
        : {
            status: 'ready',
            preview: view.preview,
            checkedAt: view.checkedAt,
            stale:
              view.refreshing ||
              Date.now() - view.checkedAt > LINEAR_PREVIEW_CACHE_LIMITS.freshMs,
          };
  return (
    <LinearIssuePreviewCard identifier={request.identifier} view={cardView} />
  );
}

/**
 * `[icon] CAN-123: Title` once the issue resolves. While a title is still
 * expected, the identifier and a text-free placeholder reserve its width; a
 * reference that can't resolve keeps its original text. The title stays whole
 * in the DOM, so native selection and the accessible name carry it, and only
 * CSS clips it. A measured max width moves that clip to the last whole word
 * that fits. A bare identifier keeps its text node, so a selection made
 * before the title arrives survives.
 */
/**
 * The chip's glyph: the issue's status once its preview has loaded, in the
 * status ink; the Linear mark before then.
 */
function LinearChipGlyph({
  request,
}: {
  request: LinearIssuePreviewRequest;
}): JSX.Element {
  // The preview object itself: stable until the view changes.
  const preview = useLinearPreviewStore((state) => {
    const view = state.views[linearPreviewKey(request)];
    return view?.status === 'ready' ? view.preview : null;
  });
  const glyph = preview
    ? linearStatusGlyph(preview.statusType, preview.status)
    : null;
  if (!glyph) {
    return (
      <LinearIcon
        aria-hidden="true"
        className={INLINE_CHIP_ICON_CLASS}
        exactSize
      />
    );
  }
  const { Icon } = glyph;
  return (
    <Icon
      aria-hidden="true"
      className={`${INLINE_CHIP_ICON_CLASS} ${glyph.ink}`}
      exactSize
    />
  );
}

function ReferenceLabel({
  request,
  expandTitle,
  bare,
  children,
}: {
  request: LinearIssuePreviewRequest;
  expandTitle: boolean;
  bare: boolean;
  children: ReactNode;
}): JSX.Element {
  // The title string, or the shared pending/none slot: a refreshed view with
  // the same title does not re-render the label.
  const slot = useLinearPreviewStore((state) => {
    if (!expandTitle) return null;
    const next = linearTitleSlot(state.views[linearPreviewKey(request)]);
    return next.kind === 'title' ? next.title : next;
  });
  const title = typeof slot === 'string' ? slot : null;
  const pending = slot !== null && typeof slot !== 'string' ? slot : null;
  return (
    <>
      <LinearChipGlyph request={request} />
      {(title !== null || pending?.kind === 'pending') && !bare
        ? request.identifier
        : children}
      {title !== null && (
        <>
          {': '}
          {/* Two caps, so the chip hugs the clipped title: the title's fixed
              40ch cap sizes the chip (a percentage inside the shrink-to-fit
              chip would size it to the whole title), and this wrapper keeps
              it within a narrower column. */}
          <span className="inline-block max-w-full overflow-hidden align-bottom">
            <WordBoundaryTruncatedText
              text={title}
              data-testid="linear-reference-title"
              className="inline-block max-w-[40ch] align-bottom"
            />
          </span>
        </>
      )}
      {pending?.kind === 'pending' && (
        // 36ch: most titles outrun the 40ch clip, which then ends on a word
        // boundary near 36ch. The inset stands in for the `: ` separator. A
        // fixed width sizes the chip; `max-w-full` keeps it in the column.
        <span className="inline-block w-[calc(36ch+0.5rem)] max-w-full pl-2 empty:hidden">
          <InlineMeasuredSkeleton
            pulse={pending.reading}
            testId="linear-reference-title-placeholder"
            className="w-full"
          >
            <WordBoundaryTruncatedText
              text="A sample issue title on a single line"
              className="inline-block max-w-full align-bottom"
            />
          </InlineMeasuredSkeleton>
        </span>
      )}
    </>
  );
}

const BareIdentifierLink = forwardRef<
  HTMLSpanElement,
  ComponentPropsWithoutRef<'span'> & {
    request: LinearIssuePreviewRequest;
  }
>(function BareIdentifierLink({ request, children, ...triggerProps }, ref) {
  const load = useLinearPreviewStore((state) => state.load);
  // The canonical URL once resolved, so the message menu offers the link
  // section; a refresh keeps the view `ready` (CAN-2632).
  const linkUrl = useLinearPreviewStore((state) => {
    const view = state.views[linearPreviewKey(request)];
    return view?.status === 'ready' ? view.preview.url : null;
  });
  const openIssue = (event: MouseEvent | KeyboardEvent): void => {
    const view = event.currentTarget.ownerDocument.defaultView ?? window;
    void load(request).then((preview) => {
      if (preview) view.open(preview.url, '_blank', 'noopener,noreferrer');
    });
  };
  // A selectable span keeps the label in copied prose; a button's label is
  // excluded from text selection.
  return (
    <span
      {...triggerProps}
      ref={ref}
      role="link"
      tabIndex={0}
      data-testid="linear-reference"
      className={INLINE_CHIP_CLASS}
      onClick={openIssue}
      onKeyDown={(event) => {
        if (event.key === 'Enter') openIssue(event);
      }}
      {...chatMessageLinkUrlProps(linkUrl)}
    >
      {children}
    </span>
  );
});

export interface LinearReferencePreviewProps {
  readonly identifier: string;
  readonly workspaceSlug?: string;
  /** The issue URL as written; absent for a bare identifier. */
  readonly href?: string;
  readonly mode?: ReferenceEnrichmentMode;
  /**
   * Replace the label with `ID: title` once resolved. Set for bare
   * identifiers and raw URL labels; author-written labels keep their text.
   */
  readonly expandTitle?: boolean;
  readonly children: ReactNode;
}

/**
 * A Linear reference in transcript prose: a chip with an icon, the
 * identifier and a title resolved while the reference is visible, and a
 * hover/focus preview card. A URL stays an ordinary external link; a bare identifier opens the canonical URL Linear
 * returns. Hosts without the capability render the text unchanged.
 */
export function LinearReferencePreview({
  identifier,
  workspaceSlug,
  href,
  mode = 'replace',
  expandTitle = href === undefined,
  children,
}: LinearReferencePreviewProps): JSX.Element {
  const supported = useCapabilities().referencePreviews === true;
  if (!supported || mode === 'off') {
    return href ? (
      <TextLink
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        variant="inline"
      >
        {children}
      </TextLink>
    ) : (
      <>{children}</>
    );
  }
  return (
    <SupportedLinearReference
      identifier={identifier}
      workspaceSlug={workspaceSlug}
      href={href}
      mode={mode}
      expandTitle={expandTitle}
    >
      {children}
    </SupportedLinearReference>
  );
}

function SupportedLinearReference({
  identifier,
  workspaceSlug,
  href,
  mode = 'replace',
  expandTitle,
  children,
}: LinearReferencePreviewProps & { expandTitle: boolean }): JSX.Element {
  const request = useMemo<LinearIssuePreviewRequest>(
    () => (workspaceSlug ? { identifier, workspaceSlug } : { identifier }),
    [identifier, workspaceSlug],
  );
  const triggerRef = useRef<HTMLElement | null>(null);
  const setTrigger = useCallback((element: HTMLElement | null): void => {
    triggerRef.current = element;
  }, []);
  const epoch = useVisibleTitleRead(triggerRef, request, mode === 'replace');
  const label =
    mode === 'hover' ? (
      <>
        <LinearChipGlyph request={request} />
        {children}
      </>
    ) : (
      <ReferenceLabel
        request={request}
        expandTitle={expandTitle}
        bare={href === undefined}
      >
        {children}
      </ReferenceLabel>
    );
  const trigger = href ? (
    <TextLink
      ref={setTrigger}
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      data-testid="linear-reference"
      variant="mention"
    >
      {label}
    </TextLink>
  ) : (
    <BareIdentifierLink ref={setTrigger} request={request}>
      {label}
    </BareIdentifierLink>
  );
  return (
    <HoverCard
      deferUntilInteraction
      resetKey={`${epoch}:${linearPreviewKey(request)}`}
      content={<LinearReferencePreviewContent request={request} />}
      openDelay={OPEN_DELAY_MS}
      focusOpenDelay={0}
      dismissOnEscape
      {...PREVIEW_CARD_SURFACE}
      triggerWrapperClassName="inline!"
    >
      {trigger}
    </HoverCard>
  );
}

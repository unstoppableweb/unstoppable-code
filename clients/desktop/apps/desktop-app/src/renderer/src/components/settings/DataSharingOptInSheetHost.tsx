import { useEffect, type JSX, type ReactNode } from 'react';
import type { DataSharingOptInFeature } from '@canopy/protocol/canopy-server';
import {
  Button,
  LoadingSpinner,
  DialogModal,
  ErrorBanner,
} from '@canopy/ui-shared/components';
import {
  DATA_SHARING_OPT_IN_SHEET_COPY as COPY,
  DataSharingOptInCta,
  DataSharingOptInScopeSummary,
  dataSharingOptInActionLabel,
  dataSharingOptInErrorText,
  dataSharingOptInHeadline,
} from '@canopy/ui-shared/components/DataSharingOptInCta';
import { brandText } from '@/lib/brand';
import {
  useNavigationStore,
  type PendingPrivacyOptIn,
} from '@/stores/navigationStore';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import {
  optInOrganizationName,
  type DataSharingOptInResolution,
} from './dataSharingOptIn';
import {
  useDataSharingOptIn,
  type DataSharingOptInPhase,
} from './useDataSharingOptIn';

const SHEET_ID = 'data-sharing-opt-in-sheet';
const UNAVAILABLE: Extract<
  DataSharingOptInResolution,
  { kind: 'unavailable' }
> = { kind: 'unavailable' };

/** The App Advisor view of the sheet: the in-flight phase, else the state. */
function reportedState(
  phase: DataSharingOptInPhase,
  resolution: DataSharingOptInResolution,
): string {
  if (phase.kind !== 'idle') return phase.kind;
  // A deliberate link ignores dismissals, so this only guards the type.
  return resolution.kind === 'dismissed' ? 'needs-opt-in' : resolution.kind;
}

interface DataSharingOptInSheetProps {
  request: PendingPrivacyOptIn;
  onClose: () => void;
}

/**
 * Confirmation for a web privacy opt-in link. It shows the authoritative
 * disclosure and saves only on Share; Cancel, Escape, and close write nothing.
 */
export function DataSharingOptInSheet({
  request,
  onClose,
}: DataSharingOptInSheetProps): JSX.Element | null {
  const { feature, organizationId } = request;
  const { resolution, phase, enable } = useDataSharingOptIn({
    feature,
    organizationId,
    // A deliberate link ignores passive dismissals.
    passive: false,
  });
  const saving = phase.kind === 'saving';
  const queued = useNavigationStore(
    (state) => state.queuedPrivacyOptIns.length,
  );
  useCurrentUiStateReporter('privacyOptIn', {
    open: true,
    feature,
    organizationId,
    state: reportedState(phase, resolution),
    queued,
  });

  // Without authoritative state the sheet cannot disclose accurately, so it
  // hands off to Privacy settings without saving.
  const unavailable =
    phase.kind !== 'saved' && resolution.kind === 'unavailable';
  useEffect(() => {
    if (!unavailable) return;
    onClose();
    useNavigationStore.getState().openSettings('privacy');
  }, [unavailable, onClose]);
  if (unavailable) return null;

  return (
    <DialogModal
      inset="flush"
      title={COPY.title}
      titleId={`${SHEET_ID}-title`}
      maxWidth="md"
      dataTestId={SHEET_ID}
      onClose={saving ? (): void => undefined : onClose}
      closeOnBackdrop={!saving}
      closeOnEscape={!saving}
      closeButtonDisabled={saving}
    >
      <SheetContent
        feature={feature}
        resolution={resolution}
        phase={phase}
        onEnable={(): void => {
          void enable();
        }}
        onClose={onClose}
      />
    </DialogModal>
  );
}

interface SheetContentProps {
  feature: DataSharingOptInFeature;
  resolution: DataSharingOptInResolution;
  phase: DataSharingOptInPhase;
  onEnable: () => void;
  onClose: () => void;
}

function SheetLayout({
  children,
  actions,
}: {
  children: ReactNode;
  actions: ReactNode;
}): JSX.Element {
  return (
    <div className="flex flex-col gap-4 px-6 pb-6 pt-4">
      {children}
      <div className="flex items-center justify-end gap-2">{actions}</div>
    </div>
  );
}

function SheetButton({
  kind,
  onClick,
}: {
  kind: 'done' | 'cancel';
  onClick: () => void;
}): JSX.Element {
  return (
    <Button
      variant={kind === 'done' ? 'primary' : 'secondary'}
      size="compact"
      onClick={onClick}
      data-testid={`${SHEET_ID}-${kind}`}
    >
      {kind === 'done' ? COPY.done : COPY.cancel}
    </Button>
  );
}

function SheetContent({
  feature,
  resolution,
  phase,
  onEnable,
  onClose,
}: SheetContentProps): JSX.Element {
  const productName = brandText.appName;
  const done = <SheetButton kind="done" onClick={onClose} />;
  if (phase.kind === 'saved') {
    return (
      <SheetLayout actions={done}>
        <DataSharingOptInCta
          feature={feature}
          organizationName={optInOrganizationName(resolution)}
          productName={productName}
          state="enabled"
          dataTestId={`${SHEET_ID}-saved`}
        />
      </SheetLayout>
    );
  }
  // Web links always name an organization, so a personal resolution never
  // reaches this sheet; it renders like any other unresolved state.
  const organizationResolution =
    (resolution.kind === 'needs-opt-in' || resolution.kind === 'shared') &&
    resolution.audience === 'personal'
      ? UNAVAILABLE
      : resolution;
  switch (organizationResolution.kind) {
    case 'needs-opt-in':
      return (
        <ReviewContent
          feature={feature}
          resolution={organizationResolution}
          phase={phase}
          onEnable={onEnable}
          onClose={onClose}
        />
      );
    case 'shared':
      return (
        <SheetLayout actions={done}>
          <p className="text-s fg-secondary" data-testid={`${SHEET_ID}-shared`}>
            {COPY.alreadyShared(organizationResolution.organizationName)}
          </p>
        </SheetLayout>
      );
    case 'managed':
      return (
        <SheetLayout actions={done}>
          <DataSharingOptInCta
            feature={feature}
            organizationName={organizationResolution.organizationName}
            productName={productName}
            state="managed"
            dataTestId={`${SHEET_ID}-managed`}
          />
        </SheetLayout>
      );
    default:
      // Loading stays here rather than redirecting before state is known.
      return (
        <SheetLayout actions={<SheetButton kind="cancel" onClick={onClose} />}>
          <p
            role="status"
            className="flex items-center gap-2 text-s fg-secondary"
            data-testid={`${SHEET_ID}-loading`}
          >
            <LoadingSpinner className="shrink-0" decorative />
            {COPY.loading}
          </p>
        </SheetLayout>
      );
  }
}

function ReviewContent({
  feature,
  resolution,
  phase,
  onEnable,
  onClose,
}: Omit<SheetContentProps, 'resolution'> & {
  resolution: Extract<
    DataSharingOptInResolution,
    { kind: 'needs-opt-in'; audience: 'organization' }
  >;
}): JSX.Element {
  const saving = phase.kind === 'saving';
  return (
    <SheetLayout
      actions={
        <>
          <Button
            variant="secondary"
            size="compact"
            onClick={onClose}
            disabled={saving}
            data-testid={`${SHEET_ID}-cancel`}
          >
            {COPY.cancel}
          </Button>
          <Button
            variant="primary"
            size="compact"
            disabled={saving}
            aria-busy={saving}
            onClick={onEnable}
            data-testid={`${SHEET_ID}-share`}
          >
            {saving && <LoadingSpinner className="shrink-0" decorative />}
            {saving
              ? COPY.saving
              : dataSharingOptInActionLabel(resolution.organizationName)}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-2 text-s">
        <p className="font-medium fg-primary">
          {dataSharingOptInHeadline(feature)}
        </p>
        <DataSharingOptInScopeSummary
          organizationName={resolution.organizationName}
          productName={brandText.appName}
          allowedScopes={resolution.allowedScopes}
          skippedScopes={resolution.skippedScopes}
          additionalScopes={resolution.additionalScopes}
          dataTestId={`${SHEET_ID}-summary`}
        />
        {phase.kind === 'error' && (
          <ErrorBanner
            errorSource="data-sharing-opt-in-sheet-host"
            className=""
            error={dataSharingOptInErrorText(phase.error)}
            testId={`${SHEET_ID}-error`}
          />
        )}
      </div>
    </SheetLayout>
  );
}

/** Mounted once at the App root; shows the active opt-in request, if any. */
export function DataSharingOptInSheetHost(): JSX.Element | null {
  const request = useNavigationStore((state) => state.pendingPrivacyOptIn);
  const consume = useNavigationStore((state) => state.consumePrivacyOptIn);
  if (!request) return null;
  return (
    <DataSharingOptInSheet
      key={request.id}
      request={request}
      onClose={(): void => consume(request.id)}
    />
  );
}

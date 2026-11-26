import { type JSX, type ReactNode, useEffect, useMemo, useState } from 'react';
import type {
  PreferencesData,
  PreferencesSavePatch,
  TelemetrySharingPreferences,
  UsageDataKey,
  UsageDataPolicySnapshot,
  UsageDataPreferences,
} from '@canopy/desktop-shared/types';
import { reportClientAppError } from '@canopy/desktop-instrumentation/client';
import { usesNativeWindowFrame } from '@canopy/desktop-shared/platform-capabilities';
import { localPlatform } from '@/lib/local-platform';
import { CONSENT_TOS_VERSION } from '@canopy/desktop-shared/constants/consent';
import { Button } from '@canopy/ui-shared';
import { BrandLogo } from '@/components/BrandLogo';
import { brand, brandText } from '@/lib/brand';
import { useCanopyLegalUrls } from '@/hooks/useCanopyLegalUrls';
import {
  ChoiceField,
  DataChoicesCard,
  ErrorBanner,
  Heading,
  SKILL_SAFETY_CHECK_ROW,
  Surface,
  USAGE_DATA_GROUP_ROWS,
  type DataChoicesActivityValue,
  type UsageDataRowLocks,
} from '@canopy/ui-shared/components';
import {
  CircleCheckIcon,
  GitHubIcon,
  ShieldIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import { useTelemetrySharingAvailable } from '@/lib/cloud-account';
import { resolveUsageDataLocks } from '@/components/settings/usageDataLocks';

export interface LegalConsentGateProps {
  /**
   * Called once the user has accepted and the acceptance has been persisted.
   * The host (`App.tsx`) unmounts the gate and lets startup proceed.
   */
  onAccepted: () => void;
  /**
   * The preferences `App.tsx` already loaded at startup. Seeds the "What you
   * share" switches from the stored choices as they are (never from the
   * policy snapshot, which is all off until consent), so a fresh profile
   * starts pre-checked and a recovered one keeps its journaled opt-outs.
   */
  preferences: Pick<PreferencesData, 'usageData' | 'telemetrySharing'> | null;
}

const USAGE_DATA_EXTRA_ROWS = [SKILL_SAFETY_CHECK_ROW];

const USAGE_GROUP_DESCRIPTION =
  'Feature usage, performance, and crash reports. Never your code or chats.';

/** Every Usage data choice, seeded from the stored preferences. */
function usageChoicesFrom(
  stored: UsageDataPreferences | undefined,
): Record<UsageDataKey, boolean> {
  // A missing value seeds on, like a fresh profile's defaults.
  return {
    productAnalytics: stored?.productAnalytics ?? true,
    sessionReplay: stored?.sessionReplay ?? true,
    errorReports: stored?.errorReports ?? true,
    activeUseSignal: stored?.activeUseSignal ?? true,
    featureFlagIdentity: stored?.featureFlagIdentity ?? true,
    skillSafetyCheck: stored?.skillSafetyCheck ?? true,
  };
}

/** Any stored visibility other than `off` reads as on. */
function activityChoicesFrom(
  stored: TelemetrySharingPreferences | undefined,
): DataChoicesActivityValue {
  return {
    metadata: (stored?.metadata ?? 'off') !== 'off',
    plans: (stored?.plans ?? 'off') !== 'off',
    summaries: (stored?.summaries ?? 'off') !== 'off',
    transcripts: (stored?.transcripts ?? 'off') !== 'off',
  };
}

/**
 * The full sharing object to save. A type left on keeps its stored scope; a
 * type switched on shares with the organization, whose delivery rule keeps
 * Personal work private and shares only that organization's own work.
 */
function telemetrySharingFrom(
  choices: DataChoicesActivityValue,
  stored: TelemetrySharingPreferences | undefined,
): TelemetrySharingPreferences {
  const scopeFor = (
    key: keyof DataChoicesActivityValue,
  ): TelemetrySharingPreferences[keyof DataChoicesActivityValue] => {
    if (!choices[key]) {
      return 'off';
    }
    const current = stored?.[key] ?? 'off';
    return current === 'off' ? 'organization' : current;
  };
  return {
    metadata: scopeFor('metadata'),
    plans: scopeFor('plans'),
    summaries: scopeFor('summaries'),
    transcripts: scopeFor('transcripts'),
  };
}

function openExternal(url: string): void {
  void window.api.browser.openExternal({ url });
}

interface LegalDocumentLinkProps {
  url: string | null;
  testId: string;
  children: ReactNode;
}

/**
 * An inline link on the gate: a legal document name in the consent sentence,
 * or the source repository. Document names sit outside the checkbox's label
 * (`ChoiceField`), so clicking one never toggles acceptance (CAN-2621).
 * It opens the Cloud-hosted page once the base URL resolves; until then, or
 * in a local build with no base URL configured, it is inert text.
 */
function LegalDocumentLink({
  url,
  testId,
  children,
}: LegalDocumentLinkProps): JSX.Element {
  if (!url) {
    return <span data-testid={testId}>{children}</span>;
  }
  return (
    <Button
      variant="link"
      data-testid={testId}
      onClick={(): void => openExternal(url)}
    >
      {children}
    </Button>
  );
}

/** A short line led by its glyph. */
function ConsentFact({
  icon,
  testId,
  children,
}: {
  icon: ReactNode;
  testId: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <p
      className="flex items-center gap-3 text-s fg-secondary"
      data-testid={testId}
    >
      <span className="flex w-4 shrink-0 justify-center">{icon}</span>
      <span>{children}</span>
    </p>
  );
}

/**
 * Blocking first-run legal gate (CAN-934). Presented before the app shell on
 * every first run, independent of the guest-mode / cloud-sign-in feature flags,
 * so every user accepts the Terms of Service and Privacy Policy before using the
 * app. Acceptance is persisted to `PreferencesData.legalConsentAcceptedAt` +
 * `legalConsentTosVersion`; until it is recorded the shell stays gated. All
 * product names come from the brand runtime per the branding rules.
 */
export function LegalConsentGate({
  onAccepted,
  preferences,
}: LegalConsentGateProps): JSX.Element {
  const [agreed, setAgreed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // False only in a local-only build (a synchronous build-profile fact), where
  // nothing leaves the computer and Settings → Privacy has no controls.
  const sharingAvailable = useTelemetrySharingAvailable();
  const [customizing, setCustomizing] = useState(false);
  const [usageChoices, setUsageChoices] = useState<
    Readonly<Record<UsageDataKey, boolean>>
  >(() => usageChoicesFrom(preferences?.usageData));
  const [activityChoices, setActivityChoices] =
    useState<DataChoicesActivityValue>(() =>
      activityChoicesFrom(preferences?.telemetrySharing),
    );
  const [policy, setPolicy] = useState<UsageDataPolicySnapshot | null>(null);

  useEffect(() => {
    if (!sharingAvailable) {
      return undefined;
    }
    let cancelled = false;
    // Locks only; the gate stays usable while this loads, and a failed read
    // means no locks.
    void window.api.observability
      .getUsageDataPolicy()
      .then((next) => {
        if (!cancelled) {
          setPolicy(next);
        }
      })
      .catch((readError: unknown) => {
        reportClientAppError(readError);
      });
    return (): void => {
      cancelled = true;
    };
  }, [sharingAvailable]);

  const locks = useMemo(
    (): UsageDataRowLocks<UsageDataKey> => ({
      ...resolveUsageDataLocks(policy),
      // Protective, so no organization lock applies to it.
      skillSafetyCheck: null,
    }),
    [policy],
  );
  const { termsUrl, privacyUrl } = useCanopyLegalUrls();
  // Brands without a public client repository make no open-source claim.
  const sourceUrl = brand.web.marketing?.sourceRepository?.url ?? null;

  const handleContinue = async (): Promise<void> => {
    if (!agreed || submitting) {
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const now = new Date().toISOString();
      // One atomic patch: terms and choices commit together, so main never
      // starts a flow on the pre-checked defaults before the choices land.
      // Main derives the declined-at-onboarding flag from this commit.
      const patch: PreferencesSavePatch = sharingAvailable
        ? {
            legalConsentAcceptedAt: now,
            legalConsentTosVersion: CONSENT_TOS_VERSION,
            dataChoicesConfirmedAt: now,
            // The full set on purpose: every switch on this screen is an
            // explicit choice, even one left at its pre-checked value.
            usageData: { ...usageChoices },
            telemetrySharing: telemetrySharingFrom(
              activityChoices,
              preferences?.telemetrySharing,
            ),
          }
        : // Local-only build: the usage-data flows have nothing to reach
          // (PostHog, LaunchDarkly, the cloud and update URLs are blanked at
          // build time; docs/local-only-build.md), so accepting with the
          // stored defaults sends nothing, as before this gate had choices.
          {
            legalConsentAcceptedAt: now,
            legalConsentTosVersion: CONSENT_TOS_VERSION,
          };
      await window.api.savePreferences(patch);
      onAccepted();
    } catch {
      setError('Could not save your acceptance. Please try again.');
      setSubmitting(false);
    }
  };

  return (
    // The window's whole content in place of the shell, not a layer over it.
    <Surface
      variant="startup-pane"
      extent="viewport"
      className="flex w-full flex-col items-center justify-center overflow-hidden"
      data-testid="legal-consent-gate"
    >
      {/* Keep the window draggable behind the centered content. */}
      {!usesNativeWindowFrame(localPlatform()) && (
        <div className="electron-drag h-10 shrink-0 w-full" />
      )}
      {/* `my-auto`, not `items-center`: auto margins collapse when the window
          is shorter than the content, so the top stays scrollable. */}
      <div className="flex flex-1 w-full justify-center overflow-y-auto px-6 pb-10">
        <div className="my-auto w-full max-w-md flex flex-col items-center gap-8">
          <div className="flex flex-col items-center gap-4 text-center">
            <BrandLogo size={72} className="select-none fg-accent" />
            <Heading level={1} variant="page">
              Welcome to {brandText.appName}
            </Heading>
          </div>

          {/* Shrink-wrapped so the rows share one icon column while the
              block itself centers under the heading. */}
          <div className="flex w-fit flex-col gap-3">
            {sourceUrl && (
              <ConsentFact
                icon={<GitHubIcon size={16} aria-hidden />}
                testId="legal-consent-open-source"
              >
                {brandText.appName} is{' '}
                <LegalDocumentLink
                  url={sourceUrl}
                  testId="legal-consent-source-link"
                >
                  open source
                </LegalDocumentLink>
              </ConsentFact>
            )}
            <ConsentFact
              icon={<ShieldIcon size={16} aria-hidden />}
              testId="legal-consent-data-promise"
            >
              Your data is yours. We don’t sell it or train AI on it.
            </ConsentFact>
            {sharingAvailable && (
              <ConsentFact
                icon={<CircleCheckIcon size={16} aria-hidden />}
                testId="legal-consent-opt-in"
              >
                You choose what you share.
              </ConsentFact>
            )}
          </div>

          {sharingAvailable && (
            <div className="w-full text-left">
              <DataChoicesCard
                rows={USAGE_DATA_GROUP_ROWS}
                extraRows={USAGE_DATA_EXTRA_ROWS}
                usageDescription={USAGE_GROUP_DESCRIPTION}
                value={usageChoices}
                locks={locks}
                onChange={setUsageChoices}
                activity={{
                  value: activityChoices,
                  onChange: setActivityChoices,
                }}
                expanded={customizing}
                onExpandedChange={setCustomizing}
                disabled={submitting}
                footnote="Change these anytime in Settings → Privacy."
                idPrefix="legal-consent"
              />
            </div>
          )}

          <ErrorBanner
            errorSource="legal-consent-error"
            className="w-full"
            error={error}
            testId="legal-consent-error"
          />

          {/* One sentence: the agreement phrase is the checkbox's label
              (clicking it toggles), and the document names continue it
              outside that label, so clicking one never accepts them
              (CAN-2621). */}
          <Surface variant="card" padding="default" className="w-full">
            <div className="text-left">
              <ChoiceField
                aria-label="I agree to the Terms of Service and Privacy Policy"
                checked={agreed}
                onChange={(e): void => setAgreed(e.target.checked)}
                disabled={submitting}
                data-testid="legal-consent-checkbox"
                label={
                  <span data-testid="legal-consent-label">I agree to the</span>
                }
                trailing={
                  <>
                    <LegalDocumentLink
                      url={termsUrl}
                      testId="legal-consent-terms-link"
                    >
                      Terms of Service
                    </LegalDocumentLink>{' '}
                    and{' '}
                    <LegalDocumentLink
                      url={privacyUrl}
                      testId="legal-consent-privacy-link"
                    >
                      Privacy Policy
                    </LegalDocumentLink>
                    .
                  </>
                }
              />
            </div>
          </Surface>

          <Button
            variant="primary"
            className="w-full"
            data-testid="legal-consent-accept"
            disabled={!agreed || submitting}
            onClick={(): void => void handleContinue()}
          >
            {submitting ? 'Saving…' : 'Agree & continue'}
          </Button>
        </div>
      </div>
    </Surface>
  );
}

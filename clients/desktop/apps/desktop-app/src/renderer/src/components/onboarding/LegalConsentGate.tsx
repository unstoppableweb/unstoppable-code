import { type JSX, type ReactNode, useState } from 'react';
import { usesNativeWindowFrame } from '@canopy/desktop-shared/platform-capabilities';
import { localPlatform } from '@/lib/local-platform';
import { CONSENT_TOS_VERSION } from '@canopy/desktop-shared/constants/consent';
import { Button } from '@canopy/ui-shared';
import { BrandLogo } from '@/components/BrandLogo';
import { brandText } from '@/lib/brand';
import { useCanopyLegalUrls } from '@/hooks/useCanopyLegalUrls';
import {
  ChoiceField,
  ErrorBanner,
  Heading,
  Surface,
} from '@canopy/ui-shared/components';

export interface LegalConsentGateProps {
  /**
   * Called once the user has accepted and the acceptance has been persisted.
   * The host (`App.tsx`) unmounts the gate and lets startup proceed.
   */
  onAccepted: () => void;
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
 * A legal document name in the consent sentence. It sits outside the
 * checkbox's label (`ChoiceField`), so clicking it never toggles acceptance
 * (CAN-2621).
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
}: LegalConsentGateProps): JSX.Element {
  const [agreed, setAgreed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { termsUrl, privacyUrl } = useCanopyLegalUrls();

  const handleContinue = async (): Promise<void> => {
    if (!agreed || submitting) {
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await window.api.savePreferences({
        legalConsentAcceptedAt: new Date().toISOString(),
        legalConsentTosVersion: CONSENT_TOS_VERSION,
      });
      onAccepted();
    } catch {
      setError('Could not save your acceptance. Please try again.');
      setSubmitting(false);
    }
  };

  return (
    // The window's whole content in place of the shell, not a layer over it.
    <div
      className="flex h-screen w-full flex-col items-center justify-center overflow-hidden bg-base fg-primary animate-fade-in"
      data-testid="legal-consent-gate"
    >
      {/* Keep the window draggable behind the centered content. */}
      {!usesNativeWindowFrame(localPlatform()) && (
        <div className="electron-drag h-10 shrink-0 w-full" />
      )}
      <div className="flex flex-1 w-full items-center justify-center overflow-y-auto px-6 pb-10">
        <div className="w-full max-w-md flex flex-col items-center gap-8">
          <div className="flex flex-col items-center gap-4 text-center">
            <BrandLogo size={72} className="select-none fg-accent" />
            <div className="flex flex-col items-center gap-2">
              <Heading level={1} variant="page">
                Welcome to {brandText.appName}
              </Heading>
              <p className="text-s fg-secondary">
                Before you get started, please review and accept our terms.
              </p>
            </div>
          </div>

          <ErrorBanner
            errorSource="legal-consent-error"
            className="w-full"
            error={error}
            testId="legal-consent-error"
          />

          {/* One block: the agreement phrase is the checkbox's label (clicking
              it toggles), and the document names follow under it in the text
              column, outside that label, so clicking one never accepts them
              (CAN-2621). */}
          <Surface variant="card" padding="default" className="w-full">
            <div className="text-left">
              <ChoiceField
                aria-label="I have read and agree to the Terms of Service and Privacy Policy"
                checked={agreed}
                onChange={(e): void => setAgreed(e.target.checked)}
                disabled={submitting}
                data-testid="legal-consent-checkbox"
                label={
                  <span data-testid="legal-consent-label">
                    I have read and agree to the
                  </span>
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
    </div>
  );
}

import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type JSX,
  type RefObject,
} from 'react';
import type { BillingReadinessSourceId } from '@canopy/app-state/provider-choice';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { isOllamaSupportedOnPlatform } from '@canopy/desktop-shared/platform-capabilities';
import {
  BILLING_SETUP_GATE_INTRO,
  BILLING_SETUP_GATE_TITLE,
  ProviderSourceRow,
} from '@canopy/ui-app/providers';
import {
  Button,
  Heading,
  POLICY_ONLY_DEAD_END_COPY,
  PROVIDER_CHOICE_ACTION_LABELS,
  SettingsRowsGroup,
} from '@canopy/ui-shared/components';
import {
  AntigravityLogo,
  CursorLogo,
  OpenCodeLogo,
} from '@canopy/ui-shared/icons';
import { GitHubIcon } from '@canopy/ui-shared/icons/AppIcons';
import {
  FirstRunProviderChooser,
  type FirstRunProviderChooserProps,
} from '@/components/onboarding/FirstRunProviderChooser';
import { useDesktopBillingGate } from '@/hooks/useDesktopBillingReadiness';
import {
  getAntigravitySettingsSection,
  isAntigravityPlatform,
} from '@/lib/antigravity-settings';
import {
  trackBillingSetupGateClick,
  trackBillingSetupGateView,
  type BillingSetupGateSurface,
} from '@/lib/billingSetupGateTelemetry';
import { getCopilotSettingsSection } from '@/lib/copilot-settings';
import { getCursorSettingsSection } from '@/lib/cursor-settings';
import { getOpenCodeSettingsSection } from '@/lib/opencode-settings';
import {
  getRendererBillingLaneFactsVersion,
  subscribeRendererBillingLaneFacts,
} from '@/stores/billingLaneRuntime';
import { useChatStore } from '@/stores/chatStore';
import { resolveLaneForTarget } from '@/stores/chat/defaults';
import {
  getRendererModelFactsVersion,
  getRendererModelPolicy,
  subscribeRendererModelFacts,
} from '@/stores/modelPolicyRuntime';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { useNavigationStore } from '@/stores/navigationStore';

type MoreProviderId = Extract<
  BillingReadinessSourceId,
  'cursor' | 'copilot' | 'opencode' | 'antigravity'
>;

interface MoreProvider {
  readonly id: MoreProviderId;
  readonly name: string;
  readonly description: string;
  readonly icon: JSX.Element;
  readonly section: () => 'account' | 'experiments';
}

const ICON_CLASS = 'h-4 w-4 shrink-0 fg-primary';

const MORE_PROVIDERS: readonly MoreProvider[] = [
  {
    id: 'cursor',
    name: 'Cursor',
    description: 'Use the Cursor agent installed on this computer.',
    icon: <CursorLogo className={ICON_CLASS} aria-hidden />,
    section: getCursorSettingsSection,
  },
  {
    id: 'copilot',
    name: 'Copilot',
    description: 'Use the GitHub Copilot agent installed on this computer.',
    icon: <GitHubIcon className={ICON_CLASS} aria-hidden />,
    section: getCopilotSettingsSection,
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    description: 'Use the OpenCode agent installed on this computer.',
    icon: <OpenCodeLogo className={ICON_CLASS} aria-hidden />,
    section: getOpenCodeSettingsSection,
  },
  {
    id: 'antigravity',
    name: 'Antigravity',
    description: 'Use the Antigravity agent installed on this computer.',
    icon: <AntigravityLogo className={ICON_CLASS} aria-hidden />,
    section: getAntigravitySettingsSection,
  },
];

/** Which of the Settings-only providers this build offers. */
function useOfferedMoreProviders(): readonly MoreProvider[] {
  const cursor = useFeatureFlagsStore((state) =>
    state.isEnabled(CLIENT_FEATURE_FLAGS.canopyDesktopCursorHarness.key),
  );
  const copilot = useFeatureFlagsStore((state) =>
    state.isEnabled(CLIENT_FEATURE_FLAGS.canopyDesktopCopilotHarness.key),
  );
  const opencode = useFeatureFlagsStore((state) =>
    state.isEnabled(CLIENT_FEATURE_FLAGS.canopyDesktopOpenCodeHarness.key),
  );
  const antigravity = useFeatureFlagsStore((state) =>
    state.isEnabled(CLIENT_FEATURE_FLAGS.canopyDesktopAntigravityHarness.key),
  );
  const offered: Readonly<Record<MoreProviderId, boolean>> = {
    cursor,
    copilot,
    opencode,
    antigravity: antigravity && isAntigravityPlatform(),
  };
  return MORE_PROVIDERS.filter((provider) => offered[provider.id]);
}

/**
 * What the billing setup gate adds to the first-run provider rows: Ollama,
 * the providers set up in Settings, and an "All provider settings" link,
 * with click analytics for `surface`. While `active`, it also records the
 * gate's view for `surface` (once per gate episode). First run spreads these
 * onto its own chooser only while the gate is shown, so the chooser never
 * remounts (and never drops a sign-in in progress) when the gate clears.
 */
export function useBillingGateChooserProps(
  surface: BillingSetupGateSurface,
  active: boolean,
): FirstRunProviderChooserProps {
  const { readiness } = useDesktopBillingGate();
  const openSettings = useNavigationStore((state) => state.openSettings);
  const moreProviders = useOfferedMoreProviders();
  const ollama: 'ready' | 'not-connected' = readiness.readyIds.includes(
    'ollama',
  )
    ? 'ready'
    : 'not-connected';

  useEffect(() => {
    if (!active) return undefined;
    return trackBillingSetupGateView(surface);
  }, [active, surface]);

  if (!active) return {};
  // The App Advisor window has its own settings modal (Orchestrator defaults
  // only) and no route to the main window's provider Settings, so the rows
  // that only open Settings would do nothing there. Offer them only where
  // Settings is reachable; the Claude, Codex, AI Credits and gateway rows
  // work in place in either window.
  const settingsReachableHere =
    typeof document === 'undefined' ||
    document.body.dataset.rendererSurface !== 'app-advisor';
  if (!settingsReachableHere) return { gateSurface: surface };

  const openProviderSettings = (
    section: Parameters<typeof openSettings>[0],
    source?: BillingReadinessSourceId,
  ): void => {
    trackBillingSetupGateClick({
      surface,
      action: source === undefined ? 'settings_open' : 'set_up',
      ...(source !== undefined ? { source } : {}),
    });
    openSettings(section);
  };

  return {
    gateSurface: surface,
    ...(isOllamaSupportedOnPlatform() ? { ollama } : {}),
    ...(moreProviders.length > 0
      ? {
          moreProviders: (
            <div
              className="flex min-w-0 flex-col gap-1"
              role="group"
              aria-labelledby={`billing-setup-more-providers-${surface}`}
            >
              <Heading
                level={3}
                variant="label"
                id={`billing-setup-more-providers-${surface}`}
              >
                More providers
              </Heading>
              <SettingsRowsGroup dataTestId="billing-setup-more-providers">
                {moreProviders.map((provider) => (
                  <ProviderSourceRow
                    key={provider.id}
                    icon={provider.icon}
                    name={provider.name}
                    description={provider.description}
                    dataTestId={`billing-setup-${provider.id}`}
                    control={
                      <Button
                        size="compact"
                        data-testid={`billing-setup-${provider.id}-set-up`}
                        onClick={() =>
                          openProviderSettings(provider.section(), provider.id)
                        }
                      >
                        {PROVIDER_CHOICE_ACTION_LABELS['set-up']}
                      </Button>
                    }
                  />
                ))}
              </SettingsRowsGroup>
            </div>
          ),
        }
      : {}),
    link: (
      <p className="text-xs text-pretty fg-secondary">
        <Button
          variant="link"
          data-testid="billing-setup-all-provider-settings"
          onClick={() => openProviderSettings('account')}
        >
          All provider settings
        </Button>
      </p>
    ),
  };
}

/**
 * The organization's model policy leaves nothing runnable on any lane, so no
 * provider row could clear the gate. The same test the No billing source
 * notice applies (`policyOnlyDeadEnd`): a real policy in force, and a lane
 * resolution that names no lane or has no policy-allowed lane at all.
 */
function usePolicyOnlyDeadEnd(projectId: string | undefined): boolean {
  const laneFactsVersion = useSyncExternalStore(
    subscribeRendererBillingLaneFacts,
    getRendererBillingLaneFactsVersion,
    getRendererBillingLaneFactsVersion,
  );
  const modelFactsVersion = useSyncExternalStore(
    subscribeRendererModelFacts,
    getRendererModelFactsVersion,
    getRendererModelFactsVersion,
  );
  const modelDefaults = useChatStore((state) => state.modelDefaults);
  return useMemo((): boolean => {
    if (projectId === undefined) return false;
    if (getRendererModelPolicy().size === 0) return false;
    const resolution = resolveLaneForTarget(projectId, modelDefaults);
    if (resolution?.outcome !== 'no-dispatchable-model') return false;
    return (
      (resolution.missing === 'policy-allowance' &&
        resolution.lanesNeeded.length === 0) ||
      (resolution.missing === 'both' && !resolution.hasPolicyAllowedLane)
    );
    // The lane and model fact versions stand for module-level runtimes the
    // resolver reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, modelDefaults, laneFactsVersion, modelFactsVersion]);
}

/**
 * The billing setup gate on desktop: the shared billing setup panel with the
 * first-run rows (Claude, Codex, the AI gateway, the account row), Ollama,
 * and the providers that can only be set up in Settings. It replaces a
 * new-chat composer while readiness is confirmed `none`; the sidebar,
 * Settings and existing chats stay reachable. There is no Skip.
 *
 * Hosts mount it only while `useDesktopBillingGate().gate.shown`.
 */
export function DesktopBillingSetupGate({
  surface,
  projectId,
  composerRef,
  onReturnFocus,
}: {
  readonly surface: BillingSetupGateSurface;
  /**
   * The project the replaced composer would start its chat in. Used only to
   * spot an organization policy that leaves nothing runnable; omitted, the
   * gate shows the provider rows.
   */
  readonly projectId?: string;
  /**
   * The composer box this panel replaces. Read on the panel's first render,
   * while the composer is still in the document: when focus was inside it,
   * the panel takes focus.
   */
  readonly composerRef?: RefObject<HTMLElement | null>;
  /**
   * Called after the panel goes away while it held focus, once the composer
   * is back, so the host can focus its editor.
   */
  readonly onReturnFocus?: () => void;
}): JSX.Element {
  const gateProps = useBillingGateChooserProps(surface, true);
  const policyDeadEnd = usePolicyOnlyDeadEnd(projectId);
  const [focusOnMount] = useState(() => {
    const active = document.activeElement;
    return active !== null && composerRef?.current?.contains(active) === true;
  });
  const regionRef = useRef<HTMLDivElement | null>(null);
  const onReturnFocusRef = useRef(onReturnFocus);
  onReturnFocusRef.current = onReturnFocus;
  // A layout cleanup runs before the panel's nodes leave the document, so it
  // can still see whether focus was inside. The composer mounts in the same
  // commit; focus it on the next frame.
  useLayoutEffect(() => {
    const region = regionRef.current;
    return (): void => {
      const active = document.activeElement;
      if (active === null || region?.contains(active) !== true) return;
      const returnFocus = onReturnFocusRef.current;
      if (returnFocus === undefined) return;
      window.requestAnimationFrame(() => returnFocus());
    };
  }, []);

  return (
    <div ref={regionRef} className="flex w-full min-w-0 flex-col">
      {policyDeadEnd ? (
        // No provider row can help: the organization's model policy leaves
        // nothing runnable on any lane. "Contact your admin" in place of the
        // rows, with the copy the No billing source notice shows for this
        // dead end.
        <ContactAdminPanel surface={surface} focusOnMount={focusOnMount} />
      ) : (
        <FirstRunProviderChooser
          {...gateProps}
          title={BILLING_SETUP_GATE_TITLE}
          intro={BILLING_SETUP_GATE_INTRO}
          focusOnMount={focusOnMount}
          dataTestId={`billing-setup-gate-${surface}`}
        />
      )}
    </div>
  );
}

function ContactAdminPanel({
  surface,
  focusOnMount,
}: {
  readonly surface: BillingSetupGateSurface;
  readonly focusOnMount: boolean;
}): JSX.Element {
  const ref = useRef<HTMLElement | null>(null);
  // Read once, on mount, as the shared panel does.
  const focusOnMountRef = useRef(focusOnMount);
  useEffect(() => {
    if (focusOnMountRef.current) ref.current?.focus({ preventScroll: true });
  }, []);
  return (
    <section
      ref={ref}
      tabIndex={-1}
      aria-label={BILLING_SETUP_GATE_TITLE}
      className="flex w-full min-w-0 flex-col gap-1 outline-none"
      data-testid={`billing-setup-gate-${surface}`}
    >
      <Heading level={2} variant="section">
        {BILLING_SETUP_GATE_TITLE}
      </Heading>
      <p
        className="text-xs text-pretty fg-secondary"
        data-testid="billing-setup-gate-contact-admin"
      >
        {POLICY_ONLY_DEAD_END_COPY.message}
      </p>
    </section>
  );
}

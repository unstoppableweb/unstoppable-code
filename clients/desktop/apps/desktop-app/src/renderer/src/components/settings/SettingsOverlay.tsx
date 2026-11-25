import { sidebarPageTransitionDelay } from '@/components/sidebar/sidebar-page-transition';
import { useCodeGraphExperimentEnabled } from '@/hooks/useCodeGraphExperimentEnabled';
import { useClaudeSettingsAvailable } from '@/lib/claude-settings-availability';
import { localPlatform } from '@/lib/local-platform';
import { useNavigationStore } from '@/stores/navigationStore';
import { useRemoteControlStore } from '@/stores/remoteControlStore';
import { useSidebarStore } from '@/stores/sidebarStore';
import { SETTINGS_SECTION_REPLAY_PRIVACY } from '@canopy/desktop-instrumentation/posthog-replay-surfaces';
import {
  isOllamaSupportedOnPlatform,
  isVoiceDictationPlatform,
} from '@canopy/desktop-shared/platform-capabilities';
import {
  SettingsSaveBarSlotContext,
  Surface,
  WindowPage,
} from '@canopy/ui-shared/components';
import {
  type ComponentType,
  type JSX,
  lazy,
  type LazyExoticComponent,
  memo,
  type RefObject,
  Suspense,
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { CanopyTab } from './CanopyTab';
import {
  type HostedRailSlots,
  SettingsNav,
  type SettingsSection,
} from './SettingsNav';
import { DesktopHostedSettingsProvider } from './hosted/DesktopSettingsHost';
import { HostedSettingsNav } from './hosted/HostedSettingsNav';
import { useHostedSettingsClient } from './hosted/hosted-settings-availability';
import { hostedSettingsRouteKey } from './hosted/hosted-settings-location';
import { SettingsReplayPrivacyContext } from './settings-replay-privacy';
import { beginSettingsScrollTarget } from './settings-scroll-target';
import { SettingsSectionNavigationContext } from './settings-section-navigation';
import { resolveSettingsSection } from './settings-section-resolution';

/**
 * Hosted account and organization settings content (CAN-4386). Its own
 * chunk, so the shared pages and their registry load only once a hosted
 * destination opens; the rail ships with the overlay.
 */
const HostedSettingsContent = lazy(() =>
  import('./hosted/HostedSettingsContent').then((module) => ({
    default: module.HostedSettingsContent,
  })),
);

/**
 * Sections whose page code has loaded. General ships with the overlay; every
 * other page is its own chunk and joins the set when that chunk resolves.
 */
const loadedSettingsSections = new Set<SettingsSection>(['canopy']);

function lazySettingsPage<P extends object>(
  section: SettingsSection,
  load: () => Promise<ComponentType<P>>,
): LazyExoticComponent<ComponentType<P>> {
  return lazy(() =>
    load().then((component) => {
      loadedSettingsSections.add(section);
      return { default: component };
    }),
  );
}

const PerformanceTab = lazySettingsPage('performance', () =>
  import('./PerformanceTab').then((module) => module.PerformanceTab),
);
const KeyboardShortcutsTab = lazySettingsPage('shortcuts', () =>
  import('./KeyboardShortcutsTab').then(
    (module) => module.KeyboardShortcutsTab,
  ),
);
const DisplayTab = lazySettingsPage('display', () =>
  import('./DisplayTab').then((module) => module.DisplayTab),
);
const NotificationsTab = lazySettingsPage('notifications', () =>
  import('./NotificationsTab').then((module) => module.NotificationsTab),
);
const AccountTab = lazySettingsPage('account', () =>
  import('./AccountTab').then((module) => module.AccountTab),
);
const PrivacyTab = lazySettingsPage('privacy', () =>
  import('./PrivacyTab').then((module) => module.PrivacyTab),
);
const ChatTab = lazySettingsPage('chat', () =>
  import('./ChatTab').then((module) => module.ChatTab),
);
const MemoryTab = lazySettingsPage('memory', () =>
  import('./MemoryTab').then((module) => module.MemoryTab),
);
const InstructionsTab = lazySettingsPage('instructions', () =>
  import('./InstructionsTab').then((module) => module.InstructionsTab),
);
const PluginsTab = lazySettingsPage('plugins', () =>
  import('./PluginsTab').then((module) => module.PluginsTab),
);
// Not platform-gated: Harnesses stays useful even without Ollama because AI
// Gateway models may be configurable.
const HarnessesTab = lazySettingsPage('harnesses', () =>
  import('./HarnessesTab').then((module) => module.HarnessesTab),
);
const AppAdvisorTab = lazySettingsPage('app-advisor', () =>
  import('./AppAdvisorTab').then((module) => module.AppAdvisorTab),
);
const FilesTab = lazySettingsPage('files', () =>
  import('./FilesTab').then((module) => module.FilesTab),
);
const BrowserTab = lazySettingsPage('browser', () =>
  import('./BrowserTab').then((module) => module.BrowserTab),
);
const TerminalTab = lazySettingsPage('terminal', () =>
  import('./TerminalTab').then((module) => module.TerminalTab),
);
const PlanDetectionTab = lazySettingsPage('plan-detection', () =>
  import('./PlanDetectionTab').then((module) => module.PlanDetectionTab),
);
const DictationTab = lazySettingsPage('dictation', () =>
  import('./DictationTab').then((module) => module.DictationTab),
);
const CodexTab = lazySettingsPage('codex', () =>
  import('./CodexTab').then((module) => module.CodexTab),
);
const ClaudeTab = lazySettingsPage('claude', () =>
  import('./ClaudeTab').then((module) => module.ClaudeTab),
);
const OllamaTab = lazySettingsPage('ollama', () =>
  import('./OllamaTab').then((module) => module.OllamaTab),
);
const AccountProxyTab = lazySettingsPage('account-proxy', () =>
  import('./account-proxy/AccountProxyTab').then(
    (module) => module.AccountProxyTab,
  ),
);
const GitTab = lazySettingsPage('git', () =>
  import('./GitTab').then((module) => module.GitTab),
);
const EnvironmentsTab = lazySettingsPage('environment', () =>
  import('./EnvironmentsTab').then((module) => module.EnvironmentsTab),
);
const ApplicationsTab = lazySettingsPage('applications', () =>
  import('./ApplicationsTab').then((module) => module.ApplicationsTab),
);
const McpTab = lazySettingsPage('mcp', () =>
  import('./McpTab').then((module) => module.McpTab),
);
const ApprovalsTab = lazySettingsPage('approvals', () =>
  import('./ApprovalsTab').then((module) => module.ApprovalsTab),
);
const CodeGraphTab = lazySettingsPage('code-graph', () =>
  import('./CodeGraphTab').then((module) => module.CodeGraphTab),
);
const ExperimentsTab = lazySettingsPage('experiments', () =>
  import('./ExperimentsTab').then((module) => module.ExperimentsTab),
);
const RemoteAccessTab = lazySettingsPage('remote-access', () =>
  import('./RemoteAccessTab').then((module) => module.RemoteAccessTab),
);
const LegalTab = lazySettingsPage('legal', () =>
  import('./LegalTab').then((module) => module.LegalTab),
);

interface SettingsSectionPageProps {
  readonly section: SettingsSection;
  readonly claudeSettingsAvailable: boolean;
  readonly codeGraphExperimentEnabled: boolean;
  readonly remoteAccessEnabled: boolean;
  readonly onOpenPerformanceSettings: () => void;
}

/**
 * Memoized so the urgent render of a page switch, which still shows the page
 * being left, does not render that page again.
 */
const SettingsSectionPage = memo(function SettingsSectionPage({
  section,
  claudeSettingsAvailable,
  codeGraphExperimentEnabled,
  remoteAccessEnabled,
  onOpenPerformanceSettings,
}: SettingsSectionPageProps): JSX.Element {
  return (
    <>
      {section === 'canopy' && <CanopyTab />}
      {section === 'performance' && <PerformanceTab />}
      {section === 'shortcuts' && <KeyboardShortcutsTab />}
      {section === 'display' && <DisplayTab />}
      {section === 'notifications' && <NotificationsTab />}
      {section === 'account' && <AccountTab />}
      {section === 'privacy' && <PrivacyTab />}
      {section === 'remote-access' && remoteAccessEnabled && (
        <RemoteAccessTab />
      )}
      {section === 'chat' && <ChatTab />}
      {section === 'memory' && <MemoryTab />}
      {section === 'instructions' && <InstructionsTab />}
      {section === 'harnesses' && <HarnessesTab />}
      {section === 'plugins' && <PluginsTab />}
      {section === 'app-advisor' && <AppAdvisorTab />}
      {section === 'files' && <FilesTab />}
      {section === 'browser' && <BrowserTab />}
      {section === 'terminal' && <TerminalTab />}
      {section === 'plan-detection' && <PlanDetectionTab />}
      {section === 'dictation' && isVoiceDictationPlatform(localPlatform()) && (
        <DictationTab />
      )}
      {section === 'codex' && <CodexTab />}
      {section === 'claude' && claudeSettingsAvailable && (
        <ClaudeTab onOpenPerformanceSettings={onOpenPerformanceSettings} />
      )}
      {section === 'ollama' && isOllamaSupportedOnPlatform() && <OllamaTab />}
      {section === 'account-proxy' && <AccountProxyTab />}
      {section === 'git' && <GitTab />}
      {section === 'environment' && <EnvironmentsTab />}
      {section === 'applications' && <ApplicationsTab />}
      {section === 'mcp' && <McpTab />}
      {section === 'approvals' && <ApprovalsTab />}
      {section === 'code-graph' && codeGraphExperimentEnabled && (
        <CodeGraphTab />
      )}
      {section === 'experiments' && <ExperimentsTab />}
      {section === 'legal' && <LegalTab />}
    </>
  );
});

interface SettingsPageContentProps extends SettingsSectionPageProps {
  readonly scrollContainerRef: RefObject<HTMLDivElement | null>;
}

/**
 * The selected section's page. It mounts with each open, so the page Settings
 * opens on renders right away.
 *
 * A page whose code has loaded switches in with the nav. A page still loading
 * goes through `useDeferredValue` instead: the nav highlights the new section
 * at once and the page renders in the background, where loading suspends it,
 * so the current page stays on screen until the next one is ready. Rendering
 * that switch urgently showed the blank Suspense fallback, which React keeps
 * up for at least 300ms. Deferring a loaded page would only add a render.
 */
function SettingsPageContent({
  section,
  scrollContainerRef,
  ...pageProps
}: SettingsPageContentProps): JSX.Element {
  const deferredSection = useDeferredValue(section);
  const displayedSection = loadedSettingsSections.has(section)
    ? section
    : deferredSection;

  // Each page opens at its top. The scroller is shared, so a page that
  // renders in one pass would otherwise keep the previous page's offset.
  useLayoutEffect(() => {
    const scrollContainer = scrollContainerRef.current;
    if (scrollContainer) {
      scrollContainer.scrollTop = 0;
    }
  }, [displayedSection, scrollContainerRef]);

  // Session replay: classify by the section on screen. `section` changes
  // before a loading page is ready, while the previous page is still shown.
  return (
    <SettingsReplayPrivacyContext.Provider
      value={SETTINGS_SECTION_REPLAY_PRIVACY[displayedSection]}
    >
      <Suspense fallback={<Surface variant="pane" extent="parent" />}>
        <SettingsSectionPage section={displayedSection} {...pageProps} />
      </Suspense>
    </SettingsReplayPrivacyContext.Provider>
  );
}

interface SettingsOverlayProps {
  open?: boolean;
  onClose: () => void;
  initialSection?: SettingsSection;
}

function SettingsOverlayImpl({
  open = true,
  onClose,
  initialSection,
}: SettingsOverlayProps): JSX.Element {
  const claudeSettingsAvailable = useClaudeSettingsAvailable();
  const codeGraphExperimentEnabled = useCodeGraphExperimentEnabled();
  // Early access: the inset window layout, like the main window's.

  // Remote access settings describe the computer in front of the user, so
  // a window that shows another computer leaves them out.
  const remoteAccessEnabled = useRemoteControlStore(
    (store) => store.state.available && store.context.mode === 'local',
  );
  // Until the first snapshot lands, a deep link to the section is kept
  // rather than downgraded.
  const remoteAccessResolvable = useRemoteControlStore(
    (store) =>
      !store.hydrated ||
      (store.state.available && store.context.mode === 'local'),
  );
  const sidebarWidth = useSidebarStore((state) => state.width);
  const setSidebarWidth = useSidebarStore((state) => state.setWidth);
  const [contentMounted, setContentMounted] = useState(open);
  const [overlayVisible, setOverlayVisible] = useState(open);
  // Hosted account and organization settings, when this window offers them.
  const hostedClient = useHostedSettingsClient();
  const hostedSettingsAvailable = hostedClient !== null;
  const resolveVisibleSection = useCallback(
    (section: SettingsSection | undefined): SettingsSection => {
      // Experiments is always reachable: managed delegation and faster
      // window opening are plain preferences, not flagged capabilities, so
      // the tab is never empty even when every flagged experiment is off.
      return resolveSettingsSection(section, localPlatform(), {
        claudeSettingsAvailable,
        codeGraphEnabled: codeGraphExperimentEnabled,
        remoteAccessEnabled: remoteAccessResolvable,
        hostedSettingsAvailable,
      });
    },
    [
      claudeSettingsAvailable,
      codeGraphExperimentEnabled,
      remoteAccessResolvable,
      hostedSettingsAvailable,
    ],
  );
  const [activeSection, setActiveSection] = useState<SettingsSection>(() =>
    resolveVisibleSection(initialSection),
  );
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const requestedHostedLocation = useNavigationStore(
    (state) => state.settingsHostedLocation,
  );
  const hostedLocation = hostedClient === null ? null : requestedHostedLocation;
  const showLocalSettingsSection = useNavigationStore(
    (state) => state.showLocalSettingsSection,
  );
  // A local row or a local page's link leaves any hosted page first.
  const navigateLocal = useCallback(
    (section: SettingsSection): void => {
      showLocalSettingsSection();
      setActiveSection(section);
    },
    [showLocalSettingsSection],
  );
  // Each open is a new hosted settings session: fresh data, nothing
  // preselected. Derived during render so no child sees the previous
  // session's store on the opening commit.
  const [hostedSession, setHostedSession] = useState({ open, key: 0 });
  if (hostedSession.open !== open) {
    setHostedSession({
      open,
      key: open ? hostedSession.key + 1 : hostedSession.key,
    });
  }
  const hostedRouteKey =
    hostedLocation === null
      ? null
      : hostedSettingsRouteKey(hostedLocation.route);
  // Each hosted page opens at its top, like the local pages.
  useLayoutEffect(() => {
    const scrollContainer = scrollContainerRef.current;
    if (hostedRouteKey !== null && scrollContainer) {
      scrollContainer.scrollTop = 0;
    }
  }, [hostedRouteKey]);
  const openPerformanceSettings = useCallback(
    (): void => setActiveSection('performance'),
    [],
  );
  const renderHostedRail = useCallback(
    ({ appGroup, trailingGroups }: HostedRailSlots): JSX.Element => (
      <HostedSettingsNav
        open={open}
        appGroup={appGroup}
        trailingGroups={trailingGroups}
      />
    ),
    [open],
  );
  const resolveVisibleSectionRef = useRef(resolveVisibleSection);
  resolveVisibleSectionRef.current = resolveVisibleSection;
  const settingsOpenRequest = useNavigationStore(
    (state) => state.settingsOpenRequest,
  );

  useEffect(() => {
    if (!open) {
      return;
    }
    // With hosted settings, Notifications is the hosted account page: every
    // `openSettings('notifications')` (palette, App Advisor, campaigns, deep
    // links) lands there. The hosted location and the local section beneath
    // it (General) update in this one effect, so General never flashes. Any
    // scroll target `openSettings` stored is left for the hosted page.
    if (hostedSettingsAvailable && initialSection === 'notifications') {
      useNavigationStore
        .getState()
        .openAccountOrganizationSettings(
          { scope: 'account', page: 'notifications' },
          { replace: true },
        );
    }
    setActiveSection(resolveVisibleSectionRef.current(initialSection));
  }, [initialSection, settingsOpenRequest, open, hostedSettingsAvailable]);

  useEffect(() => {
    setActiveSection((current) => resolveVisibleSection(current));
  }, [resolveVisibleSection]);

  // Publish the section actually DISPLAYED (never the requested one) so the
  // renderer's screen-route projection can report `app://settings/<section>`.
  // No UI depends on this; see `navigationStore.settingsActiveSection`.
  //
  // The subtlety is the open transition: the effect above resolves the
  // requested section by calling `setActiveSection`, so on the commit where
  // `open` flips true, `activeSection` still holds the PREVIOUS session's
  // value. Publishing that stale value and then the real one would produce two
  // route transitions for one navigation, so the first report of a session
  // resolves the request directly. Every later change — a nav click,
  // `ClaudeTab`'s jump to Performance, or a post-mount
  // `claudeSettingsAvailable` / Canopy Teams redirect — arrives through
  // `activeSection` and reports exactly once.
  const reportedRequestRef = useRef<{
    section: SettingsSection | undefined;
  } | null>(null);
  useEffect(() => {
    // Skip no-op writes: the overlay is mounted (closed) from startup and this
    // effect re-runs on the commit after every open, so an unconditional `set`
    // would notify every navigation-store subscriber for nothing.
    const setSettingsActiveSection = (
      section: SettingsSection | null,
    ): void => {
      const navigation = useNavigationStore.getState();
      if (navigation.settingsActiveSection !== section) {
        navigation.setSettingsActiveSection(section);
      }
    };
    if (!open) {
      reportedRequestRef.current = null;
      setSettingsActiveSection(null);
      return;
    }
    const isNewRequest =
      reportedRequestRef.current === null ||
      reportedRequestRef.current.section !== initialSection;
    reportedRequestRef.current = { section: initialSection };
    setSettingsActiveSection(
      isNewRequest
        ? resolveVisibleSectionRef.current(initialSection)
        : activeSection,
    );
  }, [activeSection, initialSection, open]);

  useEffect(() => {
    if (open) {
      setOverlayVisible(true);
      return;
    }

    const delay = sidebarPageTransitionDelay();
    if (delay === 0) {
      setOverlayVisible(false);
      return;
    }
    const timeout = window.setTimeout(() => setOverlayVisible(false), delay);
    return (): void => window.clearTimeout(timeout);
  }, [open]);

  useEffect(() => {
    if (!open) {
      setContentMounted(false);
      return;
    }

    const delay = sidebarPageTransitionDelay();
    if (delay === 0) {
      setContentMounted(true);
      return;
    }
    const timeout = window.setTimeout(() => setContentMounted(true), delay);
    return (): void => window.clearTimeout(timeout);
  }, [open]);

  // One-shot deep-link inside a section: scroll to, focus, briefly
  // highlight, and HOLD centered the control named by
  // `settingsScrollTarget` (a data-testid) while the section's slower
  // content settles around it. The whole lifecycle — including why the
  // store value is consumed only at hold release, never at acquisition —
  // lives in `settings-scroll-target.ts`; this effect just starts it and
  // cancels on close/target change.
  const settingsScrollTarget = useNavigationStore(
    (state) => state.settingsScrollTarget,
  );
  useEffect(() => {
    if (!open || !settingsScrollTarget) {
      return;
    }
    return beginSettingsScrollTarget(settingsScrollTarget, {
      onConsume: (): void =>
        useNavigationStore.getState().consumeSettingsScrollTarget(),
    });
  }, [open, settingsScrollTarget]);

  // Settings joins the shared overlay stack while open, so Escape closes it
  // only while it is the topmost Escape-enabled overlay: a dialog opened above
  // it wins, and an overlay registered earlier underneath (the hidden shell
  // keeps its pages mounted) is left untouched.

  const [saveBarSlot, setSaveBarSlot] = useState<HTMLDivElement | null>(null);
  const content = (
    <Surface
      variant="pane"
      // `min-h-0`: in its column it fills the height left by the top row, and
      // scrolls inside instead of growing with the page.
      className={`relative flex min-h-0 flex-1 flex-col ${open ? '' : 'invisible'}`}
      data-settings-card=""
      data-testid="settings-content"
    >
      {/* Reserve the scrollbar's width on every page, scrolling or not, so
          the centered page never shifts when a scrollbar appears. Pages
          scroll up under the drag strip and fade out across it; the top
          padding keeps their resting place below the strip. In the inset
          card the strip sits in the row above, so neither applies. */}
      <div
        ref={scrollContainerRef}
        className={`page-scroll-gutter flex-1 overflow-auto ${''}`}
      >
        {contentMounted &&
          (hostedLocation !== null ? (
            // Hosted pages bring their own widths (account reading width,
            // wider Feed, Statistics, Projects and Memory), so they render
            // straight into the scroller rather than a `SettingsPage` column.
            <Suspense fallback={<Surface variant="pane" extent="parent" />}>
              <HostedSettingsContent location={hostedLocation} />
            </Suspense>
          ) : (
            <SettingsSectionNavigationContext.Provider value={navigateLocal}>
              <SettingsSaveBarSlotContext.Provider value={saveBarSlot}>
                <SettingsPageContent
                  section={activeSection}
                  scrollContainerRef={scrollContainerRef}
                  claudeSettingsAvailable={claudeSettingsAvailable}
                  codeGraphExperimentEnabled={codeGraphExperimentEnabled}
                  remoteAccessEnabled={remoteAccessEnabled}
                  onOpenPerformanceSettings={openPerformanceSettings}
                />
              </SettingsSaveBarSlotContext.Provider>
            </SettingsSectionNavigationContext.Provider>
          ))}
      </div>
      {/* A page's save bar renders here, under the scroll area: the card's
          full width, flush with its bottom, never over the content. */}
      <div ref={setSaveBarSlot} className="shrink-0" />
      {/* The window drag strip floats over the page's top edge instead of
          taking a row above it, so scrolled content is never cut off. */}
      {null}
    </Surface>
  );

  // The shared window page: modal over the app, focus in on open and back on
  // close, Escape closes it. It stays mounted while closed so unsaved state
  // survives, and the page hides once the rail's exit motion ends.
  const overlay = (
    <WindowPage
      open={open}
      onClose={onClose}
      keepMounted
      portal={false}
      aria-label="Settings"
    >
      <div
        // Settings is controls and their labels, not text to copy, so a drag
        // across a page selects nothing. Fields and values stay selectable
        // through `.settings-page-overlay` in globals.css.
        // Visible from the render that opens it, so the window page can move
        // focus in at once: `overlayVisible` only catches up in an effect.
        // Hidden by an attribute, not by a class added and removed: a class
        // change here restyled the whole rail (about 750 elements) in a
        // frame of its own once the exit motion ended.
        className="settings-page-overlay flex h-full w-full select-none fg-primary data-[settings-hidden]:invisible"
        data-settings-hidden={open || overlayVisible ? undefined : 'true'}
        data-open={open ? 'true' : 'false'}
        data-settings-layout={'inset'}
        data-testid="settings-overlay"
      >
        <div
          className="flex h-full shrink-0"
          data-testid="settings-sidebar-page"
        >
          <SettingsNav
            activeSection={activeSection}
            onNavigate={navigateLocal}
            onClose={onClose}
            renderHostedRail={
              hostedSettingsAvailable ? renderHostedRail : undefined
            }
            localSelected={hostedLocation === null}
            codeGraphEnabled={codeGraphExperimentEnabled}
            claudeSettingsAvailable={claudeSettingsAvailable}
            remoteAccessEnabled={remoteAccessEnabled}
            width={sidebarWidth}
            onResize={setSidebarWidth}
          />
        </div>
        {/* Early access: the page is a card inset like the main window's, under
          the window's empty 46px top row, which drags the window. The row is
          always rendered (hidden without early access), so switching early
          access keeps the page mounted with its unsaved state. */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className={'electron-drag h-11.5 shrink-0'} />
          {content}
        </div>
      </div>
    </WindowPage>
  );

  if (hostedClient === null) return overlay;
  return (
    <DesktopHostedSettingsProvider
      client={hostedClient}
      sessionKey={hostedSession.key}
      scrollElementRef={scrollContainerRef}
    >
      {overlay}
    </DesktopHostedSettingsProvider>
  );
}

/**
 * Settings stays mounted while closed, under the app root, which renders on
 * every page switch and palette open. Its props change only when it opens,
 * closes or is sent to another section, so those renders stop here instead
 * of running through the kept-mounted rail.
 */
export const SettingsOverlay = memo(SettingsOverlayImpl);

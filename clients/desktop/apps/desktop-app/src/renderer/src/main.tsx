// The diagrams load xyflow on demand, but its stylesheet stays first among
// the startup styles, where it always was, so the cascade is unchanged.
import '@xyflow/react/dist/style.css';
import { OrgProjectDeepLinkBridge } from '@/lib/openOrgProjectDeepLink';
import { OrgProjectAddStoreBridge } from '@/lib/orgProjectCatalogAdd';
import { OnboardingTipsPreferencesBridge } from '@/components/onboarding-tips/OnboardingTipsPreferencesBridge';
import { SuggestionsPreferencesBridge } from '@/components/suggestions/SuggestionsPreferencesBridge';
import { SuggestionsProvider } from '@canopy/ui-app/suggestions';
import './styles/globals.css';
import type { ComponentType } from 'react';
import { createRoot } from 'react-dom/client';
import {
  initClaudeModels,
  initCodexModels,
  initOllamaModels,
  initModelAliases,
  omitModelFeatureFlags,
  type ClaudeModelEntry,
  type CodexModelEntry,
  type OllamaModelEntry,
  type UsageDataPolicySnapshot,
} from '@canopy/desktop-shared/types';
import { replaceModelFamilyMetadata } from '@canopy/desktop-shared/model-config';
import {
  initializeDesktopInstrumentationClient,
  disposePostHogInstrumentationClient,
} from '@canopy/desktop-instrumentation/client';
import type { PostHogRuntimeFlags } from '@canopy/desktop-instrumentation/types';
import {
  CLIENT_FEATURE_FLAGS,
  type FeatureFlagSnapshot,
} from '@canopy/protocol/feature-flags';
import { createPostHogRouteSource } from '@/lib/instrumentation/posthog-route-source';
import { useModelCatalogStore } from '@/stores/modelCatalogStore';
import { isChatTabInScopingContext } from '@/lib/contextScope';
import { brand } from '@/lib/brand';
import { applyBrandDocumentHead } from '@/lib/brandDocumentHead';
import { installBrandDefaultTheme, installUiZoomMetrics } from '@/lib/theme';
import { installWindowCornerRadius } from '@/lib/windowCornerRadius';
import { RootErrorBoundary } from './components/shared/RootErrorBoundary';
import { installRendererErrorLogging } from './lib/renderer-error-logging';
import { installSurfacedErrorRecording } from '@/lib/surfaced-error-recording';
import {
  disposeClaudeTerminalSubscriptions,
  initClaudeTerminalSubscriptions,
} from '@/stores/claudeTerminalStore';
import {
  disposeTerminalActivitySubscriptions,
  initTerminalActivitySubscriptions,
} from '@/stores/terminalActivityStore';
import { CanopyClientProvider } from '@canopy/app-state';
import { HostMermaidExportProvider } from '@canopy/ui-app/mermaid-image-clipboard';
import { postDiagramExportToast } from './lib/diagram-export-toast';
import { ensureReferencePreviewInvalidation } from './components/chat/referencePreviewDecoration';
import {
  initializeChatEnrichmentModes,
  disposeChatEnrichmentModes,
} from './lib/chat-enrichment-modes';
import {
  initializeMarkdownMathPreference,
  disposeMarkdownMathPreference,
} from './lib/markdown-math-preference';
import { DesktopFileSessionRuntime } from './components/chat/DesktopFileSessionRuntime';
import { ipcCanopyClient } from './client/ipc-canopy-client';
import { LifecycleJournalQuarantineHost } from '@canopy/ui-app/lifecycle-journal';
import { DesktopWorktreeDiscardHost } from './components/worktree/DesktopWorktreeDiscardHost';
import { DesktopProjectDeletionDiscardHost } from './components/worktree/DesktopProjectDeletionDiscardHost';
import { DesktopTerminalRuntime } from './client/DesktopTerminalRuntime';
import { EarlyAccessUiProviders } from './components/EarlyAccessUiProviders';
import { localPlatform } from '@/lib/local-platform';

/**
 * The window a renderer page serves. Each window has its own HTML page and
 * entry module (`index.html` -> `main-window-entry.tsx`, `app-advisor.html`
 * -> `app-advisor-entry.tsx`), so neither window loads the other's app. The
 * App Advisor page keeps the `?surface=app-advisor` query that other renderer
 * and main-process code read.
 */
type RendererSurface = 'main' | 'app-advisor';

/**
 * Shared renderer startup for both windows. Entry modules call it once, after
 * their imports have evaluated, which is when this work used to run as the
 * single entry module's body.
 */
export function startRenderer(
  surface: RendererSurface,
  RootApp: ComponentType,
): void {
  // Apply brand-driven title + favicon as early as possible so the OS window
  // chrome and the loading flash show the correct brand before React mounts.
  applyBrandDocumentHead(brand);
  installBrandDefaultTheme();
  // The main process has already zoomed this window to the interface scale;
  // publish `--ui-zoom` and the one-device-pixel hairline before the first
  // React paint so no frame renders with the static fallbacks.
  installUiZoomMetrics();
  // Lets nested surfaces keep their corners concentric with the OS window.
  void installWindowCornerRadius();
  hydrateModelRegistries();
  installRendererRuntime();

  const rootElement = document.getElementById('root');
  if (!rootElement) {
    throw new Error('Root element not found');
  }

  const isMainSurface = surface === 'main';
  // The window's own chrome and material are this computer's.
  document.documentElement.dataset.platform = localPlatform();
  document.body.dataset.rendererSurface = surface;
  ensureReferencePreviewInvalidation();

  import.meta.hot?.dispose(disposeChatEnrichmentModes);
  import.meta.hot?.dispose(disposeMarkdownMathPreference);
  // Instrumentation never gates the first mount.
  initializeInstrumentation(surface);
  void Promise.all([
    initializeChatEnrichmentModes(),
    initializeMarkdownMathPreference(),
  ]).then(() => {
    const root = createRoot(rootElement);
    import.meta.hot?.dispose(() => root.unmount());
    root.render(
      <RootErrorBoundary>
        <CanopyClientProvider client={ipcCanopyClient}>
          <HostMermaidExportProvider notify={postDiagramExportToast}>
            <EarlyAccessUiProviders>
              {/* One-at-a-time suggestions and their master switch (CAN-4343). */}
              <SuggestionsProvider>
                <DesktopTerminalRuntime />
                <OrgProjectDeepLinkBridge />
                <OrgProjectAddStoreBridge />
                <OnboardingTipsPreferencesBridge />
                <SuggestionsPreferencesBridge />
                {/* The desktop file-session controller owns file tabs only in
                    the main window; the standalone App Advisor renderer has
                    none. */}
                {isMainSurface && <DesktopFileSessionRuntime />}
                {/* Deletion and archive refusals open this review (CAN-5335). */}
                {isMainSurface && (
                  <LifecycleJournalQuarantineHost client={ipcCanopyClient} />
                )}
                {/* A refused single-row removal offers a discard (CAN-5336). */}
                {isMainSurface && <DesktopWorktreeDiscardHost />}
                {/* A refused project deletion offers its discards (CAN-5337). */}
                {isMainSurface && <DesktopProjectDeletionDiscardHost />}
                <RootApp />
              </SuggestionsProvider>
            </EarlyAccessUiProviders>
          </HostMermaidExportProvider>
        </CanopyClientProvider>
      </RootErrorBoundary>,
    );
  });
}

function hydrateModelRegistries(): void {
  // Hydrate model registries from preload-injected data before
  // any React component reads the model lists (synchronous fallback).
  const claudeEntries = (
    window as unknown as { claudeModelEntries?: ClaudeModelEntry[] }
  ).claudeModelEntries;
  if (claudeEntries) {
    initClaudeModels(omitModelFeatureFlags(claudeEntries));
  }

  const aliases = (
    window as unknown as { modelAliases?: Record<string, string> }
  ).modelAliases;
  if (aliases) {
    initModelAliases(aliases);
  }

  const codexEntries = (
    window as unknown as { codexModelEntries?: CodexModelEntry[] }
  ).codexModelEntries;
  replaceModelFamilyMetadata([
    ...(claudeEntries ?? []),
    ...(codexEntries ?? []),
  ]);
  if (codexEntries) {
    initCodexModels(omitModelFeatureFlags(codexEntries));
  }

  const ollamaEntries = (
    window as unknown as { ollamaModelEntries?: OllamaModelEntry[] }
  ).ollamaModelEntries;
  if (ollamaEntries) {
    initOllamaModels(ollamaEntries);
  }
}

function installRendererRuntime(): void {
  // Async: fetch the full registry snapshot and overwrite stale preload data,
  // then subscribe to live updates so new models appear without a restart.
  void window.api
    .getModelRegistry()
    .then((snapshot) => {
      useModelCatalogStore.getState().hydrate(snapshot);
    })
    .catch(() => {});

  const unsubscribeFromModelRegistry = useModelCatalogStore
    .getState()
    .subscribe({ isTabInOwnerScope: isChatTabInScopingContext });
  const uninstallRendererErrorLogging = installRendererErrorLogging();
  const uninstallSurfacedErrorRecording = installSurfacedErrorRecording();
  // Register the Claude Code terminal IPC subscriptions exactly once for the
  // lifetime of the renderer. The disposer is wired into the HMR dispose hook
  // so hot-reloaded modules don't double-subscribe (see store implementation).
  initClaudeTerminalSubscriptions();
  initTerminalActivitySubscriptions();
  import.meta.hot?.dispose(() => {
    unsubscribeFromModelRegistry();
    uninstallRendererErrorLogging();
    // Before instrumentation goes away, with the recorder's dedupe cache.
    uninstallSurfacedErrorRecording();
    disposeClaudeTerminalSubscriptions();
    disposeTerminalActivitySubscriptions();
    disposePostHogInstrumentationClient();
  });
}

function postHogFlagsFromSnapshot(snapshot: FeatureFlagSnapshot): {
  captureEnabled: boolean;
  sessionReplaySampleRate: number;
  autocaptureEnabled: boolean;
} {
  return {
    captureEnabled:
      snapshot.values[CLIENT_FEATURE_FLAGS.canopyPostHogCaptureEnabled.key],
    sessionReplaySampleRate:
      snapshot.values[
        CLIENT_FEATURE_FLAGS.canopyPostHogSessionReplaySampleRate.key
      ],
    autocaptureEnabled:
      snapshot.values[CLIENT_FEATURE_FLAGS.canopyPostHogAutocaptureEnabled.key],
  };
}

/**
 * Combines the LaunchDarkly snapshot with main's effective usage-data policy
 * into one `PostHogRuntimeFlags` object. The policy flags stay `false` until
 * the policy has been read (fail closed), and a read never overwrites a newer
 * push from either source.
 */
function createPostHogFlagSource(): {
  getSnapshot: () => Promise<PostHogRuntimeFlags>;
  onSnapshotChanged: (
    listener: (flags: PostHogRuntimeFlags) => void,
  ) => () => void;
} {
  let flags: FeatureFlagSnapshot | undefined;
  let policy: UsageDataPolicySnapshot | undefined;
  let flagsRevision = 0;
  let policyRevision = 0;
  const listeners = new Set<(flags: PostHogRuntimeFlags) => void>();
  const combine = (): PostHogRuntimeFlags => ({
    ...(flags
      ? postHogFlagsFromSnapshot(flags)
      : {
          captureEnabled: false,
          sessionReplaySampleRate: 0,
          autocaptureEnabled: false,
        }),
    productAnalytics: policy?.effective.productAnalytics === true,
    errorReports: policy?.effective.errorReports === true,
    sessionReplay: policy?.effective.sessionReplay === true,
  });
  return {
    getSnapshot: async () => {
      const startFlags = flagsRevision;
      const startPolicy = policyRevision;
      // A failed policy read leaves the usage-data flags closed until main
      // pushes the policy; a failed flag read propagates as before.
      const [flagsRead, policyRead] = await Promise.allSettled([
        window.api.featureFlags.getSnapshot(),
        window.api.observability.getUsageDataPolicy(),
      ]);
      if (flagsRead.status === 'rejected') throw flagsRead.reason;
      const nextFlags = flagsRead.value;
      const nextPolicy =
        policyRead.status === 'fulfilled' ? policyRead.value : undefined;
      const pushed =
        flagsRevision !== startFlags || policyRevision !== startPolicy;
      if (flagsRevision === startFlags) flags = nextFlags;
      if (policyRevision === startPolicy && nextPolicy) policy = nextPolicy;
      const combined = combine();
      // A push during the read published a half-known state; the client
      // drops this read in favor of that push, so republish the merge.
      if (pushed) listeners.forEach((listener) => listener(combined));
      return combined;
    },
    onSnapshotChanged: (listener) => {
      listeners.add(listener);
      const unsubscribeFlags = window.api.featureFlags.onSnapshotChanged(
        (snapshot) => {
          flagsRevision++;
          flags = snapshot;
          listener(combine());
        },
      );
      const unsubscribePolicy =
        window.api.observability.onUsageDataPolicyChanged((snapshot) => {
          policyRevision++;
          policy = snapshot;
          listener(combine());
        });
      return (): void => {
        listeners.delete(listener);
        unsubscribeFlags();
        unsubscribePolicy();
      };
    },
  };
}

function initializeInstrumentation(surface: RendererSurface): void {
  void initializeDesktopInstrumentationClient({
    surface,
    posthogFlags: createPostHogFlagSource(),
    getPostHogAnonymousId: () =>
      window.api.observability.getPostHogAnonymousId(),
    posthogAccount: {
      getSnapshot: () => window.api.observability.getPostHogEmailDomain(),
      onSnapshotChanged: (listener) =>
        window.api.observability.onPostHogEmailDomainUpdate(listener),
    },
    // Both windows share this startup, so branch on the entry's
    // surface: the App Advisor window gets a fixed
    // `app://app-advisor` source, the main window the live projection.
    // Construction is synchronous and touches no store, so it cannot delay
    // first paint. SDK initialization owns subscribing and disposing this
    // source — with instrumentation disabled it is never subscribed, so no
    // ongoing tracking is installed.
    // Keep the route projection out of capture-disabled production bundles.
    // Besides avoiding subscriptions, the build-time branch lets Rollup
    // remove the projection's store graph entirely when PostHog is off.
    posthogRoutes: __CANOPY_POSTHOG_ENABLED__
      ? createPostHogRouteSource(surface)
      : undefined,
    posthogSession: {
      get: () => window.api.observability.getPostHogSession(),
      report: (proposal) =>
        window.api.observability.reportPostHogSessionRotation(proposal),
      subscribe: (callback) =>
        window.api.observability.onPostHogSessionUpdate(callback),
    },
    onProviderInitialized: (result) => {
      if (!result.enabled && result.reason && result.reason !== 'disabled') {
        void window.api.observability
          .recordDesktopInstrumentationInitFailure({
            surface,
            reason: `${result.provider}: ${result.reason}`,
          })
          .catch(() => undefined);
      }
    },
  }).catch(() => undefined);
}

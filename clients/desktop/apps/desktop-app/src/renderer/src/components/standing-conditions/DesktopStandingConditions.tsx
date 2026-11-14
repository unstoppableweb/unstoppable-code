import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { reportClientAppError } from '@canopy/desktop-instrumentation/client';
import type { AppError } from '@canopy/protocol/app-errors';
import {
  OFFLINE_STANDING_CONDITION,
  standingConditionToast,
  useOnlineStatus,
  visibleStandingConditions,
  useStandingConditions,
  type StandingConditionInput,
} from '@canopy/ui-app/standing-conditions';
import { startHostedSettingsSignIn } from '@/components/settings/hosted/hosted-settings-sign-in';
import { useCanopyCloudConnected } from '@/hooks/useCanopyCloudConnected';
import { useCanopyCloudSessionExpired } from '@/hooks/useCanopyCloudSessionExpired';
import { invalidateClaudeAuthStatusCache } from '@/hooks/useClaudeAuthStatus';
import { invalidateCodexAuthStatusCache } from '@/hooks/useCodexAuthStatus';
import { useTelemetrySyncPausedReason } from '@/hooks/useTelemetrySyncPausedReason';
import { openCloudAccountSettings } from '@/lib/navigation/settings-destinations';
import { startOllamaUnavailableRecovery } from '@/lib/ollama-unavailable-recovery';
import {
  onRuntimeProbeRecovered,
  retryRuntime,
  useRuntimeProbeOutcomes,
  type ProbedRuntime,
  type RuntimeProbeView,
} from '@/lib/runtime-probe-outcomes';
import { useNavigationStore } from '@/stores/navigationStore';
import { pinToast, unpinToast } from '@/stores/toastStore';
import { useAnyOllamaConnectionUnavailable } from '@/stores/ollamaConnectionBannerStore';
import { useRemoteControlStore } from '@/stores/remoteControlStore';

const NO_LOCAL_CONDITIONS: readonly StandingConditionInput[] = [];

/** Each episode is recorded once, when it starts, as the card it shows on. */
function reportStandingConditionError(error: AppError): AppError {
  return reportClientAppError(error, { surface: 'toast' })?.error ?? error;
}

function probedRuntimeInput(
  runtime: ProbedRuntime,
  view: RuntimeProbeView,
): StandingConditionInput {
  return {
    id: `runtime-${runtime}`,
    kind: 'runtime-unreachable',
    code: 'app.runtime_unreachable',
    source: `runtime.${runtime}`,
    runtime,
    networkDependent: true,
    suppressed: view.revalidating,
    action: {
      // The app retests every 30 seconds on its own; this retests now.
      // A deliberate exception to the `Try again` retry label (CAN-6361).
      label: 'Retry now',
      busyLabel: 'Retrying now…',
      busy: view.retrying,
      onAction: (): void => {
        retryRuntime(runtime);
      },
    },
  };
}

function useLocalStandingConditions(): readonly StandingConditionInput[] {
  const sessionExpiry = useCanopyCloudSessionExpired();
  const connected = useCanopyCloudConnected();
  const syncPausedReason = useTelemetrySyncPausedReason();
  const probes = useRuntimeProbeOutcomes();
  const ollamaUnavailable = useAnyOllamaConnectionUnavailable();
  const openSettings = useNavigationStore((state) => state.openSettings);

  useEffect(
    () =>
      onRuntimeProbeRecovered((runtime) => {
        if (runtime === 'claude') invalidateClaudeAuthStatusCache();
        else invalidateCodexAuthStatusCache();
      }),
    [],
  );

  useEffect(() => {
    if (!__CANOPY_OLLAMA_ENABLED__) return undefined;
    return startOllamaUnavailableRecovery(window.api);
  }, []);

  return useMemo(() => {
    const inputs: StandingConditionInput[] = [];
    if (sessionExpiry !== 'none') {
      inputs.push({
        id: 'session-expired',
        kind: 'session-expired',
        code: 'external.sign_in_required',
        // A rejection the server already gave stays true without a network.
        networkDependent: false,
        action:
          sessionExpiry === 'manual'
            ? {
                label: 'Open settings',
                onAction: (): void => {
                  openCloudAccountSettings();
                },
              }
            : { label: 'Sign in', onAction: startHostedSettingsSignIn },
      });
    }
    if (probes.claude.unreachable) {
      inputs.push(probedRuntimeInput('claude', probes.claude));
    }
    if (probes.codex.unreachable) {
      inputs.push(probedRuntimeInput('codex', probes.codex));
    }
    if (ollamaUnavailable) {
      inputs.push({
        id: 'runtime-ollama',
        kind: 'runtime-unreachable',
        code: 'external.runtime_unreachable',
        source: 'runtime.ollama',
        runtime: 'ollama',
        // Ollama is only ever reached on the loopback address.
        networkDependent: false,
        action: {
          label: 'Open settings',
          onAction: (): void => {
            openSettings('ollama');
          },
        },
      });
    }
    if (syncPausedReason !== null && connected === true) {
      inputs.push({
        id: 'sync-paused',
        kind: 'sync-paused',
        code: 'external.sync_paused',
        networkDependent: true,
      });
    }
    return inputs;
  }, [
    connected,
    ollamaUnavailable,
    openSettings,
    probes,
    sessionExpiry,
    syncPausedReason,
  ]);
}

const TOAST_TEST_ID = 'standing-conditions-toast';

/**
 * The top standing condition as a pinned card in the toast stack (CAN-6361),
 * with its action and, for a defect, `Report this`, which carries the
 * reference (the card leaves the reference row off). The
 * episode was recorded when it started, so the card doesn't record it again.
 * Closing the card hides that episode while it stays on top; once a
 * different condition takes over or none is left, it shows again on return. Renders nothing itself.
 */
function StandingConditionsView({
  localInputs,
}: {
  readonly localInputs: readonly StandingConditionInput[];
}): null {
  const online = useOnlineStatus();
  const inputs = useMemo(
    () => (online ? localInputs : [OFFLINE_STANDING_CONDITION, ...localInputs]),
    [localInputs, online],
  );
  const conditions = useStandingConditions(
    inputs,
    reportStandingConditionError,
  );
  const [closedReference, setClosedReference] = useState<string | null>(null);
  // A close lasts while its condition stays on top: once another condition
  // takes over (or none is left), the closed one shows again when it returns.
  const topReference =
    visibleStandingConditions(conditions)[0]?.error.referenceId;
  if (closedReference !== null && topReference !== closedReference) {
    setClosedReference(null);
  }
  const toast = useMemo(
    () => standingConditionToast(conditions, closedReference),
    [conditions, closedReference],
  );
  const pinnedIdRef = useRef<string | null>(null);

  useEffect(() => {
    const previousId = pinnedIdRef.current;
    if (previousId !== null && previousId !== toast?.id) unpinToast(previousId);
    pinnedIdRef.current = toast?.id ?? null;
    if (toast === null) return;
    const { action, error } = toast;
    pinToast({
      id: toast.id,
      type: toast.type,
      message: toast.message,
      testId: TOAST_TEST_ID,
      meta: {
        title: toast.title,
        ...(toast.messageContext === undefined
          ? {}
          : { messageContext: toast.messageContext }),
        ...(action === undefined
          ? {}
          : {
              action: {
                label: action.label,
                ...(action.busyLabel === undefined
                  ? {}
                  : { busyLabel: action.busyLabel }),
                // The probe reports its own progress; the button follows it.
                ...(action.busy === true ? { busy: true } : {}),
                testId: `${TOAST_TEST_ID}-action`,
                // The card leaves when the condition clears.
                keepOpen: true,
                onClick: action.onAction,
              },
            }),
      },
      ...(error.kind === 'defect'
        ? // Report this carries the reference; the card stays short.
          { reference: error, referenceRecorded: true, hideReference: true }
        : {}),
      onDismiss: () => setClosedReference(error.referenceId),
    });
  }, [toast]);

  useEffect(
    () => (): void => {
      if (pinnedIdRef.current !== null) unpinToast(pinnedIdRef.current);
    },
    [],
  );

  return null;
}

function LocalStandingConditions(): JSX.Element {
  return <StandingConditionsView localInputs={useLocalStandingConditions()} />;
}

/**
 * Every window watches for device offline. A window controlling another
 * computer evaluates nothing else: those signals describe that computer, and
 * their hooks must not run here.
 */
export function DesktopStandingConditions(): JSX.Element {
  const local = useRemoteControlStore(
    (store) => store.context.mode === 'local',
  );
  return local ? (
    <LocalStandingConditions />
  ) : (
    <StandingConditionsView localInputs={NO_LOCAL_CONDITIONS} />
  );
}

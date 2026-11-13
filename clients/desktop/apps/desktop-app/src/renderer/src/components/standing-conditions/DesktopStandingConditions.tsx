import { useEffect, useMemo, type JSX, type ReactNode } from 'react';
import { reportClientAppError } from '@canopy/desktop-instrumentation/client';
import type { AppError } from '@canopy/protocol/app-errors';
import {
  OFFLINE_STANDING_CONDITION,
  StandingConditionsBanner,
  useOnlineStatus,
  useStandingConditions,
  type StandingConditionInput,
} from '@canopy/ui-app/standing-conditions';
import { startHostedSettingsSignIn } from '@/components/settings/hosted/hosted-settings-sign-in';
import { DesktopReportThisAction } from '@/components/shared/DesktopReportThisAction';
import { useCanopyCloudConnected } from '@/hooks/useCanopyCloudConnected';
import { useCanopyCloudSessionExpired } from '@/hooks/useCanopyCloudSessionExpired';
import { invalidateClaudeAuthStatusCache } from '@/hooks/useClaudeAuthStatus';
import { invalidateCodexAuthStatusCache } from '@/hooks/useCodexAuthStatus';
import { useTelemetrySyncPausedReason } from '@/hooks/useTelemetrySyncPausedReason';
import { brandText } from '@/lib/brand';
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
import { useAnyOllamaConnectionUnavailable } from '@/stores/ollamaConnectionBannerStore';
import { useRemoteControlStore } from '@/stores/remoteControlStore';

const NO_LOCAL_CONDITIONS: readonly StandingConditionInput[] = [];

function reportBannerError(error: AppError): AppError {
  return reportClientAppError(error, { surface: 'banner' })?.error ?? error;
}

function renderReportAction(error: AppError): ReactNode {
  return <DesktopReportThisAction error={error} appName={brandText.appName} />;
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
      label: 'Try again',
      busyLabel: 'Trying again…',
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
          label: 'Open Ollama settings',
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

function StandingConditionsView({
  localInputs,
}: {
  readonly localInputs: readonly StandingConditionInput[];
}): JSX.Element {
  const online = useOnlineStatus();
  const inputs = useMemo(
    () => (online ? localInputs : [OFFLINE_STANDING_CONDITION, ...localInputs]),
    [localInputs, online],
  );
  const conditions = useStandingConditions(inputs, reportBannerError);
  return (
    <StandingConditionsBanner
      conditions={conditions}
      reportAction={renderReportAction}
      className="pointer-events-auto"
    />
  );
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

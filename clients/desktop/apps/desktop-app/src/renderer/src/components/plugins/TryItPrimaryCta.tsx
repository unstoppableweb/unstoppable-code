import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from 'react';
import {
  resolveDetailPrimaryCta,
  type TryItCapability,
} from '@canopy/protocol/try-it';
import {
  DetailPrimaryCta,
  type DetailPrimaryCtaState,
} from '@canopy/ui-shared/components';
import { useTryItAccount } from '@/hooks/useCanopyCloudConnected';
import { useClaudeAuthStatus } from '@/hooks/useClaudeAuthStatus';
import { useCodexAuthStatus } from '@/hooks/useCodexAuthStatus';
import { useCursorChatAvailable } from '@/hooks/useCursorChatAvailable';
import {
  startTryItChat,
  TryItStageCancelledError,
  type TryItChatRequest,
} from '@/lib/tryItChat';
import { tryItStagedMessage } from '@/lib/tryItStage';
import {
  resolveTryItRuntime,
  type TryItHarnessSupport,
  type TryItRuntime,
} from '@/lib/tryItRuntime';
import { useChatStore } from '@/stores/chatStore';
import { useGitHubStore } from '@/stores/githubStore';

/** Shown when the Try it chat could not be opened; the launch stays recoverable. */
export const TRY_IT_START_ERROR = "Couldn't open the chat. Try again.";

export interface TryItPrimaryCtaProps {
  capability: TryItCapability;
  prompt: string;
  /** Host installation semantics; `pending` while a connect is in flight. */
  installation: 'loading' | 'pending' | 'installed' | 'not-installed';
  runtimeSelections?: TryItChatRequest['runtimeSelections'];
  /**
   * The capability's Harness rows. Try it starts on a harness that supports
   * it, retaining the chat before harness sign-in. Absent means every
   * harness is supported.
   */
  harnessSupport?: TryItHarnessSupport;
  /** The host's existing Add/connect flow. */
  onInstall: () => void;
  installLabel?: string;
  installBusyLabel?: string;
  installBusy?: boolean;
  installDisabled?: boolean;
  /**
   * The host's existing install action, kept as a secondary beside Try it for
   * a signed-out viewer: the desktop installs locally without an account, so
   * Try it must not take that path away.
   */
  guestInstallAction?: ReactNode;
}

const DEFAULT_RUNTIME: TryItRuntime = { status: 'default' };

/**
 * One Try it launch, shared by every place a detail presents it (CAN-5306):
 * the header's primary CTA, or a ⋯ menu item when another action is primary.
 */
export interface TryItLaunchController {
  readonly state: DetailPrimaryCtaState;
  /** A launch is in flight; another activation is ignored until it settles. */
  readonly launching: boolean;
  readonly onTry: () => void;
  /** The primary CTA, with a signed-out viewer's install action beside it. */
  readonly primary: JSX.Element;
}

interface TryItLaunchProps extends TryItPrimaryCtaProps {
  children: (controller: TryItLaunchController) => ReactNode;
}

/**
 * Resolves and runs Try it for a detail page, rendering its presentation
 * through `children`. Keeping one mounted launch per detail keeps an
 * in-flight launch's state when the detail moves Try it between slots.
 */
export function TryItLaunch(props: TryItLaunchProps): JSX.Element {
  return props.harnessSupport ? (
    <HarnessAwareTryItLaunch {...props} harnessSupport={props.harnessSupport} />
  ) : (
    <TryItLaunchView {...props} runtime={DEFAULT_RUNTIME} />
  );
}

/**
 * Desktop host for the shared detail-page CTA (CAN-4359): resolves Try it /
 * Install from the live account and the host's installation state, and
 * stages the starter prompt, unsent, in the current worktree's chat
 * (CAN-5218); see `startTryItChat`.
 */
export function TryItPrimaryCta(props: TryItPrimaryCtaProps): JSX.Element {
  return <TryItLaunch {...props}>{(launch) => launch.primary}</TryItLaunch>;
}

/** Reads the same sign-in facts as `PluginHarnessStatus`. */
function HarnessAwareTryItLaunch(
  props: TryItLaunchProps & { harnessSupport: TryItHarnessSupport },
): JSX.Element {
  const claude = useClaudeAuthStatus();
  const codex = useCodexAuthStatus();
  const cursor = useCursorChatAvailable(true);
  const modelDefaults = useChatStore((state) => state.modelDefaults);
  useEffect(() => {
    void useChatStore.getState().ensureModelDefaultsLoaded();
  }, []);
  const runtime = resolveTryItRuntime({
    support: props.harnessSupport,
    defaults: modelDefaults,
    signedIn: {
      claude: claude ? claude.authenticated : null,
      codex: codex ? codex.authenticated : null,
      cursor,
    },
  });
  return <TryItLaunchView {...props} runtime={runtime} />;
}

function TryItLaunchView({
  children,
  capability,
  prompt,
  installation,
  runtimeSelections,
  harnessSupport,
  runtime,
  onInstall,
  installLabel,
  installBusyLabel,
  installBusy = false,
  installDisabled = false,
  guestInstallAction,
}: TryItLaunchProps & { runtime: TryItRuntime }): JSX.Element {
  const account = useTryItAccount();
  const [launching, setLaunching] = useState(false);
  // Guards a second activation from another presentation before the
  // launching state re-renders either of them.
  const launchingRef = useRef(false);
  const state = resolveDetailPrimaryCta({
    account: account.status,
    installation,
    runtime:
      runtime.status === 'loading' || runtime.status === 'setup-required'
        ? runtime.status
        : 'ready',
  });
  const accountId = account.accountId;
  const model = runtime.status === 'model' ? runtime.selection : undefined;
  // A launch is fenced to the account that started it.
  const accountRef = useRef(accountId);
  useEffect(() => {
    accountRef.current = accountId;
  }, [accountId]);

  const onTry = useCallback((): void => {
    if (accountId === null || launchingRef.current) return;
    launchingRef.current = true;
    setLaunching(true);
    void startTryItChat({
      accountId,
      capability,
      prompt,
      runtimeSelections,
      ...(model ? { model } : {}),
      ...(harnessSupport ? { harnessSupport } : {}),
      isCurrent: () => accountRef.current === accountId,
    })
      .then((result): void => {
        if (result === 'joined') return;
        useGitHubStore
          .getState()
          .addToast(tryItStagedMessage(capability.name), 'success', undefined, {
            forceInApp: true,
            suppressOsNotification: true,
          });
      })
      .catch((error: unknown): void => {
        // A launch whose destination changed is dropped quietly.
        if (error instanceof TryItStageCancelledError) return;
        useGitHubStore
          .getState()
          .addToast(TRY_IT_START_ERROR, 'error', undefined, { caught: error });
      })
      .finally((): void => {
        launchingRef.current = false;
        setLaunching(false);
      });
  }, [accountId, capability, prompt, runtimeSelections, model, harnessSupport]);

  const cta = (
    <DetailPrimaryCta
      state={state}
      disabled={state === 'install' && installDisabled}
      subjectName={capability.name}
      onTry={onTry}
      onInstall={onInstall}
      busy={state === 'install' ? installBusy : launching}
      installLabel={installLabel}
      installBusyLabel={installBusyLabel}
    />
  );
  const primary =
    account.status === 'guest' &&
    installation === 'not-installed' &&
    state !== 'install' &&
    guestInstallAction ? (
      <span className="inline-flex items-center gap-2">
        {guestInstallAction}
        {cta}
      </span>
    ) : (
      cta
    );
  return <>{children({ state, launching, onTry, primary })}</>;
}

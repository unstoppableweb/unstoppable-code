'use client';

import {
  isPlanModeHintAvailable,
  type PlanModeHintStore,
} from '@canopy/app-state';
import { useComposerTipClaim } from '@canopy/ui-shared/components';
import {
  PLAN_MODE_SUGGESTION_DEBOUNCE_MS,
  isLongMultiStepPrompt,
} from '@canopy/ui-shared/lib';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type { SuggestionsClaimApi } from '../../suggestions/SuggestionsProvider';
import {
  useSuggestionClaim,
  useSuggestionEligible,
} from '../../suggestions/useSuggestionClaim';

export interface UsePlanModeSuggestionOptions {
  /** Null for an unsupported target, even within a supporting session. */
  suggestionsClaimApi?: SuggestionsClaimApi | null;
  /** The composer's current draft text. Attachments do not contribute. */
  text: string;
  /**
   * Identifies the draft session: the composer and its conversation or
   * target. A new key, an accepted send, or clearing the text starts a new
   * session; editing the same draft does not.
   */
  draftKey: string;
  /** Effective enable target/provider; changes cancel stale activation without replacing the draft. */
  activationKey?: string;
  planMode: boolean;
  /** The host's effective capability: Plan is offered in this composer. */
  planAvailable: boolean;
  /** The provider exposes Plan only as a read-only mode. */
  planReadOnly: boolean;
  /** Pipeline or terminal mode. */
  pipelineMode: boolean;
  /** This is the active, visible composer. */
  active: boolean;
  /** IME composition in progress. */
  composing: boolean;
  /** Null while the host's persistence scope is not available. */
  store: PlanModeHintStore | null;
  /**
   * Turn plan mode on in this composer without touching the draft. Resolve
   * whether it actually turned on, including asynchronous failure.
   */
  onEnablePlanMode: () => boolean | Promise<boolean>;
  /** Host telemetry, once per actual presentation. */
  onShown?: () => void;
  /** Host telemetry, only after plan mode turned on. */
  onAccepted?: () => void;
  onDismissed?: () => void;
  /** Return focus to the composer when an action removes the notice. */
  focusComposer?: () => void;
}

export interface PlanModeSuggestion {
  visible: boolean;
  /** Plan mode is being turned on: further activation is disabled. */
  pending: boolean;
  accept: () => Promise<void>;
  dismiss: () => void;
}

interface DraftSession {
  key: string;
  scope: PlanModeHintStore | null;
  /** Presented and then hidden: it does not reappear in this session. */
  done: boolean;
  presented: boolean;
}

const NO_STORE_SUBSCRIPTION = (): (() => void) => () => undefined;

/**
 * Suggest plan mode for a long, multi-step draft (CAN-4008). Evaluates
 * after the debounce, at most once per draft session, and never intercepts
 * or delays sending. Retirement in any composer sharing the store hides it
 * everywhere.
 */
export function usePlanModeSuggestion({
  suggestionsClaimApi,
  text,
  draftKey,
  activationKey,
  planMode,
  planAvailable,
  planReadOnly,
  pipelineMode,
  active,
  composing,
  store,
  onEnablePlanMode,
  onShown,
  onAccepted,
  onDismissed,
  focusComposer,
}: UsePlanModeSuggestionOptions): PlanModeSuggestion {
  const subscribe = useCallback(
    (listener: () => void): (() => void) =>
      store === null ? (): void => undefined : store.subscribe(listener),
    [store],
  );
  const available = useSyncExternalStore(
    store === null ? NO_STORE_SUBSCRIPTION : subscribe,
    () => store !== null && isPlanModeHintAvailable(store.getState()),
    () => false,
  );
  const gate =
    available &&
    active &&
    planAvailable &&
    !planReadOnly &&
    !planMode &&
    !pipelineMode &&
    !composing;

  const [visible, setVisible] = useState(false);
  const [pending, setPending] = useState(false);
  const session = useRef<DraftSession>({
    key: draftKey,
    scope: store,
    done: false,
    presented: false,
  });
  const activationAllowed =
    active && planAvailable && !planReadOnly && !pipelineMode && !composing;
  // Hosts may project Plan optimistically before its acknowledgement. Keep
  // this existing notice disabled through that request so rejection restores
  // it; every other capability/visibility gate still hides it immediately.
  const awaitingActivation = pending && available && activationAllowed;
  const presentationGate = gate || awaitingActivation;
  const wantsTip =
    presentationGate &&
    (session.current.key !== draftKey ||
      session.current.scope !== store ||
      !session.current.done) &&
    isLongMultiStepPrompt(text);
  // The shared suggestions slot (CAN-4343) is asked for only once this
  // composer's own arbiter granted the tip, and the local slot only while the
  // category is eligible, so neither gate waits on the other or reserves a
  // slot for a hint that cannot show. Losing the shared slot pauses the hint
  // without retiring the draft session. Without a claim API (cloud, older
  // Portal) the hint behaves as before.
  const sharedEligible = useSuggestionEligible(
    'plan-mode-hint',
    suggestionsClaimApi,
  );
  const { visible: localTipAllowed, isVisible: isLocalTipAllowed } =
    useComposerTipClaim('plan-mode', wantsTip && sharedEligible);
  const sharedClaim = useSuggestionClaim(
    'plan-mode-hint',
    wantsTip && sharedEligible && localTipAllowed,
    draftKey,
    undefined,
    suggestionsClaimApi,
  );
  const tipAllowed = localTipAllowed && sharedClaim.allowed;
  const isSharedTipAllowed = sharedClaim.isAllowed;
  const isTipAllowed = useCallback(
    (): boolean => isLocalTipAllowed() && isSharedTipAllowed(),
    [isLocalTipAllowed, isSharedTipAllowed],
  );
  const confirmSharedShown = sharedClaim.confirmShown;
  const dismissShared = sharedClaim.dismiss;
  const latest = useRef({
    draftKey,
    activationKey,
    gate,
    visible: visible && tipAllowed,
    store,
    activationAllowed,
    text,
  });
  latest.current = {
    draftKey,
    activationKey,
    gate,
    visible: visible && tipAllowed,
    store,
    activationAllowed,
    text,
  };
  const activating = useRef(false);
  const activationId = useRef(0);
  const callbacks = useRef({
    onEnablePlanMode,
    onShown,
    onAccepted,
    onDismissed,
    focusComposer,
  });
  callbacks.current = {
    onEnablePlanMode,
    onShown,
    onAccepted,
    onDismissed,
    focusComposer,
  };
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return (): void => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    activationId.current += 1;
    activating.current = false;
    setPending(false);
  }, [activationKey]);

  const empty = text.trim() === '';
  useEffect(() => {
    const replaced =
      session.current.key !== draftKey || session.current.scope !== store;
    if (replaced || empty) {
      session.current = {
        key: draftKey,
        scope: store,
        done: false,
        presented: false,
      };
      activationId.current += 1;
      activating.current = false;
      setPending(false);
      setVisible(false);
      if (empty) return undefined;
    }
    if (!replaced && visible) {
      if (!presentationGate || !isLongMultiStepPrompt(text)) {
        session.current.done = true;
        setVisible(false);
      }
      if (!tipAllowed) setVisible(false);
      return undefined;
    }
    // Arbitration pauses presentation without retiring this draft session.
    // A hidden hint is left alone: this runs on every keystroke, and even a
    // same-value write schedules one more render after each key's own. Keys
    // that arrive faster than those renders run stack them up until React
    // stops the composer with #185 (CAN-6649).
    if (!tipAllowed) {
      if (visible) setVisible(false);
      return undefined;
    }
    if (session.current.done || !gate || composing) return undefined;
    const timer = setTimeout(() => {
      if (
        session.current.done ||
        session.current.key !== draftKey ||
        !isLongMultiStepPrompt(text)
      ) {
        return;
      }
      setVisible(true);
    }, PLAN_MODE_SUGGESTION_DEBOUNCE_MS);
    return (): void => clearTimeout(timer);
  }, [
    text,
    empty,
    draftKey,
    gate,
    presentationGate,
    tipAllowed,
    composing,
    visible,
    store,
  ]);

  const actuallyVisible =
    visible &&
    tipAllowed &&
    presentationGate &&
    session.current.key === draftKey &&
    session.current.scope === store &&
    isLongMultiStepPrompt(text);
  useEffect(() => {
    if (!actuallyVisible || !isTipAllowed() || session.current.presented)
      return;
    session.current.presented = true;
    confirmSharedShown();
    callbacks.current.onShown?.();
    void store?.getState().markShown();
  }, [actuallyVisible, isTipAllowed, store, confirmSharedShown]);

  const accept = useCallback(async () => {
    const {
      draftKey: key,
      activationKey: enableKey,
      gate: open,
      visible: shown,
      store: scope,
      text: draft,
    } = latest.current;
    if (
      !shown ||
      !open ||
      !isTipAllowed() ||
      activating.current ||
      !isLongMultiStepPrompt(draft)
    )
      return;
    const acceptedSession = session.current;
    const generation = scope?.getState().record?.generation;
    const attempt = ++activationId.current;
    activating.current = true;
    setPending(true);
    let enabled = false;
    try {
      enabled = await callbacks.current.onEnablePlanMode();
    } catch {
      enabled = false;
    }
    if (activationId.current !== attempt) return;
    activating.current = false;
    if (!mounted.current) return;
    setPending(false);
    // A failed enable keeps the suggestion; a stale target never retires it.
    if (
      !enabled ||
      !isTipAllowed() ||
      session.current !== acceptedSession ||
      latest.current.draftKey !== key ||
      latest.current.activationKey !== enableKey ||
      latest.current.store !== scope ||
      scope?.getState().record?.generation !== generation ||
      !latest.current.activationAllowed ||
      !isLongMultiStepPrompt(latest.current.text)
    )
      return;
    session.current.done = true;
    setVisible(false);
    void store?.getState().markTried();
    callbacks.current.onAccepted?.();
    callbacks.current.focusComposer?.();
  }, [store, isTipAllowed]);

  const dismiss = useCallback(() => {
    if (!latest.current.visible || !latest.current.gate || !isTipAllowed())
      return;
    session.current.done = true;
    setVisible(false);
    void store?.getState().markDismissed();
    // Dismissing the lesson also retires the category through the shared
    // suggestions path, so every surface reading it agrees.
    dismissShared();
    callbacks.current.onDismissed?.();
    callbacks.current.focusComposer?.();
  }, [store, isTipAllowed, dismissShared]);

  return { visible: actuallyVisible, pending, accept, dismiss };
}

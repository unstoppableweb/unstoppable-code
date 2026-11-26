import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  CanopyCloudAccountPublicState,
  CanopyServerStatus,
} from '@canopy/desktop-shared/types';
import { CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT } from '@canopy/desktop-shared/constants/canopy-cloud';
import { reportClientAppError } from '@canopy/desktop-instrumentation/client';
import { isGuestAccount } from '@canopy/desktop-shared/lib/guest-account';
import { isConclusiveAccountRead } from '@canopy/desktop-shared/lib/canopy-cloud-account-read';
import { brandText } from '@/lib/brand';
import { isCanopyCloudConnected } from '@/lib/canopy-cloud';
import { describeSignInFailure } from '@/lib/sign-in-failure';

import type { SecureStorageFailure } from '@canopy/execution-engine/types/secure-storage';
import {
  getSecureStorageNotice,
  unavailableSecureStorageFailure,
  unknownSecureStorageFailure,
} from '@/lib/secureStorageNotice';

const TOKEN_SAVE_DEBOUNCE_MS = 600;

interface CanopyCloudErrorMessage {
  message: string;
}

function describeCanopyCloudStatus(
  status: CanopyServerStatus,
  account: CanopyCloudAccountPublicState,
): CanopyCloudErrorMessage | null {
  const storageFailure = account.secureStorageFailure;
  if (storageFailure)
    return { message: getSecureStorageNotice(storageFailure).description };
  if (status.error) {
    return { message: status.error };
  }
  if (status.missingCapabilities.length > 0) {
    return {
      message: `This server is missing something the app needs: ${status.missingCapabilities.join(', ')}`,
    };
  }
  if (
    status.authenticated &&
    status.account &&
    status.missingCapabilities.length === 0
  ) {
    return account.hasApiKey && account.storageAvailable
      ? null
      : {
          message:
            'Your credentials were not saved. Try again when secure storage is available.',
        };
  }
  return {
    message:
      "Couldn't sign in with this key. Check the key and your connection.",
  };
}

/**
 * Local UI mode for the Canopy Cloud auth surfaces. `oauth` is the default for
 * new users; `api_key` is the manual fallback. This is renderer-only UI state —
 * the saved credential in secure storage remains the source of truth.
 */
export type CanopyCloudUiMode = 'oauth' | 'api_key';

/**
 * Resolve the initial mode from the loaded account so the UI never silently
 * moves an existing manual user to OAuth:
 *  - explicit OAuth credential → `oauth`
 *  - guest credential → `oauth` (a guest is a browser/OAuth-style identity, not
 *    a manually-entered API key, even though it carries a device `hasApiKey`)
 *  - explicit manual / legacy saved key → `api_key`
 *  - no saved credential → `oauth` (the default for new users)
 */
function resolveInitialCloudMode(
  account: CanopyCloudAccountPublicState,
): CanopyCloudUiMode {
  if (
    account.authMode === 'oauth' ||
    account.credentialSource === 'oauth_desktop' ||
    isGuestAccount(account)
  ) {
    return 'oauth';
  }
  if (
    account.authMode === 'api_key' ||
    account.credentialSource === 'manual' ||
    account.hasApiKey
  ) {
    return 'api_key';
  }
  return 'oauth';
}

function isManualOrLegacyCloudCredential(
  account: CanopyCloudAccountPublicState | null,
): boolean {
  // A guest is never a manual/legacy API-key credential. A normalized guest can
  // carry `credentialSource: 'manual'` while `authMode: 'guest'` (the store's
  // `normalizeCredentialSource` falls back to 'manual' for unrecognized values),
  // and treating it as api-key-connected would render its synthetic
  // `guest+<uuid>@guest.canopy.invalid` email as "Signed in as …" (CAN-936).
  if (isGuestAccount(account)) {
    return false;
  }
  return (
    account?.authMode === 'api_key' ||
    account?.credentialSource === 'manual' ||
    (account !== null &&
      account.hasApiKey &&
      !account.authMode &&
      !account.credentialSource)
  );
}

export interface CanopyCloudConnectSuccess {
  mode: CanopyCloudUiMode;
  account: CanopyCloudAccountPublicState;
  replacedManualKey: boolean;
  /** The successful credential replaced a device-scoped guest identity. */
  upgradedFromGuest: boolean;
  guestDataMerged?: boolean;
}

// A Settings section can unmount while its system-browser OAuth request is
// still live. Retain the connect completion in renderer memory so the next auth
// surface announces it (for example a guest-merge failure) instead of treating
// it as mount-time state. The app process owns the request, so a renderer reload cannot occur
// while that same promise later resolves.
let deferredConnectSuccess: CanopyCloudConnectSuccess | null = null;

// Every hook instance writes the same credential. A write deferred behind an
// earlier save (a queued clear or an unmount flush) submits only if no other
// write or local edit started after it was queued, so a closed surface cannot
// overwrite a newer sign-in or unsubmitted draft after Settings reopened.
let cloudCredentialWriteGeneration = 0;

function claimCloudCredentialWrite(): number {
  cloudCredentialWriteGeneration += 1;
  return cloudCredentialWriteGeneration;
}

export interface UseCanopyCloudAuthOptions {
  onConnectedChange?: (connected: boolean) => void;
  /**
   * Fired ONCE, imperatively, from a user-initiated connect that succeeded.
   * Never fired for a credential resolved at mount — that distinction is the
   * whole reason this is a callback and not a `useEffect` on `connected`.
   */
  onConnectSuccess?: (result: CanopyCloudConnectSuccess) => void;
  /**
   * Settings-tile behaviour: typing in the API-key field schedules a debounced
   * save, and a pending save is flushed on unmount. The auth panel opts out
   * (`false`) because it has an explicit submit button — keeping both means a
   * partially-typed key validates mid-keystroke and paints "Invalid API key"
   * while the user is still typing.
   */
  autoSaveApiKey?: boolean;
}

export interface UseCanopyCloudAuthResult {
  cloudName: string;
  account: CanopyCloudAccountPublicState | null;
  accountInfo: CanopyCloudAccountPublicState['account'];
  loading: boolean;
  mode: CanopyCloudUiMode | null;
  setMode: (next: CanopyCloudUiMode) => void;
  apiKeyInput: string;
  handleApiKeyInputChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  apiKeyVisible: boolean;
  setApiKeyVisible: (next: boolean | ((prev: boolean) => boolean)) => void;
  validating: boolean;
  oauthPending: boolean;
  disconnecting: boolean;
  /**
   * The authoritative credential on disk exists but could not be decrypted, so
   * every signed-out-looking field below is inconclusive. Surfaces must offer
   * recovery instead of ordinary sign-in while this is true — an OAuth or
   * API-key write would land next to an unreadable entry the user still cannot
   * get past.
   */
  accountUnreadable: boolean;
  /** A {@link UseCanopyCloudAuthResult.resetUnreadableAccount} call is in flight. */
  repairing: boolean;
  errorMessage: string | null;
  successMessage: string | null;
  storageAvailable: boolean;
  secureStorageFailure: SecureStorageFailure | null;
  retrySecureStorage: () => Promise<void>;
  storageRetrying: boolean;
  apiKeyConnected: boolean;
  oauthConnected: boolean;
  busy: boolean;
  statusGreen: boolean;
  connected: boolean;
  /** A user-initiated connection has not yet notified its host. */
  connectCompletionPending: boolean;
  handleStartOAuthLogin: () => Promise<void>;
  handleCancelOAuthLogin: () => Promise<void>;
  handleDisconnect: () => Promise<void>;
  handleSubmitApiKey: () => Promise<void>;
  /**
   * Back up and remove an unreadable authoritative credential, ending in an
   * explicit signed-out state. Resolves `true` when the request settled (either
   * the file was reset or it turned out not to need one) and `false` when it
   * failed, so a host confirmation dialog knows whether to stay open.
   */
  resetUnreadableAccount: () => Promise<boolean>;
}

/**
 * The whole Canopy Cloud sign-in state machine, shared by every surface that
 * can connect an account: the Settings → Account tile, the modal auth panel,
 * and the blocking splash gate. Extracted so the three presentations differ
 * only in layout — the credential handling and debounce/sequence machinery
 * have exactly one implementation.
 *
 * Signing in shows no activity-sharing prompt. Sharing is off by default, so
 * there is nothing to disclose at sign-in; people change it in Privacy.
 */
export function useCanopyCloudAuth({
  onConnectedChange,
  onConnectSuccess,
  autoSaveApiKey = true,
}: UseCanopyCloudAuthOptions = {}): UseCanopyCloudAuthResult {
  const cloudName = useMemo(() => `${brandText.appName} Cloud`, []);
  const [account, setAccount] = useState<CanopyCloudAccountPublicState | null>(
    null,
  );
  const [cloudMode, setCloudMode] = useState<CanopyCloudUiMode | null>(null);
  const [loading, setLoading] = useState(true);
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [apiKeyVisible, setApiKeyVisible] = useState(false);
  const [validating, setValidating] = useState(false);
  const [oauthPending, setOauthPending] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [repairing, setRepairing] = useState(false);
  const [secureStorageFailure, setSecureStorageFailure] =
    useState<SecureStorageFailure | null>(null);
  const [storageRetrying, setStorageRetrying] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const apiKeySaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const apiKeySaveSequence = useRef(0);
  const apiKeyWriteInFlightRef = useRef<number | null>(null);
  // Retain the submitted candidate even after failure: unmount must flush a
  // newer draft, not silently retry the same submitted credential.
  const lastApiKeyWriteRef = useRef<{
    candidate: string;
    sequence: number;
    outcome: { state: 'queued' | 'submitted' | 'skipped' };
    settled: Promise<void>;
  } | null>(null);
  // A skipped queued clear must not hide the credential already submitted.
  const lastSubmittedApiKeyRef = useRef<string | null>(null);
  const latestApiKeyInputRef = useRef(apiKeyInput);
  const hasApiKeyRef = useRef(false);
  const pendingApiKeyFlushRef = useRef(false);
  const storageAvailableRef = useRef(true);
  const mountedRef = useRef(true);
  const accountRef = useRef<CanopyCloudAccountPublicState | null>(null);
  const persistedApiKeyRef = useRef<string | null>(null);
  const accountSnapshotLoadedRef = useRef(false);
  const preserveEditorDuringDispatchRef = useRef(false);
  const accountReadSequenceRef = useRef(0);
  const oauthAttemptSequenceRef = useRef(0);
  const activeOauthAttemptRef = useRef<number | null>(null);
  const oauthCancelRequestedAttemptRef = useRef<number | null>(null);
  const oauthCancelInFlightAttemptRef = useRef<number | null>(null);
  const autoSaveApiKeyRef = useRef(autoSaveApiKey);
  const repairingRef = useRef(false);
  const storageRetryActionRef = useRef<'api_key' | 'oauth' | null>(null);

  // Latest-ref rather than a dep: `onConnectSuccess` is routinely an inline
  // arrow, and in a `useCallback` dep array it would destabilise
  // `handleStartOAuthLogin` / `saveApiKeyCandidate` and every memo downstream.
  // Mirrors the existing `mountedRef` / `accountRef` pattern.
  const onConnectSuccessRef = useRef(onConnectSuccess);
  // Latch: a re-validate of an already-good key (the debounce re-fires when the
  // user edits then restores the value) must not announce a second time.
  const connectAnnouncedRef = useRef(false);

  // A user-initiated connection waits here until the effect below notifies the
  // host, so a host that closes itself from `onConnectSuccess` does so after
  // the connected state has rendered.
  const [pendingConnectSuccess, setPendingConnectSuccess] =
    useState<CanopyCloudConnectSuccess | null>(null);

  useEffect(() => {
    onConnectSuccessRef.current = onConnectSuccess;
  }, [onConnectSuccess]);

  useEffect(() => {
    autoSaveApiKeyRef.current = autoSaveApiKey;
  }, [autoSaveApiKey]);

  const announceConnectSuccess = useCallback(
    (
      mode: CanopyCloudUiMode,
      next: CanopyCloudAccountPublicState,
      replacedManualKey: boolean,
      upgradedFromGuest: boolean,
      guestDataMerged?: boolean,
    ): void => {
      // Guest creation can use the same OAuth-shaped response, but it is not a
      // completed sign-in. Do not consume the one-shot announcement latch or a
      // later real account connection in this mount would never reach the host.
      if (connectAnnouncedRef.current || isGuestAccount(next)) return;
      const success: CanopyCloudConnectSuccess = {
        mode,
        account: next,
        replacedManualKey,
        upgradedFromGuest,
        ...(guestDataMerged === undefined ? {} : { guestDataMerged }),
      };
      connectAnnouncedRef.current = true;
      if (!mountedRef.current) {
        deferredConnectSuccess = success;
        return;
      }
      setPendingConnectSuccess(success);
    },
    [],
  );

  const dispatchAccountChanged = useCallback((preserveEditor = false): void => {
    preserveEditorDuringDispatchRef.current = preserveEditor;
    try {
      window.dispatchEvent(new Event(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT));
    } finally {
      preserveEditorDuringDispatchRef.current = false;
    }
  }, []);

  const applyLoadedAccount = useCallback(
    (
      next: CanopyCloudAccountPublicState,
      apiKey: string,
      preserveEditor = false,
    ): void => {
      const diagnostic = next.secureStorageStatus;
      const availabilityFailure =
        diagnostic && !diagnostic.writeAvailable
          ? {
              ...unavailableSecureStorageFailure(),
              state: diagnostic.state,
              backend: diagnostic.backend,
              retryable:
                diagnostic.state === 'locked' ||
                diagnostic.state === 'unavailable',
            }
          : null;
      setSecureStorageFailure(
        next.secureStorageFailure ??
          availabilityFailure ??
          (next.storageAvailable ? null : unavailableSecureStorageFailure()),
      );
      const previous = accountRef.current;
      const sameCredential =
        accountSnapshotLoadedRef.current &&
        persistedApiKeyRef.current === apiKey &&
        previous?.hasApiKey === next.hasApiKey &&
        previous?.authMode === next.authMode &&
        previous?.credentialSource === next.credentialSource &&
        previous?.serverApiKeyId === next.serverApiKeyId &&
        previous?.account?.id === next.account?.id &&
        previous?.storageAvailable === next.storageAvailable;
      accountRef.current = next;
      persistedApiKeyRef.current = apiKey;
      accountSnapshotLoadedRef.current = true;
      hasApiKeyRef.current = next.hasApiKey;
      storageAvailableRef.current = next.storageAvailable;
      setAccount(next);
      if (
        preserveEditor &&
        lastSubmittedApiKeyRef.current !== apiKey &&
        isConclusiveAccountRead(next)
      ) {
        // A confirmed replacement invalidates submitted-key deduplication.
        // Retain the actual prior write so cleanup still waits for it.
        lastSubmittedApiKeyRef.current = null;
      }
      if (!preserveEditor && !sameCredential) {
        lastApiKeyWriteRef.current = null;
        lastSubmittedApiKeyRef.current = null;
        if (apiKeySaveTimer.current) {
          clearTimeout(apiKeySaveTimer.current);
          apiKeySaveTimer.current = null;
        }
        apiKeySaveSequence.current += 1;
        pendingApiKeyFlushRef.current = false;
        const nextInput = isManualOrLegacyCloudCredential(next) ? apiKey : '';
        latestApiKeyInputRef.current = nextInput;
        setApiKeyInput(nextInput);
        setCloudMode(resolveInitialCloudMode(next));
        setValidating(false);
      }
      if (deferredConnectSuccess) {
        const deferred = deferredConnectSuccess;
        deferredConnectSuccess = null;
        const liveAccountMatches =
          isCanopyCloudConnected(next) &&
          !isGuestAccount(next) &&
          next.account?.id === deferred.account.account?.id;
        if (liveAccountMatches) {
          connectAnnouncedRef.current = true;
          setPendingConnectSuccess(deferred);
        }
      }
    },
    [],
  );

  useEffect(() => {
    let cancelled = false;
    const sequence = ++accountReadSequenceRef.current;
    Promise.all([
      window.api.loadCanopyCloudAccount(),
      // Degrade the key read on its own rather than through `Promise.all`'s
      // all-or-nothing rejection. An unreadable credential must still reach
      // `applyLoadedAccount` so `read: 'error'` survives into state and the
      // recovery surfaces render; falling into the `catch` below would discard
      // it and route the user into ordinary OAuth against a broken entry.
      window.api.loadCanopyCloudApiKey().catch(() => undefined),
    ])
      .then(([next, apiKey]) => {
        if (cancelled || sequence !== accountReadSequenceRef.current) return;
        applyLoadedAccount(next, apiKey ?? '');
        if (apiKey === undefined && isConclusiveAccountRead(next)) {
          setSecureStorageFailure(unknownSecureStorageFailure('read'));
        }
      })
      .catch(() => {
        if (cancelled) return;
        // No credential could be loaded — default new users to OAuth.
        setCloudMode('oauth');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return (): void => {
      cancelled = true;
    };
  }, [applyLoadedAccount]);

  useEffect(() => {
    let cancelled = false;
    const refreshAccount = (): void => {
      // A completion from an unmounted surface can arrive before this draft's
      // debounce fires, or while its newer save is queued behind another write.
      // Refresh the account without replacing that unsent input/timer.
      const preserveEditor =
        preserveEditorDuringDispatchRef.current ||
        (pendingApiKeyFlushRef.current &&
          (lastApiKeyWriteRef.current?.sequence !==
            apiKeySaveSequence.current ||
            lastApiKeyWriteRef.current?.outcome.state === 'queued'));
      const editSequence = apiKeySaveSequence.current;
      const sequence = ++accountReadSequenceRef.current;
      void Promise.all([
        window.api.loadCanopyCloudAccount(),
        window.api.loadCanopyCloudApiKey(),
      ])
        .then(([next, apiKey]) => {
          if (cancelled || sequence !== accountReadSequenceRef.current) return;
          if (!isConclusiveAccountRead(next)) {
            // An unreadable snapshot cannot cancel a pending credential write.
            setSecureStorageFailure(next.secureStorageFailure ?? null);
            return;
          }
          applyLoadedAccount(
            next,
            apiKey,
            preserveEditor || editSequence !== apiKeySaveSequence.current,
          );
        })
        .catch(() => {
          // Preserve the last-known-good snapshot on a transient read failure.
        });
    };
    window.addEventListener(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT, refreshAccount);
    return (): void => {
      cancelled = true;
      window.removeEventListener(
        CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT,
        refreshAccount,
      );
    };
  }, [applyLoadedAccount]);

  const storageAvailable =
    account?.storageAvailable !== false && !secureStorageFailure;
  const hasApiKey = !!account?.hasApiKey;
  const accountInfo = account?.account;
  // API-key mode is "connected" only when a saved key resolved to account
  // metadata and there is no outstanding validation error.
  const apiKeyConnected =
    isManualOrLegacyCloudCredential(account) && !!accountInfo && !errorMessage;
  // OAuth mode is "connected" only when the saved credential was minted by the
  // desktop OAuth flow and resolved to account metadata.
  const oauthConnected =
    account?.credentialSource === 'oauth_desktop' && !!accountInfo;
  // A non-`ok` read collapses to a signed-out-shaped snapshot, so this is the
  // ONLY signal separating "no account" from "an account we cannot decrypt".
  const accountUnreadable = account?.read === 'error';
  const busy = oauthPending || disconnecting || repairing || storageRetrying;
  const statusGreen =
    cloudMode === 'oauth' ? oauthConnected && !errorMessage : apiKeyConnected;
  const connected = (oauthConnected || apiKeyConnected) && !errorMessage;

  // Surface the authoritative connection signal to an embedding host so it can
  // gate dependent controls (e.g. the sync modal's Privacy section).
  useEffect(() => {
    if (loading) return;
    onConnectedChange?.(connected);
  }, [connected, loading, onConnectedChange]);

  // Only a user-initiated connect creates `pendingConnectSuccess`; credentials
  // resolved at mount never do. Complete the connection and notify the host.
  useEffect(() => {
    if (!pendingConnectSuccess) return;
    setPendingConnectSuccess(null);
    onConnectSuccessRef.current?.(pendingConnectSuccess);
  }, [pendingConnectSuccess]);

  useEffect(() => {
    latestApiKeyInputRef.current = apiKeyInput;
  }, [apiKeyInput]);

  useEffect(() => {
    storageAvailableRef.current = storageAvailable;
  }, [storageAvailable]);

  useEffect(() => {
    hasApiKeyRef.current = hasApiKey;
  }, [hasApiKey]);

  const clearSavedApiKey = useCallback(
    async (sequence: number): Promise<void> => {
      const priorWrite = lastApiKeyWriteRef.current;
      if (
        loading ||
        !storageAvailableRef.current ||
        (!hasApiKeyRef.current &&
          !priorWrite?.candidate &&
          priorWrite?.outcome.state !== 'queued' &&
          priorWrite?.outcome.state !== 'skipped')
      ) {
        if (sequence === apiKeySaveSequence.current) {
          storageRetryActionRef.current = !storageAvailableRef.current
            ? 'api_key'
            : null;
          setValidating(false);
        }
        return;
      }

      setValidating(true);
      setErrorMessage(null);
      setSuccessMessage(null);
      apiKeyWriteInFlightRef.current = sequence;

      try {
        const outcome: { state: 'queued' | 'submitted' | 'skipped' } = {
          state: 'queued',
        };
        const generation = claimCloudCredentialWrite();
        const clearLatest =
          (): Promise<CanopyCloudAccountPublicState | null> => {
            if (
              generation !== cloudCredentialWriteGeneration ||
              sequence !== apiKeySaveSequence.current ||
              latestApiKeyInputRef.current.trim().length > 0
            ) {
              outcome.state = 'skipped';
              return Promise.resolve(null);
            }
            outcome.state = 'submitted';
            lastSubmittedApiKeyRef.current = '';
            return window.api.clearCanopyCloudApiKey();
          };
        // A stale initial save may have persisted a key without updating our
        // snapshot. Clear after it settles, but only while empty is still the
        // latest intent. Register the queued clear now so unmount won't copy it.
        const write = priorWrite
          ? priorWrite.settled.then(clearLatest)
          : clearLatest();
        lastApiKeyWriteRef.current = {
          candidate: '',
          sequence,
          outcome,
          settled: write.then(
            () => undefined,
            () => undefined,
          ),
        };
        const next = await write;
        if (!next) return;
        const isLatest =
          sequence === apiKeySaveSequence.current &&
          latestApiKeyInputRef.current.trim().length === 0;
        if (!isLatest) {
          if (!mountedRef.current && !next.secureStorageFailure) {
            window.dispatchEvent(new Event(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT));
          }
          return;
        }

        pendingApiKeyFlushRef.current = false;
        storageRetryActionRef.current = next.secureStorageFailure
          ? 'api_key'
          : null;
        setSecureStorageFailure(next.secureStorageFailure ?? null);
        if (next.secureStorageFailure) return;
        hasApiKeyRef.current = next.hasApiKey;
        if (!mountedRef.current) {
          window.dispatchEvent(new Event(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT));
          return;
        }

        setAccount(next);
        dispatchAccountChanged(!isGuestAccount(next));
      } catch {
        if (
          mountedRef.current &&
          sequence === apiKeySaveSequence.current &&
          latestApiKeyInputRef.current.trim().length === 0
        ) {
          setErrorMessage(
            "Couldn't sign in with this key. Check the key and your connection.",
          );
        }
      } finally {
        if (apiKeyWriteInFlightRef.current === sequence) {
          apiKeyWriteInFlightRef.current = null;
        }
        if (
          mountedRef.current &&
          sequence === apiKeySaveSequence.current &&
          latestApiKeyInputRef.current.trim().length === 0
        ) {
          setValidating(false);
        }
      }
    },
    [dispatchAccountChanged, loading],
  );

  const saveApiKeyCandidate = useCallback(
    async (candidate: string, sequence: number): Promise<void> => {
      const apiKey = candidate.trim();
      if (loading || !storageAvailableRef.current || apiKey.length === 0) {
        if (sequence === apiKeySaveSequence.current) {
          storageRetryActionRef.current = !storageAvailableRef.current
            ? 'api_key'
            : null;
          setValidating(false);
        }
        return;
      }

      storageRetryActionRef.current = null;
      setValidating(true);
      setErrorMessage(null);
      setSuccessMessage(null);
      apiKeyWriteInFlightRef.current = sequence;

      try {
        const replacingGuest = isGuestAccount(accountRef.current);
        const priorWrite = lastApiKeyWriteRef.current;
        const outcome: { state: 'queued' | 'submitted' | 'skipped' } = {
          state: 'queued',
        };
        const generation = claimCloudCredentialWrite();
        const submitLatest = (): Promise<Awaited<
          ReturnType<typeof window.api.saveCanopyCloudApiKey>
        > | null> => {
          if (
            generation !== cloudCredentialWriteGeneration ||
            sequence !== apiKeySaveSequence.current ||
            latestApiKeyInputRef.current.trim() !== apiKey
          ) {
            outcome.state = 'skipped';
            return Promise.resolve(null);
          }
          outcome.state = 'submitted';
          lastSubmittedApiKeyRef.current = apiKey;
          return window.api.saveCanopyCloudApiKey({ apiKey });
        };
        // The previous save must finish its persistence and identity transition
        // before this candidate captures the expected account. Register queued
        // ownership now so unmount does not submit the same draft twice.
        const write = priorWrite
          ? priorWrite.settled.then(submitLatest)
          : submitLatest();
        lastApiKeyWriteRef.current = {
          candidate: apiKey,
          sequence,
          outcome,
          settled: write.then(
            () => undefined,
            () => undefined,
          ),
        };
        const result = await write;
        if (!result) return;
        const isLatest =
          sequence === apiKeySaveSequence.current &&
          latestApiKeyInputRef.current.trim() === apiKey;
        if (!isLatest) {
          // A newer draft owns the editor, but this completed write still
          // changed storage. Notify readers without announcing a stale connect.
          if (
            !mountedRef.current &&
            !describeCanopyCloudStatus(result.status, result.account)
          ) {
            window.dispatchEvent(new Event(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT));
          }
          return;
        }

        pendingApiKeyFlushRef.current = false;
        storageRetryActionRef.current = result.account.secureStorageFailure
          ? 'api_key'
          : null;
        const failure = describeCanopyCloudStatus(
          result.status,
          result.account,
        );
        if (!mountedRef.current) {
          if (!failure) {
            announceConnectSuccess(
              'api_key',
              result.account,
              false,
              replacingGuest,
              replacingGuest ? false : undefined,
            );
            window.dispatchEvent(new Event(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT));
          }
          return;
        }

        setSecureStorageFailure(result.account.secureStorageFailure ?? null);
        setAccount(result.account);
        if (failure) {
          setErrorMessage(failure.message);
        } else {
          pendingApiKeyFlushRef.current = false;
          hasApiKeyRef.current = result.account.hasApiKey;
          latestApiKeyInputRef.current = apiKey;
          setApiKeyInput(apiKey);
          dispatchAccountChanged(true);
          // Announce AFTER clearing the pending-flush latch and dispatching the
          // account-changed event: the unmount cleanup would otherwise re-fire
          // `saveCanopyCloudApiKey`, and every listener (CloudSyncStatus,
          // RemoteControlModal, useSubscriptionStatus) must have refreshed
          // before a host closes itself in response to this callback.
          announceConnectSuccess(
            'api_key',
            result.account,
            false,
            replacingGuest,
            replacingGuest ? false : undefined,
          );
        }
      } catch {
        if (
          mountedRef.current &&
          sequence === apiKeySaveSequence.current &&
          latestApiKeyInputRef.current.trim() === apiKey
        ) {
          setErrorMessage(
            "Couldn't sign in with this key. Check the key and your connection.",
          );
        }
      } finally {
        if (apiKeyWriteInFlightRef.current === sequence) {
          apiKeyWriteInFlightRef.current = null;
        }
        if (
          mountedRef.current &&
          sequence === apiKeySaveSequence.current &&
          latestApiKeyInputRef.current.trim() === apiKey
        ) {
          setValidating(false);
        }
      }
    },
    [announceConnectSuccess, dispatchAccountChanged, loading],
  );

  const scheduleApiKeySave = useCallback(
    (next: string): void => {
      if (apiKeySaveTimer.current) {
        clearTimeout(apiKeySaveTimer.current);
      }
      pendingApiKeyFlushRef.current = true;
      const sequence = apiKeySaveSequence.current + 1;
      apiKeySaveSequence.current = sequence;
      if (next.trim().length === 0) {
        setErrorMessage(null);
        setSuccessMessage(null);
        if (
          !hasApiKeyRef.current &&
          apiKeyWriteInFlightRef.current === null &&
          lastApiKeyWriteRef.current?.outcome.state !== 'queued' &&
          lastApiKeyWriteRef.current?.outcome.state !== 'skipped'
        ) {
          pendingApiKeyFlushRef.current = false;
          setValidating(false);
          return;
        }
        setValidating(true);
        apiKeySaveTimer.current = setTimeout(() => {
          void clearSavedApiKey(sequence);
        }, TOKEN_SAVE_DEBOUNCE_MS);
        return;
      }

      setValidating(true);
      setErrorMessage(null);
      setSuccessMessage(null);
      apiKeySaveTimer.current = setTimeout(() => {
        void saveApiKeyCandidate(next, sequence);
      }, TOKEN_SAVE_DEBOUNCE_MS);
    },
    [clearSavedApiKey, saveApiKeyCandidate],
  );

  useEffect(() => {
    return (): void => {
      mountedRef.current = false;
      if (apiKeySaveTimer.current) {
        clearTimeout(apiKeySaveTimer.current);
      }
      // Submit-only surfaces never schedule a debounced write, so there is
      // nothing to flush and firing one here would save a half-typed key.
      if (!autoSaveApiKeyRef.current) return;
      if (!pendingApiKeyFlushRef.current || !storageAvailableRef.current) {
        return;
      }

      const pendingApiKey = latestApiKeyInputRef.current.trim();
      const priorWrite = lastApiKeyWriteRef.current;
      if (lastSubmittedApiKeyRef.current === pendingApiKey) return;
      // A skipped write of this same revision was superseded elsewhere.
      // Closing its editor must not reclaim authority over that newer intent.
      if (
        priorWrite?.candidate === pendingApiKey &&
        ((priorWrite.outcome.state === 'submitted' &&
          lastSubmittedApiKeyRef.current !== null) ||
          ((priorWrite.outcome.state === 'queued' ||
            priorWrite.outcome.state === 'skipped') &&
            priorWrite.sequence === apiKeySaveSequence.current))
      )
        return;
      const generation = claimCloudCredentialWrite();
      const flush = async (): Promise<void> => {
        if (generation !== cloudCredentialWriteGeneration) return;
        if (pendingApiKey.length > 0) {
          const result = await window.api.saveCanopyCloudApiKey({
            apiKey: pendingApiKey,
          });
          if (!describeCanopyCloudStatus(result.status, result.account)) {
            window.dispatchEvent(new Event(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT));
          }
        } else if (hasApiKeyRef.current || priorWrite) {
          const next = await window.api.clearCanopyCloudApiKey();
          if (!next.secureStorageFailure) {
            window.dispatchEvent(new Event(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT));
          }
        }
      };
      // A newer draft must follow the submitted write, including when that
      // write fails. Never race a cleanup clear/save against its predecessor.
      void (priorWrite ? priorWrite.settled.then(flush) : flush()).catch(() => {
        // Best-effort flush on unmount.
      });
    };
  }, []);

  const handleApiKeyInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>): void => {
      const next = e.target.value;
      claimCloudCredentialWrite();
      latestApiKeyInputRef.current = next;
      setApiKeyInput(next);
      if (!autoSaveApiKeyRef.current) {
        if (validating) {
          // A submit-only consumer normally disables this field while its save
          // owns the credential write. If a programmatic change still arrives,
          // invalidate the candidate and release the host's pending UI instead
          // of leaving `validating` latched forever.
          apiKeySaveSequence.current += 1;
          pendingApiKeyFlushRef.current = false;
          setValidating(false);
        }
        // Submit-only surface: the first keystroke after a failure clears the
        // stale error so the field does not accuse the user while they retype.
        setErrorMessage(null);
        return;
      }
      scheduleApiKeySave(next);
    },
    [scheduleApiKeySave, validating],
  );

  // Explicit submit for the surfaces that offer a Connect button. Flushes any
  // pending debounce timer and validates the current key immediately.
  const handleSubmitApiKey = useCallback(async (): Promise<void> => {
    const candidate = apiKeyInput.trim();
    if (
      loading ||
      !storageAvailable ||
      validating ||
      busy ||
      activeOauthAttemptRef.current !== null
    ) {
      return;
    }
    if (candidate.length === 0) return;
    if (apiKeySaveTimer.current) {
      clearTimeout(apiKeySaveTimer.current);
      apiKeySaveTimer.current = null;
    }
    pendingApiKeyFlushRef.current = true;
    const sequence = apiKeySaveSequence.current + 1;
    apiKeySaveSequence.current = sequence;
    await saveApiKeyCandidate(candidate, sequence);
  }, [
    apiKeyInput,
    loading,
    storageAvailable,
    validating,
    busy,
    saveApiKeyCandidate,
  ]);

  const handleCloudModeChange = useCallback(
    (next: CanopyCloudUiMode): void => {
      // Switching modes never mutates the saved credential — it only flips the
      // editor view. The OAuth credential survives a switch to API-key mode
      // until the user enters a valid manual key or explicitly disconnects.
      if (
        next === cloudMode ||
        oauthPending ||
        disconnecting ||
        apiKeyWriteInFlightRef.current !== null
      ) {
        return;
      }
      setErrorMessage(null);
      setSuccessMessage(null);
      setCloudMode(next);
    },
    [cloudMode, oauthPending, disconnecting],
  );

  // Cancel any debounced manual-key save still in flight so it cannot land
  // after — and clobber — a credential established by OAuth/disconnect. The
  // claim also supersedes writes deferred by other, unmounted instances.
  const cancelPendingApiKeySave = useCallback((): void => {
    if (apiKeySaveTimer.current) {
      clearTimeout(apiKeySaveTimer.current);
      apiKeySaveTimer.current = null;
    }
    claimCloudCredentialWrite();
    apiKeySaveSequence.current += 1;
    pendingApiKeyFlushRef.current = false;
    storageRetryActionRef.current = null;
    lastApiKeyWriteRef.current = null;
    lastSubmittedApiKeyRef.current = null;
    if (mountedRef.current && apiKeyWriteInFlightRef.current === null) {
      setValidating(false);
    }
  }, []);

  const handleStartOAuthLogin = useCallback(async (): Promise<void> => {
    // The state flag updates after render, so the ref also closes the small
    // same-tick window in which two callers could both start a login.
    if (
      !storageAvailableRef.current ||
      activeOauthAttemptRef.current !== null ||
      oauthPending ||
      disconnecting ||
      apiKeyWriteInFlightRef.current !== null
    ) {
      return;
    }
    const attempt = oauthAttemptSequenceRef.current + 1;
    oauthAttemptSequenceRef.current = attempt;
    activeOauthAttemptRef.current = attempt;
    oauthCancelRequestedAttemptRef.current = null;
    storageRetryActionRef.current = null;
    setOauthPending(true);
    setErrorMessage(null);
    setSuccessMessage(null);
    // A manual key currently in storage/input is being superseded by OAuth.
    const prior = accountRef.current;
    const upgradingGuest = isGuestAccount(prior);
    cancelPendingApiKeySave();
    const replacingManual =
      !upgradingGuest && isManualOrLegacyCloudCredential(prior);
    try {
      const result = await window.api.startCanopyCloudOAuthLogin();
      if (activeOauthAttemptRef.current !== attempt) return;
      if (!mountedRef.current) {
        if (!describeCanopyCloudStatus(result.status, result.account)) {
          window.dispatchEvent(new Event(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT));
          announceConnectSuccess(
            'oauth',
            result.account,
            replacingManual,
            upgradingGuest,
            result.guestDataMerged,
          );
        }
        return;
      }
      storageRetryActionRef.current = result.account.secureStorageFailure
        ? 'oauth'
        : null;
      const failure = describeCanopyCloudStatus(result.status, result.account);
      setSecureStorageFailure(result.account.secureStorageFailure ?? null);
      setAccount(result.account);
      hasApiKeyRef.current = result.account.hasApiKey;
      if (failure) {
        setErrorMessage(failure.message);
      } else {
        pendingApiKeyFlushRef.current = false;
        setApiKeyInput('');
        if (replacingManual) {
          setSuccessMessage('Your saved API key was replaced by this sign-in.');
        }
        window.dispatchEvent(new Event(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT));
        // See the matching note in `saveApiKeyCandidate`: the ordering here is
        // load-bearing, not stylistic.
        announceConnectSuccess(
          'oauth',
          result.account,
          replacingManual,
          upgradingGuest,
          result.guestDataMerged,
        );
      }
    } catch (error: unknown) {
      // A cancellation, including a sign-in replaced from another surface,
      // shows nothing; `finally` still clears the pending state (CAN-6895).
      const failure = describeSignInFailure(
        error,
        `Couldn't finish signing in to ${cloudName}.`,
      );
      if (
        !failure.cancelled &&
        mountedRef.current &&
        activeOauthAttemptRef.current === attempt &&
        oauthCancelRequestedAttemptRef.current !== attempt
      ) {
        setErrorMessage(failure.message);
      }
    } finally {
      if (activeOauthAttemptRef.current === attempt) {
        activeOauthAttemptRef.current = null;
        if (mountedRef.current) {
          if (oauthCancelRequestedAttemptRef.current === attempt) {
            setErrorMessage(null);
          }
          setOauthPending(false);
        }
        if (oauthCancelRequestedAttemptRef.current === attempt) {
          oauthCancelRequestedAttemptRef.current = null;
        }
        if (oauthCancelInFlightAttemptRef.current === attempt) {
          oauthCancelInFlightAttemptRef.current = null;
        }
      }
    }
  }, [
    announceConnectSuccess,
    cloudName,
    oauthPending,
    disconnecting,
    cancelPendingApiKeySave,
  ]);

  const handleDisconnect = useCallback(async (): Promise<void> => {
    if (disconnecting) return;
    setDisconnecting(true);
    setErrorMessage(null);
    setSuccessMessage(null);
    cancelPendingApiKeySave();
    try {
      const next = await window.api.disconnectCanopyCloudAccount();
      if (!mountedRef.current) {
        window.dispatchEvent(new Event(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT));
        return;
      }
      pendingApiKeyFlushRef.current = false;
      hasApiKeyRef.current = next.hasApiKey;
      // A later re-connect in the same mount is a fresh user-initiated
      // connect and must be able to announce again.
      connectAnnouncedRef.current = false;
      setAccount(next);
      setApiKeyInput('');
      window.dispatchEvent(new Event(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT));
    } catch {
      if (mountedRef.current) {
        setErrorMessage(`Couldn't sign out of ${cloudName}.`);
      }
    } finally {
      if (mountedRef.current) setDisconnecting(false);
    }
  }, [cloudName, disconnecting, cancelPendingApiKeySave]);

  /**
   * Explicit recovery for a credential this build wrote but can no longer
   * decrypt. Main backs the file up, purges account-derived local replicas, and
   * returns the resulting signed-out public state; nothing here is destructive
   * on its own, and a `not-needed` outcome (the entry became readable or absent
   * before the lock was acquired) must not be announced as a successful reset.
   */
  const resetUnreadableAccount = useCallback(async (): Promise<boolean> => {
    // Synchronous guard: `repairing` only updates after render, so two clicks
    // in one frame would otherwise both reach IPC.
    if (repairingRef.current) return false;
    repairingRef.current = true;
    setRepairing(true);
    setErrorMessage(null);
    setSuccessMessage(null);
    cancelPendingApiKeySave();
    try {
      const result = await window.api.resetUnreadableCanopyCloudAccount();
      if (!mountedRef.current) {
        window.dispatchEvent(new Event(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT));
        return true;
      }
      pendingApiKeyFlushRef.current = false;
      hasApiKeyRef.current = result.account.hasApiKey;
      accountRef.current = result.account;
      // A later sign-in in this same mount is a fresh user-initiated connect
      // and must be able to announce again.
      connectAnnouncedRef.current = false;
      setAccount(result.account);
      setApiKeyInput('');
      setCloudMode(resolveInitialCloudMode(result.account));
      if (result.status === 'reset') {
        setSuccessMessage('Saved sign-in reset. Sign in again.');
      }
      window.dispatchEvent(new Event(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT));
      return true;
    } catch (error: unknown) {
      // Main records a rejected reset itself; this only links to that record
      // and records a failure that never reached main.
      reportClientAppError(error);
      if (mountedRef.current) {
        setErrorMessage(
          "Couldn't reset the saved sign-in. Close other copies of the app, then try again.",
        );
      }
      return false;
    } finally {
      repairingRef.current = false;
      if (mountedRef.current) setRepairing(false);
    }
  }, [cancelPendingApiKeySave]);

  const handleCancelOAuthLogin = useCallback(async (): Promise<void> => {
    const attempt = activeOauthAttemptRef.current;
    if (attempt === null || oauthCancelInFlightAttemptRef.current === attempt) {
      return;
    }
    oauthCancelInFlightAttemptRef.current = attempt;
    oauthCancelRequestedAttemptRef.current = attempt;
    setErrorMessage(null);
    setSuccessMessage(null);
    try {
      await window.api.cancelCanopyCloudOAuthLogin();
    } catch {
      // The start request remains authoritative. Allow another cancel attempt,
      // but do not reopen the login CTA while that request is still live.
      if (activeOauthAttemptRef.current === attempt) {
        oauthCancelRequestedAttemptRef.current = null;
      }
    } finally {
      if (oauthCancelInFlightAttemptRef.current === attempt) {
        oauthCancelInFlightAttemptRef.current = null;
      }
    }
  }, []);

  const retrySecureStorage = useCallback(async (): Promise<void> => {
    if (storageRetrying || oauthPending || validating) return;
    setStorageRetrying(true);
    const retryAction = storageRetryActionRef.current;
    try {
      const next = await window.api.loadCanopyCloudAccount();
      if (
        !isConclusiveAccountRead(next) ||
        !next.storageAvailable ||
        next.secureStorageFailure
      ) {
        setSecureStorageFailure(
          next.secureStorageFailure ?? unavailableSecureStorageFailure('read'),
        );
        return;
      }
      const key = await window.api.loadCanopyCloudApiKey();
      applyLoadedAccount(next, key, true);
      storageRetryActionRef.current = null;
      setErrorMessage(null);
      if (retryAction) {
        if (retryAction === 'api_key') {
          const sequence = ++apiKeySaveSequence.current;
          if (latestApiKeyInputRef.current.trim()) {
            await saveApiKeyCandidate(latestApiKeyInputRef.current, sequence);
          } else {
            await clearSavedApiKey(sequence);
          }
        } else {
          await handleStartOAuthLogin();
        }
      } else {
        // A recovered read is not a new connection, but mounted account
        // consumers still need the conclusive snapshot. Preserve this editor.
        dispatchAccountChanged(true);
      }
    } catch {
      setErrorMessage('Couldn’t check secure storage. Try again.');
    } finally {
      setStorageRetrying(false);
    }
  }, [
    storageRetrying,
    oauthPending,
    validating,
    applyLoadedAccount,
    saveApiKeyCandidate,
    clearSavedApiKey,
    handleStartOAuthLogin,
    dispatchAccountChanged,
  ]);

  return {
    cloudName,
    account,
    accountInfo,
    loading,
    mode: cloudMode,
    setMode: handleCloudModeChange,
    apiKeyInput,
    handleApiKeyInputChange,
    apiKeyVisible,
    setApiKeyVisible,
    validating,
    oauthPending,
    disconnecting,
    accountUnreadable,
    repairing,
    errorMessage,
    successMessage,
    storageAvailable,
    secureStorageFailure,
    retrySecureStorage,
    storageRetrying,
    apiKeyConnected,
    oauthConnected,
    busy,
    statusGreen,
    connected,
    connectCompletionPending: pendingConnectSuccess !== null,
    handleStartOAuthLogin,
    handleCancelOAuthLogin,
    handleDisconnect,
    handleSubmitApiKey,
    resetUnreadableAccount,
  };
}

import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import type { McpServerIndexEntry } from '@canopy/execution-engine/types/mcp-servers';
import type { SecretValueInput } from '@canopy/execution-engine/types/stored-secrets';
import { reportClientAppError } from '@canopy/desktop-instrumentation/client';
import type { AccountMcpActions } from '@/hooks/useAccountMcpActions';
import { extractIpcErrorMessage } from '@/lib/errors';
import { AccountMcpCredentialDialog } from './AccountMcpControls';
import { McpPromoteDialog } from './McpPlacementDialogs';
import {
  CLOUD_REGISTRATION_UNAVAILABLE,
  loadSignedInAccountId,
  promoteCustomMcpServer,
  requireCapturedMcpAccount,
} from './mcpManagementOperations';

const SIGN_IN_REQUIRED = 'Sign in to connect account servers.';

interface PromotionPrompt {
  readonly kind: 'confirm' | 'token';
  readonly row: McpServerIndexEntry;
  readonly accountId: string;
}

export interface McpPromotion {
  /**
   * Accepts moving a custom row to the cloud account. The confirmation opens
   * once the signed-in account is known; a failure after this returned true
   * appears in {@link error}. False while another promotion is in progress.
   */
  readonly request: (row: McpServerIndexEntry) => boolean;
  readonly isPending: (rowId: string) => boolean;
  readonly dialogOpen: boolean;
  readonly tokenPromptOpen: boolean;
  readonly error: string | null;
  readonly errorFor: (rowId: string) => string | null;
  readonly clearError: () => void;
  /** Closes the dialogs and drops every capture and completion in progress. */
  readonly invalidate: () => void;
  /** The confirmation and token dialogs; render once. */
  readonly dialogs: JSX.Element;
}

/**
 * Moves a custom server to the cloud account under the account its credentials
 * were captured for: a sign-in change closes the dialogs, and nothing started
 * before it can reopen one or report into the new account's page.
 */
export function useMcpPromotion(
  actions: AccountMcpActions,
  refresh: () => Promise<void>,
): McpPromotion {
  const [prompt, setPrompt] = useState<PromotionPrompt | null>(null);
  const [failure, setFailure] = useState<{
    readonly rowId: string;
    readonly message: string;
  } | null>(null);
  const errorFor = useCallback(
    (rowId: string): string | null =>
      failure?.rowId === rowId ? failure.message : null,
    [failure],
  );
  const promptRef = useRef(prompt);
  promptRef.current = prompt;
  // The row being promoted, from acceptance until the flow ends. It guards the
  // whole sequence synchronously, ahead of the state above.
  const activeRowId = useRef<string | null>(null);
  const capturedAccountId = useRef<string | undefined>(undefined);
  const submitting = useRef(false);
  const generation = useRef(0);
  const identityRevision = useRef(0);

  const invalidate = useCallback((): void => {
    generation.current += 1;
    activeRowId.current = null;
    capturedAccountId.current = undefined;
    submitting.current = false;
    promptRef.current = null;
    setPrompt(null);
  }, []);

  useEffect(
    () => (): void => {
      generation.current += 1;
    },
    [],
  );

  // The bridge fires this for every account operation, so only a real change
  // of account closes a dialog.
  useEffect(
    (): (() => void) | undefined =>
      window.mcpServers?.onAuthChanged?.((): void => {
        const revision = ++identityRevision.current;
        if (activeRowId.current === null) return;
        const captured = capturedAccountId.current;
        // An unresolved capture revalidates this signal before opening. The
        // bridge also fires for unrelated operations under the same account.
        if (captured === undefined) return;
        const current = generation.current;
        void loadSignedInAccountId().then((accountId): void => {
          if (
            current === generation.current &&
            revision === identityRevision.current &&
            accountId !== captured
          )
            invalidate();
        });
      }),
    [invalidate],
  );

  const request = (row: McpServerIndexEntry): boolean => {
    if (activeRowId.current !== null) return false;
    activeRowId.current = row.id;
    const current = ++generation.current;
    let revision = identityRevision.current;
    setFailure(null);
    void (async (): Promise<void> => {
      const accountId = await loadSignedInAccountId();
      if (current !== generation.current) return;
      if (!accountId) {
        activeRowId.current = null;
        setFailure({ rowId: row.id, message: SIGN_IN_REQUIRED });
        return;
      }
      while (revision !== identityRevision.current) {
        revision = identityRevision.current;
        const signedIn = await loadSignedInAccountId();
        if (current !== generation.current) return;
        if (signedIn !== accountId) {
          invalidate();
          return;
        }
      }
      capturedAccountId.current = accountId;
      setPrompt({ kind: 'confirm', row, accountId });
    })();
    return true;
  };

  const submit = (bearerToken: SecretValueInput | undefined): void => {
    const open = promptRef.current;
    if (
      !open ||
      submitting.current ||
      activeRowId.current !== open.row.id ||
      capturedAccountId.current !== open.accountId
    )
      return;
    submitting.current = true;
    setPrompt(null);
    const { row, accountId } = open;
    const current = generation.current;
    let reprompting = false;
    void (async (): Promise<void> => {
      try {
        await requireCapturedMcpAccount(accountId);
        if (current !== generation.current) return;
        await promoteCustomMcpServer(
          row,
          {
            ...(bearerToken ? { bearerToken } : {}),
            expectedAccountId: accountId,
          },
          actions,
          (): void => {
            if (current !== generation.current) return;
            reprompting = true;
            void loadSignedInAccountId().then((signedIn): void => {
              if (current !== generation.current) return;
              if (signedIn === accountId) {
                setPrompt({ kind: 'token', row, accountId });
                return;
              }
              invalidate();
            });
          },
        );
        if (current === generation.current) await refresh();
      } catch (cause) {
        reportClientAppError(cause);
        if (current === generation.current)
          setFailure({ rowId: row.id, message: extractIpcErrorMessage(cause) });
      } finally {
        if (current === generation.current) {
          submitting.current = false;
          if (!reprompting) {
            activeRowId.current = null;
            capturedAccountId.current = undefined;
          }
        }
      }
    })();
  };

  return {
    request,
    isPending: (rowId): boolean => activeRowId.current === rowId,
    dialogOpen: prompt?.kind === 'confirm',
    tokenPromptOpen: prompt?.kind === 'token',
    error: failure?.message ?? null,
    errorFor,
    clearError: (): void => setFailure(null),
    invalidate,
    dialogs: (
      <>
        {prompt?.kind === 'confirm' && (
          <McpPromoteDialog
            key={prompt.row.id}
            serverId={prompt.row.id}
            serverName={prompt.row.name}
            onClose={invalidate}
            onConfirm={submit}
          />
        )}
        {prompt?.kind === 'token' && (
          <AccountMcpCredentialDialog
            key={`promote:${prompt.row.id}`}
            kind="bearer"
            intro={CLOUD_REGISTRATION_UNAVAILABLE}
            displayName={prompt.row.name}
            onSubmit={(credential): void => {
              if ('bearerToken' in credential) submit(credential.bearerToken);
            }}
            onClose={invalidate}
          />
        )}
      </>
    ),
  };
}

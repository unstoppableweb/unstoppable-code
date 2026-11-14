import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import { registerCursorSettingsAction } from '@/lib/cursor-settings-actions';
import {
  emitPreferencesUpdated,
  subscribePreferencesUpdated,
} from '@/lib/preferences-events';
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type JSX,
} from 'react';
import {
  CURSOR_APPROVAL_CHECK_PROJECT_ID,
  type ApprovalPromptDecision,
  type ApprovalRequestEvent,
  type CursorApprovalCheckResult,
} from '@canopy/desktop-shared/types';
import { Button } from '@canopy/ui-shared/components';
import {
  reportClientAppError,
  resolveClientAppError,
} from '@canopy/desktop-instrumentation/client';
import { toAppError } from '@canopy/protocol/app-errors';
import { DesktopErrorBanner } from '@/components/shared/DesktopErrorBanner';
import { inlineFailure, type InlineFailure } from '@/lib/inline-app-error';
import { ToolApprovalCard } from '@canopy/ui-shared/components';
import {
  SettingsGroup,
  SettingsRow,
  SettingsSection,
  SettingsTextField,
} from './SettingsLayout';

interface CursorApprovalCheckProps {
  collapsible?: boolean;
}

export function CursorApprovalCheck({
  collapsible = false,
}: CursorApprovalCheckProps): JSX.Element | null {
  const [expanded, setExpanded] = useState(false);
  const pathInputId = useId();
  const [available, setAvailable] = useState(false);
  const [savedPath, setSavedPath] = useState('');
  const [saving, setSaving] = useState(false);
  const [binaryPath, setBinaryPath] = useState('');
  const [requiredVersion, setRequiredVersion] = useState('');
  const [running, setRunning] = useState(false);
  const [pending, setPending] = useState<ApprovalRequestEvent | null>(null);
  const [result, setResult] = useState<CursorApprovalCheckResult | null>(null);
  const [error, setError] = useState<InlineFailure | null>(null);
  const active = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    void window.api
      .loadPreferences()
      .then((preferences) => {
        if (mounted.current && preferences.cursorAgentPath) {
          setBinaryPath(preferences.cursorAgentPath);
          setSavedPath(preferences.cursorAgentPath);
        }
      })
      .catch((caught: unknown) => {
        reportClientAppError(caught);
      });
    // Connect and Disconnect clear the saved path from the sibling panel; keep
    // both path states in step so a cleared path cannot be run from here.
    const offPreferences = subscribePreferencesUpdated((preferences) => {
      if (!mounted.current) return;
      const next = preferences.cursorAgentPath ?? '';
      setSavedPath(next);
      setBinaryPath(next);
    });
    // The pinned CLI version is owned by the managed-runtime status so the
    // copy below cannot drift from what the check enforces.
    void window.api.cursorConnection
      ?.status()
      .then((status) => {
        if (mounted.current) setRequiredVersion(status.version);
      })
      .catch((caught: unknown) => {
        reportClientAppError(caught);
      });
    const api = window.api.cursorApprovalCheck;
    if (!api)
      return (): void => {
        mounted.current = false;
        offPreferences();
      };
    void api
      ?.available()
      .then((value) => {
        if (mounted.current) setAvailable(value);
      })
      .catch((caught: unknown) => {
        reportClientAppError(caught);
      });
    const offRequest = window.api.approvals.onRequest((event) => {
      if (
        active.current &&
        event.surface === 'non-chat' &&
        event.provider === 'cursor' &&
        event.projectId === CURSOR_APPROVAL_CHECK_PROJECT_ID
      )
        setPending(event);
    });
    const offCancelled = window.api.approvals.onCancelled((event) => {
      setPending((current) =>
        current?.requestId === event.requestId ? null : current,
      );
    });
    return (): void => {
      mounted.current = false;
      offPreferences();
      offRequest();
      offCancelled();
      if (active.current)
        void api?.cancel().catch((caught: unknown) => {
          reportClientAppError(caught);
        });
    };
  }, []);

  const run = useCallback(async (): Promise<void> => {
    const api = window.api.cursorApprovalCheck;
    if (!api || active.current) return;
    active.current = true;
    setRunning(true);
    setResult(null);
    setError(null);
    setPending(null);
    try {
      const next = await api.run(binaryPath.trim());
      if (mounted.current) setResult(next);
    } catch (caught) {
      const appError = toAppError(resolveClientAppError(caught));
      if (appError && mounted.current)
        setError(
          inlineFailure(
            appError,
            "Couldn't start the Cursor check. Check the executable path.",
          ),
        );
    } finally {
      active.current = false;
      if (mounted.current) {
        setRunning(false);
        setPending(null);
      }
    }
  }, [binaryPath]);

  const respond = useCallback(
    async (
      requestId: string,
      decision: ApprovalPromptDecision,
    ): Promise<void> => {
      if (!pending || requestId !== pending.requestId) return;
      try {
        const accepted = await window.api.approvals.respond({
          requestId,
          projectId: pending.projectId,
          worktreeId: pending.worktreeId,
          chatId: pending.chatId,
          decision,
          ...(pending.policyRevision !== undefined
            ? { policyRevision: pending.policyRevision }
            : {}),
        });
        if (!accepted) {
          // A refused allow may be stale: keep the card while it is pending.
          const live = (await window.api.approvals.pendingRequests()).find(
            (event) => event.requestId === requestId,
          );
          if (live) {
            setPending((current) =>
              current?.requestId === requestId &&
              (current.policyRevision ?? -1) <= (live.policyRevision ?? -1)
                ? live
                : current,
            );
            return;
          }
          setError({ error: 'This approval is no longer pending.' });
        }
        setPending(null);
        if (decision.stopTurn) await window.api.cursorApprovalCheck?.cancel();
      } catch (caught) {
        const appError = toAppError(resolveClientAppError(caught));
        if (appError)
          setError(
            inlineFailure(
              appError,
              "Couldn't send the approval decision. Try again or press Stop.",
            ),
          );
      }
    },
    [pending],
  );

  const stop = useCallback(async (): Promise<void> => {
    try {
      await window.api.cursorApprovalCheck?.cancel();
    } catch (caught) {
      const appError = toAppError(resolveClientAppError(caught));
      if (appError)
        setError(
          inlineFailure(
            appError,
            "Couldn't stop the check. Close this window to end it.",
          ),
        );
    }
  }, []);

  const saveDiagnosticPath = async (): Promise<void> => {
    setSaving(true);
    setError(null);
    try {
      const preferences = await window.api.savePreferences({
        cursorAgentPath: binaryPath.trim(),
      });
      emitPreferencesUpdated(preferences);
      if (mounted.current) setSavedPath(preferences.cursorAgentPath ?? '');
    } catch (caught) {
      const appError = toAppError(resolveClientAppError(caught));
      if (appError && mounted.current)
        setError(inlineFailure(appError, "Couldn't save the diagnostic path."));
    } finally {
      if (mounted.current) setSaving(false);
    }
  };

  useCurrentUiStateReporter('settings.cursorApprovalCheck', {
    available,
    configured: Boolean(binaryPath.trim()),
    running,
    awaitingApproval: pending !== null,
    outcome: result?.outcome ?? null,
    errorVisible: error !== null,
  });
  const actionHandler = useRef<(operation: string) => boolean>(() => false);
  actionHandler.current = (operation): boolean => {
    if (!available) return false;
    if (operation === 'stop' && active.current) {
      void stop();
      return true;
    }
    if (operation === 'run' && !active.current && binaryPath.trim()) {
      void run();
      return true;
    }
    return false;
  };
  useEffect(() => {
    if (!available) return;
    return registerCursorSettingsAction(
      'cursor.approval_check',
      (operation) => {
        const accepted = actionHandler.current(operation);
        if (accepted) setExpanded(true);
        return accepted;
      },
    );
  }, [available]);
  if (!available) return null;
  const filePath =
    pending?.details.kind === 'file-write'
      ? pending.details.path
      : result?.filePath;
  const status = running
    ? pending
      ? 'Waiting for your decision.'
      : 'Running Cursor check…'
    : result?.outcome === 'allowed'
      ? 'File created after approval.'
      : result?.outcome === 'denied'
        ? 'Edit rejected. No file created.'
        : result?.outcome === 'cancelled'
          ? 'Stopped. No file created.'
          : result?.outcome === 'error'
            ? result.message
            : 'Ready to test.';

  const description =
    'A local development check that asks Cursor to create one file in a temporary folder. It can use your Cursor account credits.';
  const errorNotice = (
    <DesktopErrorBanner
      errorSource="cursor-approval-check-error"
      className=""
      error={error?.error}
      {...(error?.details === undefined ? {} : { details: error.details })}
      onDismiss={(): void => setError(null)}
      testId="cursor-approval-check-error"
    />
  );
  // The check's rows. Experiments shows them in the section's group;
  // Accounts keeps them behind the group's Show row.
  const checkRows = (
    <>
      <SettingsRow
        label="Cursor executable"
        htmlFor={pathInputId}
        description={`Requires Cursor CLI ${requiredVersion || 'at the pinned version'}. Used only for approval checks; connect Cursor to use Cursor chat.`}
        control={
          <SettingsTextField
            id={pathInputId}
            width="md"
            value={binaryPath}
            disabled={running}
            onChange={(event): void => setBinaryPath(event.target.value)}
            placeholder="/absolute/path/to/cursor-agent"
          />
        }
      />
      <SettingsRow
        label="Saved path"
        description={
          <span role="status" data-testid="cursor-diagnostic-path-status">
            {savedPath && binaryPath.trim() === savedPath
              ? 'Diagnostic path saved.'
              : 'Save this path to reuse it for approval checks.'}
          </span>
        }
        control={
          <Button
            size="compact"
            variant="secondary"
            disabled={running || saving || binaryPath.trim() === savedPath}
            onClick={(): void => {
              void saveDiagnosticPath();
            }}
          >
            Save diagnostic path
          </Button>
        }
      />
      <SettingsRow
        label="Approval check"
        description={
          <span role="status" data-testid="cursor-check-status">
            {status}
          </span>
        }
        control={
          <>
            {running && (
              <Button
                size="compact"
                variant="secondary"
                onClick={(): void => {
                  void stop();
                }}
              >
                Stop
              </Button>
            )}
            <Button
              size="compact"
              disabled={running || !binaryPath.trim()}
              onClick={(): void => {
                void run();
              }}
            >
              Test Cursor approvals
            </Button>
          </>
        }
      >
        {filePath && (
          <code
            className="block break-all font-mono text-xs fg-secondary"
            data-testid="cursor-check-path"
          >
            {filePath}
          </code>
        )}
        {pending && <ToolApprovalCard pending={pending} onRespond={respond} />}
      </SettingsRow>
    </>
  );
  // Either way this is a page section with its own group, returned whole so
  // it can sit directly in a grouped page. Accounts keeps the check collapsed
  // behind a Show row, the group's first row, so no control floats beside
  // the heading; Experiments shows it.
  if (collapsible) {
    return (
      <SettingsSection
        title="Cursor diagnostics"
        description={description}
        dataTestId="cursor-diagnostics"
      >
        {expanded && errorNotice}
        <SettingsGroup
          // The check's test id marks its rows, which exist only while shown.
          dataTestId={expanded ? 'cursor-approval-check' : undefined}
        >
          <SettingsRow
            label="Approval diagnostics"
            description="Set the Cursor executable and run the check."
            control={
              <Button
                size="compact"
                variant="secondary"
                aria-expanded={expanded}
                onClick={(): void => setExpanded((open) => !open)}
              >
                {expanded ? 'Hide' : 'Show'}
              </Button>
            }
          />
          {expanded && checkRows}
        </SettingsGroup>
      </SettingsSection>
    );
  }
  return (
    <SettingsSection
      title="Cursor approval check"
      description={description}
      dataTestId="cursor-approval-check"
    >
      {errorNotice}
      <SettingsGroup>{checkRows}</SettingsGroup>
    </SettingsSection>
  );
}

'use client';

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from 'react';
import type { ShortcutPlatform } from '@canopy/protocol/shortcuts';
import type {
  ScriptAction,
  ScriptActionsReviewRequest,
  ScriptActionsSnapshot,
} from '@canopy/protocol/script-actions';
import { useScriptActions } from '@canopy/app-state/script-actions';
import {
  Stack,
  Button,
  Checkbox,
  DelayedLoadingPlaceholder,
  Disclosure,
  ErrorBanner,
  LoadingSpinner,
  Notice,
  SettingsRowsSubRow,
  ToggleSwitch,
  EmptyStateRow,
  StatusLabel,
  Heading,
  Skeleton,
} from '@canopy/ui-shared/components';
import {
  REPLAY_BLOCK_CLASS,
  REPLAY_MASK_CLASS,
} from '@canopy/ui-shared/lib/replay-privacy';
import {
  aliasCountLabel,
  errorMessage,
  groupScriptActions,
  isStaleRevisionError,
  reconcileScriptSelection,
  scriptCountLabel,
  scriptSourceLabel,
  selectAllState,
  splitScriptReviewBatches,
  toggleScriptSelection,
  type RepositoryNameResolver,
  type ScriptReviewBatch,
  type ScriptReviewSelection,
} from './review-model';
import { SelectionCheckbox } from './SelectionCheckbox';
import { ShortcutRecorderField } from './ShortcutRecorderField';
import {
  validateScriptActionShortcut,
  type ReservedScriptShortcut,
} from './shortcut-validation';
import { Surface } from '@canopy/ui-shared/components';

/** Host-supplied, platform-dependent parts of the review. */
export interface ScriptActionsReviewHostProps {
  /** Platform whose keys the shortcut recorder reads and displays. */
  readonly shortcutPlatform: ShortcutPlatform;
  /**
   * Platforms a shortcut must be valid on. Defaults to `shortcutPlatform`.
   * A host that cannot tell which desktop executes the shortcut passes every
   * platform so validation is the strictest union.
   */
  readonly shortcutValidationPlatforms?: readonly ShortcutPlatform[];
  /** Host chords beyond the shared desktop command table. */
  readonly reservedShortcuts?: readonly ReservedScriptShortcut[];
  /** Explains where shortcut and pin preferences apply, when not here. */
  readonly preferencesNote?: string;
  /** Host display names for a project's repository IDs. */
  readonly resolveRepositoryName?: (
    projectId: string,
    repoId: string,
  ) => string | undefined;
}

export interface ScriptActionsReviewProps extends ScriptActionsReviewHostProps {
  readonly projectId: string;
  readonly worktreeId: string;
  /** `dialog` scrolls the body and pins the review actions to the bottom. */
  readonly layout?: 'inline' | 'dialog';
  /** Opening the review dialog asks for a fresh scan. */
  readonly rescanOnMount?: boolean;
}

type Decision = ScriptActionsReviewRequest['decision'];

interface Feedback {
  readonly tone: 'success' | 'error';
  readonly message: string;
}

const EMPTY_ACTIONS: readonly ScriptAction[] = [];
const STALE_MESSAGE =
  'Some scripts changed since you selected them. Review them and select again.';

const DIAGNOSTIC_LABELS: Record<
  ScriptActionsSnapshot['diagnostics'][number]['code'],
  string
> = {
  unreadable: "Couldn't be read",
  malformed: "Couldn't be parsed",
  truncated: 'Too large; only part was scanned',
  unsupported: 'Not supported',
  'outside-root': 'Points outside the repository',
};

function sameSelection(
  left: ScriptReviewSelection,
  right: ScriptReviewSelection,
): boolean {
  if (left.size !== right.size) return false;
  for (const [id, revision] of left)
    if (right.get(id) !== revision) return false;
  return true;
}

function batchLabel(batch: ScriptReviewBatch): string {
  return batch.store === 'alias'
    ? aliasCountLabel(batch.entries.length)
    : scriptCountLabel(batch.entries.length);
}

const DECISION_COPY: Record<
  Exclude<Decision, 'reset'>,
  { readonly done: string; readonly verb: string }
> = {
  approve: { done: 'Approved', verb: 'approve' },
  dismiss: { done: 'Dismissed', verb: 'dismiss' },
};

/**
 * Review for repository scripts and personal shell aliases (CAN-2050):
 * approve or dismiss detected entries, edit shortcut and pin preferences for
 * approved ones, restore dismissed ones, and opt in to shell alias scanning.
 * Hosts supply state through `useScriptActions` and gate it with
 * `CanopyCapabilities.scriptActions`; without it the review renders a notice
 * and makes no client calls.
 */
export function ScriptActionsReview(
  props: ScriptActionsReviewProps,
): JSX.Element {
  // A new target starts with a clean selection and fresh row state.
  return (
    <ScriptActionsReviewBody
      key={JSON.stringify([props.projectId, props.worktreeId])}
      {...props}
    />
  );
}

function ScriptActionsReviewBody({
  projectId,
  worktreeId,
  layout = 'inline',
  rescanOnMount = false,
  shortcutPlatform,
  shortcutValidationPlatforms,
  reservedShortcuts,
  preferencesNote,
  resolveRepositoryName,
}: ScriptActionsReviewProps): JSX.Element {
  const scripts = useScriptActions({
    projectId,
    worktreeId,
    includeDismissed: true,
  });
  const { snapshot, supported } = scripts;
  const actions = snapshot?.actions ?? EMPTY_ACTIONS;
  const pending = useMemo(
    () => actions.filter((action) => action.status === 'pending'),
    [actions],
  );
  const approved = useMemo(
    () => actions.filter((action) => action.status === 'approved'),
    [actions],
  );
  const dismissed = useMemo(
    () => actions.filter((action) => action.status === 'dismissed'),
    [actions],
  );
  const resolveRepository = useMemo<RepositoryNameResolver | undefined>(
    () =>
      resolveRepositoryName
        ? (repoId): string | undefined =>
            resolveRepositoryName(projectId, repoId)
        : undefined,
    [projectId, resolveRepositoryName],
  );
  const pendingGroups = useMemo(
    () => groupScriptActions(pending, resolveRepository),
    [pending, resolveRepository],
  );
  const approvedGroups = useMemo(
    () => groupScriptActions(approved, resolveRepository),
    [approved, resolveRepository],
  );

  const [selectionState, setSelection] = useState<ScriptReviewSelection>(
    () => new Map(),
  );
  // Every snapshot change drops selections whose row vanished or changed. The
  // render-time pass keeps a stale row out before the effect lands.
  useEffect(() => {
    setSelection((previous) => {
      const next = reconcileScriptSelection(previous, pending);
      return sameSelection(previous, next) ? previous : next;
    });
  }, [pending]);
  const selection = useMemo(
    () => reconcileScriptSelection(selectionState, pending),
    [selectionState, pending],
  );

  const [saving, setSaving] = useState<Exclude<Decision, 'reset'> | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [rescanning, setRescanning] = useState(false);
  const [rowBusy, setRowBusy] = useState<Readonly<Record<string, boolean>>>({});
  const [rowErrors, setRowErrors] = useState<Readonly<Record<string, string>>>(
    {},
  );
  const [showDismissed, setShowDismissed] = useState(false);
  const [aliasState, setAliasState] = useState<{
    readonly busy: boolean;
    readonly error: string | null;
  }>({ busy: false, error: null });
  const aliasHeadingId = useId();
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return (): void => {
      mounted.current = false;
    };
  }, []);

  const { rescan, refresh, review } = scripts;
  const runRescan = useCallback((): void => {
    setRescanning(true);
    void rescan().finally(() => {
      if (mounted.current) setRescanning(false);
    });
  }, [rescan]);

  const rescanRequested = useRef(false);
  useEffect(() => {
    if (!rescanOnMount || !supported || rescanRequested.current) return;
    rescanRequested.current = true;
    runRescan();
  }, [rescanOnMount, runRescan, supported]);

  const submit = async (
    decision: Exclude<Decision, 'reset'>,
  ): Promise<void> => {
    const batches = splitScriptReviewBatches(selection, pending);
    if (batches.length === 0 || saving !== null) return;
    setSaving(decision);
    setFeedback(null);
    const copy = DECISION_COPY[decision];
    const messages: string[] = [];
    let failed = false;
    let stale = false;
    for (const batch of batches) {
      try {
        await review([...batch.entries], decision);
        messages.push(`${copy.done} ${batchLabel(batch)}.`);
        setSelection((previous) => {
          const next = new Map(previous);
          for (const entry of batch.entries) next.delete(entry.id);
          return next;
        });
      } catch (error: unknown) {
        failed = true;
        if (isStaleRevisionError(error)) stale = true;
        else
          messages.push(
            `Couldn't ${copy.verb} ${batchLabel(batch)}. ${errorMessage(error, 'Try again.')}`,
          );
      }
    }
    if (stale) {
      messages.push(STALE_MESSAGE);
      await refresh();
    }
    if (!mounted.current) return;
    setSaving(null);
    setFeedback({
      tone: failed ? 'error' : 'success',
      message: messages.join(' '),
    });
  };

  const runRowWrite = (
    id: string,
    write: () => Promise<unknown>,
    fallback: string,
  ): void => {
    setRowBusy((previous) => ({ ...previous, [id]: true }));
    setRowErrors((previous) => {
      const next = { ...previous };
      delete next[id];
      return next;
    });
    write()
      .catch(async (error: unknown) => {
        const stale = isStaleRevisionError(error);
        if (stale) await refresh();
        if (!mounted.current) return;
        setRowErrors((previous) => ({
          ...previous,
          [id]: stale
            ? 'This script changed. Review it again.'
            : errorMessage(error, fallback),
        }));
      })
      .finally(() => {
        if (!mounted.current) return;
        setRowBusy((previous) => {
          const next = { ...previous };
          delete next[id];
          return next;
        });
      });
  };

  const reset = (action: ScriptAction, fallback: string): void =>
    runRowWrite(
      action.id,
      () => review([{ id: action.id, revision: action.revision }], 'reset'),
      fallback,
    );

  const enableAliases = (): void => {
    setAliasState({ busy: true, error: null });
    scripts
      .enableShellAliasScan()
      .then(() => {
        if (mounted.current) setAliasState({ busy: false, error: null });
      })
      .catch((error: unknown) => {
        if (mounted.current)
          setAliasState({
            busy: false,
            error: errorMessage(
              error,
              "Couldn't scan your shell configuration. Try again.",
            ),
          });
      });
  };

  const executingPlatform =
    snapshot?.shortcutContext?.platform ?? shortcutPlatform;
  const validationPlatforms = snapshot?.shortcutContext
    ? [executingPlatform]
    : (shortcutValidationPlatforms ?? [shortcutPlatform]);
  const executingReservations =
    snapshot?.shortcutContext?.reserved ?? reservedShortcuts;
  const validateShortcut =
    (action: ScriptAction) =>
    (accelerator: string): string | null => {
      const result = validateScriptActionShortcut({
        accelerator,
        actionId: action.id,
        actions,
        platforms: validationPlatforms,
        reserved: executingReservations,
      });
      return result.ok ? null : result.message;
    };

  if (!supported)
    return (
      <Notice intent="neutral" data-testid="script-actions-review-unsupported">
        Script review isn&apos;t available for this project.
      </Notice>
    );

  const header = (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <Stack gap="tight" className="min-w-0 flex-1">
        {layout === 'inline' ? (
          <Heading level={3} variant="title">
            Detected scripts
          </Heading>
        ) : null}
        <p className="text-xs fg-secondary">
          Scripts found in this worktree and your personal aliases. Only
          approved scripts can run, and they run in a terminal, never through
          the agent.
        </p>
      </Stack>
      <Button
        size="compact"
        variant="secondary"
        disabled={rescanning}
        onClick={runRescan}
        data-testid="script-actions-rescan"
      >
        {rescanning ? <LoadingSpinner decorative /> : null}
        {rescanning ? 'Rescanning…' : 'Rescan'}
      </Button>
    </div>
  );

  const loadError = scripts.error;
  let body: ReactNode;
  if (snapshot === null) {
    body =
      scripts.status === 'error' ? (
        <ErrorBanner
          errorSource="script-actions-review-body-load"
          className=""
          error={loadError ?? "Couldn't load scripts."}
          onRetry={(): void => {
            void refresh();
          }}
        />
      ) : (
        <DelayedLoadingPlaceholder slowNote="Still loading scripts…">
          <Skeleton
            loading
            label="Loading scripts"
            testId="script-actions-loading"
          >
            <PendingSection
              groups={SAMPLE_GROUPS}
              pending={SAMPLE_PENDING}
              selection={EMPTY_SELECTION}
              disabled={false}
              onSelectionChange={noop}
              renderPreferences={(): null => null}
            />
          </Skeleton>
        </DelayedLoadingPlaceholder>
      );
  } else {
    body = (
      <>
        {loadError !== null ? (
          <div data-testid="script-actions-scan-error">
            <ErrorBanner
              errorSource="script-actions-load-review"
              className=""
              error={`${loadError} Showing the last results.`}
              onRetry={runRescan}
              retryLabel="Rescan"
            />
          </div>
        ) : null}
        <ScanStatusLine snapshot={snapshot} />
        {preferencesNote ? (
          <Notice
            intent="neutral"
            data-testid="script-actions-preferences-note"
          >
            {preferencesNote}
          </Notice>
        ) : null}
        <PendingSection
          groups={pendingGroups}
          pending={pending}
          selection={selection}
          disabled={saving !== null}
          onSelectionChange={setSelection}
          renderPreferences={(action) => (
            <div className="flex shrink-0 flex-col items-end gap-2">
              {action.shortcut ? (
                <Button
                  size="compact"
                  variant="secondary"
                  disabled={rowBusy[action.id] || saving !== null}
                  data-testid="script-actions-clear-shortcut"
                  onClick={() =>
                    runRowWrite(
                      action.id,
                      () => scripts.setShortcut(action.id, null),
                      "Couldn't clear the shortcut.",
                    )
                  }
                >
                  Clear shortcut
                </Button>
              ) : null}
              {action.pinned ? (
                <Button
                  size="compact"
                  variant="secondary"
                  disabled={rowBusy[action.id] || saving !== null}
                  data-testid="script-actions-clear-pin"
                  onClick={() =>
                    runRowWrite(
                      action.id,
                      () => scripts.setPinned(action.id, false),
                      "Couldn't clear the pin.",
                    )
                  }
                >
                  Unpin
                </Button>
              ) : null}
              {rowErrors[action.id] ? (
                <ErrorBanner
                  errorSource="script-action-apply-review"
                  className=""
                  error={rowErrors[action.id]}
                />
              ) : null}
            </div>
          )}
        />
        <ApprovedSection
          groups={approvedGroups}
          busy={rowBusy}
          errors={rowErrors}
          shortcutPlatform={executingPlatform}
          validateShortcut={validateShortcut}
          onSaveShortcut={async (action, accelerator): Promise<void> => {
            await scripts.setShortcut(action.id, accelerator);
          }}
          onPin={(action, pinned): void =>
            runRowWrite(
              action.id,
              () => scripts.setPinned(action.id, pinned),
              "Couldn't save the pin. Try again.",
            )
          }
          onRemove={(action): void =>
            reset(action, "Couldn't move the script back to review.")
          }
        />
        {!snapshot.shellAliasScanEnabled ? (
          <Surface
            gap="inline"
            as="section"
            variant="outline"
            padding="compact"
            data-testid="script-actions-alias-opt-in"
            aria-labelledby={aliasHeadingId}
          >
            <div className="flex flex-col gap-2">
              <Heading level={4} variant="title" id={aliasHeadingId}>
                Personal shell aliases
              </Heading>
              <p className="text-xs fg-secondary">
                Find aliases in your shell configuration, such as ~/.zshrc and
                ~/.bashrc. Files are read, never run, and each alias still needs
                your approval. Rescans include them from then on.
              </p>
              <ErrorBanner
                errorSource="script-actions-review-body-alias"
                className=""
                error={aliasState.error}
              />
              <Button
                className="self-start"
                size="compact"
                variant="secondary"
                disabled={aliasState.busy}
                onClick={enableAliases}
                data-testid="script-actions-scan-shell"
              >
                {aliasState.busy ? <LoadingSpinner decorative /> : null}
                Scan shell configuration
              </Button>
            </div>
          </Surface>
        ) : null}
        {dismissed.length > 0 ? (
          <DismissedSection
            actions={dismissed}
            expanded={showDismissed}
            busy={rowBusy}
            errors={rowErrors}
            onToggle={(): void => setShowDismissed((value) => !value)}
            onRestore={(action): void =>
              reset(action, "Couldn't restore the script.")
            }
          />
        ) : null}
      </>
    );
  }

  const footer =
    snapshot !== null && pending.length > 0 ? (
      <ReviewFooter
        selectedCount={selection.size}
        saving={saving}
        feedback={feedback}
        onApprove={(): void => {
          void submit('approve');
        }}
        onDismiss={(): void => {
          void submit('dismiss');
        }}
      />
    ) : feedback !== null ? (
      <FeedbackLine feedback={feedback} />
    ) : null;

  if (layout === 'dialog')
    return (
      <div
        className="flex min-h-0 flex-1 flex-col"
        data-testid="script-actions-review"
      >
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-6 grid grid-cols-1 content-start gap-4">
          {header}
          {body}
        </div>
        {footer ? (
          <Surface variant="section" boundary="top" padding="dialog-footer">
            {footer}
          </Surface>
        ) : null}
      </div>
    );

  return (
    <Stack as="section" gap="group" data-testid="script-actions-review">
      {header}
      {body}
      {footer}
    </Stack>
  );
}

function sampleScript(id: string, name: string, command: string): ScriptAction {
  return {
    id,
    kind: 'detected',
    name,
    command,
    multiline: false,
    repoId: null,
    repoName: null,
    packagePath: null,
    target: { kind: 'workspace-root' },
    source: {
      kind: 'package-json',
      file: 'package.json',
      entry: name,
      line: null,
    },
    revision: '1',
    status: 'pending',
    shortcut: null,
    pinned: false,
  };
}

/** Plain scripts the loading skeleton measures, under Needs review. */
const SAMPLE_PENDING: readonly ScriptAction[] = [
  sampleScript('script-actions-skeleton-1', 'test', 'pnpm test'),
  sampleScript('script-actions-skeleton-2', 'build', 'pnpm build'),
];
const SAMPLE_GROUPS = groupScriptActions(SAMPLE_PENDING);
const EMPTY_SELECTION: ScriptReviewSelection = new Map();

const noop = (): void => undefined;

function ScanStatusLine({
  snapshot,
}: {
  readonly snapshot: ScriptActionsSnapshot;
}): JSX.Element | null {
  const message =
    snapshot.scanStatus === 'scanning'
      ? 'Scanning…'
      : snapshot.scanStatus === 'failed'
        ? "The last scan didn't finish. Showing earlier results."
        : snapshot.scanStatus === 'incomplete'
          ? "Some files couldn't be scanned."
          : null;
  if (message === null && snapshot.diagnostics.length === 0) return null;
  return (
    <Stack gap="tight" data-testid="script-actions-scan-status">
      {message !== null ? (
        <p className="text-xs fg-secondary" role="status">
          {message}
        </p>
      ) : null}
      {snapshot.diagnostics.length > 0 ? (
        <Disclosure
          label={
            snapshot.diagnostics.length === 1
              ? '1 file skipped'
              : `${snapshot.diagnostics.length} files skipped`
          }
          dataTestId="script-actions-skipped-files"
        >
          <ul className="text-xs fg-tertiary flex flex-col gap-0.5">
            {snapshot.diagnostics.map((diagnostic, index) => (
              <li
                key={`${diagnostic.source}:${index}`}
                className="flex flex-wrap gap-2"
              >
                <code className={`font-mono ${REPLAY_BLOCK_CLASS}`}>
                  {diagnostic.source}
                </code>
                <span>{DIAGNOSTIC_LABELS[diagnostic.code]}</span>
              </li>
            ))}
          </ul>
        </Disclosure>
      ) : null}
    </Stack>
  );
}

function ScriptDetails({
  action,
  nameId,
  commandId,
}: {
  readonly action: ScriptAction;
  readonly nameId?: string;
  readonly commandId?: string;
}): JSX.Element {
  return (
    <Stack gap="tight" className="min-w-0 flex-1">
      <p className="flex flex-wrap items-baseline gap-x-2 text-s">
        <span
          id={nameId}
          className={`font-medium fg-primary ${REPLAY_MASK_CLASS}`}
        >
          {action.name}
        </span>
        {action.kind === 'tracked' ? (
          <span className="text-xs fg-tertiary">From project settings</span>
        ) : null}
      </p>
      <Surface variant="group" size="small" className="overflow-hidden">
        <pre
          id={commandId}
          className={`max-h-24 overflow-auto whitespace-pre-wrap break-all px-2 py-1 font-mono text-xs fg-secondary ${REPLAY_BLOCK_CLASS}`}
          data-testid="script-actions-command"
        >
          {action.command}
        </pre>
      </Surface>
      <p className={`text-xs fg-tertiary ${REPLAY_BLOCK_CLASS}`}>
        {scriptSourceLabel(action)}
      </p>
    </Stack>
  );
}

function PendingSection({
  groups,
  pending,
  selection,
  disabled,
  onSelectionChange,
  renderPreferences,
}: {
  readonly groups: ReturnType<typeof groupScriptActions>;
  readonly pending: readonly ScriptAction[];
  readonly selection: ScriptReviewSelection;
  readonly disabled: boolean;
  readonly onSelectionChange: (next: ScriptReviewSelection) => void;
  readonly renderPreferences: (action: ScriptAction) => ReactNode;
}): JSX.Element {
  const headingId = useId();
  return (
    <Stack
      as="section"
      gap="inline"
      aria-labelledby={headingId}
      data-testid="script-actions-pending"
    >
      <div className="flex items-center gap-3">
        {pending.length > 0 ? (
          <SelectionCheckbox
            state={selectAllState(selection, pending)}
            label="Select all scripts that need review"
            disabled={disabled}
            onToggle={(): void =>
              onSelectionChange(toggleScriptSelection(selection, pending))
            }
            testId="script-actions-select-all"
          />
        ) : null}
        <Heading level={4} variant="title" id={headingId}>
          Needs review
          {pending.length > 0 ? (
            <span className="ml-1 fg-tertiary">{pending.length}</span>
          ) : null}
        </Heading>
      </div>
      {pending.length === 0 ? (
        <p
          className="text-xs fg-tertiary"
          data-testid="script-actions-pending-empty"
        >
          Nothing needs review.
        </p>
      ) : (
        groups.map((group) => (
          <PendingGroup
            key={group.key}
            group={group}
            selection={selection}
            disabled={disabled}
            onSelectionChange={onSelectionChange}
            renderPreferences={renderPreferences}
          />
        ))
      )}
    </Stack>
  );
}

function PendingGroup({
  group,
  selection,
  disabled,
  onSelectionChange,
  renderPreferences,
}: {
  readonly group: ReturnType<typeof groupScriptActions>[number];
  readonly selection: ScriptReviewSelection;
  readonly disabled: boolean;
  readonly onSelectionChange: (next: ScriptReviewSelection) => void;
  readonly renderPreferences: (action: ScriptAction) => ReactNode;
}): JSX.Element {
  const labelId = useId();
  return (
    <Stack
      gap="tight"
      role="group"
      aria-labelledby={labelId}
      data-testid="script-actions-group"
    >
      <div className="flex items-center gap-3 pl-3">
        <SelectionCheckbox
          state={selectAllState(selection, group.actions)}
          label={`Select all in ${group.label}`}
          disabled={disabled}
          onToggle={(): void =>
            onSelectionChange(toggleScriptSelection(selection, group.actions))
          }
          testId="script-actions-group-select"
        />
        <span
          id={labelId}
          className={`text-xs font-medium fg-tertiary ${REPLAY_MASK_CLASS}`}
        >
          {group.label}
        </span>
      </div>
      <Surface variant="outline">
        <ul className="divide-y">
          {group.actions.map((action) => (
            <PendingRow
              key={action.id}
              action={action}
              preferences={renderPreferences(action)}
              checked={selection.get(action.id) === action.revision}
              disabled={disabled}
              onToggle={(): void => {
                const next = new Map(selection);
                if (next.get(action.id) === action.revision)
                  next.delete(action.id);
                else next.set(action.id, action.revision);
                onSelectionChange(next);
              }}
            />
          ))}
        </ul>
      </Surface>
    </Stack>
  );
}

function PendingRow({
  action,
  checked,
  disabled,
  onToggle,
  preferences,
}: {
  readonly action: ScriptAction;
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly onToggle: () => void;
  readonly preferences: ReactNode;
}): JSX.Element {
  const nameId = useId();
  const commandId = useId();
  return (
    <li
      className="flex items-start gap-3 p-3"
      data-testid="script-actions-pending-row"
      data-script-name={action.name}
    >
      <Checkbox
        className="mt-0.5"
        checked={checked}
        disabled={disabled}
        aria-labelledby={nameId}
        aria-describedby={commandId}
        onChange={onToggle}
        data-testid="script-actions-row-select"
      />
      <ScriptDetails action={action} nameId={nameId} commandId={commandId} />
      {preferences}
    </li>
  );
}

function ApprovedSection({
  groups,
  busy,
  errors,
  shortcutPlatform,
  validateShortcut,
  onSaveShortcut,
  onPin,
  onRemove,
}: {
  readonly groups: ReturnType<typeof groupScriptActions>;
  readonly busy: Readonly<Record<string, boolean>>;
  readonly errors: Readonly<Record<string, string>>;
  readonly shortcutPlatform: ShortcutPlatform;
  readonly validateShortcut: (
    action: ScriptAction,
  ) => (accelerator: string) => string | null;
  readonly onSaveShortcut: (
    action: ScriptAction,
    accelerator: string | null,
  ) => Promise<void>;
  readonly onPin: (action: ScriptAction, pinned: boolean) => void;
  readonly onRemove: (action: ScriptAction) => void;
}): JSX.Element {
  const headingId = useId();
  const count = groups.reduce(
    (total, group) => total + group.actions.length,
    0,
  );
  return (
    <Stack
      as="section"
      gap="inline"
      aria-labelledby={headingId}
      data-testid="script-actions-approved"
    >
      <Heading level={4} variant="title" id={headingId}>
        Approved
        {count > 0 ? <span className="ml-1 fg-tertiary">{count}</span> : null}
      </Heading>
      {count === 0 ? (
        <EmptyStateRow
          testId="script-actions-approved-empty"
          title="No approved scripts yet."
        />
      ) : (
        groups.map((group, groupIndex) => (
          <Stack gap="tight" key={group.key}>
            <p
              className={`pl-3 text-xs font-medium fg-tertiary ${REPLAY_MASK_CLASS}`}
            >
              {group.label}
            </p>
            <Surface variant="outline">
              <ul className="divide-y">
                {group.actions.map((action, index) => (
                  <li
                    key={action.id}
                    className="p-3 flex flex-col gap-2"
                    data-testid="script-actions-approved-row"
                    data-script-name={action.name}
                  >
                    <div className="flex items-start gap-3">
                      <ScriptDetails action={action} />
                      {action.kind !== 'tracked' ? (
                        <Button
                          size="compact"
                          variant="ghost"
                          disabled={busy[action.id] === true}
                          onClick={(): void => onRemove(action)}
                          aria-label={`Remove approval for ${action.name}`}
                          data-testid="script-actions-remove"
                        >
                          Remove
                        </Button>
                      ) : null}
                    </div>
                    {action.unavailableReason ? (
                      <p className="text-xs fg-warning">
                        {action.unavailableReason}
                      </p>
                    ) : null}
                    <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
                      <ShortcutRecorderField
                        value={action.shortcut}
                        platform={shortcutPlatform}
                        label={`Shortcut for ${action.name}`}
                        validate={validateShortcut(action)}
                        onSave={(accelerator): Promise<void> =>
                          onSaveShortcut(action, accelerator)
                        }
                        disabled={busy[action.id] === true}
                        testId="script-actions-shortcut"
                      />
                      {/* The caption labels the switch, so a click on it flips it. */}
                      <SettingsRowsSubRow
                        label="Pin to header"
                        htmlFor={`${headingId}-pin-${groupIndex}-${index}`}
                        control={
                          <ToggleSwitch
                            id={`${headingId}-pin-${groupIndex}-${index}`}
                            checked={action.pinned}
                            disabled={busy[action.id] === true}
                            label={`Pin ${action.name} to the header`}
                            onChange={(next): void => onPin(action, next)}
                            dataTestId="script-actions-pin"
                          />
                        }
                      />
                    </div>
                    {action.shortcutConflict ? (
                      <p data-testid="script-actions-shortcut-conflict">
                        <StatusLabel size="xs">
                          Shortcut is off. {action.shortcutConflict}
                        </StatusLabel>
                      </p>
                    ) : null}
                    {errors[action.id] ? (
                      <ErrorBanner
                        errorSource="approved-section"
                        className=""
                        error={errors[action.id]}
                      />
                    ) : null}
                  </li>
                ))}
              </ul>
            </Surface>
          </Stack>
        ))
      )}
    </Stack>
  );
}

function DismissedSection({
  actions,
  expanded,
  busy,
  errors,
  onToggle,
  onRestore,
}: {
  readonly actions: readonly ScriptAction[];
  readonly expanded: boolean;
  readonly busy: Readonly<Record<string, boolean>>;
  readonly errors: Readonly<Record<string, string>>;
  readonly onToggle: () => void;
  readonly onRestore: (action: ScriptAction) => void;
}): JSX.Element {
  const listId = useId();
  return (
    <section
      className="flex flex-col gap-2"
      data-testid="script-actions-dismissed"
    >
      <Button
        className="self-start"
        size="compact"
        variant="ghost"
        aria-expanded={expanded}
        aria-controls={listId}
        onClick={onToggle}
        data-testid="script-actions-dismissed-toggle"
      >
        {expanded ? 'Hide dismissed' : `Show dismissed (${actions.length})`}
      </Button>
      {expanded ? (
        <Surface variant="outline">
          <ul id={listId} className="divide-y">
            {actions.map((action) => (
              <li
                key={action.id}
                className="p-3 flex flex-col gap-1"
                data-testid="script-actions-dismissed-row"
                data-script-name={action.name}
              >
                <div className="flex items-start gap-3">
                  <ScriptDetails action={action} />
                  <Button
                    size="compact"
                    variant="secondary"
                    disabled={busy[action.id] === true}
                    onClick={(): void => onRestore(action)}
                    aria-label={`Restore ${action.name}`}
                    data-testid="script-actions-restore"
                  >
                    Restore
                  </Button>
                </div>
                {errors[action.id] ? (
                  <ErrorBanner
                    errorSource="dismissed-section"
                    className=""
                    error={errors[action.id]}
                  />
                ) : null}
              </li>
            ))}
          </ul>
        </Surface>
      ) : null}
    </section>
  );
}

function FeedbackLine({
  feedback,
}: {
  readonly feedback: Feedback;
}): JSX.Element {
  if (feedback.tone === 'error') {
    return (
      <Notice
        errorSource="script-actions-feedback"
        intent="destructive"
        data-testid="script-actions-feedback"
      >
        {feedback.message}
      </Notice>
    );
  }
  return (
    <p
      className="text-xs fg-secondary"
      role="status"
      data-testid="script-actions-feedback"
    >
      {feedback.message}
    </p>
  );
}

function ReviewFooter({
  selectedCount,
  saving,
  feedback,
  onApprove,
  onDismiss,
}: {
  readonly selectedCount: number;
  readonly saving: Exclude<Decision, 'reset'> | null;
  readonly feedback: Feedback | null;
  readonly onApprove: () => void;
  readonly onDismiss: () => void;
}): JSX.Element {
  const disabled = selectedCount === 0 || saving !== null;
  return (
    <Stack gap="inline" data-testid="script-actions-footer">
      {feedback !== null ? <FeedbackLine feedback={feedback} /> : null}
      <div className="flex flex-wrap items-center justify-end gap-2">
        <span className="mr-auto text-xs fg-tertiary" aria-live="polite">
          {selectedCount === 0
            ? 'Select scripts to review'
            : `${scriptCountLabel(selectedCount)} selected`}
        </span>
        <Button
          size="compact"
          variant="secondary"
          disabled={disabled}
          onClick={onDismiss}
          data-testid="script-actions-dismiss"
        >
          {saving === 'dismiss' ? <LoadingSpinner decorative /> : null}
          Dismiss selected
        </Button>
        <Button
          size="compact"
          variant="primary"
          disabled={disabled}
          onClick={onApprove}
          data-testid="script-actions-approve"
        >
          {saving === 'approve' ? <LoadingSpinner decorative /> : null}
          Approve selected
        </Button>
      </div>
    </Stack>
  );
}

import { ORCHESTRATOR_LABEL } from '@canopy/protocol';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from 'react';
import {
  createDefaultApprovalDefaults,
  APP_ADVISOR_PROJECT_ID,
  PIPELINE_EDITOR_PROJECT_ID,
  type ApprovalDefaults,
  type ApprovalMode,
  type ApprovalRule,
  type ApprovalRuleOrigin,
  type ApprovalRuleTarget,
} from '@canopy/desktop-shared/types';
import { emitPreferencesUpdated } from '@/lib/preferences-events';
import { useChatStore } from '@/stores/chatStore';
import { invalidateApprovalDefaults } from '@/stores/chat/approval-defaults';
import { useProjectsStore } from '@/stores/projectsStore';
import {
  POSTHOG_REPLAY_BLOCK_CLASS,
  POSTHOG_REPLAY_MASK_CLASS,
} from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import {
  reportClientAppError,
  resolveClientAppError,
} from '@canopy/desktop-instrumentation/client';
import { toAppError } from '@canopy/protocol/app-errors';
import { DesktopErrorBanner } from '@/components/shared/DesktopErrorBanner';
import { inlineFailure, type InlineFailure } from '@/lib/inline-app-error';
import {
  Button,
  FormField,
  SettingsSelect,
  StatusBadge,
} from '@canopy/ui-shared/components';
import {
  SettingsGroup,
  SettingsPage,
  SettingsLoading,
  SettingsRow,
  SettingsSection,
  SettingsTextField,
} from './SettingsLayout';

type RuleScope = 'global' | 'project';
type RuleKind = ApprovalRuleTarget['kind'];
type RuleBehavior = ApprovalRule['behavior'];

interface ApprovalModeOption {
  mode: ApprovalMode;
  label: string;
}

const APPROVAL_MODE_OPTIONS: ApprovalModeOption[] = [
  { mode: 'ask', label: 'Ask' },
  { mode: 'auto', label: 'Accept edits' },
  { mode: 'full-access', label: 'Full access' },
];

interface RuleKindOption {
  kind: RuleKind;
  label: string;
}

const RULE_KIND_OPTIONS: RuleKindOption[] = [
  { kind: 'command', label: 'Command' },
  { kind: 'file-write', label: 'File write' },
  { kind: 'mcp', label: 'MCP tool' },
  { kind: 'network', label: 'Network host' },
  { kind: 'tool', label: 'Tool' },
  { kind: 'browser-upload', label: 'Browser upload' },
];

const ORIGIN_LABELS: Record<ApprovalRuleOrigin, string> = {
  prompt: 'Prompt',
  settings: 'Settings',
  'canopy-json': 'canopy.json',
};

function describeRuleTarget(target: ApprovalRuleTarget): string {
  switch (target.kind) {
    case 'command':
      return target.pattern;
    case 'file-write':
      return target.path;
    case 'mcp':
      return target.tool ? `${target.server} → ${target.tool}` : target.server;
    case 'network':
      return target.host;
    case 'tool':
      return target.toolName;
    case 'browser-upload':
      return target.path ? `${target.origin} → ${target.path}` : target.origin;
    default:
      return '';
  }
}

/** The origin of a site the user typed, or null when it is not a web URL. */
function uploadOrigin(value: string): string | null {
  const trimmed = value.trim();
  // Typed text that isn't a URL is an expected outcome, not a failure.
  if (!URL.canParse(trimmed)) return null;
  const url = new URL(trimmed);
  return url.protocol === 'https:' || url.protocol === 'http:'
    ? url.origin
    : null;
}

function ruleKindLabel(kind: RuleKind): string {
  const option = RULE_KIND_OPTIONS.find((entry) => entry.kind === kind);
  return option ? option.label : kind;
}

function parseApprovalMode(value: string): ApprovalMode {
  const match = APPROVAL_MODE_OPTIONS.find((option) => option.mode === value);
  return match ? match.mode : 'ask';
}

function parseRuleKind(value: string): RuleKind {
  const match = RULE_KIND_OPTIONS.find((option) => option.kind === value);
  return match ? match.kind : 'command';
}

function formatCreatedAt(createdAt: string): string {
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return createdAt;
  return date.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

/**
 * Display-only seed for a failed `loadPreferences()`. Derived from the single
 * shared source so it cannot drift from the product default the way the Git
 * tab's copy did.
 *
 * It is safe to render but must never be *persisted*: writes go through
 * `setApprovalDefaultPreference`, which sends only the changed key and merges
 * inside the preferences write queue, so this synthetic snapshot can never
 * reach the surfaces the user did not touch (CAN-3055).
 */
const FALLBACK_APPROVAL_DEFAULTS: ApprovalDefaults =
  createDefaultApprovalDefaults();

const PROJECT_SELECT_ID = 'approval-project-workspace-select';

interface AddRuleFormValues {
  behavior: RuleBehavior;
  kind: RuleKind;
  value: string;
  server: string;
  tool: string;
  path: string;
}

const EMPTY_ADD_RULE_FORM: AddRuleFormValues = {
  behavior: 'allow',
  kind: 'command',
  value: '',
  server: '',
  tool: '',
  path: '',
};

function buildRuleTarget(form: AddRuleFormValues): ApprovalRuleTarget | null {
  switch (form.kind) {
    case 'command': {
      const pattern = form.value.trim();
      return pattern ? { kind: 'command', pattern } : null;
    }
    case 'file-write': {
      const path = form.value.trim();
      return path ? { kind: 'file-write', path } : null;
    }
    case 'mcp': {
      const server = form.server.trim();
      if (!server) return null;
      const tool = form.tool.trim();
      return tool ? { kind: 'mcp', server, tool } : { kind: 'mcp', server };
    }
    case 'network': {
      const host = form.value.trim();
      return host ? { kind: 'network', host } : null;
    }
    case 'tool': {
      const toolName = form.value.trim();
      return toolName ? { kind: 'tool', toolName } : null;
    }
    case 'browser-upload': {
      const origin = uploadOrigin(form.value);
      if (!origin) return null;
      const path = form.path.trim();
      return path
        ? { kind: 'browser-upload', origin, path }
        : { kind: 'browser-upload', origin };
    }
    default:
      return null;
  }
}

interface AddRuleFormProps {
  scope: RuleScope;
  disabled?: boolean;
  onAdd: (behavior: RuleBehavior, target: ApprovalRuleTarget) => void;
}

/**
 * The new-rule fields on one wrapping line, each captioned above its field,
 * with the Add action last. Rendered under a `New rule` row at the end of
 * the rules group.
 */
function AddRuleForm({
  scope,
  disabled = false,
  onAdd,
}: AddRuleFormProps): JSX.Element {
  const [form, setForm] = useState<AddRuleFormValues>(EMPTY_ADD_RULE_FORM);

  const submit = useCallback((): void => {
    const target = buildRuleTarget(form);
    if (!target) return;
    onAdd(form.behavior, target);
    setForm((prev) => ({ ...EMPTY_ADD_RULE_FORM, kind: prev.kind }));
  }, [form, onAdd]);

  const patternInputTestId = `approval-add-rule-${scope}-value`;

  return (
    <div className="flex flex-wrap items-end gap-3">
      <FormField label="Behavior">
        {(control) => (
          <SettingsSelect
            {...control}
            options={[
              { value: 'allow', label: 'Allow' },
              { value: 'deny', label: 'Deny' },
            ]}
            value={form.behavior}
            disabled={disabled}
            onValueChange={(next): void =>
              setForm((prev) => ({
                ...prev,
                behavior: next === 'deny' ? 'deny' : 'allow',
              }))
            }
          />
        )}
      </FormField>

      <FormField label="Kind">
        {(control) => (
          <SettingsSelect
            {...control}
            options={RULE_KIND_OPTIONS.map((option) => ({
              value: option.kind,
              label: option.label,
            }))}
            value={form.kind}
            disabled={disabled}
            onValueChange={(next): void => {
              const kind = parseRuleKind(next);
              setForm((prev) => ({
                ...EMPTY_ADD_RULE_FORM,
                behavior: prev.behavior,
                kind,
              }));
            }}
          />
        )}
      </FormField>

      {form.kind === 'mcp' ? (
        <>
          <FormField label="Server">
            {(control) => (
              <SettingsTextField
                {...control}
                type="text"
                width="sm"
                value={form.server}
                disabled={disabled}
                placeholder="server name"
                onChange={(e): void =>
                  setForm((prev) => ({ ...prev, server: e.target.value }))
                }
              />
            )}
          </FormField>
          <FormField label="Tool (optional)">
            {(control) => (
              <SettingsTextField
                {...control}
                type="text"
                width="sm"
                value={form.tool}
                disabled={disabled}
                placeholder="tool name"
                onChange={(e): void =>
                  setForm((prev) => ({ ...prev, tool: e.target.value }))
                }
              />
            )}
          </FormField>
        </>
      ) : form.kind === 'browser-upload' ? (
        <>
          <FormField label="Site">
            {(control) => (
              <SettingsTextField
                {...control}
                type="text"
                width="md"
                data-testid={patternInputTestId}
                value={form.value}
                disabled={disabled}
                placeholder="https://upload.example.com"
                onChange={(e): void =>
                  setForm((prev) => ({ ...prev, value: e.target.value }))
                }
              />
            )}
          </FormField>
          <FormField label="Path (optional)">
            {(control) => (
              <SettingsTextField
                {...control}
                type="text"
                width="sm"
                value={form.path}
                disabled={disabled}
                placeholder="exports/**"
                onChange={(e): void =>
                  setForm((prev) => ({ ...prev, path: e.target.value }))
                }
              />
            )}
          </FormField>
        </>
      ) : (
        <FormField
          label={
            form.kind === 'command'
              ? 'Command pattern'
              : form.kind === 'file-write'
                ? 'Path pattern'
                : form.kind === 'network'
                  ? 'Host'
                  : 'Tool name'
          }
        >
          {(control) => (
            <SettingsTextField
              {...control}
              type="text"
              width="md"
              data-testid={patternInputTestId}
              value={form.value}
              disabled={disabled}
              placeholder={
                form.kind === 'command'
                  ? 'npm test*'
                  : form.kind === 'file-write'
                    ? 'src/**/*.ts'
                    : form.kind === 'network'
                      ? 'api.example.com'
                      : 'ToolName'
              }
              onChange={(e): void =>
                setForm((prev) => ({ ...prev, value: e.target.value }))
              }
            />
          )}
        </FormField>
      )}

      <Button
        size="compact"
        variant="secondary"
        data-testid={`approval-add-rule-${scope}`}
        disabled={disabled}
        onClick={submit}
      >
        Add rule
      </Button>
    </div>
  );
}

// Behavior, Target (with its kind under it), Origin, Created, action.
const RULE_GRID_COLUMNS = '4.5rem minmax(0, 1fr) 6rem 6.5rem 6.5rem';

interface RuleListProps {
  rules: ApprovalRule[];
  emptyMessage: string;
  onRemove: (ruleId: string) => void;
  tableTestId?: string;
  /** A row above the rules in the same group, such as the project picker. */
  leadingRow?: ReactNode;
  /** A row under the rules in the same group: the new-rule form. */
  trailingRow?: ReactNode;
  /** The rules are loading: a placeholder stands in for them. */
  loading?: boolean;
}

/**
 * The rules as a table inside one group: an optional leading row, a caption
 * row, then one row per rule on the same column template, or the empty line
 * when there are none, and an optional trailing row (the new-rule form).
 */
function RuleList({
  rules,
  emptyMessage,
  onRemove,
  tableTestId = 'approval-rules-table',
  leadingRow,
  trailingRow,
  loading = false,
}: RuleListProps): JSX.Element {
  if (loading) {
    return (
      <SettingsGroup dataTestId={tableTestId}>
        {leadingRow}
        <SettingsLoading rows={2} />
        {trailingRow}
      </SettingsGroup>
    );
  }
  return (
    <SettingsGroup dataTestId={tableTestId}>
      {leadingRow}
      {rules.length === 0 ? (
        <p className="text-s fg-secondary">{emptyMessage}</p>
      ) : (
        <div
          className="grid items-center gap-x-3 text-xs fg-tertiary"
          style={{ gridTemplateColumns: RULE_GRID_COLUMNS }}
        >
          <span>Behavior</span>
          <span>Target</span>
          <span>Origin</span>
          <span>Created</span>
          <span />
        </div>
      )}
      {rules.map((rule) => (
        <div
          key={rule.id}
          data-testid={`approval-rule-row-${rule.id}`}
          className="grid items-center gap-x-3 text-s"
          style={{ gridTemplateColumns: RULE_GRID_COLUMNS }}
        >
          <span className="flex">
            <StatusBadge
              variant={rule.behavior === 'allow' ? 'success' : 'destructive'}
              label={rule.behavior === 'allow' ? 'Allow' : 'Deny'}
            />
          </span>
          <div className="min-w-0">
            {/* Command rules quote whole command lines, so the target is blocked. */}
            <code
              className={`${POSTHOG_REPLAY_BLOCK_CLASS} block truncate font-mono text-xs fg-primary`}
              title={describeRuleTarget(rule.target)}
            >
              {describeRuleTarget(rule.target)}
            </code>
            <span className="block text-xs fg-secondary">
              {ruleKindLabel(rule.target.kind)}
            </span>
          </div>
          <span className="truncate fg-secondary">
            {ORIGIN_LABELS[rule.origin]}
          </span>
          <span className="truncate fg-secondary">
            {formatCreatedAt(rule.createdAt)}
          </span>
          <span className="flex justify-end">
            {rule.origin === 'canopy-json' ? (
              <span
                className="text-xs fg-secondary"
                title="Defined in canopy.json; edit the repo file to change it."
              >
                Repo-managed
              </span>
            ) : (
              <Button
                size="compact"
                variant="secondary"
                data-testid={`approval-rule-remove-${rule.id}`}
                onClick={(): void => onRemove(rule.id)}
              >
                Remove
              </Button>
            )}
          </span>
        </div>
      ))}
      {trailingRow}
    </SettingsGroup>
  );
}

interface ApprovalDefaultRowProps {
  surface: keyof ApprovalDefaults;
  label: string;
  testId: string;
  value: ApprovalMode;
  onChange: (surface: keyof ApprovalDefaults, mode: ApprovalMode) => void;
}

function ApprovalDefaultRow({
  surface,
  label,
  testId,
  value,
  onChange,
}: ApprovalDefaultRowProps): JSX.Element {
  const id = `${testId}-select`;
  return (
    <SettingsRow
      label={label}
      htmlFor={id}
      control={
        <SettingsSelect
          id={id}
          data-testid={testId}
          options={APPROVAL_MODE_OPTIONS.map((option) => ({
            value: option.mode,
            label: option.label,
          }))}
          value={value}
          onValueChange={(next): void =>
            onChange(surface, parseApprovalMode(next))
          }
        />
      }
    />
  );
}

export function ApprovalsTab(): JSX.Element {
  const visibleWorkspaces = useProjectsStore((state) => state.projects);
  const workspaces = useMemo(
    () => [
      ...visibleWorkspaces,
      ...[
        { id: APP_ADVISOR_PROJECT_ID, name: ORCHESTRATOR_LABEL },
        { id: PIPELINE_EDITOR_PROJECT_ID, name: 'Workflow editor' },
      ].filter(
        (managed) =>
          !visibleWorkspaces.some((workspace) => workspace.id === managed.id),
      ),
    ],
    [visibleWorkspaces],
  );

  const [defaults, setDefaults] = useState<ApprovalDefaults | null>(null);
  const syncedDefaultsRef = useRef(false);
  const defaultsRevisionRef = useRef(0);
  const [globalRules, setGlobalRules] = useState<ApprovalRule[]>([]);
  const [projectRules, setProjectRules] = useState<ApprovalRule[]>([]);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string>('');
  const [projectRulesLoading, setProjectRulesLoading] = useState(false);
  const [defaultsError, setDefaultsError] = useState<InlineFailure | null>(
    null,
  );
  const [globalRulesError, setGlobalRulesError] =
    useState<InlineFailure | null>(null);
  const [projectRulesError, setProjectRulesError] =
    useState<InlineFailure | null>(null);

  useEffect(() => {
    let cancelled = false;
    const unsubscribePreferencesSynced =
      typeof window.api.onPreferencesSynced === 'function'
        ? window.api.onPreferencesSynced((preferences) => {
            syncedDefaultsRef.current = true;
            defaultsRevisionRef.current += 1;
            setDefaults(preferences.approvalDefaults);
          })
        : undefined;
    void window.api
      .loadPreferences()
      .then((prefs) => {
        if (cancelled || syncedDefaultsRef.current) return;
        setDefaults(prefs.approvalDefaults);
      })
      .catch((error: unknown) => {
        reportClientAppError(error);
        if (cancelled || syncedDefaultsRef.current) return;
        setDefaults(FALLBACK_APPROVAL_DEFAULTS);
      });
    void window.api.approvals
      .listRules({})
      .then((response) => {
        if (cancelled) return;
        setGlobalRules(response.global);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setGlobalRules([]);
        const appError = toAppError(resolveClientAppError(error));
        if (appError)
          setGlobalRulesError(
            inlineFailure(appError, "Couldn't load global rules."),
          );
      });
    return (): void => {
      cancelled = true;
      unsubscribePreferencesSynced?.();
    };
  }, []);

  useEffect(() => {
    if (selectedWorkspaceId || workspaces.length === 0) return;
    setSelectedWorkspaceId(workspaces[0].id);
  }, [workspaces, selectedWorkspaceId]);

  useEffect(() => {
    if (!selectedWorkspaceId) {
      setProjectRules([]);
      return;
    }
    let cancelled = false;
    setProjectRulesLoading(true);
    setProjectRulesError(null);
    void window.api.approvals
      .listRules({ workspaceId: selectedWorkspaceId })
      .then((response) => {
        if (cancelled) return;
        setProjectRules(response.project);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setProjectRules([]);
        const appError = toAppError(resolveClientAppError(error));
        if (appError)
          setProjectRulesError(
            inlineFailure(appError, "Couldn't load project rules."),
          );
      })
      .finally(() => {
        if (!cancelled) setProjectRulesLoading(false);
      });
    return (): void => {
      cancelled = true;
    };
  }, [selectedWorkspaceId]);

  function handleDefaultChange(
    surface: keyof ApprovalDefaults,
    mode: ApprovalMode,
  ): void {
    if (!defaults) return;
    const requestRevision = defaultsRevisionRef.current + 1;
    defaultsRevisionRef.current = requestRevision;
    const next: ApprovalDefaults = { ...defaults, [surface]: mode };
    setDefaults(next);
    setDefaultsError(null);
    // Clear send-time defaults immediately so a privileged cached value can
    // never survive a hard flip to Ask while persistence is in flight.
    invalidateApprovalDefaults();
    useChatStore.setState({ approvalDefaultsCache: {} });
    // Send ONLY the changed key. `savePreferences({ approvalDefaults: next })`
    // would persist a whole object built from `defaults`, which is a snapshot
    // taken when this tab mounted — that clobbers a concurrent in-chat
    // write-back, and when `loadPreferences()` failed and `defaults` came from
    // `FALLBACK_APPROVAL_DEFAULTS` it would silently escalate the two surfaces
    // the user never touched to Full Access (CAN-3055). The main handler
    // merges this single key inside the preferences write queue.
    void window.api
      .setApprovalDefaultPreference({ surface, mode })
      .then((normalized) => {
        if (defaultsRevisionRef.current !== requestRevision) return;
        setDefaults(normalized.approvalDefaults);
        invalidateApprovalDefaults();
        useChatStore.setState({ approvalDefaultsCache: {} });
        emitPreferencesUpdated(normalized);
      })
      .catch((error: unknown) => {
        if (defaultsRevisionRef.current !== requestRevision) return;
        const appError = toAppError(resolveClientAppError(error));
        if (appError)
          setDefaultsError(
            inlineFailure(appError, "Couldn't save the approval mode."),
          );
        void window.api
          .loadPreferences()
          .then((normalized) => {
            if (defaultsRevisionRef.current !== requestRevision) return;
            setDefaults(normalized.approvalDefaults);
            invalidateApprovalDefaults();
            useChatStore.setState({ approvalDefaultsCache: {} });
          })
          .catch((reloadError: unknown) => {
            reportClientAppError(reloadError);
            if (defaultsRevisionRef.current !== requestRevision) return;
            setDefaults(FALLBACK_APPROVAL_DEFAULTS);
          });
      });
  }

  const rollbackGlobalRules = useCallback(
    (failure: InlineFailure | null): void => {
      setGlobalRulesError(failure);
      void window.api.approvals
        .listRules({})
        .then((response) => setGlobalRules(response.global))
        .catch((error: unknown) => {
          reportClientAppError(error);
          setGlobalRules([]);
        });
    },
    [],
  );

  const addGlobalRule = useCallback(
    (behavior: RuleBehavior, target: ApprovalRuleTarget): void => {
      const rule: ApprovalRule = {
        id: crypto.randomUUID(),
        behavior,
        target,
        createdAt: new Date().toISOString(),
        origin: 'settings',
      };
      setGlobalRules((prev) => [...prev, rule]);
      setGlobalRulesError(null);
      void window.api.approvals
        .addRule({ scope: 'global', rule })
        .catch((error: unknown) => {
          const appError = toAppError(resolveClientAppError(error));
          rollbackGlobalRules(
            appError
              ? inlineFailure(appError, "Couldn't add the global rule.")
              : null,
          );
        });
    },
    [rollbackGlobalRules],
  );

  const removeGlobalRule = useCallback(
    (ruleId: string): void => {
      setGlobalRules((prev) => prev.filter((rule) => rule.id !== ruleId));
      setGlobalRulesError(null);
      void window.api.approvals
        .removeRule({ scope: 'global', ruleId })
        .catch((error: unknown) => {
          const appError = toAppError(resolveClientAppError(error));
          rollbackGlobalRules(
            appError
              ? inlineFailure(appError, "Couldn't remove the global rule.")
              : null,
          );
        });
    },
    [rollbackGlobalRules],
  );

  const rollbackProjectRules = useCallback(
    (failure: InlineFailure | null): void => {
      if (!selectedWorkspaceId) return;
      setProjectRulesError(failure);
      void window.api.approvals
        .listRules({ workspaceId: selectedWorkspaceId })
        .then((response) => setProjectRules(response.project))
        .catch((error: unknown) => {
          reportClientAppError(error);
          setProjectRules([]);
        });
    },
    [selectedWorkspaceId],
  );

  const addProjectRule = useCallback(
    (behavior: RuleBehavior, target: ApprovalRuleTarget): void => {
      if (!selectedWorkspaceId) return;
      const rule: ApprovalRule = {
        id: crypto.randomUUID(),
        behavior,
        target,
        createdAt: new Date().toISOString(),
        origin: 'settings',
      };
      setProjectRules((prev) => [...prev, rule]);
      setProjectRulesError(null);
      void window.api.approvals
        .addRule({
          scope: 'project',
          workspaceId: selectedWorkspaceId,
          rule,
        })
        .catch((error: unknown) => {
          const appError = toAppError(resolveClientAppError(error));
          rollbackProjectRules(
            appError
              ? inlineFailure(appError, "Couldn't add the project rule.")
              : null,
          );
        });
    },
    [selectedWorkspaceId, rollbackProjectRules],
  );

  const removeProjectRule = useCallback(
    (ruleId: string): void => {
      if (!selectedWorkspaceId) return;
      setProjectRules((prev) => prev.filter((rule) => rule.id !== ruleId));
      setProjectRulesError(null);
      void window.api.approvals
        .removeRule({
          scope: 'project',
          workspaceId: selectedWorkspaceId,
          ruleId,
        })
        .catch((error: unknown) => {
          const appError = toAppError(resolveClientAppError(error));
          rollbackProjectRules(
            appError
              ? inlineFailure(appError, "Couldn't remove the project rule.")
              : null,
          );
        });
    },
    [selectedWorkspaceId, rollbackProjectRules],
  );

  if (!defaults) {
    return (
      <SettingsPage title="Approvals" dataTestId="settings-approvals-section">
        <SettingsLoading />
      </SettingsPage>
    );
  }

  return (
    <SettingsPage
      title="Approvals"
      description="Set the default tool-approval mode for each surface, and rules that always allow or deny a tool, command, file, or host."
      dataTestId="settings-approvals-section"
    >
      <SettingsSection title="Default mode">
        <DesktopErrorBanner
          errorSource="approval-defaults-error"
          className=""
          error={defaultsError?.error}
          {...(defaultsError?.details === undefined
            ? {}
            : { details: defaultsError.details })}
          onDismiss={(): void => setDefaultsError(null)}
          testId="approval-defaults-error"
        />
        <SettingsGroup>
          <ApprovalDefaultRow
            surface="worktree"
            label="Worktree chats"
            testId="approval-default-worktree"
            value={defaults.worktree}
            onChange={handleDefaultChange}
          />
          <ApprovalDefaultRow
            surface="cowork"
            label="Cowork chats"
            testId="approval-default-cowork"
            value={defaults.cowork}
            onChange={handleDefaultChange}
          />
          <ApprovalDefaultRow
            surface="appAdvisor"
            label={ORCHESTRATOR_LABEL}
            testId="approval-default-app-advisor"
            value={defaults.appAdvisor}
            onChange={handleDefaultChange}
          />
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection
        title="Global rules"
        description="Apply in every project, whatever the default mode."
      >
        <DesktopErrorBanner
          errorSource="approval-global-rules-error"
          className=""
          error={globalRulesError?.error}
          {...(globalRulesError?.details === undefined
            ? {}
            : { details: globalRulesError.details })}
          testId="approval-global-rules-error"
        />
        <RuleList
          rules={globalRules}
          emptyMessage="No global rules yet."
          onRemove={removeGlobalRule}
          tableTestId="approval-rules-table"
          trailingRow={
            <SettingsRow label="New rule">
              <AddRuleForm scope="global" onAdd={addGlobalRule} />
            </SettingsRow>
          }
        />
      </SettingsSection>

      <SettingsSection
        title="Project rules"
        description="Apply only in the selected project."
      >
        {workspaces.length === 0 ? (
          <SettingsGroup>
            <p className="text-s fg-secondary">No projects found.</p>
          </SettingsGroup>
        ) : (
          <>
            <DesktopErrorBanner
              errorSource="approval-project-rules-error"
              className=""
              error={projectRulesError?.error}
              {...(projectRulesError?.details === undefined
                ? {}
                : { details: projectRulesError.details })}
              testId="approval-project-rules-error"
            />
            {/* The project picker is the group's first row: the rules
                under it belong to the project it names. */}
            <RuleList
              rules={projectRules}
              emptyMessage="No project rules yet."
              onRemove={removeProjectRule}
              tableTestId="approval-project-rules-table"
              loading={projectRulesLoading}
              leadingRow={
                <SettingsRow
                  label="Project"
                  htmlFor={PROJECT_SELECT_ID}
                  control={
                    <SettingsSelect
                      id={PROJECT_SELECT_ID}
                      data-testid="approval-project-workspace"
                      options={workspaces.map((workspace) => ({
                        value: workspace.id,
                        label: workspace.name,
                      }))}
                      value={selectedWorkspaceId}
                      onValueChange={setSelectedWorkspaceId}
                      // Project names are the user's own; mask the label text.
                      replayPrivacy={{
                        maskClassName: POSTHOG_REPLAY_MASK_CLASS,
                      }}
                    />
                  }
                />
              }
              trailingRow={
                <SettingsRow label="New rule">
                  <AddRuleForm
                    scope="project"
                    disabled={!selectedWorkspaceId}
                    onAdd={addProjectRule}
                  />
                </SettingsRow>
              }
            />
          </>
        )}
      </SettingsSection>
    </SettingsPage>
  );
}

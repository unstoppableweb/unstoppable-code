import { useEffect, useId, useMemo, useRef, useState, type JSX } from 'react';
import { ToggleSwitch, type SegmentedControlOption } from '@canopy/ui-shared';
import {
  MAX_SCRIPT_DEV_SERVER_LABEL_LENGTH,
  MAX_SCRIPT_DEV_SERVER_PATTERN_LENGTH,
  MAX_SCRIPT_DEV_SERVER_PATTERNS,
  SCRIPT_ENV_VISIBLE_VAR_DEFINITIONS,
  isLinuxCommandShell,
  isMacCommandShell,
  isScriptInteractiveSupported,
  isScriptTimeoutConfigurable,
  isWindowsCommandShell,
  type CommandShellDefinition,
} from '@canopy/desktop-shared/scripts';
import {
  createScriptEnvVarInsertion,
  insertTextAtSelection,
} from '@/lib/scriptEditor';
import {
  createEmptyEditableDevServerPattern,
  invalidDevServerPatternRowIds,
  isRegexParseable,
  type EditableDevServerPattern,
} from '@/lib/editableScripts';
import {
  getCustomTimeoutDraft,
  parseCustomTimeoutDraft,
} from '@/lib/scriptConfigTimeout';
import { brandText } from '@/lib/brand';
import {
  Stack,
  Button,
  FormField,
  SegmentedControl,
  SettingsSelect,
  Surface,
  TextArea,
  TextInput,
} from '@canopy/ui-shared/components';
import {
  SettingsSubRow,
  SettingsTextArea,
} from '@/components/settings/SettingsLayout';
import { VariableInsertDropdown } from './VariableInsertDropdown';
import {
  RuntimeModePicker,
  type CommandRuntimeMode,
} from './RuntimeModePicker';

/**
 * Tri-state for the timeout segmented control:
 *
 *   - `default`  → `timeoutSeconds === undefined` (use the global default).
 *   - `custom`   → `timeoutSeconds` is a positive integer.
 *   - `disabled` → `timeoutSeconds === null` (no timeout).
 */
export type ScriptTimeoutMode = 'default' | 'custom' | 'disabled';

export interface ScriptConfigEditorProps {
  label: string;
  scriptName: string;
  command: string;
  timeoutSeconds?: number | null;
  onCommandChange: (next: string) => void;
  onTimeoutSecondsChange: (next: number | null | undefined) => void;
  interactive?: boolean;
  onInteractiveChange?: (next: boolean) => void;
  shell?: CommandShellDefinition;
  onShellChange?: (next: CommandShellDefinition | undefined) => void;
  placeholder?: string;
  rows?: number;
  defaultTimeoutSeconds: number;
  /**
   * Editor-side dev-server pattern list for this script. `undefined` means
   * "no patterns configured" (the user has never touched the section);
   * an empty array means "an explicitly empty list" — both canonicalize back
   * to `undefined` on save.
   */
  devServerPatterns?: EditableDevServerPattern[];
  /**
   * Receive an updated dev-server pattern list. Pass `undefined` to clear the
   * list back to the un-configured state.
   */
  onDevServerPatternsChange?: (
    next: EditableDevServerPattern[] | undefined,
  ) => void;
  /**
   * Surfaces row-level validity to the parent so the parent can disable Save.
   * Empty array means "all rows are valid (or trivially empty)". Non-empty
   * array lists offending row ids. When patterns are not configured, the
   * editor reports an empty array so the parent can clear stale validity state.
   */
  onDevServerPatternsValidityChange?: (invalidRowIds: string[]) => void;
  /**
   * Stable identifier for the parent validity bucket represented by this
   * editor. When local/source settings swap in-place, this lets the editor
   * clear the old bucket before reporting rows for the new one.
   */
  devServerPatternsValidityScopeKey?: string;
  /**
   * `stack` is the modal form. `settings` lays the options out as rows under
   * the command, for a settings page: Runtime, Timeout and each shell are a
   * labeled row with the control on the trailing edge.
   */
  layout?: 'stack' | 'settings';
}

function deriveMode(
  timeoutSeconds: number | null | undefined,
): ScriptTimeoutMode {
  if (timeoutSeconds === null) {
    return 'disabled';
  }
  if (typeof timeoutSeconds === 'number') {
    return 'custom';
  }
  return 'default';
}

function formatDefaultHelper(defaultTimeoutSeconds: number): string {
  if (defaultTimeoutSeconds <= 0) {
    return 'Uses the global script timeout.';
  }
  const minutes = defaultTimeoutSeconds / 60;
  if (Number.isInteger(minutes)) {
    return `Uses the global script timeout (${minutes} ${
      minutes === 1 ? 'minute' : 'minutes'
    }).`;
  }
  return `Uses the global script timeout (${defaultTimeoutSeconds} seconds).`;
}

interface TimeoutSegmentedControlProps {
  mode: ScriptTimeoutMode;
  onChange: (next: ScriptTimeoutMode) => void;
  disabled: boolean;
  describedById?: string;
}

const TIMEOUT_OPTIONS: readonly SegmentedControlOption<ScriptTimeoutMode>[] = [
  { value: 'default', label: 'Default' },
  { value: 'custom', label: 'Custom' },
  { value: 'disabled', label: 'Disabled' },
];

function TimeoutSegmentedControl({
  mode,
  onChange,
  disabled,
  describedById,
}: TimeoutSegmentedControlProps): JSX.Element {
  return (
    <SegmentedControl<ScriptTimeoutMode>
      label="Timeout"
      semantics="radio"
      shape="capsule"
      width="content"
      value={mode}
      options={TIMEOUT_OPTIONS}
      disabled={disabled}
      describedBy={describedById}
      onChange={(next) => {
        if (next !== mode) onChange(next);
      }}
    />
  );
}

export function ScriptConfigEditor({
  label,
  scriptName,
  command,
  timeoutSeconds,
  onCommandChange,
  onTimeoutSecondsChange,
  interactive = false,
  onInteractiveChange,
  shell,
  onShellChange,
  placeholder,
  rows = 3,
  defaultTimeoutSeconds,
  devServerPatterns,
  onDevServerPatternsChange,
  onDevServerPatternsValidityChange,
  devServerPatternsValidityScopeKey,
  layout = 'stack',
}: ScriptConfigEditorProps): JSX.Element {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const selectionRef = useRef({
    start: 0,
    end: 0,
  });
  const helperId = useId();

  const isTimeoutConfigurable = isScriptTimeoutConfigurable(scriptName);
  const isTimeoutControlDisabled = !isTimeoutConfigurable;
  const mode: ScriptTimeoutMode = isTimeoutControlDisabled
    ? 'disabled'
    : deriveMode(timeoutSeconds);

  // Track a local draft of the Custom number input so users can type
  // freely (including clearing the field to retype) without churning the
  // upstream model on every keystroke. Synced to props when the configured
  // timeoutSeconds changes externally.
  const [customDraft, setCustomDraft] = useState<string>(() =>
    getCustomTimeoutDraft(timeoutSeconds),
  );

  useEffect(() => {
    setCustomDraft(getCustomTimeoutDraft(timeoutSeconds));
  }, [timeoutSeconds]);

  const rememberSelection = (): void => {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }

    selectionRef.current = {
      start: textarea.selectionStart,
      end: textarea.selectionEnd,
    };
  };

  const insertVariable = (variableName: string): void => {
    const insertedText = createScriptEnvVarInsertion(variableName);
    const nextSelection =
      textareaRef.current && document.activeElement === textareaRef.current
        ? {
            start: textareaRef.current.selectionStart,
            end: textareaRef.current.selectionEnd,
          }
        : selectionRef.current;
    const insertion = insertTextAtSelection({
      value: command,
      insertedText,
      selectionStart: nextSelection.start,
      selectionEnd: nextSelection.end,
    });

    onCommandChange(insertion.value);

    requestAnimationFrame((): void => {
      const textarea = textareaRef.current;
      if (!textarea) {
        return;
      }

      textarea.focus();
      textarea.selectionStart = insertion.cursorPosition;
      textarea.selectionEnd = insertion.cursorPosition;
      selectionRef.current = {
        start: insertion.cursorPosition,
        end: insertion.cursorPosition,
      };
    });
  };

  const handleModeChange = (next: ScriptTimeoutMode): void => {
    if (next === mode) {
      return;
    }
    if (next === 'default') {
      onTimeoutSecondsChange(undefined);
      return;
    }
    if (next === 'disabled') {
      onTimeoutSecondsChange(null);
      return;
    }
    // Switching to Custom commits whatever the user previously typed,
    // falling back to the global default so the saved value is meaningful
    // even before the user touches the input.
    const parsed = parseCustomTimeoutDraft(customDraft);
    if (parsed !== undefined) {
      onTimeoutSecondsChange(parsed);
      return;
    }
    onTimeoutSecondsChange(defaultTimeoutSeconds);
  };

  const handleCustomInputChange = (raw: string): void => {
    const parsed = parseCustomTimeoutDraft(raw);
    if (raw.length > 0 && parsed === undefined) {
      return;
    }
    setCustomDraft(raw);
    if (raw.length === 0) {
      // Allow temporary blank state while editing; do not collapse the mode.
      return;
    }
    onTimeoutSecondsChange(parsed);
  };

  // Teardown lifecycles always use the background runner because archival
  // makes their worktree terminal inaccessible. Lock the picker to Background
  // and keep their real timeout visible even if older configuration persisted
  // `interactive: true`.
  const interactiveSupported = isScriptInteractiveSupported(scriptName);
  const runtimeMode: CommandRuntimeMode =
    interactive && interactiveSupported ? 'interactive' : 'background';
  const showTimeoutControl = runtimeMode === 'background';
  // Teardown editors are rendered without an `onInteractiveChange` handler
  // because there is nothing to change; the locked picker still renders so the
  // forced runtime is visible rather than silently missing.
  const showRuntimePicker =
    Boolean(onInteractiveChange) || !interactiveSupported;

  const helperText = !isTimeoutConfigurable
    ? 'Launch scripts are persistent and do not time out.'
    : mode === 'disabled'
      ? 'This script will keep running until it exits or is stopped.'
      : mode === 'custom'
        ? undefined
        : formatDefaultHelper(defaultTimeoutSeconds);

  const customTimeoutInput =
    !isTimeoutControlDisabled && mode === 'custom' ? (
      <div className="w-28">
        <TextInput
          density="settings"
          trailing="seconds"
          type="number"
          min={1}
          step={1}
          inputMode="numeric"
          value={customDraft}
          placeholder="300"
          aria-label={`${label} timeout in seconds`}
          onChange={(event) => handleCustomInputChange(event.target.value)}
          onBlur={() => {
            if (customDraft.trim().length === 0) {
              // Snap back to the last committed numeric value (or the
              // global default if we never had one) so the input is
              // never left visually empty in Custom mode.
              const fallback =
                typeof timeoutSeconds === 'number'
                  ? timeoutSeconds
                  : defaultTimeoutSeconds;
              setCustomDraft(String(fallback));
              if (typeof timeoutSeconds !== 'number') {
                onTimeoutSecondsChange(defaultTimeoutSeconds);
              }
            }
          }}
        />
      </div>
    ) : null;

  const runtimePicker = (showLabel: boolean): JSX.Element => (
    <RuntimeModePicker
      mode={runtimeMode}
      onChange={(next) => onInteractiveChange?.(next === 'interactive')}
      interactiveDescription="Run this script in the project terminal so it can accept input."
      disabled={!interactiveSupported}
      disabledReason="Teardown scripts can only be run as background commands."
      testId="script-runtime-mode"
      ariaLabel={`${label} runtime`}
      showLabel={showLabel}
    />
  );

  if (layout === 'settings') {
    return (
      <Stack gap="inline">
        <SettingsTextArea
          ref={textareaRef}
          mono
          aria-label={label}
          value={command}
          onChange={(event) => onCommandChange(event.target.value)}
          onSelect={rememberSelection}
          onClick={rememberSelection}
          onKeyUp={rememberSelection}
          placeholder={placeholder}
          rows={rows}
          spellCheck={false}
        />
        <div className="w-52">
          <VariableInsertDropdown
            variables={SCRIPT_ENV_VISIBLE_VAR_DEFINITIONS}
            onInsert={insertVariable}
          />
        </div>
        {showRuntimePicker && (
          <SettingsSubRow
            label="Runtime"
            description={
              !interactiveSupported
                ? 'Teardown scripts always run in the background.'
                : runtimeMode === 'interactive'
                  ? 'Runs in the project terminal so it can take input.'
                  : 'Output streams into the activity panel.'
            }
            control={runtimePicker(false)}
          />
        )}
        {showTimeoutControl && (
          <SettingsSubRow
            label="Timeout"
            description={helperText}
            control={
              <>
                {customTimeoutInput}
                <TimeoutSegmentedControl
                  mode={mode}
                  onChange={handleModeChange}
                  disabled={isTimeoutControlDisabled}
                />
              </>
            }
          />
        )}
        {onShellChange && (
          <ShellSelectionSection
            label={label}
            shell={shell}
            onChange={onShellChange}
            layout="settings"
          />
        )}
        {onDevServerPatternsChange && (
          <DevServerPatternsSection
            patterns={devServerPatterns}
            onChange={onDevServerPatternsChange}
            onValidityChange={onDevServerPatternsValidityChange}
            validityScopeKey={devServerPatternsValidityScopeKey}
          />
        )}
      </Stack>
    );
  }

  return (
    <Stack gap="inline">
      <FormField label={label}>
        {(control) => (
          <TextArea
            {...control}
            ref={textareaRef}
            mono
            value={command}
            onChange={(event) => onCommandChange(event.target.value)}
            onSelect={rememberSelection}
            onClick={rememberSelection}
            onKeyUp={rememberSelection}
            placeholder={placeholder}
            rows={rows}
          />
        )}
      </FormField>

      <VariableInsertDropdown
        variables={SCRIPT_ENV_VISIBLE_VAR_DEFINITIONS}
        onInsert={insertVariable}
      />

      {showRuntimePicker && runtimePicker(true)}

      {showTimeoutControl && (
        <div className="flex flex-col pt-1 gap-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-2xs font-medium fg-secondary">Timeout</span>
            <TimeoutSegmentedControl
              mode={mode}
              onChange={handleModeChange}
              disabled={isTimeoutControlDisabled}
              describedById={helperText ? helperId : undefined}
            />
            {customTimeoutInput}
          </div>
          {helperText && (
            <p id={helperId} className="text-2xs fg-secondary">
              {helperText}
            </p>
          )}
        </div>
      )}

      {onShellChange && (
        <ShellSelectionSection
          label={label}
          shell={shell}
          onChange={onShellChange}
        />
      )}

      {onDevServerPatternsChange && (
        <DevServerPatternsSection
          patterns={devServerPatterns}
          onChange={onDevServerPatternsChange}
          onValidityChange={onDevServerPatternsValidityChange}
          validityScopeKey={devServerPatternsValidityScopeKey}
        />
      )}
    </Stack>
  );
}

function updateShellPlatform(
  shell: CommandShellDefinition | undefined,
  platform: 'windows' | 'mac' | 'linux',
  value: string,
): CommandShellDefinition | undefined {
  const next: CommandShellDefinition = { ...(shell ?? {}) };
  if (platform === 'windows') {
    if (isWindowsCommandShell(value)) {
      next.windows = value;
    } else {
      delete next.windows;
    }
  } else if (platform === 'mac') {
    if (isMacCommandShell(value)) {
      next.mac = value;
    } else {
      delete next.mac;
    }
  } else if (isLinuxCommandShell(value)) {
    next.linux = value;
  } else {
    delete next.linux;
  }

  return Object.keys(next).length > 0 ? next : undefined;
}

const SHELL_PLATFORM_OPTIONS: ReadonlyArray<{
  readonly platform: 'mac' | 'windows' | 'linux';
  readonly rowLabel: string;
  /** The short label over the dropdown in the stacked layout. */
  readonly stackLabel: string;
  readonly ariaSuffix: string;
  readonly options: ReadonlyArray<{
    readonly value: string;
    readonly label: string;
  }>;
}> = [
  {
    platform: 'mac',
    rowLabel: 'Shell on macOS',
    stackLabel: 'Mac',
    ariaSuffix: 'Mac shell',
    options: [
      { value: '', label: 'Default' },
      { value: 'zsh', label: 'zsh' },
      { value: 'bash', label: 'bash' },
    ],
  },
  {
    platform: 'windows',
    rowLabel: 'Shell on Windows',
    stackLabel: 'Windows',
    ariaSuffix: 'Windows shell',
    options: [
      { value: '', label: 'Default' },
      { value: 'cmd', label: 'Command Prompt' },
      { value: 'powershell', label: 'PowerShell' },
      { value: 'bash', label: 'Git Bash' },
    ],
  },
  {
    platform: 'linux',
    rowLabel: 'Shell on Linux',
    stackLabel: 'Linux',
    ariaSuffix: 'Linux shell',
    options: [
      { value: '', label: 'Default (Bash)' },
      { value: 'bash', label: 'bash' },
      { value: 'zsh', label: 'zsh' },
    ],
  },
];

/** The stacked layout keeps its original Windows, Mac, Linux order. */
const STACK_SHELL_PLATFORM_ORDER = ['windows', 'mac', 'linux'] as const;

function ShellSelectionSection({
  label,
  shell,
  onChange,
  layout = 'stack',
}: {
  label: string;
  shell: CommandShellDefinition | undefined;
  onChange: (next: CommandShellDefinition | undefined) => void;
  layout?: 'stack' | 'settings';
}): JSX.Element {
  const shellRef = useRef(shell);
  useEffect(() => {
    shellRef.current = shell;
  }, [shell]);

  const updatePlatform = (
    platform: 'windows' | 'mac' | 'linux',
    value: string,
  ): void => {
    const next = updateShellPlatform(shellRef.current, platform, value);
    // React may batch platform selects before the parent rerenders.
    // Retain the eagerly emitted value so each change merges with the
    // first instead of rebuilding from a stale prop snapshot.
    shellRef.current = next;
    onChange(next);
  };

  if (layout === 'settings') {
    return (
      <>
        {SHELL_PLATFORM_OPTIONS.map((entry) => (
          <SettingsSubRow
            key={entry.platform}
            label={entry.rowLabel}
            control={
              <SettingsSelect
                aria-label={`${label} ${entry.ariaSuffix}`}
                value={shell?.[entry.platform] ?? ''}
                onValueChange={(value) => updatePlatform(entry.platform, value)}
                options={entry.options}
              />
            }
          />
        ))}
      </>
    );
  }

  return (
    <div className="flex flex-col pt-1 gap-1.5">
      <span className="text-2xs font-medium fg-secondary">Shell</span>
      <div className="grid gap-2 sm:grid-cols-2">
        {STACK_SHELL_PLATFORM_ORDER.map((platform) => {
          const entry = SHELL_PLATFORM_OPTIONS.find(
            (option) => option.platform === platform,
          );
          if (!entry) return null;
          return (
            <FormField key={platform} label={entry.stackLabel}>
              {(control) => (
                <SettingsSelect
                  {...control}
                  width="fill"
                  aria-label={`${label} ${entry.ariaSuffix}`}
                  value={shell?.[platform] ?? ''}
                  onValueChange={(value) => updatePlatform(platform, value)}
                  options={entry.options}
                />
              )}
            </FormField>
          );
        })}
      </div>
    </div>
  );
}

interface DevServerPatternsSectionProps {
  patterns: EditableDevServerPattern[] | undefined;
  onChange: (next: EditableDevServerPattern[] | undefined) => void;
  onValidityChange?: (invalidRowIds: string[]) => void;
  validityScopeKey?: string;
}

function DevServerPatternsSection({
  patterns,
  onChange,
  onValidityChange,
  validityScopeKey,
}: DevServerPatternsSectionProps): JSX.Element {
  const list = useMemo(() => patterns ?? [], [patterns]);
  const atCap = list.length >= MAX_SCRIPT_DEV_SERVER_PATTERNS;

  const invalidRowIds = useMemo<string[]>(
    () => invalidDevServerPatternRowIds(list),
    [list],
  );
  const onValidityChangeRef = useRef(onValidityChange);
  const validityScopeKeyRef = useRef(validityScopeKey);

  useEffect(() => {
    const previousScopeKey = validityScopeKeyRef.current;
    const previousValidityChange = onValidityChangeRef.current;
    if (previousScopeKey !== validityScopeKey) {
      previousValidityChange?.([]);
      validityScopeKeyRef.current = validityScopeKey;
    }
    onValidityChangeRef.current = onValidityChange;
  }, [onValidityChange, validityScopeKey]);

  useEffect(() => {
    onValidityChange?.(invalidRowIds);
  }, [invalidRowIds, onValidityChange]);

  useEffect(() => {
    return (): void => {
      onValidityChangeRef.current?.([]);
    };
  }, []);

  const updateRow = (
    index: number,
    next: Partial<
      Pick<
        EditableDevServerPattern,
        'pattern' | 'label' | 'openTarget' | 'autoOpen'
      >
    >,
  ): void => {
    const nextList = list.map((row, i) =>
      i === index ? { ...row, ...next } : row,
    );
    onChange(nextList);
  };

  const removeRow = (index: number): void => {
    const nextList = list.filter((_, i) => i !== index);
    onChange(nextList.length === 0 ? undefined : nextList);
  };

  const moveRow = (index: number, direction: -1 | 1): void => {
    const targetIndex = index + direction;
    if (targetIndex < 0 || targetIndex >= list.length) {
      return;
    }
    const nextList = [...list];
    const [moved] = nextList.splice(index, 1);
    nextList.splice(targetIndex, 0, moved);
    onChange(nextList);
  };

  const addRow = (): void => {
    if (atCap) {
      return;
    }
    const nextList = [...list, createEmptyEditableDevServerPattern()];
    onChange(nextList);
  };

  return (
    <Surface variant="outline" padding="compact">
      <div className="flex flex-col gap-2">
        <Stack gap="tight">
          <p className="text-xs font-medium fg-primary">Dev server patterns</p>
          <p className="text-2xs fg-secondary">
            Optional regex patterns. The first capture group, or the full match,
            must be an http(s) URL. Patterns are checked in order, and the first
            match labels the detected URL.
          </p>
          <p className="text-2xs fg-secondary">
            In {brandText.shortName} opens links in the Browser tab. URLs
            blocked by the Browser settings open externally.
          </p>
          <p className="text-2xs fg-secondary">
            Auto open opens each detected URL once per script run.
          </p>
        </Stack>
        {list.length === 0 ? (
          <p className="text-2xs fg-secondary">No dev server patterns</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {list.map((row, index) => {
              const trimmed = row.pattern.trim();
              const regexInvalid =
                trimmed.length > 0 && !isRegexParseable(trimmed);
              const patternTooLong =
                trimmed.length > MAX_SCRIPT_DEV_SERVER_PATTERN_LENGTH;
              const labelTooLong =
                row.label.trim().length > MAX_SCRIPT_DEV_SERVER_LABEL_LENGTH;
              const patternError = regexInvalid
                ? 'Invalid regex'
                : patternTooLong
                  ? `Pattern is too long (max ${MAX_SCRIPT_DEV_SERVER_PATTERN_LENGTH} characters)`
                  : undefined;
              const labelError = labelTooLong
                ? `Label is too long (max ${MAX_SCRIPT_DEV_SERVER_LABEL_LENGTH} characters)`
                : undefined;
              const isFirst = index === 0;
              const isLast = index === list.length - 1;
              return (
                <Surface
                  as="li"
                  variant="outline"
                  size="small"
                  padding="tight"
                  key={row.id}
                >
                  <div className="flex flex-col gap-1.5">
                    <div className="grid gap-2 md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_auto]">
                      <FormField label="Pattern" error={patternError}>
                        {(control) => (
                          <TextInput
                            {...control}
                            density="settings"
                            mono
                            type="text"
                            value={row.pattern}
                            onChange={(event) =>
                              updateRow(index, { pattern: event.target.value })
                            }
                            placeholder={'https?://localhost:\\d+\\S*'}
                            maxLength={MAX_SCRIPT_DEV_SERVER_PATTERN_LENGTH}
                          />
                        )}
                      </FormField>
                      <FormField label="Label" error={labelError}>
                        {(control) => (
                          <TextInput
                            {...control}
                            density="settings"
                            type="text"
                            value={row.label}
                            onChange={(event) =>
                              updateRow(index, { label: event.target.value })
                            }
                            placeholder="Web app"
                            maxLength={MAX_SCRIPT_DEV_SERVER_LABEL_LENGTH}
                          />
                        )}
                      </FormField>
                      <div className="flex items-start gap-1 md:pt-6">
                        <Button
                          variant="ghost"
                          size="compact"
                          iconOnly
                          onClick={(): void => moveRow(index, -1)}
                          disabled={isFirst}
                          aria-label="Move dev server pattern up"
                        >
                          ↑
                        </Button>
                        <Button
                          variant="ghost"
                          size="compact"
                          iconOnly
                          onClick={(): void => moveRow(index, 1)}
                          disabled={isLast}
                          aria-label="Move dev server pattern down"
                        >
                          ↓
                        </Button>
                        <Button
                          variant="ghost-destructive"
                          size="compact"
                          onClick={(): void => removeRow(index)}
                        >
                          Remove
                        </Button>
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-2xs fg-secondary">Open</span>
                      <SegmentedControl<'in-app' | 'external'>
                        label="Open target"
                        value={row.openTarget ?? null}
                        width="content"
                        shape="capsule"
                        options={[
                          {
                            value: 'in-app',
                            label: `In ${brandText.shortName}`,
                          },
                          { value: 'external', label: 'External' },
                        ]}
                        onChange={(openTarget): void =>
                          updateRow(index, { openTarget })
                        }
                      />
                      <div className="ml-auto flex items-center gap-2">
                        <span className="text-2xs fg-secondary">Auto open</span>
                        <ToggleSwitch
                          label="Auto open detected URL"
                          checked={row.autoOpen === true}
                          onChange={(autoOpen): void =>
                            updateRow(index, { autoOpen })
                          }
                          dataTestId="dev-server-pattern-auto-open"
                        />
                      </div>
                    </div>
                  </div>
                </Surface>
              );
            })}
          </ul>
        )}
        <div className="flex items-center gap-2">
          <Button
            size="compact"
            onClick={addRow}
            disabled={atCap}
            aria-disabled={atCap || undefined}
          >
            Add pattern
          </Button>
          {atCap && (
            <span className="text-2xs fg-secondary">
              Maximum {MAX_SCRIPT_DEV_SERVER_PATTERNS} patterns
            </span>
          )}
        </div>
      </div>
    </Surface>
  );
}

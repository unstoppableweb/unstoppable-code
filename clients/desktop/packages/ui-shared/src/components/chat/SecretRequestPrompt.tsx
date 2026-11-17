'use client';

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent,
} from 'react';
import { AGENT_SECRET_VALUE_MAX_LENGTH } from '@canopy/protocol/agent-secrets';
import {
  ClipboardIcon,
  CloseLargeIcon,
  EyeIcon,
  EyeOffIcon,
  KeyIcon,
} from '../../icons/AppIcons';
import { REPLAY_BLOCK_CLASS } from '../../lib/replay-privacy';
import { Button } from '../Button';
import { FormField } from '../FormField';
import { TextArea, TextInput } from '../Field';
import { Notice } from '../Notice';
import { OverlayScrollArea } from '../OverlayScrollArea';
import { SegmentedControl } from '../SegmentedControl';
import { ComposerIconButton } from './ComposerIconButton';
import { COMPOSER_PROMPT_HEADER_CLASS } from './ComposerPrompt';

/** One requested secret as the form shows it: metadata only. */
export interface SecretRequestPromptItem {
  readonly name: string;
  readonly label?: string;
  readonly description?: string;
  readonly kind?: 'password' | 'token' | 'multiline';
  /** Defaults to true. */
  readonly required?: boolean;
  readonly hint?: { readonly prefix?: string; readonly minLength?: number };
  /** The chat already holds a value for this name. */
  readonly held?: boolean;
}

export interface SecretRequestPromptSubmission {
  /** Entered values by name, only for fields the person filled in. */
  readonly values: Readonly<Record<string, string>>;
  /** Held names the person chose to keep using. */
  readonly useHeld: readonly string[];
}

export interface SecretRequestPromptProps {
  /** The agent asking, such as Claude or Codex. */
  readonly agentName: string;
  readonly reason: string;
  readonly items: readonly SecretRequestPromptItem[];
  /**
   * Footer copy: `ask` for Ask and Accept edits, `full` for Full access,
   * `cloud` for a cloud chat, whose values go to its cloud workspace.
   */
  readonly accessMode: 'ask' | 'full' | 'cloud';
  /** `session` when secure storage is unavailable: values stay in memory. */
  readonly storage: 'encrypted' | 'session';
  readonly busy: 'submit' | 'decline' | null;
  readonly errorKind: 'submit' | 'decline' | null;
  /** Why the last submission was refused, when the host knows. */
  readonly errorMessage?: string;
  readonly disconnected?: boolean;
  /**
   * Why this viewer can't answer, when they can't (a guest, or someone who
   * can't send in the chat): the form shows locked with this hint.
   */
  readonly readOnlyHint?: string;
  readonly onSubmit: (submission: SecretRequestPromptSubmission) => void;
  readonly onDecline: () => void;
  /** Closes the prompt and keeps the request waiting. */
  readonly onClose: () => void;
}

/** Below this, output redaction may miss a value (it matches 4+ characters). */
const SHORT_VALUE_WARNING_LENGTH = 8;

const DOTENV_LINE =
  /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/;

/**
 * Pasted `.env` text as values for the requested names only: `KEY=value`,
 * `export KEY=value`, single or double quotes, `#` comments and CRLF line
 * ends. Unknown keys and empty values are ignored.
 */
export function parseDotenvForSecrets(
  text: string,
  names: readonly string[],
): Record<string, string> {
  const wanted = new Set(names);
  const values: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(?:#|$)/.test(line)) continue;
    const match = DOTENV_LINE.exec(line);
    if (!match) continue;
    const [, key, raw] = match;
    if (key === undefined || raw === undefined || !wanted.has(key)) continue;
    let value: string;
    const quote = raw[0];
    if ((quote === '"' || quote === "'") && raw.length >= 2) {
      // The value ends at the first closing quote (a backslash escapes one in
      // double quotes), so a trailing comment never joins it.
      let end = 1;
      while (end < raw.length && raw[end] !== quote)
        end += quote === '"' && raw[end] === '\\' ? 2 : 1;
      if (end >= raw.length) continue;
      value = raw.slice(1, end);
      if (quote === '"')
        value = value
          .replace(/\\n/g, '\n')
          .replace(/\\"/g, '"')
          .replace(/\\\\/g, '\\');
    } else {
      // An unquoted value ends at an inline comment.
      value = raw.replace(/\s+#.*$/, '');
    }
    if (value.length > 0) values[key] = value;
  }
  return values;
}

type FieldMode = 'held' | 'enter';

interface FieldCheck {
  readonly blocking?: string;
  readonly warning?: string;
  readonly ok?: string;
}

function checkValue(item: SecretRequestPromptItem, value: string): FieldCheck {
  if (value.trim().length === 0) return {};
  if (value.length > AGENT_SECRET_VALUE_MAX_LENGTH)
    return {
      blocking: `Use at most ${AGENT_SECRET_VALUE_MAX_LENGTH.toLocaleString('en-US')} characters.`,
    };
  const minLength = item.hint?.minLength;
  if (minLength !== undefined && value.length < minLength)
    return { blocking: `Use at least ${minLength} characters.` };
  const prefix = item.hint?.prefix;
  if (prefix !== undefined && !value.startsWith(prefix))
    return { warning: `Usually starts with ${prefix}. Check the value.` };
  if (value.length < SHORT_VALUE_WARNING_LENGTH)
    return {
      warning:
        'Short values may not be redacted from command output. Use the full value if there is one.',
      ...(prefix !== undefined ? { ok: `Starts with ${prefix}` } : {}),
    };
  return prefix !== undefined ? { ok: `Starts with ${prefix}` } : {};
}

function labelOf(item: SecretRequestPromptItem): string {
  return item.label ?? item.name;
}

/** Masks a multiline field's text (inherited) without changing what it holds. */
const MULTILINE_MASK_CLASS = 'secret-text-mask';

const FOOTER_COPY: Record<SecretRequestPromptProps['accessMode'], string> = {
  ask: 'Hidden from the agent. It can use the value in commands; output is redacted.',
  full: "Available to the agent's commands. The agent could print it, so redaction is best effort.",
  cloud: "Sent to this chat's cloud workspace and stored encrypted.",
};

/**
 * The composer while an agent waits on secrets (RequestSecrets): the
 * agent's reason and one masked field per secret, named by its environment
 * variable. Values live only in this component's state: they are cleared as
 * they are sent, on Decline and when the prompt unmounts, and they never
 * reach a draft, a store or the composer. x or Escape closes the prompt and
 * keeps the request waiting.
 */
export function SecretRequestPrompt({
  agentName,
  reason,
  items,
  accessMode,
  storage,
  busy,
  errorKind,
  errorMessage,
  disconnected = false,
  readOnlyHint,
  onSubmit,
  onDecline,
  onClose,
}: SecretRequestPromptProps): JSX.Element {
  const titleId = useId();
  const pasteId = useId();
  const firstFieldRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(
    null,
  );
  const [values, setValues] = useState<Record<string, string>>({});
  const [visible, setVisible] = useState<Record<string, boolean>>({});
  const [modes, setModes] = useState<Record<string, FieldMode>>({});
  const [attempted, setAttempted] = useState(false);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const [pasteResult, setPasteResult] = useState<string | null>(null);
  const locked = busy !== null || disconnected || readOnlyHint !== undefined;

  // Values never outlive the prompt.
  useEffect(
    () => (): void => {
      setValues({});
      setPasteText('');
    },
    [],
  );

  const modeOf = (item: SecretRequestPromptItem): FieldMode =>
    item.held === true ? (modes[item.name] ?? 'held') : 'enter';

  const checks = useMemo(
    () =>
      new Map(
        items.map((item) => [
          item.name,
          checkValue(item, values[item.name] ?? ''),
        ]),
      ),
    [items, values],
  );

  const missingRequired = items.filter(
    (item) =>
      item.required !== false &&
      modeOf(item) === 'enter' &&
      (values[item.name] ?? '').trim().length === 0,
  );
  const blocked = items.some(
    (item) =>
      modeOf(item) === 'enter' && checks.get(item.name)?.blocking !== undefined,
  );
  const provideCount = items.filter(
    (item) =>
      modeOf(item) === 'held' || (values[item.name] ?? '').trim().length > 0,
  ).length;
  const canSubmit =
    !locked && missingRequired.length === 0 && !blocked && provideCount > 0;

  const submit = (): void => {
    setAttempted(true);
    if (!canSubmit) return;
    const entered: Record<string, string> = {};
    const useHeld: string[] = [];
    for (const item of items) {
      if (modeOf(item) === 'held') useHeld.push(item.name);
      else {
        const value = values[item.name] ?? '';
        if (value.trim().length > 0) entered[item.name] = value;
      }
    }
    // Cleared as sent, pasted text included: a failed send asks for the
    // values again.
    setValues({});
    setVisible({});
    setPasteText('');
    setPasteOpen(false);
    setAttempted(false);
    onSubmit({ values: entered, useHeld });
  };

  const decline = (): void => {
    setValues({});
    setVisible({});
    setPasteText('');
    onDecline();
  };

  const applyPaste = (): void => {
    const parsed = parseDotenvForSecrets(
      pasteText,
      items
        .filter((item) => modeOf(item) === 'enter' || item.held)
        .map((item) => item.name),
    );
    setPasteText('');
    const names = Object.keys(parsed);
    setPasteResult(
      names.length === 0
        ? 'No requested names found in the pasted text.'
        : `Filled ${names.length} of ${items.length}.`,
    );
    if (names.length === 0) return;
    setValues((current) => ({ ...current, ...parsed }));
    setModes((current) => {
      const next = { ...current };
      for (const name of names) next[name] = 'enter';
      return next;
    });
    setPasteOpen(false);
  };

  const handleFieldKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
    event.preventDefault();
    submit();
  };

  useEffect(() => {
    firstFieldRef.current?.focus();
  }, []);

  const notice = readOnlyHint
    ? { intent: 'neutral' as const, message: readOnlyHint }
    : disconnected
      ? {
          intent: 'neutral' as const,
          message: 'Reconnect to provide secrets.',
        }
      : errorKind === 'submit'
        ? {
            intent: 'destructive' as const,
            message: errorMessage
              ? `${errorMessage} Enter the values again.`
              : "Couldn't send the secrets. Enter them again.",
          }
        : errorKind === 'decline'
          ? {
              intent: 'destructive' as const,
              message: "Couldn't decline. The request is still waiting.",
            }
          : null;

  const title =
    items.length === 1
      ? `${agentName} needs a secret`
      : `${agentName} needs ${items.length} secrets`;
  let firstInputAssigned = false;

  return (
    <div
      data-testid="chat-secret-request-prompt"
      role="group"
      aria-labelledby={titleId}
      className="flex flex-col gap-2 pb-1 text-pretty"
      onKeyDown={(event): void => {
        if (event.key !== 'Escape' || event.defaultPrevented) return;
        event.preventDefault();
        onClose();
      }}
    >
      <div className={`${COMPOSER_PROMPT_HEADER_CLASS} items-start`}>
        <span aria-hidden className="shrink-0 pt-1.5 fg-secondary">
          <KeyIcon size={16} />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5 py-1">
          <div id={titleId} className="text-s font-medium fg-primary">
            {title}
          </div>
          <div
            className={`${REPLAY_BLOCK_CLASS} text-s fg-secondary break-words`}
          >
            {reason}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="compact"
            disabled={locked}
            aria-expanded={pasteOpen}
            aria-controls={pasteId}
            onClick={(): void => {
              setPasteOpen((open) => !open);
              setPasteResult(null);
            }}
            data-testid="chat-secret-request-paste-toggle"
          >
            <ClipboardIcon size={14} />
            Paste .env
          </Button>
          <ComposerIconButton
            capsule
            tone="strong"
            aria-label="Close"
            onClick={onClose}
            data-testid="chat-secret-request-close"
          >
            <CloseLargeIcon size={16} />
          </ComposerIconButton>
        </div>
      </div>

      <form
        className="flex flex-col gap-3 px-3"
        autoComplete="off"
        noValidate
        onSubmit={(event): void => {
          event.preventDefault();
          submit();
        }}
      >
        {pasteOpen && (
          <div id={pasteId} className="flex flex-col gap-2">
            <FormField
              label="Paste .env lines"
              description="Only the requested names are used. The text is cleared after reading."
            >
              {(control) => (
                <div className={REPLAY_BLOCK_CLASS}>
                  <TextArea
                    {...control}
                    mono
                    rows={3}
                    autoComplete="off"
                    spellCheck={false}
                    value={pasteText}
                    onChange={(event): void => setPasteText(event.target.value)}
                    data-testid="chat-secret-request-paste"
                  />
                </div>
              )}
            </FormField>
            <div>
              <Button
                type="button"
                size="compact"
                disabled={locked || pasteText.trim().length === 0}
                onClick={applyPaste}
                data-testid="chat-secret-request-paste-apply"
              >
                Fill fields
              </Button>
            </div>
          </div>
        )}
        {pasteResult !== null && (
          <div className="text-xs fg-secondary" role="status">
            {pasteResult}
          </div>
        )}

        {/* Many secrets scroll within the box; the actions stay in view. */}
        <OverlayScrollArea viewportClassName="max-h-[min(40vh,24rem)]">
          <div className="flex flex-col gap-3 p-1">
            {items.map((item) => {
              const mode = modeOf(item);
              const value = values[item.name] ?? '';
              const check = checks.get(item.name) ?? {};
              const shown = visible[item.name] === true;
              const missing =
                attempted &&
                item.required !== false &&
                mode === 'enter' &&
                value.trim().length === 0;
              const error = missing
                ? `Enter ${labelOf(item)}.`
                : attempted && check.blocking
                  ? check.blocking
                  : undefined;
              const assignFirst = !firstInputAssigned && mode === 'enter';
              if (assignFirst) firstInputAssigned = true;
              const toggle = (
                <ComposerIconButton
                  capsule
                  aria-label={
                    shown ? `Hide ${labelOf(item)}` : `Show ${labelOf(item)}`
                  }
                  aria-pressed={shown}
                  disabled={locked}
                  onClick={(): void =>
                    setVisible((current) => ({
                      ...current,
                      [item.name]: !shown,
                    }))
                  }
                  data-testid={`chat-secret-request-toggle-${item.name}`}
                >
                  {shown ? <EyeOffIcon size={14} /> : <EyeIcon size={14} />}
                </ComposerIconButton>
              );
              return (
                <div key={item.name} className="flex flex-col gap-1.5">
                  <FormField
                    label={
                      <span className="inline-flex flex-wrap items-center gap-2">
                        <span>{labelOf(item)}</span>
                        <span className="rounded-sm bg-subtle px-1.5 py-0.5 font-mono text-xs fg-secondary">
                          {item.name}
                        </span>
                      </span>
                    }
                    {...(item.required === false
                      ? { labelMeta: 'Optional' }
                      : {})}
                    {...(item.description !== undefined
                      ? {
                          // Agent-supplied text: blocked from session replay.
                          description: (
                            <span className={REPLAY_BLOCK_CLASS}>
                              {item.description}
                            </span>
                          ),
                        }
                      : {})}
                    {...(error !== undefined ? { error } : {})}
                    dataTestId={`chat-secret-request-field-${item.name}`}
                  >
                    {(control) =>
                      item.held === true && mode === 'held' ? (
                        <SegmentedControl<FieldMode>
                          label={`${labelOf(item)} value`}
                          value={mode}
                          semantics="radio"
                          onChange={(next): void =>
                            setModes((current) => ({
                              ...current,
                              [item.name]: next,
                            }))
                          }
                          options={[
                            { value: 'held', label: "Use this chat's value" },
                            { value: 'enter', label: 'Enter new' },
                          ]}
                        />
                      ) : (
                        <div className="flex flex-col gap-1.5">
                          {item.held === true && (
                            <SegmentedControl<FieldMode>
                              label={`${labelOf(item)} value`}
                              value={mode}
                              semantics="radio"
                              onChange={(next): void =>
                                setModes((current) => ({
                                  ...current,
                                  [item.name]: next,
                                }))
                              }
                              options={[
                                {
                                  value: 'held',
                                  label: "Use this chat's value",
                                },
                                { value: 'enter', label: 'Enter new' },
                              ]}
                            />
                          )}
                          <div
                            className={
                              item.kind === 'multiline' && !shown
                                ? `${REPLAY_BLOCK_CLASS} ${MULTILINE_MASK_CLASS}`
                                : REPLAY_BLOCK_CLASS
                            }
                          >
                            {item.kind === 'multiline' ? (
                              // A textarea keeps line breaks (PEM keys, JSON
                              // credentials) in both states; masking is visual.
                              <TextArea
                                {...control}
                                mono
                                rows={4}
                                autoComplete="off"
                                spellCheck={false}
                                disabled={locked}
                                value={value}
                                ref={
                                  assignFirst
                                    ? (element): void => {
                                        firstFieldRef.current = element;
                                      }
                                    : undefined
                                }
                                placeholder={
                                  item.required === false
                                    ? 'Leave empty to skip'
                                    : undefined
                                }
                                onChange={(event): void =>
                                  setValues((current) => ({
                                    ...current,
                                    [item.name]: event.target.value,
                                  }))
                                }
                                data-testid={`chat-secret-request-input-${item.name}`}
                              />
                            ) : (
                              <TextInput
                                {...control}
                                type={shown ? 'text' : 'password'}
                                mono
                                autoComplete="off"
                                spellCheck={false}
                                disabled={locked}
                                value={value}
                                ref={
                                  assignFirst
                                    ? (element): void => {
                                        firstFieldRef.current = element;
                                      }
                                    : undefined
                                }
                                placeholder={
                                  item.required === false
                                    ? 'Leave empty to skip'
                                    : undefined
                                }
                                trailing={toggle}
                                onKeyDown={handleFieldKeyDown}
                                onChange={(event): void =>
                                  setValues((current) => ({
                                    ...current,
                                    [item.name]: event.target.value,
                                  }))
                                }
                                data-testid={`chat-secret-request-input-${item.name}`}
                              />
                            )}
                          </div>
                          {item.kind === 'multiline' && <div>{toggle}</div>}
                        </div>
                      )
                    }
                  </FormField>
                  {mode === 'enter' && (check.ok || check.warning) && (
                    <div className="flex flex-col gap-0.5 text-xs">
                      {check.ok && (
                        <span className="fg-positive">{check.ok}</span>
                      )}
                      {check.warning && (
                        <span className="fg-attention">{check.warning}</span>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </OverlayScrollArea>

        {notice && (
          <Notice
            errorSource="chat-secret-request-notice"
            intent={notice.intent}
            data-testid="chat-secret-request-notice"
          >
            {notice.message}
          </Notice>
        )}

        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button
            type="button"
            size="compact"
            disabled={locked}
            onClick={decline}
            data-testid="chat-secret-request-decline"
          >
            Decline
          </Button>
          <Button
            type="submit"
            variant="primary"
            size="compact"
            disabled={locked || (attempted && !canSubmit)}
            data-testid="chat-secret-request-provide"
          >
            {provideCount <= 1 ? 'Provide' : `Provide ${provideCount}`}
          </Button>
        </div>

        <div className="flex items-start gap-2 text-xs fg-tertiary">
          <span aria-hidden className="shrink-0 pt-0.5">
            <EyeOffIcon size={12} />
          </span>
          <div className="flex flex-col gap-0.5">
            <span data-testid="chat-secret-request-footer">
              {FOOTER_COPY[accessMode]}
            </span>
            {storage === 'session' && (
              <span data-testid="chat-secret-request-session-storage">
                Secure storage is unavailable, so these values are kept only
                until you quit.
              </span>
            )}
          </div>
        </div>
      </form>
    </div>
  );
}

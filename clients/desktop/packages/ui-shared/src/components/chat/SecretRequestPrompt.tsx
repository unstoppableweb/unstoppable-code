'use client';

import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent,
  type ReactNode,
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
import { ConfirmDialog } from '../ConfirmDialog';
import { FORM_FIELD_DESCRIPTION_CLASS, FormField } from '../FormField';
import { TextArea, TextInput } from '../Field';
import { Notice } from '../Notice';
import { OverlayScrollArea } from '../OverlayScrollArea';
import { SegmentedControl } from '../SegmentedControl';
import { TextLink } from '../TextLink';
import { useChatAppName } from '../chat-look';
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

/**
 * A value that doesn't start with its hint's prefix. `partial` while the
 * value is still a leading part of the prefix (`shp` for `shpat_`): the
 * person may still be typing, so it shows only after a submit attempt.
 */
interface PrefixMismatch {
  readonly prefix: string;
  readonly partial: boolean;
}

interface FieldCheck {
  readonly blocking?: string;
  readonly warning?: string;
  readonly ok?: string;
  /** Computed apart from `blocking`: a length error never hides it. */
  readonly mismatch?: PrefixMismatch;
}

function checkValue(item: SecretRequestPromptItem, value: string): FieldCheck {
  if (value.trim().length === 0) return {};
  const prefix =
    item.hint?.prefix !== undefined && item.hint.prefix.length > 0
      ? item.hint.prefix
      : undefined;
  // Raw and case-sensitive: the value is compared exactly as it is sent.
  const mismatch: PrefixMismatch | undefined =
    prefix !== undefined && !value.startsWith(prefix)
      ? { prefix, partial: prefix.startsWith(value) }
      : undefined;
  const withMismatch = mismatch !== undefined ? { mismatch } : {};
  if (value.length > AGENT_SECRET_VALUE_MAX_LENGTH)
    return {
      blocking: `Use at most ${AGENT_SECRET_VALUE_MAX_LENGTH.toLocaleString('en-US')} characters.`,
      ...withMismatch,
    };
  const minLength = item.hint?.minLength;
  if (minLength !== undefined && value.length < minLength)
    return {
      blocking: `Use at least ${minLength} characters.`,
      ...withMismatch,
    };
  if (mismatch !== undefined) return { mismatch };
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

// CAN-7049: a value that misses its prefix is often the wrong secret, and the
// one that matters most is an account sign-in password typed in by habit. The
// copy names that case plainly and never promises the hint is right.
function mismatchCopy(prefix: string): string {
  return `This doesn't look like the value asked for. It usually starts with ${prefix}. Never enter an account sign-in password here.`;
}

function loginHelperCopy(appName: string | undefined): string {
  return appName !== undefined && appName.length > 0
    ? `Don't enter your account sign-in password here. ${appName} never needs it. Not sure? Choose Decline; none of these values will be sent.`
    : "Don't enter your account sign-in password here. Not sure? Choose Decline; none of these values will be sent.";
}

/** A description's link, as the form shows it: the parsed target and host. */
interface DescriptionLink {
  readonly href: string;
  readonly host: string;
}

const URL_TRAILING_PUNCTUATION = /[.,;:!?]$/;
// Characters that make a token's end ambiguous; such a token stays text.
const URL_AMBIGUOUS_CHARACTERS = /["'“”‘’<>`\\]/;

function countOf(text: string, character: string): number {
  return text.split(character).length - 1;
}

/**
 * The first standalone `https:` URL in an agent's description, as a link
 * placed after the remaining text. Only that token moves: other URLs, and
 * anything malformed, plain `http:`, or carrying credentials, stay text. A
 * trailing sentence mark or an unbalanced `)` stays in the text; a query,
 * fragment or balanced path parenthesis stays in the URL. A visible host
 * is not a trust signal, so the link never says official or verified.
 */
function splitDescriptionLink(description: string): {
  readonly text: string;
  readonly link: DescriptionLink | null;
} {
  const token = /\S+/g;
  for (
    let match = token.exec(description);
    match !== null;
    match = token.exec(description)
  ) {
    const raw = match[0];
    const lead = raw.startsWith('(') ? 1 : 0;
    if (!/^https:\/\//i.test(raw.slice(lead))) continue;
    let candidate = raw.slice(lead);
    // A final mark in a query/fragment can be part of its value. Do not
    // guess a shorter destination when sentence boundaries are ambiguous.
    if (/[?#]/.test(candidate) && /[.,;:!?)]$/.test(candidate)) continue;
    let trimming = true;
    while (trimming) {
      trimming =
        URL_TRAILING_PUNCTUATION.test(candidate) ||
        (candidate.endsWith(')') &&
          countOf(candidate, ')') > countOf(candidate, '('));
      if (trimming) candidate = candidate.slice(0, -1);
    }
    if (countOf(candidate, '(') !== countOf(candidate, ')')) continue;
    if (URL_AMBIGUOUS_CHARACTERS.test(candidate)) continue;
    let parsed: URL;
    try {
      parsed = new URL(candidate);
    } catch {
      continue;
    }
    if (
      parsed.protocol !== 'https:' ||
      parsed.hostname.length === 0 ||
      parsed.username.length > 0 ||
      parsed.password.length > 0
    )
      continue;
    const start = match.index + lead;
    let before = description.slice(0, start);
    const after = description.slice(start + candidate.length);
    // No space left before a sentence mark the URL sat in front of.
    if (after.length === 0 || /^[\s.,;:!?)]/.test(after))
      before = before.replace(/\s+$/, '');
    return {
      text: `${before}${after}`.trim(),
      link: { href: parsed.href, host: parsed.hostname },
    };
  }
  return { text: description, link: null };
}

/** An open Send anyway confirmation, bound to the submission it was asked for. */
interface PendingConfirmation {
  /** The value revision when it opened; any later edit invalidates it. */
  readonly revision: number;
  /** The request's metadata when it opened. */
  readonly requestKey: string;
  /** The prompt's own document, so a popped-out window gets the dialog. */
  readonly ownerDocument: Document;
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
 *
 * A value that misses its hint's prefix is a nudge, not a block (the hint
 * may be wrong): Provide and Enter both open a Send anyway confirmation, and
 * only its explicit Send anyway sends. That confirmation covers the whole
 * submission and lapses when the values or the request change (CAN-7049).
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
  const helperId = useId();
  const appName = useChatAppName();
  const rootRef = useRef<HTMLDivElement | null>(null);
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
  // Counts edits to values and modes, so a confirmation can tell whether the
  // submission it was asked about is still the one on screen without
  // keeping a second copy of the secrets.
  const [revision, setRevision] = useState(0);
  const [confirmation, setConfirmation] = useState<PendingConfirmation | null>(
    null,
  );
  // Single flight: set while a confirmation is open or a send has started in
  // this event, before React re-renders, so overlapping key and submit
  // events can't open two dialogs or send twice.
  const gateRef = useRef<'idle' | 'confirming' | 'sending' | 'closed'>('idle');
  const activeConfirmationRef = useRef<PendingConfirmation | null>(null);
  const locked = busy !== null || disconnected || readOnlyHint !== undefined;
  // Metadata only (never values): a different request, or changed hints,
  // invalidates an open confirmation.
  const requestKey = useMemo(
    () => JSON.stringify({ agentName, reason, items }),
    [agentName, reason, items],
  );

  const setValue = (name: string, value: string): void => {
    cancelConfirmation();
    setValues((current) => ({ ...current, [name]: value }));
    setRevision((current) => current + 1);
  };
  const setMode = (name: string, mode: FieldMode): void => {
    cancelConfirmation();
    setModes((current) => ({ ...current, [name]: mode }));
    setRevision((current) => current + 1);
  };

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
  // Every entered value that misses its prefix, shown or not: the gate asks
  // about a partial-prefix value too.
  const mismatched = items.flatMap((item) => {
    const mismatch = checks.get(item.name)?.mismatch;
    return modeOf(item) === 'enter' && mismatch !== undefined
      ? [{ item, mismatch }]
      : [];
  });

  /** The message under a field: missing, then blocking, then a mismatch. */
  const fieldErrorOf = (
    item: SecretRequestPromptItem,
  ): { readonly text: string; readonly mismatch: boolean } | undefined => {
    if (modeOf(item) !== 'enter') return undefined;
    const value = values[item.name] ?? '';
    const check = checks.get(item.name) ?? {};
    if (attempted && item.required !== false && value.trim().length === 0)
      return { text: `Enter ${labelOf(item)}.`, mismatch: false };
    if (attempted && check.blocking !== undefined)
      return { text: check.blocking, mismatch: false };
    // Design deviation (docs/design/forms.md shows errors after submit): a
    // prefix mismatch shows while typing, so the person sees it before
    // choosing to send. A partial prefix waits for an attempt (CAN-7049).
    if (check.mismatch !== undefined && (attempted || !check.mismatch.partial))
      return { text: mismatchCopy(check.mismatch.prefix), mismatch: true };
    return undefined;
  };
  const shownMismatches = items.flatMap((item) => {
    const error = fieldErrorOf(item);
    return error?.mismatch === true ? [{ item, text: error.text }] : [];
  });
  // Stable while the same fields mismatch, so typing doesn't re-announce.
  const mismatchAnnouncement =
    shownMismatches.length === 1 && items.length === 1
      ? (shownMismatches[0]?.text ?? '')
      : shownMismatches
          .map(({ item, text }) => `${labelOf(item)}: ${text}`)
          .join(' ');
  const hasTypedField = items.some((item) => modeOf(item) === 'enter');

  const confirmationValid =
    confirmation !== null &&
    confirmation.revision === revision &&
    confirmation.requestKey === requestKey &&
    canSubmit &&
    mismatched.length > 0;

  // A retained callback must compare against the latest committed state,
  // not the render in which that callback opened its dialog. No secrets are
  // copied into this identity/eligibility record.
  const submissionRef = useRef({ revision, requestKey, canSubmit });
  useLayoutEffect(() => {
    submissionRef.current = { revision, requestKey, canSubmit };
    if (!confirmationValid) activeConfirmationRef.current = null;
  });
  // Clearing entered values can leave held/optional values eligible. Keep
  // that delivery single-flight until the host completes it or the person
  // changes the submission (setValue/setMode also release the gate).
  useLayoutEffect(() => {
    if (!locked && gateRef.current === 'sending') gateRef.current = 'idle';
  }, [requestKey, locked]);
  useLayoutEffect(() => {
    gateRef.current = 'idle';
    return (): void => {
      activeConfirmationRef.current = null;
      gateRef.current = 'closed';
    };
  }, []);

  // A confirmation for a submission that changed underneath it (an edit, a
  // new request, a lock) lapses; the dialog is already hidden by
  // `confirmationValid`, and the next submission goes through the gate.
  useEffect(() => {
    if (confirmation === null || confirmationValid) return;
    gateRef.current = 'idle';
    setConfirmation(null);
  }, [confirmation, confirmationValid]);

  const send = (): void => {
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
    setPasteResult(null);
    setAttempted(false);
    setConfirmation(null);
    setRevision((current) => current + 1);
    onSubmit({ values: entered, useHeld });
  };

  /**
   * Every submission (Provide, Enter, the form's submit) comes through here:
   * it marks the attempt, validates, then asks to confirm a mismatch or
   * sends. Opening the confirmation sends nothing.
   */
  const requestSubmit = (): void => {
    if (gateRef.current !== 'idle') return;
    setAttempted(true);
    if (!canSubmit) return;
    if (mismatched.length > 0) {
      gateRef.current = 'confirming';
      const pending: PendingConfirmation = {
        revision,
        requestKey,
        ownerDocument: rootRef.current?.ownerDocument ?? document,
      };
      activeConfirmationRef.current = pending;
      setConfirmation(pending);
      return;
    }
    gateRef.current = 'sending';
    send();
  };

  function cancelConfirmation(): void {
    activeConfirmationRef.current = null;
    gateRef.current = 'idle';
    setConfirmation(null);
  }

  const close = (): void => {
    cancelConfirmation();
    gateRef.current = 'closed';
    onClose();
  };

  /** Only the dialog's Send anyway action sends a mismatched submission. */
  const confirmSend = (): void => {
    if (
      gateRef.current !== 'confirming' ||
      confirmation === null ||
      activeConfirmationRef.current !== confirmation
    )
      return;
    const current = submissionRef.current;
    cancelConfirmation();
    // Rechecked here, not only at render: a stale dialog never sends.
    if (
      !current.canSubmit ||
      current.revision !== confirmation.revision ||
      current.requestKey !== confirmation.requestKey
    )
      return;
    gateRef.current = 'sending';
    send();
  };

  const decline = (): void => {
    cancelConfirmation();
    setValues({});
    setVisible({});
    setPasteText('');
    setPasteOpen(false);
    setPasteResult(null);
    setAttempted(false);
    setRevision((current) => current + 1);
    onDecline();
  };

  const applyPaste = (): void => {
    cancelConfirmation();
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
    setRevision((current) => current + 1);
    setPasteOpen(false);
  };

  const handleFieldKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
    event.preventDefault();
    // A held Enter repeats: only the first press submits.
    if (event.repeat) return;
    requestSubmit();
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
  const confirmationOpen = confirmation !== null && confirmationValid;
  let confirmationMessage: ReactNode = null;
  if (confirmationOpen) {
    const [only] = mismatched;
    const whole =
      provideCount > 1
        ? " Sending will provide all the values you've supplied."
        : '';
    confirmationMessage =
      mismatched.length === 1 && only !== undefined ? (
        <span className={REPLAY_BLOCK_CLASS}>
          The value for “{labelOf(only.item)}” doesn't start with{' '}
          <span className="font-mono">{only.mismatch.prefix}</span>, so it may
          be the wrong value. If it's an account sign-in password, choose
          Cancel.
          {whole}
        </span>
      ) : (
        <span className={`${REPLAY_BLOCK_CLASS} flex flex-col gap-1.5`}>
          <span>
            These values don't start with their expected prefixes and may be
            wrong:
          </span>
          <ul className="list-disc pl-5">
            {mismatched.map(({ item, mismatch }) => (
              <li key={item.name}>
                {labelOf(item)}: usually starts with{' '}
                <span className="font-mono">{mismatch.prefix}</span>
              </li>
            ))}
          </ul>
          <span>
            If any is an account sign-in password, choose Cancel.{whole}
          </span>
        </span>
      );
  }

  return (
    <div
      ref={rootRef}
      data-testid="chat-secret-request-prompt"
      role="group"
      aria-labelledby={titleId}
      className="flex flex-col gap-2 pb-1 text-pretty"
      onKeyDown={(event): void => {
        // The confirmation portals out but its key events still bubble here
        // through React. Leave them to the dialog: its own Escape closes only
        // it, and a held Enter that opened it must not answer it.
        if (confirmation !== null) {
          if (event.key === 'Enter' && event.repeat) event.preventDefault();
          return;
        }
        if (event.key !== 'Escape' || event.defaultPrevented) return;
        // Another portaled overlay inside this tree answers its own Escape.
        // The window's own `Node`, so a popped-out window's nodes match.
        const view = event.currentTarget.ownerDocument.defaultView;
        if (
          view !== null &&
          event.target instanceof view.Node &&
          !event.currentTarget.contains(event.target)
        )
          return;
        event.preventDefault();
        close();
      }}
    >
      <div className={`${COMPOSER_PROMPT_HEADER_CLASS} items-start`}>
        <span aria-hidden className="shrink-0 pt-1.5 fg-secondary">
          <KeyIcon size={16} />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5 py-1">
          <div id={titleId} className="text-s font-medium fg-primary">
            <span className={REPLAY_BLOCK_CLASS}>{title}</span>
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
            onClick={close}
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
          requestSubmit();
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
              const error = fieldErrorOf(item)?.text;
              const description =
                item.description !== undefined
                  ? splitDescriptionLink(item.description)
                  : null;
              const assignFirst = !firstInputAssigned && mode === 'enter';
              if (assignFirst) firstInputAssigned = true;
              const toggle = (
                <ComposerIconButton
                  capsule
                  aria-labelledby={`${helperId}-${item.name}-visibility`}
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
                  <span
                    id={`${helperId}-${item.name}-visibility`}
                    className={`${REPLAY_BLOCK_CLASS} sr-only`}
                  >
                    {shown ? `Hide ${labelOf(item)}` : `Show ${labelOf(item)}`}
                  </span>
                  {shown ? <EyeOffIcon size={14} /> : <EyeIcon size={14} />}
                </ComposerIconButton>
              );
              return (
                <div key={item.name} className="flex flex-col gap-1.5">
                  <FormField
                    label={
                      <span className="inline-flex flex-wrap items-center gap-2">
                        <span
                          id={`${helperId}-${item.name}-label`}
                          className={REPLAY_BLOCK_CLASS}
                        >
                          {labelOf(item)}
                        </span>
                        <span
                          className={`${REPLAY_BLOCK_CLASS} rounded-sm bg-subtle px-1.5 py-0.5 font-mono text-xs fg-secondary`}
                        >
                          {item.name}
                        </span>
                      </span>
                    }
                    {...(item.required === false
                      ? { labelMeta: 'Optional' }
                      : {})}
                    {...(description !== null
                      ? {
                          // Agent-supplied text and link: blocked from
                          // session replay. Escaped text, never markup.
                          description: (
                            <span className={REPLAY_BLOCK_CLASS}>
                              {description.text}
                              {description.link !== null && (
                                <>
                                  {description.text.length > 0 ? ' ' : null}
                                  <TextLink
                                    href={description.link.href}
                                    variant="inline"
                                    replayBlock
                                    data-testid={`chat-secret-request-description-link-${item.name}`}
                                  >
                                    Where to find it ({description.link.host})
                                  </TextLink>
                                </>
                              )}
                            </span>
                          ),
                        }
                      : {})}
                    {...(error !== undefined ? { error } : {})}
                    dataTestId={`chat-secret-request-field-${item.name}`}
                  >
                    {(formControl) => {
                      // Every typed field also points at the login helper.
                      const control = {
                        ...formControl,
                        'aria-describedby': [
                          formControl['aria-describedby'],
                          helperId,
                        ]
                          .filter(
                            (id): id is string =>
                              id !== undefined && id.length > 0,
                          )
                          .join(' '),
                      };
                      return item.held === true && mode === 'held' ? (
                        <SegmentedControl<FieldMode>
                          label="Value source"
                          describedBy={`${helperId}-${item.name}-label`}
                          value={mode}
                          semantics="radio"
                          onChange={(next): void => setMode(item.name, next)}
                          options={[
                            { value: 'held', label: "Use this chat's value" },
                            { value: 'enter', label: 'Enter new' },
                          ]}
                        />
                      ) : (
                        <div className="flex flex-col gap-1.5">
                          {item.held === true && (
                            <SegmentedControl<FieldMode>
                              label="Value source"
                              describedBy={`${helperId}-${item.name}-label`}
                              value={mode}
                              semantics="radio"
                              onChange={(next): void =>
                                setMode(item.name, next)
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
                                  setValue(item.name, event.target.value)
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
                                  setValue(item.name, event.target.value)
                                }
                                data-testid={`chat-secret-request-input-${item.name}`}
                              />
                            )}
                          </div>
                          {item.kind === 'multiline' && <div>{toggle}</div>}
                        </div>
                      );
                    }}
                  </FormField>
                  {mode === 'enter' &&
                    error === undefined &&
                    (check.ok || check.warning) && (
                      <div className="flex flex-col gap-0.5 text-xs">
                        {check.ok && (
                          <span className={`${REPLAY_BLOCK_CLASS} fg-positive`}>
                            {check.ok}
                          </span>
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

        {/* Once, outside the scroll area, so it stays in view; every typed
            field points at it. Kept for `password` fields too: a database
            password can belong here, an account sign-in password can't. */}
        {hasTypedField && (
          <p
            id={helperId}
            className={FORM_FIELD_DESCRIPTION_CLASS}
            data-testid="chat-secret-request-login-helper"
          >
            {loginHelperCopy(appName)}
          </p>
        )}
        {/* Always mounted so a new mismatch is announced politely; the text
            holds steady while the same fields mismatch. Agent-supplied
            labels and prefixes stay out of replay. */}
        <div
          role="status"
          aria-live="polite"
          className={`${REPLAY_BLOCK_CLASS} sr-only`}
          data-testid="chat-secret-request-mismatch-status"
        >
          {mismatchAnnouncement}
        </div>

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
            {/* The ellipsis: this opens a confirmation, it doesn't send. */}
            {shownMismatches.length > 0
              ? 'Send anyway…'
              : provideCount <= 1
                ? 'Provide'
                : `Provide ${provideCount}`}
          </Button>
        </div>
        {confirmationOpen && (
          <ConfirmDialog
            title="Send anyway?"
            message={confirmationMessage}
            confirmLabel="Send anyway"
            // Not destructive styling, but no default either: Cancel takes
            // focus so a second Enter can't send.
            focusCancel
            onConfirm={confirmSend}
            onCancel={cancelConfirmation}
            ownerDocument={confirmation.ownerDocument}
            dataTestId="chat-secret-request-mismatch-dialog"
            confirmTestId="chat-secret-request-mismatch-confirm"
            cancelTestId="chat-secret-request-mismatch-cancel"
          />
        )}

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

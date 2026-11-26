'use client';

import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type ClipboardEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { AGENT_SECRET_VALUE_MAX_LENGTH } from '@canopy/protocol/agent-secrets';
import { ArrowUpRightIcon, EyeIcon, EyeOffIcon } from '../../icons/AppIcons';
import { REPLAY_BLOCK_CLASS } from '../../lib/replay-privacy';
import { Button } from '../../primitives/Button';
import { ConfirmDialog } from '../../primitives/ConfirmDialog';
import { FormField } from '../../primitives/FormField';
import { TextArea, TextInput } from '../../primitives/Field';
import { Notice } from '../../primitives/Notice';
import { OverlayScrollArea } from '../../primitives/OverlayScrollArea';
import { TextLink } from '../../primitives/TextLink';
import { useChatAppName } from '../chat-look';
import { isCoarsePointerNow } from '../../primitives/useMediaQuery';
import { ComposerIconButton } from './ComposerIconButton';
import {
  ComposerPromptHeader,
  closeComposerPromptOnEscape,
} from './ComposerPromptHeader';

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
  /**
   * The request can't take any answer now: it `ended` (stopped, timed out)
   * or was already `answered`. The form locks with a neutral notice until
   * the host removes it.
   */
  readonly settled?: 'ended' | 'answered';
  readonly disconnected?: boolean;
  /**
   * The computer that keeps the values is offline, for a form answered from
   * a paired browser or phone. Values go straight to that computer and are
   * never queued, so the form says why and stays locked until it is back.
   */
  readonly computerOffline?: boolean;
  /** The paired computer's name, for the offline notice. */
  readonly computerName?: string;
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

/** Mockups §3, paired web: why the form is locked while the computer is away. */
function computerOfflineNotice(computerName: string | undefined): string {
  return `${computerName ?? 'Your computer'} is offline. Secrets go straight to it, so provide them once it's back online.`;
}

/** Why a form that can no longer take an answer is locked. */
const SETTLED_NOTICE = {
  ended: 'This request has ended. Nothing was sent.',
  answered: 'This request was already answered. Nothing was sent.',
} as const;

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
// helper line under the fields and the Send anyway dialog name that case, so
// the field's own message only gives the hint, and never promises it's right.
function mismatchCopy(prefix: string): string {
  return `These values usually start with ${prefix}.`;
}

function loginHelperCopy(appName: string | undefined): string {
  // Each note is a full sentence: they run together as one paragraph.
  return appName !== undefined && appName.length > 0
    ? `Never enter your account password here. ${appName} never needs it.`
    : 'Never enter your account password here.';
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
 * placed after the text, with the URL's host left in its place. Only that
 * token moves: other URLs, and
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
    const before = description.slice(0, start);
    const after = description.slice(start + candidate.length);
    // The host stays where the URL was so the sentence still reads; a
    // description that was only the URL leaves no text.
    const bare = `${before}${after}`.replace(/[\s.,;:!?()]/g, '') === '';
    return {
      text: bare ? '' : `${before}${parsed.hostname}${after}`.trim(),
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
  // "Hidden", never "never sees": output redaction matches the exact value,
  // so a command that re-encodes it can get past.
  ask: 'Hidden from the agent and command output.',
  // Full access runs commands without approval, so nothing checks a print.
  full: "In Full access, the agent's commands can print this value.",
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
  settled,
  disconnected = false,
  computerOffline = false,
  computerName,
  readOnlyHint,
  onSubmit,
  onDecline,
  onClose,
}: SecretRequestPromptProps): JSX.Element {
  const titleId = useId();
  const helperId = useId();
  const appName = useChatAppName();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const firstFieldRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(
    null,
  );
  const [values, setValues] = useState<Record<string, string>>({});
  const [visible, setVisible] = useState<Record<string, boolean>>({});
  const [attempted, setAttempted] = useState(false);
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
  const locked =
    busy !== null ||
    settled !== undefined ||
    disconnected ||
    computerOffline ||
    readOnlyHint !== undefined;
  // Locking forgets what was revealed, so nothing shows in the clear again
  // when the form unlocks without a new Reveal. Adjusted during render, so no
  // frame shows it.
  const [wasLocked, setWasLocked] = useState(locked);
  if (wasLocked !== locked) {
    setWasLocked(locked);
    if (locked) {
      setVisible({});
      setPasteResult(null);
    }
  }
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

  // Values never outlive the prompt.
  useEffect(
    () => (): void => {
      setValues({});
    },
    [],
  );

  const fieldPlaceholder = (
    item: SecretRequestPromptItem,
  ): string | undefined =>
    computerOffline
      ? 'Unavailable while offline'
      : item.held === true
        ? 'Using your saved value'
        : item.required === false
          ? 'Leave empty to skip'
          : undefined;

  // A held field left empty reuses the chat's value; typing replaces it.
  const modeOf = (item: SecretRequestPromptItem): FieldMode =>
    // Trimmed, as the send is: spaces alone never replace a saved value.
    item.held === true && (values[item.name] ?? '').trim().length === 0
      ? 'held'
      : 'enter';

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
    // Cleared as sent: a failed send asks for the values again.
    setValues({});
    setVisible({});
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
    setPasteResult(null);
    setAttempted(false);
    setRevision((current) => current + 1);
    onDecline();
  };

  /**
   * A paste into any field that holds `.env` lines for requested names fills
   * those fields instead, and the raw text goes nowhere, so a whole `.env`
   * pasted by habit never becomes one value. Any other paste goes in as usual.
   */
  const fillFromPaste = (
    event: ClipboardEvent<HTMLInputElement | HTMLTextAreaElement>,
  ): void => {
    const parsed = parseDotenvForSecrets(
      event.clipboardData.getData('text'),
      items.map((item) => item.name),
    );
    const names = Object.keys(parsed);
    if (names.length === 0) return;
    event.preventDefault();
    cancelConfirmation();
    setValues((current) => ({ ...current, ...parsed }));
    setRevision((current) => current + 1);
    setPasteResult(
      `Filled ${names.length} of ${items.length} fields from the pasted text.`,
    );
  };

  const handleFieldKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
    event.preventDefault();
    // A held Enter repeats: only the first press submits.
    if (event.repeat) return;
    requestSubmit();
  };

  useEffect(() => {
    // Focusing on touch would open the keyboard before the user asks.
    if (!isCoarsePointerNow()) firstFieldRef.current?.focus();
  }, []);

  const notice = settled
    ? { intent: 'neutral' as const, message: SETTLED_NOTICE[settled] }
    : readOnlyHint
      ? { intent: 'neutral' as const, message: readOnlyHint }
      : computerOffline
        ? {
            intent: 'neutral' as const,
            message: computerOfflineNotice(computerName),
          }
        : disconnected
          ? {
              intent: 'neutral' as const,
              message: 'Reconnect to continue.',
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
      provideCount > 1 ? ` This sends all ${provideCount} values.` : '';
    confirmationMessage =
      mismatched.length === 1 && only !== undefined ? (
        <span className={REPLAY_BLOCK_CLASS}>
          “{labelOf(only.item)}” doesn't start with{' '}
          <span className="font-mono">{only.mismatch.prefix}</span>, so it may
          be the wrong value.
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
          {whole && <span>{whole.trim()}</span>}
        </span>
      );
  }

  return (
    <div
      ref={rootRef}
      data-testid="chat-secret-request-prompt"
      role="group"
      aria-labelledby={titleId}
      // pb-3 plus the box's 4px puts Decline and Provide 16px from the
      // bottom, as far as they sit from the side. The 8px the other prompts
      // use fits a round send button in the corner, not a row of labels.
      className="flex flex-col gap-2 pb-3 text-pretty"
      onKeyDown={(event): void => {
        // The confirmation portals out but its key events still bubble here
        // through React. Leave them to the dialog: its own Escape closes only
        // it, and a held Enter that opened it must not answer it.
        if (confirmation !== null) {
          if (event.key === 'Enter' && event.repeat) event.preventDefault();
          return;
        }
        closeComposerPromptOnEscape(event, close);
      }}
    >
      <ComposerPromptHeader
        close={{ onClose: close, testId: 'chat-secret-request-close' }}
      >
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
      </ComposerPromptHeader>

      <form
        className="flex flex-col gap-3 px-3"
        autoComplete="off"
        noValidate
        onSubmit={(event): void => {
          event.preventDefault();
          requestSubmit();
        }}
      >
        {pasteResult !== null && (
          <div className="text-xs fg-secondary" role="status">
            {pasteResult}
          </div>
        )}

        {/* Many secrets scroll within the box; the actions stay in view.
            The list's 4px keeps focus rings unclipped; -mx-1 takes it back
            so fields line up with the title and notes. */}
        <OverlayScrollArea
          className="-mx-1"
          // dvh: with a phone's keyboard open, 40vh runs past the screen.
          viewportClassName="max-h-[min(40dvh,24rem)]"
        >
          <div className="flex flex-col gap-3 p-1">
            {items.map((item) => {
              const mode = modeOf(item);
              const value = values[item.name] ?? '';
              const check = checks.get(item.name) ?? {};
              // A locked form masks every value: its Hide is disabled.
              const shown = !locked && visible[item.name] === true;
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
                        {/* Without a label, the name is the label already. */}
                        {labelOf(item) !== item.name && (
                          <span
                            className={`${REPLAY_BLOCK_CLASS} rounded-sm bg-subtle px-1.5 py-0.5 font-mono text-xs fg-secondary`}
                          >
                            {item.name}
                          </span>
                        )}
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
                                  {/* The host is the part worth reading: where
                                      the link goes. "Open" keeps it from
                                      reading as a bare URL; the accessible
                                      name adds what it's for. */}
                                  <TextLink
                                    href={description.link.href}
                                    variant="inline"
                                    replayBlock
                                    withIcon
                                    className="align-bottom"
                                    aria-label={`Open ${description.link.host} to find ${labelOf(item)}`}
                                    data-testid={`chat-secret-request-description-link-${item.name}`}
                                  >
                                    Open {description.link.host}
                                    <ArrowUpRightIcon size={12} aria-hidden />
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
                      // Every field also points at the password warning.
                      const control = {
                        ...formControl,
                        'aria-describedby': [
                          formControl['aria-describedby'],
                          mode === 'held'
                            ? `${helperId}-${item.name}-held`
                            : undefined,
                          helperId,
                        ]
                          .filter(
                            (id): id is string =>
                              id !== undefined && id.length > 0,
                          )
                          .join(' '),
                      };
                      return (
                        <div className="flex flex-col gap-1.5">
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
                                placeholder={fieldPlaceholder(item)}
                                onPaste={fillFromPaste}
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
                                // Browsers ignore autocomplete="off" on a
                                // password field; keep password managers from
                                // saving an agent's key as a site login.
                                data-1p-ignore
                                data-lpignore="true"
                                data-bwignore
                                disabled={locked}
                                value={value}
                                ref={
                                  assignFirst
                                    ? (element): void => {
                                        firstFieldRef.current = element;
                                      }
                                    : undefined
                                }
                                placeholder={fieldPlaceholder(item)}
                                trailing={toggle}
                                onKeyDown={handleFieldKeyDown}
                                onPaste={fillFromPaste}
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
                  {item.held === true && mode === 'held' && (
                    <span
                      id={`${helperId}-${item.name}-held`}
                      className="text-xs fg-tertiary"
                    >
                      Enter a new value to change it.
                    </span>
                  )}
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

        {/* One paragraph of notes above the actions, wrapping as it needs:
            where the value goes, then the password warning a step stronger
            than the fine print. Every field points at the warning.
            "Account" password, since a database password can belong here
            and a sign-in password can't. */}
        <p className="text-xs fg-tertiary">
          <span data-testid="chat-secret-request-footer">
            {FOOTER_COPY[accessMode]}
          </span>{' '}
          {storage === 'session' && (
            <>
              <span data-testid="chat-secret-request-session-storage">
                {/* Secure storage is unavailable: values live in memory
                    and go when the app quits. */}
                Only available in this session.
              </span>{' '}
            </>
          )}
          <span
            id={helperId}
            className="fg-secondary"
            data-testid="chat-secret-request-login-helper"
          >
            {loginHelperCopy(appName)}
          </span>
        </p>

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
            aria-busy={busy === 'decline'}
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
            aria-busy={busy === 'submit'}
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
      </form>
    </div>
  );
}

import type { JSX, ReactNode } from 'react';
import { KeyIcon } from '../../icons/AppIcons';

/*
 * The transcript's RequestSecrets row: what was asked and, once settled,
 * "Provided N of M" with one chip per name. It reads only the names in the
 * call and the tool result's metadata, which never holds a value.
 */

/**
 * Whether a tool name is RequestSecrets under any provider's name: Claude's
 * `mcp__<ns>_ui__RequestSecrets`, Codex's `<ns>_request_secrets`, a Cursor
 * title, or the bare display name.
 */
export function isRequestSecretsToolName(
  toolName: string | null | undefined,
): boolean {
  return (
    typeof toolName === 'string' &&
    (toolName === 'RequestSecrets' ||
      /^mcp__[^_].*__RequestSecrets$/.test(toolName) ||
      /^[^:]+: RequestSecrets$/.test(toolName) ||
      /^[a-z][a-z0-9_]*_request_secrets$/.test(toolName))
  );
}

export interface RequestSecretsResultView {
  readonly status:
    | 'provided'
    | 'partial'
    | 'declined'
    | 'expired'
    | 'cancelled';
  readonly secrets: ReadonlyArray<{
    readonly name: string;
    readonly state: 'provided' | 'skipped' | 'unavailable';
    readonly source?: 'entered' | 'saved' | 'chat';
    readonly scope?: 'chat' | 'project';
  }>;
}

type ResultStatus = RequestSecretsResultView['status'];
type ResultSecret = RequestSecretsResultView['secrets'][number];

function isStatus(value: unknown): value is ResultStatus {
  return (
    value === 'provided' ||
    value === 'partial' ||
    value === 'declined' ||
    value === 'expired' ||
    value === 'cancelled'
  );
}
function isState(value: unknown): value is ResultSecret['state'] {
  return value === 'provided' || value === 'skipped' || value === 'unavailable';
}
function isSource(
  value: unknown,
): value is NonNullable<ResultSecret['source']> {
  return value === 'entered' || value === 'saved' || value === 'chat';
}
function isScope(value: unknown): value is NonNullable<ResultSecret['scope']> {
  return value === 'chat' || value === 'project';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A RequestSecrets result's names and states, or null when it isn't one. */
export function parseRequestSecretsResult(
  text: string | null | undefined,
): RequestSecretsResultView | null {
  if (typeof text !== 'string' || !text.trimStart().startsWith('{'))
    return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(value) || !Array.isArray(value.secrets)) return null;
  const status = value.status;
  if (!isStatus(status)) return null;
  const secrets: ResultSecret[] = [];
  const entries: unknown[] = value.secrets;
  for (const entry of entries) {
    if (!isRecord(entry) || typeof entry.name !== 'string') return null;
    const state = entry.state;
    if (!isState(state)) return null;
    const source = entry.source;
    const scope = entry.scope;
    secrets.push({
      name: entry.name,
      state,
      ...(isSource(source) ? { source } : {}),
      ...(isScope(scope) ? { scope } : {}),
    });
  }
  return { status, secrets };
}

/** "Provided 3 of 4", "Declined", "Expired" or "Cancelled". */
export function requestSecretsStatusLabel(
  result: RequestSecretsResultView,
): string {
  switch (result.status) {
    case 'declined':
      return 'Declined';
    case 'expired':
      return 'Expired';
    case 'cancelled':
      return 'Cancelled';
    default: {
      const provided = result.secrets.filter(
        (secret) => secret.state === 'provided',
      ).length;
      return `Provided ${provided} of ${result.secrets.length}`;
    }
  }
}

function chipMeta(secret: ResultSecret): string | null {
  if (secret.state === 'skipped') return 'skipped';
  if (secret.state === 'unavailable') return 'unavailable';
  if (secret.source === 'chat' || secret.source === 'saved') return 'saved';
  return null;
}

function requestedNames(input: string): string[] {
  try {
    const value: unknown = JSON.parse(input);
    if (!isRecord(value) || !Array.isArray(value.secrets)) return [];
    const secrets: unknown[] = value.secrets;
    return secrets.flatMap((secret) =>
      isRecord(secret) && typeof secret.name === 'string' ? [secret.name] : [],
    );
  } catch {
    return [];
  }
}

function NameChip({
  name,
  meta,
  muted,
}: {
  readonly name: string;
  readonly meta?: string | null;
  readonly muted?: boolean;
}): JSX.Element {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-sm bg-subtle px-1.5 py-0.5 text-xs ${muted ? 'fg-tertiary' : 'fg-secondary'}`}
    >
      <span className="font-mono">{name}</span>
      {meta ? <span className="fg-tertiary">{meta}</span> : null}
    </span>
  );
}

/**
 * The row label: "Requested secrets" with the requested names, or, with a
 * result, its status and each name's state.
 */
export function RequestSecretsRowLabel({
  input,
  resultText,
}: {
  readonly input: string;
  readonly resultText?: string | null;
}): JSX.Element {
  const result = parseRequestSecretsResult(resultText);
  if (!result) {
    const names = requestedNames(input);
    return (
      <span className="inline-flex flex-wrap items-center gap-1.5">
        <span>Requested secrets</span>
        {names.map((name) => (
          <NameChip key={name} name={name} />
        ))}
      </span>
    );
  }
  return (
    <span
      className="inline-flex flex-wrap items-center gap-1.5"
      data-testid="request-secrets-row"
    >
      <span>Requested secrets</span>
      <span
        className={
          result.status === 'provided' || result.status === 'partial'
            ? 'fg-positive'
            : 'fg-tertiary'
        }
        data-testid="request-secrets-status"
      >
        {requestSecretsStatusLabel(result)}
      </span>
      {result.secrets.map((secret) => (
        <NameChip
          key={secret.name}
          name={secret.name}
          meta={chipMeta(secret)}
          muted={secret.state !== 'provided'}
        />
      ))}
    </span>
  );
}

/** Input-only display, for rows without a result yet and summaries. */
export function requestSecretsToolDisplay(input: string): {
  icon: JSX.Element;
  label: ReactNode;
} {
  return {
    icon: <KeyIcon />,
    label: <RequestSecretsRowLabel input={input} />,
  };
}

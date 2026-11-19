import type { JSX, ReactNode } from 'react';
import { KeyIcon } from '../../icons/AppIcons';
import { REPLAY_BLOCK_CLASS } from '../../lib/replay-privacy';
import {
  isRequestSecretsToolName,
  RequestSecretsRowLabel,
} from './request-secrets-display';

/*
 * The transcript rows of RunWithSecrets ("Run with secrets": the command,
 * the secret names and, once settled, its exit, redaction count or the
 * missing names) and WriteSecretsFile ("Wrote secrets file": the path and
 * "0600 · git-excluded"). They read the call's names and the tool result,
 * which never holds a value: the executor redacted the output already.
 */

function toolNameMatcher(
  displayName: string,
  codexSuffix: string,
): (toolName: string | null | undefined) => boolean {
  const mcp = new RegExp(`^mcp__[^_].*__${displayName}$`);
  const cursor = new RegExp(`^[^:]+: ${displayName}$`);
  const codex = new RegExp(`^[a-z][a-z0-9_]*_${codexSuffix}$`);
  return (toolName) =>
    typeof toolName === 'string' &&
    (toolName === displayName ||
      mcp.test(toolName) ||
      cursor.test(toolName) ||
      codex.test(toolName));
}

/** RunWithSecrets under any provider's name. */
export const isRunWithSecretsToolName = toolNameMatcher(
  'RunWithSecrets',
  'run_with_secrets',
);

/** WriteSecretsFile under any provider's name. */
export const isWriteSecretsFileToolName = toolNameMatcher(
  'WriteSecretsFile',
  'write_secrets_file',
);

/** Any of the three agent secret tools. */
export function isAgentSecretToolName(
  toolName: string | null | undefined,
): boolean {
  return (
    isRequestSecretsToolName(toolName) ||
    isRunWithSecretsToolName(toolName) ||
    isWriteSecretsFileToolName(toolName)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseObject(
  text: string | null | undefined,
): Record<string, unknown> | null {
  if (typeof text !== 'string' || !text.trimStart().startsWith('{'))
    return null;
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

/** The secret names a RunWithSecrets call passes, sorted. */
function runSecretNames(input: Record<string, unknown> | null): string[] {
  if (!input) return [];
  const names = new Set<string>();
  if (isRecord(input.env))
    for (const name of Object.values(input.env))
      if (typeof name === 'string') names.add(name);
  if (typeof input.stdin === 'string') names.add(input.stdin);
  return [...names].sort();
}

function writeSecretNames(input: Record<string, unknown> | null): string[] {
  if (!input || !isRecord(input.entries)) return [];
  return [
    ...new Set(
      Object.values(input.entries).filter(
        (name): name is string => typeof name === 'string',
      ),
    ),
  ].sort();
}

export interface RunWithSecretsResultView {
  readonly exitCode: number | null;
  readonly signal?: string;
  readonly timedOut?: boolean;
  readonly redactions: number;
  readonly missing?: readonly string[];
}

/** A RunWithSecrets result's status fields, or null when it isn't one. */
export function parseRunWithSecretsResult(
  text: string | null | undefined,
): RunWithSecretsResultView | null {
  const value = parseObject(text);
  if (
    !value ||
    !('exitCode' in value) ||
    (value.exitCode !== null && typeof value.exitCode !== 'number') ||
    typeof value.redactions !== 'number'
  )
    return null;
  const missing = strings(value.missing);
  return {
    exitCode: value.exitCode,
    ...(typeof value.signal === 'string' ? { signal: value.signal } : {}),
    ...(value.timedOut === true ? { timedOut: true } : {}),
    redactions: value.redactions,
    ...(missing.length ? { missing } : {}),
  };
}

/** "exit 0 · 1 value redacted", "timed out", or "missing NAME". */
export function runWithSecretsStatusLabel(
  result: RunWithSecretsResultView,
): string {
  if (result.missing?.length)
    return `not run: ${result.missing.join(', ')} ${result.missing.length === 1 ? 'is' : 'are'} not held`;
  const parts = [
    result.timedOut
      ? 'timed out'
      : result.exitCode === null
        ? `stopped${result.signal ? ` (${result.signal})` : ''}`
        : `exit ${result.exitCode}`,
  ];
  if (result.redactions > 0)
    parts.push(
      `${result.redactions} ${result.redactions === 1 ? 'value' : 'values'} redacted`,
    );
  return parts.join(' · ');
}

export interface WriteSecretsFileResultView {
  readonly path: string;
  readonly written: readonly string[];
  readonly gitExcluded: boolean;
}

/** A WriteSecretsFile result's fields, or null when it isn't one. */
export function parseWriteSecretsFileResult(
  text: string | null | undefined,
): WriteSecretsFileResultView | null {
  const value = parseObject(text);
  if (
    !value ||
    typeof value.path !== 'string' ||
    typeof value.gitExcluded !== 'boolean'
  )
    return null;
  return {
    path: value.path,
    written: strings(value.written),
    gitExcluded: value.gitExcluded,
  };
}

function Chip({
  children,
  muted,
}: {
  readonly children: ReactNode;
  readonly muted?: boolean;
}): JSX.Element {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-sm bg-subtle px-1.5 py-0.5 text-xs ${muted ? 'fg-tertiary' : 'fg-secondary'}`}
    >
      {children}
    </span>
  );
}

function Code({ children }: { readonly children: string }): JSX.Element {
  return (
    <code
      className={`${REPLAY_BLOCK_CLASS} min-w-0 truncate font-mono text-xs fg-primary`}
    >
      {children}
    </code>
  );
}

/** The RunWithSecrets row label, with its result's status once settled. */
export function RunWithSecretsRowLabel({
  input,
  resultText,
  isError,
}: {
  readonly input: string;
  readonly resultText?: string | null;
  readonly isError?: boolean;
}): JSX.Element {
  const call = parseObject(input);
  const command = typeof call?.command === 'string' ? call.command : '';
  const names = runSecretNames(call);
  const result = isError ? null : parseRunWithSecretsResult(resultText);
  const missing = new Set(result?.missing ?? []);
  return (
    <span
      className="inline-flex min-w-0 flex-wrap items-center gap-1.5"
      data-testid="run-with-secrets-row"
    >
      <span>Run with secrets</span>
      {command ? <Code>{command}</Code> : null}
      {names.map((name) => (
        <Chip key={name} muted={missing.has(name)}>
          <span className="font-mono">{name}</span>
          {missing.has(name) ? (
            <span className="fg-tertiary">not held</span>
          ) : null}
        </Chip>
      ))}
      {result ? (
        <span
          className={
            result.missing?.length || result.exitCode !== 0
              ? 'fg-tertiary'
              : 'fg-positive'
          }
          data-testid="run-with-secrets-status"
        >
          {runWithSecretsStatusLabel(result)}
        </span>
      ) : null}
    </span>
  );
}

/** The WriteSecretsFile row label: the path, then "0600 · git-excluded". */
export function WriteSecretsFileRowLabel({
  input,
  resultText,
  isError,
}: {
  readonly input: string;
  readonly resultText?: string | null;
  readonly isError?: boolean;
}): JSX.Element {
  const call = parseObject(input);
  const result = isError ? null : parseWriteSecretsFileResult(resultText);
  const path =
    result?.path ?? (typeof call?.path === 'string' ? call.path : '');
  return (
    <span
      className="inline-flex min-w-0 flex-wrap items-center gap-1.5"
      data-testid="write-secrets-file-row"
    >
      <span>{result ? 'Wrote secrets file' : 'Write secrets file'}</span>
      {path ? <Code>{path}</Code> : null}
      {result ? (
        <Chip>{result.gitExcluded ? '0600 · git-excluded' : '0600'}</Chip>
      ) : (
        writeSecretNames(call).map((name) => (
          <Chip key={name}>
            <span className="font-mono">{name}</span>
          </Chip>
        ))
      )}
    </span>
  );
}

/**
 * The row label of any agent secret tool, from its call and result; null
 * for other tools. Hosts use it in place of the generic label.
 */
export function agentSecretToolRowLabel(
  toolName: string,
  input: string,
  result: { readonly text: string | null; readonly isError: boolean } | null,
): JSX.Element | null {
  if (isRequestSecretsToolName(toolName))
    return result && !result.isError ? (
      <RequestSecretsRowLabel input={input} resultText={result.text} />
    ) : null;
  if (isRunWithSecretsToolName(toolName))
    return (
      <RunWithSecretsRowLabel
        input={input}
        resultText={result?.text ?? null}
        isError={result?.isError ?? false}
      />
    );
  if (isWriteSecretsFileToolName(toolName))
    return (
      <WriteSecretsFileRowLabel
        input={input}
        resultText={result?.text ?? null}
        isError={result?.isError ?? false}
      />
    );
  return null;
}

/** Input-only display for the secret-use tools, for summaries and pending rows. */
export function secretUseToolDisplay(
  toolName: string,
  input: string,
): { icon: JSX.Element; label: ReactNode } {
  return {
    icon: <KeyIcon />,
    label: isRunWithSecretsToolName(toolName) ? (
      <RunWithSecretsRowLabel input={input} />
    ) : (
      <WriteSecretsFileRowLabel input={input} />
    ),
  };
}

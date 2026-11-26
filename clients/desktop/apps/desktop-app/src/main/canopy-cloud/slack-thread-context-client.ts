import {
  SLACK_THREAD_CONTEXT_FILE_PATH,
  SLACK_THREAD_CONTEXT_PATH,
  SLACK_THREAD_FILE_CLIENT_TIMEOUT_MS,
  SLACK_THREAD_READ_CLIENT_TIMEOUT_MS,
  isSlackThreadContextRefusal,
  slackThreadFileResponseSchema,
  slackThreadReadResponseSchema,
  type SlackThreadContextRefusal,
  type SlackThreadFileRequest,
  type SlackThreadFileResponse,
  type SlackThreadReadRequest,
  type SlackThreadReadResponse,
} from '@canopy/protocol/slack-thread-context';
import type { z } from 'zod';
import { CanopyCloudClientError, requestCanopyCloudJson } from './client';

/**
 * Why a hosted Slack thread call (CAN-7749) gave no answer. Every case is
 * decided here, so the port maps a closed set and never reads an error
 * message.
 */
export type SlackThreadContextFailure =
  /** The web refused with one of the shared refusal codes. */
  | {
      readonly kind: 'refused';
      readonly code: SlackThreadContextRefusal;
      readonly retryAfterMs?: number;
    }
  /** Signed out, or a local-only build: no request was sent. */
  | { readonly kind: 'signed_out' }
  /** A 404 without a code: a web build that predates the routes. */
  | { readonly kind: 'route_missing' }
  /** The client timeout passed or the turn was cancelled. */
  | { readonly kind: 'timeout' }
  /** The web couldn't be reached, or answered 5xx without a code. */
  | { readonly kind: 'network' }
  /** An answer that fails the shared schema, or an unknown refusal code. */
  | { readonly kind: 'invalid_response' };

export type SlackThreadContextOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: SlackThreadContextFailure };

export interface SlackThreadContextClient {
  read(
    request: SlackThreadReadRequest,
    signal?: AbortSignal,
  ): Promise<SlackThreadContextOutcome<SlackThreadReadResponse>>;
  openFile(
    request: SlackThreadFileRequest,
    signal?: AbortSignal,
  ): Promise<SlackThreadContextOutcome<SlackThreadFileResponse>>;
}

/** The transport this client uses; tests inject a fake. */
export type SlackThreadContextTransport = (
  pathname: string,
  init: {
    method: 'POST';
    body: string;
    signal: AbortSignal;
    timeoutMs: number;
  },
) => Promise<unknown>;

/**
 * The helper's own timeout is a backstop just above ours, so a timeout is
 * always observed on our controller and reads as `timeout`.
 */
const TRANSPORT_BACKSTOP_MS = 1_000;

function failureFromError(
  error: unknown,
  aborted: boolean,
): SlackThreadContextFailure {
  if (aborted) return { kind: 'timeout' };
  if (!(error instanceof CanopyCloudClientError)) return { kind: 'network' };
  switch (error.code) {
    case 'cloud-not-configured':
    case 'missing-api-key':
      return { kind: 'signed_out' };
    case 'network-error':
      return { kind: 'network' };
    case 'invalid-response':
    case 'unsupported-capability':
      return { kind: 'invalid_response' };
    case 'http-error':
      break;
  }
  if (error.serverCode !== undefined) {
    if (!isSlackThreadContextRefusal(error.serverCode))
      return { kind: 'invalid_response' };
    return {
      kind: 'refused',
      code: error.serverCode,
      ...(error.retryAfterMs !== undefined
        ? { retryAfterMs: error.retryAfterMs }
        : {}),
    };
  }
  if (error.status === 404) return { kind: 'route_missing' };
  if (error.status !== undefined && error.status >= 500)
    return { kind: 'network' };
  return { kind: 'invalid_response' };
}

async function post<Schema extends z.ZodType>(
  transport: SlackThreadContextTransport,
  pathname: string,
  body: unknown,
  schema: Schema,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<SlackThreadContextOutcome<z.output<Schema>>> {
  if (signal?.aborted) return { ok: false, failure: { kind: 'timeout' } };
  const deadline = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  try {
    const raw = await transport(pathname, {
      // POST is never retried by the cloud client: only idempotent GETs are.
      method: 'POST',
      body: JSON.stringify(body),
      signal: combined,
      timeoutMs: timeoutMs + TRANSPORT_BACKSTOP_MS,
    });
    const parsed = schema.safeParse(raw);
    return parsed.success
      ? { ok: true, value: parsed.data }
      : { ok: false, failure: { kind: 'invalid_response' } };
  } catch (error) {
    return {
      ok: false,
      failure: failureFromError(error, combined.aborted),
    };
  }
}

const defaultTransport: SlackThreadContextTransport = (pathname, init) =>
  requestCanopyCloudJson<unknown>(pathname, init);

/**
 * The desktop's calls to the hosted Slack thread routes (CAN-7749), made
 * with the signed-in account's key. Every answer is parsed with the shared
 * contract; nothing here logs or keeps thread content.
 */
export function createSlackThreadContextClient(
  transport: SlackThreadContextTransport = defaultTransport,
): SlackThreadContextClient {
  return {
    read: (request, signal) =>
      post(
        transport,
        SLACK_THREAD_CONTEXT_PATH,
        request,
        slackThreadReadResponseSchema,
        SLACK_THREAD_READ_CLIENT_TIMEOUT_MS,
        signal,
      ),
    openFile: (request, signal) =>
      post(
        transport,
        SLACK_THREAD_CONTEXT_FILE_PATH,
        request,
        slackThreadFileResponseSchema,
        SLACK_THREAD_FILE_CLIENT_TIMEOUT_MS,
        signal,
      ),
  };
}

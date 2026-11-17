import { randomUUID } from 'node:crypto';
import {
  AGENT_SECRET_VALUE_MAX_LENGTH,
  type RequestSecretsInput,
  type RequestSecretsResult,
  type RequestSecretsStatus,
  requestSecretsUsageText,
} from '@canopy/agent-actions';
import {
  ASK_USER_TIMEOUT_ERROR,
  ASK_USER_TIMEOUT_MS,
} from '@canopy/execution-engine/lib/canopy-injected-tools';
import type {
  AgentProviderType,
  ApprovalMode,
  ChatModel,
  McpQuestion,
  McpQuestionAnswer,
  McpSecretRequest,
  McpSecretRequestOutcome,
  SecretRequestSettleResponse,
  SecretRequestSubmitRequest,
} from '@canopy/desktop-shared/types';
import { requestAnswersFromRenderer } from '../canopy-tools/session-runtime';
import {
  chatQuestionScope,
  respondToChatQuestion,
} from '../chat-questions/respond';
import { getDesktopChatWaits } from '../chat-waits/desktop-chat-waits';
import { getChatStateCommandPort } from '../ipc/chat-state';
import { logMainProcessWarn } from '../lib/main-process-logging';
import { isRecord } from '../lib/type-guards';
import type { SendableBrowserWindow } from '../lib/window-send';
import { getChatSecretStore, type ChatSecretScope } from './chat-secret-store';
import { isAgentSecretRequestsEnabled } from './feature-gate';

/*
 * RequestSecrets on desktop (CONTRACTS.md §3, §5, §8). The request reuses
 * the AskUserQuestion wait: one person-only, `secret` pending question whose
 * `secretRequest` carries the form's metadata, the `awaiting_input` state and
 * the 59-minute timeout. Values never travel on it: the form submits them on
 * `secretRequest.submit`, which stores them and only then settles the wait
 * with names and states.
 */

/** The text the pending question shows anywhere that renders it as text. */
export function secretRequestQuestionText(
  agentName: string,
  count: number,
): string {
  return count === 1
    ? `${agentName} needs a secret`
    : `${agentName} needs ${count} secrets`;
}

export class SecretRequestUnavailableError extends Error {
  constructor() {
    super('Secret requests are unavailable in this session.');
    this.name = 'SecretRequestUnavailableError';
  }
}

export interface RequestSecretsHost {
  scope: ChatSecretScope;
  sessionKey: string;
  getWindow: () => SendableBrowserWindow | null;
  providerType: AgentProviderType;
  model?: ChatModel;
  getApprovalMode: () => ApprovalMode;
  onAwaitingUser?: () => void;
  onRequestCreated?: (requestId: string) => void;
}

function result(
  status: RequestSecretsStatus,
  secrets: RequestSecretsResult['secrets'],
): RequestSecretsResult {
  return { status, secrets, usage: requestSecretsUsageText(status) };
}

function unprovided(
  status: 'declined' | 'expired' | 'cancelled',
  input: RequestSecretsInput,
): RequestSecretsResult {
  return result(
    status,
    input.secrets.map((secret) => ({ name: secret.name, state: 'skipped' })),
  );
}

function parseOutcome(
  answers: readonly McpQuestionAnswer[],
): McpSecretRequestOutcome | null {
  const text = answers[0]?.freeformText;
  if (typeof text !== 'string') return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(value) || !Array.isArray(value.secrets)) return null;
  const action = value.action;
  if (action !== 'provide' && action !== 'decline') return null;
  const secrets: McpSecretRequestOutcome['secrets'] = [];
  const entries: unknown[] = value.secrets;
  for (const entry of entries) {
    if (!isRecord(entry) || typeof entry.name !== 'string') return null;
    const state = entry.state;
    if (state !== 'provided' && state !== 'skipped') return null;
    const source = entry.source;
    secrets.push({
      name: entry.name,
      state,
      ...(source === 'entered' || source === 'chat' ? { source } : {}),
    });
  }
  return { action, secrets };
}

/** Maps a settled outcome onto the result the model sees. */
export function requestSecretsResultFromOutcome(
  input: RequestSecretsInput,
  outcome: McpSecretRequestOutcome,
): RequestSecretsResult {
  if (outcome.action === 'decline') return unprovided('declined', input);
  const byName = new Map(outcome.secrets.map((entry) => [entry.name, entry]));
  const secrets: RequestSecretsResult['secrets'] = input.secrets.map(
    (secret) => {
      const entry = byName.get(secret.name);
      return entry?.state === 'provided'
        ? {
            name: secret.name,
            state: 'provided',
            source: entry.source ?? 'entered',
            scope: 'chat',
          }
        : { name: secret.name, state: 'skipped' };
    },
  );
  const provided = secrets.filter((s) => s.state === 'provided').length;
  return result(provided === secrets.length ? 'provided' : 'partial', secrets);
}

function cancellationStatus(
  error: unknown,
): 'expired' | 'declined' | 'cancelled' {
  const message = error instanceof Error ? error.message : '';
  if (message === ASK_USER_TIMEOUT_ERROR) return 'expired';
  // The chat state dismisses a waiting question as `cancelled`, for example
  // when the person sends a message instead of answering.
  if (message === 'cancelled') return 'declined';
  return 'cancelled';
}

/**
 * Runs one RequestSecrets call: returns at once in Full access when the chat
 * already holds every name, else shows the form and waits.
 */
export async function requestSecrets(
  host: RequestSecretsHost,
  input: RequestSecretsInput,
  options: { toolUseId?: string; signal?: AbortSignal } = {},
): Promise<RequestSecretsResult> {
  if (!isAgentSecretRequestsEnabled())
    throw new SecretRequestUnavailableError();
  const store = getChatSecretStore();
  const names = input.secrets.map((secret) => secret.name);
  const held = new Set(await store.heldNames(host.scope, names));
  const fullAccess = host.getApprovalMode() === 'full-access';
  void store.audit({
    event: 'requested',
    scope: host.scope,
    names,
    tool: 'RequestSecrets',
  });
  if (fullAccess && held.size === names.length) {
    void store.audit({
      event: 'provided',
      scope: host.scope,
      names,
      sources: Object.fromEntries(names.map((name) => [name, 'chat'])),
      tool: 'RequestSecrets',
    });
    return result(
      'provided',
      names.map((name) => ({
        name,
        state: 'provided',
        source: 'chat',
        scope: 'chat',
      })),
    );
  }
  const agentName =
    host.providerType === 'codex'
      ? 'Codex'
      : host.providerType === 'claude'
        ? 'Claude'
        : 'The agent';
  const request: McpSecretRequest = {
    reason: input.reason,
    agentName,
    accessMode: fullAccess ? 'full' : 'ask',
    storage: store.storageMode(),
    secrets: input.secrets.map((secret) => ({
      name: secret.name,
      ...(secret.label !== undefined ? { label: secret.label } : {}),
      ...(secret.description !== undefined
        ? { description: secret.description }
        : {}),
      ...(secret.kind !== undefined ? { kind: secret.kind } : {}),
      ...(secret.required !== undefined ? { required: secret.required } : {}),
      ...(secret.hint !== undefined ? { hint: { ...secret.hint } } : {}),
      ...(held.has(secret.name) ? { held: true } : {}),
    })),
  };
  const question: McpQuestion = {
    id: 'secret-request',
    question: secretRequestQuestionText(agentName, names.length),
    options: [],
    secret: true,
    secretRequest: request,
  };
  let answers: McpQuestionAnswer[];
  try {
    answers = await requestAnswersFromRenderer({
      sessionKey: host.sessionKey,
      projectId: host.scope.projectId,
      worktreeId: host.scope.worktreeId,
      chatId: host.scope.chatId,
      questions: [question],
      getWindow: host.getWindow,
      providerType: host.providerType,
      askUserTimeoutMs: ASK_USER_TIMEOUT_MS,
      personOnly: true,
      ...(options.toolUseId ? { toolUseId: options.toolUseId } : {}),
      ...(host.model ? { model: host.model } : {}),
      ...(host.onAwaitingUser ? { onAwaitingUser: host.onAwaitingUser } : {}),
      ...(host.onRequestCreated
        ? { onRequestCreated: host.onRequestCreated }
        : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'Window not available')
      throw error;
    const status = cancellationStatus(error);
    void store.audit({
      event: status === 'expired' ? 'expired' : 'declined',
      scope: host.scope,
      names,
      reason: status,
      tool: 'RequestSecrets',
    });
    return unprovided(status, input);
  }
  const outcome = parseOutcome(answers);
  if (!outcome) return unprovided('cancelled', input);
  return requestSecretsResultFromOutcome(input, outcome);
}

// Settlement: the form's dedicated channel. ---------------------------------

/** Request ids a submission is settling now: the first answer wins. */
const settling = new Set<string>();

function refused(error: string): SecretRequestSettleResponse {
  return { accepted: false, error };
}

async function pendingSecretRequest(requestId: string): Promise<
  | {
      scope: ChatSecretScope;
      request: McpSecretRequest;
      questionText: string;
    }
  | { error: string }
> {
  const live = chatQuestionScope(requestId);
  const port = getChatStateCommandPort();
  if (!live || !port) return { error: 'This request is no longer waiting.' };
  const scope: ChatSecretScope = {
    projectId: live.workspaceId,
    worktreeId: live.worktreeId,
    chatId: live.chatId,
  };
  let record;
  try {
    const state = await port.getState({
      projectId: scope.projectId,
      worktreeId: scope.worktreeId,
    });
    record = state.tabsFile.pendingQuestions?.find(
      (question) =>
        question.requestId === requestId && question.chatId === scope.chatId,
    );
  } catch {
    return { error: "Couldn't reach this chat. Try again." };
  }
  const question = record?.questions[0];
  if (!record || !question?.secretRequest)
    return { error: 'This request is no longer waiting.' };
  if (record.answeredAt !== undefined || record.dismissedAt !== undefined)
    return { error: 'This request was already answered.' };
  return {
    scope,
    request: question.secretRequest,
    questionText: question.question,
  };
}

function validateSubmission(
  request: McpSecretRequest,
  submission: SecretRequestSubmitRequest,
  held: ReadonlySet<string>,
): string | undefined {
  const requested = new Map(request.secrets.map((s) => [s.name, s]));
  const entered = Object.keys(submission.values);
  for (const name of entered) {
    if (!requested.has(name))
      return 'A value names a secret this request did not ask for.';
    const value = submission.values[name];
    if (typeof value !== 'string' || value.trim().length === 0)
      return 'A secret value is empty.';
    if (value.length > AGENT_SECRET_VALUE_MAX_LENGTH)
      return `A secret value is longer than ${AGENT_SECRET_VALUE_MAX_LENGTH} characters.`;
  }
  for (const name of submission.useHeld) {
    if (!requested.has(name) || !held.has(name))
      return "This chat doesn't hold a value for one of the kept secrets.";
    if (Object.prototype.hasOwnProperty.call(submission.values, name))
      return 'A secret is both entered and kept.';
  }
  for (const secret of request.secrets) {
    if (
      secret.required !== false &&
      !Object.prototype.hasOwnProperty.call(submission.values, secret.name) &&
      !submission.useHeld.includes(secret.name)
    )
      return `Enter ${secret.label ?? secret.name} before providing.`;
  }
  return undefined;
}

async function settle(
  requestId: string,
  scope: ChatSecretScope,
  questionText: string,
  outcome: McpSecretRequestOutcome,
): Promise<'applied' | 'refused' | 'unavailable'> {
  // The answer command resolves the wait as it commits. The wait can time
  // out between the open check and that commit; the command still applies,
  // but the agent got the expired result, so only a wait settled as
  // answered during this call counts as delivered.
  let delivered = false;
  const stopObserving = getDesktopChatWaits().observe({
    opened: (): void => undefined,
    settled: (wait): void => {
      if (wait.waitId === requestId && wait.status === 'answered')
        delivered = true;
    },
  });
  const respond = await respondToChatQuestion({
    scope: { projectId: scope.projectId, worktreeId: scope.worktreeId },
    chatId: scope.chatId,
    questionId: requestId,
    response: {
      kind: 'answer',
      answers: [
        {
          questionId: 'secret-request',
          question: questionText,
          selectedOptions: [],
          freeformText: JSON.stringify(outcome),
        },
      ],
    },
    commandId: randomUUID(),
    executionOptions: { answeredByPerson: true, secretRequestSettlement: true },
  }).finally(stopObserving);
  if (respond.status === 'applied') return delivered ? 'applied' : 'refused';
  return respond.status === 'unavailable' ? 'unavailable' : 'refused';
}

/**
 * `secretRequest.submit`: validates, stores the values, then settles the
 * wait with names and states. The caller is the local window's form.
 */
export async function submitSecretRequest(
  submission: SecretRequestSubmitRequest,
): Promise<SecretRequestSettleResponse> {
  if (!isAgentSecretRequestsEnabled())
    return refused('Secret requests are turned off.');
  const { requestId } = submission;
  if (settling.has(requestId))
    return refused('This request is already being answered.');
  settling.add(requestId);
  try {
    const pending = await pendingSecretRequest(requestId);
    if ('error' in pending) return refused(pending.error);
    const { scope, request, questionText } = pending;
    const store = getChatSecretStore();
    const held = new Set(
      await store.heldNames(
        scope,
        request.secrets.map((s) => s.name),
      ),
    );
    const invalid = validateSubmission(request, submission, held);
    if (invalid !== undefined) return refused(invalid);
    if (!getDesktopChatWaits().isOpen(requestId))
      return refused('This request is no longer waiting.');
    const entered = Object.keys(submission.values);
    // Stored before the agent resumes, so its next command can use them.
    let undo: () => Promise<void>;
    try {
      // Kept as the form said when it opened: a session-only request stays
      // in memory even if secure storage has come back since.
      undo = await store.put(scope, submission.values, {
        sessionOnly: request.storage === 'session',
      });
    } catch {
      return refused("Couldn't store the secrets. Try again.");
    }
    const outcome: McpSecretRequestOutcome = {
      action: 'provide',
      secrets: request.secrets.map((secret) =>
        entered.includes(secret.name)
          ? { name: secret.name, state: 'provided', source: 'entered' }
          : submission.useHeld.includes(secret.name)
            ? { name: secret.name, state: 'provided', source: 'chat' }
            : { name: secret.name, state: 'skipped' },
      ),
    };
    const settled = await settle(requestId, scope, questionText, outcome);
    if (settled !== 'applied') {
      // The agent never got these: restore what the chat held before.
      // A failed write keeps the undo in memory; the next write retries it.
      await undo().catch(() => {
        logMainProcessWarn(
          "[agent-secrets] Couldn't write back a refused secret submission",
        );
      });
      return refused(
        settled === 'unavailable'
          ? "Couldn't reach this chat. Try again."
          : 'This request is no longer waiting.',
      );
    }
    const sources: Record<string, 'entered' | 'chat'> = {};
    for (const entry of outcome.secrets)
      if (entry.state === 'provided' && entry.source)
        sources[entry.name] = entry.source;
    void store.audit({
      event: 'provided',
      scope,
      names: Object.keys(sources),
      sources,
      tool: 'RequestSecrets',
    });
    return { accepted: true };
  } finally {
    settling.delete(requestId);
  }
}

/** `secretRequest.decline`: settles the wait as declined. */
export async function declineSecretRequest(
  requestId: string,
): Promise<SecretRequestSettleResponse> {
  if (settling.has(requestId))
    return refused('This request is already being answered.');
  settling.add(requestId);
  try {
    const pending = await pendingSecretRequest(requestId);
    if ('error' in pending) return refused(pending.error);
    const settled = await settle(
      requestId,
      pending.scope,
      pending.questionText,
      {
        action: 'decline',
        secrets: pending.request.secrets.map((secret) => ({
          name: secret.name,
          state: 'skipped',
        })),
      },
    );
    if (settled !== 'applied')
      return refused(
        settled === 'unavailable'
          ? "Couldn't reach this chat. Try again."
          : 'This request is no longer waiting.',
      );
    void getChatSecretStore().audit({
      event: 'declined',
      scope: pending.scope,
      names: pending.request.secrets.map((secret) => secret.name),
      tool: 'RequestSecrets',
    });
    return { accepted: true };
  } finally {
    settling.delete(requestId);
  }
}

import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type {
  ApprovalCheck,
  ApprovalRequestDetails,
} from '@canopy/desktop-shared/types';
import type { ExecutionSecretAudience } from '@canopy/core-runtime/node/execution-secrets';
import { requestChatApproval } from '../approvals/approval-session-registry';
import { getDesktopExecutionSecrets } from '../execution-secrets/owner';
import {
  chatSecretBindings,
  getChatSecretStore,
  type ChatSecretScope,
} from './chat-secret-store';

/*
 * What RunWithSecrets and WriteSecretsFile share (CONTRACTS.md §2–§5, §8):
 * the chat they act for, its approval, the single-use grant that hands them
 * values, and the worktree boundary their paths stay inside.
 */

/** The chat a RunWithSecrets or WriteSecretsFile call acts for. */
export interface AgentSecretToolHost {
  scope: ChatSecretScope;
  /** The chat's worktree or work entry folder: the tools stay inside it. */
  root: string;
  /** The agent's name for the approval card ("Claude", "Codex", "Cursor"...). */
  agentName: string;
  /**
   * Ends the chat's turn, for "Deny and stop". Called after the tool's
   * result is returned, so the provider records the denial first.
   */
  stopTurn?: () => void;
}

export interface AgentSecretToolCallOptions {
  toolUseId?: string;
  signal?: AbortSignal;
}

/** A refusal the model sees as an error result, with no value in it. */
export class AgentSecretToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentSecretToolError';
  }
}

/** What the person sees when the store was damaged and lost its values. */
export const SECRET_STORE_DAMAGED_MESSAGE =
  'Secrets for this chat are unavailable; provide them again. Ask for them again with RequestSecrets.';

/**
 * The names among `names` the chat does not hold now, sorted. Throws
 * {@link AgentSecretToolError} when the store was found damaged and the
 * person hasn't provided secrets since: values it held are gone, so nothing
 * runs with secrets until then.
 */
export async function missingSecretNames(
  scope: ChatSecretScope,
  names: readonly string[],
): Promise<string[]> {
  const unique = [...new Set(names)];
  const store = getChatSecretStore();
  const held = new Set(await store.heldNames(scope, unique));
  if (store.isDamaged())
    throw new AgentSecretToolError(SECRET_STORE_DAMAGED_MESSAGE);
  return unique.filter((name) => !held.has(name)).sort();
}

/**
 * Asks the chat's approval policy before secrets reach a command or file.
 * Full Access allows; every other mode shows the card, and no saved rule
 * answers it (`agent-secret-use` in the approval engine). A chat with no
 * live approval prompt is denied. Throws when the person denies; resolves
 * whether the person answered the card (false when the mode allowed it,
 * before the card or by a mode change while it was up).
 */
export async function approveSecretUse(
  host: AgentSecretToolHost,
  details: Extract<ApprovalRequestDetails, { kind: 'agent-secret-use' }>,
  options: AgentSecretToolCallOptions,
): Promise<boolean> {
  let asked = false;
  const check: ApprovalCheck = {
    kind: 'agent-secret-use',
    tool: details.tool,
    secretNames: [...details.secretNames],
  };
  const outcome = await requestChatApproval(
    host.scope.projectId,
    host.scope.worktreeId,
    host.scope.chatId,
    check,
    {
      title:
        details.tool === 'RunWithSecrets'
          ? 'Run a command with secrets?'
          : 'Write a secrets file?',
      description: `${host.agentName} wants to give ${
        details.secretNames.length === 1
          ? 'a secret'
          : `${details.secretNames.length} secrets`
      } to ${details.tool === 'RunWithSecrets' ? 'this command' : 'this file'}.`,
      details,
      onAwaitingUser: (): void => {
        asked = true;
      },
      ...(options.toolUseId ? { toolUseId: options.toolUseId } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    },
  );
  if (options.signal?.aborted)
    throw new AgentSecretToolError('The call was stopped before it ran.');
  if (outcome.decision !== 'allow' && outcome.stopTurn && host.stopTurn) {
    const stop = host.stopTurn;
    setImmediate(stop);
  }
  if (outcome.decision !== 'allow')
    throw new AgentSecretToolError(
      outcome.message?.trim()
        ? `The person denied this use of secrets: ${outcome.message.trim()}`
        : 'The person denied this use of secrets, so nothing ran. Continue without it or stop.',
    );
  // A card a mode change released was not answered by the person.
  return asked && outcome.grantedByModeChange !== true;
}

/**
 * Reads the values of `names` through one single-use, 5-minute execution
 * secret grant (CAN-5067), staged and redeemed here. The result maps each
 * secret name to its value; keep it in memory only.
 */
export async function redeemChatSecrets(
  scope: ChatSecretScope,
  names: readonly string[],
  signal: AbortSignal,
): Promise<Map<string, string>> {
  const unique = [...new Set(names)];
  const bindings = chatSecretBindings(
    scope,
    Object.fromEntries(unique.map((name) => [name, name])),
  );
  const grants = getDesktopExecutionSecrets();
  const audience: ExecutionSecretAudience = {
    operation: 'agent.secret.use',
    key: randomUUID(),
  };
  const handle = grants.stage(audience, bindings);
  try {
    const redeemed = await grants.redeem({ audience, bindings }, signal);
    return new Map(Object.entries(redeemed.env));
  } catch {
    throw new AgentSecretToolError(
      "This chat's secrets couldn't be read. Ask for them again with RequestSecrets.",
    );
  } finally {
    handle.revoke();
  }
}

function inside(root: string, target: string): boolean {
  const path = relative(root, target);
  return (
    path === '' ||
    (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
  );
}

/** The chat's root, resolved through links. */
export async function resolveToolRoot(root: string): Promise<string> {
  try {
    return await realpath(root);
  } catch {
    throw new AgentSecretToolError("This chat's folder is not available.");
  }
}

/**
 * Resolves an existing relative path inside `root` (already resolved),
 * through links, and refuses one that leaves it.
 */
export async function resolveInside(
  root: string,
  path: string,
): Promise<string> {
  const target = resolve(root, path);
  if (!inside(root, target))
    throw new AgentSecretToolError('The path is outside this worktree.');
  let resolved: string;
  try {
    resolved = await realpath(target);
  } catch {
    throw new AgentSecretToolError(`${path} does not exist in this worktree.`);
  }
  if (!inside(root, resolved))
    throw new AgentSecretToolError('The path leads outside this worktree.');
  return resolved;
}

/** Resolves `cwd` for a command: a directory inside the root. */
export async function resolveCommandDirectory(
  root: string,
  cwd: string | undefined,
): Promise<string> {
  const directory = await resolveInside(root, cwd ?? '.');
  const info = await stat(directory).catch(() => null);
  if (!info?.isDirectory())
    throw new AgentSecretToolError(`${cwd ?? '.'} is not a directory.`);
  return directory;
}

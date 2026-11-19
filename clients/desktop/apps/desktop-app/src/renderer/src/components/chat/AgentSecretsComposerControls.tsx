import { useState, type JSX } from 'react';
import {
  ChatSecretsChip,
  ChatSecretsRestartNotice,
} from '@canopy/ui-shared/components/chat/ChatSecretsChip';
import type { ChatAgentSecrets } from '@/hooks/useChatAgentSecrets';

/*
 * The local chat's Secrets chip and Codex's Restart to apply (agent secret
 * requests, U3). The chip hides while the chat holds nothing.
 */

/**
 * The status-row Secrets chip (the shared `ChatSecretsChip` the web cloud
 * chat mounts too), with this host's ambient line and Restart to apply. It
 * renders nothing while the chat holds no secret.
 */
export function AgentSecretsComposerControl({
  secrets,
  agentName,
}: {
  readonly secrets: ChatAgentSecrets;
  readonly agentName: string;
}): JSX.Element | null {
  const { state, revoke, restart } = secrets;
  const [revoking, setRevoking] = useState<ReadonlySet<string>>(new Set());
  const [errorMessage, setErrorMessage] = useState<string | undefined>();
  const onRevoke = (name: string): void => {
    setErrorMessage(undefined);
    setRevoking((current) => new Set(current).add(name));
    void revoke(name).then((error) => {
      if (error !== undefined) setErrorMessage(error);
      setRevoking((current) => {
        const next = new Set(current);
        next.delete(name);
        return next;
      });
    });
  };
  return (
    <ChatSecretsChip
      secrets={state.secrets.map((secret) => ({
        name: secret.name,
        scope: secret.scope,
        lastUsedAt:
          secret.lastUsedAt === undefined
            ? null
            : new Date(secret.lastUsedAt).toISOString(),
      }))}
      revoking={revoking}
      {...(errorMessage === undefined ? {} : { errorMessage })}
      onRevoke={onRevoke}
      ambient={state.ambient}
      agentName={agentName}
      onRestart={(): void => void restart()}
      placement="top-right"
    />
  );
}

/** Codex's Restart to apply, above the composer, while it applies. */
export function AgentSecretsComposerRestartNotice({
  secrets,
  agentName,
}: {
  readonly secrets: ChatAgentSecrets;
  readonly agentName: string;
}): JSX.Element | null {
  const { state, restart } = secrets;
  if (state.ambient !== 'restart' && state.ambient !== 'restart-pending')
    return null;
  return (
    <ChatSecretsRestartNotice
      agentName={agentName}
      pending={state.ambient === 'restart-pending'}
      onRestart={(): void => void restart()}
    />
  );
}

export interface PipelineStatusReason {
  readonly id: string;
  readonly kind: string;
  readonly provider?: string;
  readonly code: string;
  readonly resets_at?: string;
}

export interface PipelineStatusReasonGroup {
  key: string;
  reasons: PipelineStatusReason[];
  heading: string;
  helper: string;
}

function providerLabel(reason: PipelineStatusReason): string {
  return reason.provider === 'claude'
    ? 'Claude'
    : reason.provider === 'codex'
      ? 'Codex'
      : reason.provider === 'ollama'
        ? 'Ollama'
        : 'Provider';
}

export function formatPipelineReasonResetTime(iso: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(iso));
}

export function pipelineStatusReasonCopy(reason: PipelineStatusReason): {
  heading: string;
  helper: string;
} {
  if (reason.kind === 'provider_sign_in')
    return {
      heading: 'Paused for Codex sign-in.',
      helper:
        'Resume this run when you are ready. Completed steps will be retained.',
    };
  if (reason.kind === 'app_shutdown')
    return {
      heading: 'Application stopped.',
      helper:
        'Resume this run when you are ready. Completed steps will be retained.',
    };
  // A remote owner that stayed away past its lease or stopped answering
  // (CAN-6102), and a run checkpointed so its host could roll over (CAN-6199).
  if (reason.kind === 'owner_lost')
    return {
      heading: 'Paused when the connection to this run was lost.',
      helper:
        'Resume this run when you are ready. Completed steps will be retained.',
    };
  if (reason.kind === 'host_rollover')
    return {
      heading: 'Paused while the machine running it was replaced.',
      helper:
        'Resume this run when you are ready. Completed steps will be retained.',
    };
  const provider = providerLabel(reason);
  if (reason.kind === 'provider_authentication_required') {
    return {
      heading: `${provider} authentication is required.`,
      helper: `Sign in to ${provider}, then resume this run.`,
    };
  }
  if (reason.kind === 'provider_usage_limit') {
    return {
      heading: `${provider} usage limit reached.`,
      helper: reason.resets_at
        ? `Usage is expected to reset around ${formatPipelineReasonResetTime(reason.resets_at)}.`
        : 'Resume after switching accounts or when usage resets.',
    };
  }
  if (reason.code === 'model_capacity') {
    return {
      heading: `The selected ${provider} model is at capacity.`,
      helper:
        'Try resuming this run later. Start over with a different model if the capacity issue continues.',
    };
  }
  if (reason.code === 'server_overloaded') {
    return {
      heading: `${provider} is temporarily overloaded.`,
      helper: 'Try resuming this run later.',
    };
  }
  if (
    reason.code === 'connection_failed' ||
    reason.code === 'stream_disconnected'
  ) {
    return {
      heading: `${provider} is temporarily unavailable.`,
      helper: `The connection to ${provider} was interrupted.`,
    };
  }
  if (reason.kind === 'provider_temporarily_unavailable') {
    return {
      heading: `${provider} is temporarily unavailable.`,
      helper: 'Try resuming this run later.',
    };
  }
  if (reason.kind === 'input_required') {
    return {
      heading: 'Input is required.',
      helper: 'Provide the requested input.',
    };
  }
  return {
    heading: 'This run was paused by a workflow action.',
    helper: 'Resume when you are ready to continue.',
  };
}

export function groupPipelineStatusReasons(
  reasons: readonly PipelineStatusReason[] | undefined,
): PipelineStatusReasonGroup[] {
  const grouped = new Map<string, PipelineStatusReason[]>();
  for (const reason of reasons ?? []) {
    const key = `${reason.kind}:${reason.provider ?? 'pipeline'}:${reason.code}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.push(reason);
    } else {
      grouped.set(key, [reason]);
    }
  }
  return Array.from(grouped.entries()).map(([key, entries]) => ({
    key,
    reasons: entries,
    ...pipelineStatusReasonCopy(entries[0]),
  }));
}

export function selectProviderStatusReasonIds(
  reasons: readonly PipelineStatusReason[],
  provider: 'claude' | 'codex',
  kind?: PipelineStatusReason['kind'],
): string[] {
  return reasons
    .filter(
      (reason) =>
        reason.provider === provider && (!kind || reason.kind === kind),
    )
    .map((reason) => reason.id);
}

export function compactPipelineStatusReasonLabel(
  reasons: readonly PipelineStatusReason[] | undefined,
): string {
  const groups = groupPipelineStatusReasons(reasons);
  if (groups.length === 0) return 'Paused';
  if (groups.length !== 1) return `Paused · ${groups.length} issues`;
  const reason = groups[0].reasons[0];
  const provider = providerLabel(reason);
  if (reason.kind === 'provider_sign_in') return 'Paused for sign-in';
  if (reason.kind === 'app_shutdown') return 'Application stopped';
  if (reason.kind === 'owner_lost') return 'Connection lost';
  if (reason.kind === 'host_rollover') return 'Machine replaced';
  if (reason.kind === 'input_required') return 'Needs input';
  if (reason.kind === 'provider_usage_limit') return `${provider} usage limit`;
  if (reason.kind === 'provider_authentication_required') {
    return `${provider} sign-in required`;
  }
  if (reason.code === 'model_capacity') return `${provider} at capacity`;
  if (reason.kind === 'provider_temporarily_unavailable') {
    return `${provider} unavailable`;
  }
  return 'Paused';
}

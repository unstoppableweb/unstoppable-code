import { createHash } from 'node:crypto';
import {
  AI_CREDITS_PROXY_ERROR_MARKER,
  parseCanopyProxyError,
  type GatewayModelEntry,
} from '@canopy/protocol/llm-gateway';
import {
  resolveGatewayModelEntry,
  resolveOwnerScopedModelId,
} from '@canopy/execution-engine/lib/gateway-model-availability';
import { getRawOpenCodeModelId } from '@canopy/execution-engine/lib/opencode-models';
import { isOpenCodeGatewayRouteSupported } from '@canopy/desktop-shared/lib/opencode-gateway-models';
import {
  prepareOpenCodeInferenceRoute,
  type OpenCodeInferenceRoute,
} from '@canopy/desktop-shared/node/opencode/inference-route';
import {
  attributionHeaderPairs,
  buildOrgGatewayCodexBaseUrl,
  buildProxyBaseUrl,
  getAiCreditsRoutingContext,
  markOrgGatewayCredentialRejected,
  resolveOrgGatewayCredential,
  type AiCreditsAttribution,
} from '../agents/ai-credits-routing';
import {
  getCodexGatewayProxyService,
  type CodexGatewayRouteLease,
} from '../agents/codex-gateway-proxy-service';
import {
  loadCanopyCloudAccount,
  subscribeCanopyCloudAccountChanges,
  type CanopyCloudAccountEntry,
} from '../lib/canopy-cloud-account-store';
import { checkModelGatewayRoute } from '../lib/model-gateway-state';
import { getCanopyCloudBaseUrl } from '../canopy-cloud/config';
import { getMockLlmOrigin } from '../lib/e2e-mock-control-plane';

export interface OpenCodeInferenceLease {
  route: OpenCodeInferenceRoute;
  funding: 'ai-credits' | 'org-gateway';
  signal: AbortSignal;
  dispose: () => void;
  /**
   * Only use for a failed managed turn; preserve api_error_status on events.
   * requestRejected is the trusted worker's explicit pre-prompt refusal flag,
   * never inferred from an arbitrary provider message or a missing broker error.
   */
  failureError: (
    fallback?: unknown,
    requestRejected?: boolean,
  ) => Error & { api_error_status?: number };
}

function accountIdentity(
  account: CanopyCloudAccountEntry | null,
): string | undefined {
  if (!account?.apiKey.trim()) return undefined;
  return (
    account.account?.id ??
    account.serverApiKeyId ??
    createHash('sha256').update(account.apiKey.trim()).digest('hex')
  );
}

function routeFingerprint(entry: GatewayModelEntry): string {
  return JSON.stringify([
    entry.modelId,
    entry.gatewayId,
    entry.recommendedHarness,
    entry.origin ?? 'hosted',
    entry.baseUrl,
    entry.organizationId,
    entry.toolSchemaProfile,
    entry.contextWindow,
    entry.promptCachePassthrough,
    entry.supportsImages === true,
  ]);
}

/** Explicit app inference only. Native OpenCode selections never fall back to credits. */
export async function openOpenCodeInferenceLease(options: {
  model: string;
  sessionId: string;
  attribution: AiCreditsAttribution;
  /** App response budget, not a claim about a provider's maximum output. */
  outputLimit: number;
  signal: AbortSignal;
}): Promise<OpenCodeInferenceLease | null> {
  const selectionModel = options.model;
  const signal = options.signal;
  const sessionId = options.sessionId;
  signal.throwIfAborted();
  if (getRawOpenCodeModelId(selectionModel)) return null;
  const attribution: AiCreditsAttribution = {
    ...options.attribution,
    ...(options.attribution.workOwner
      ? { workOwner: { ...options.attribution.workOwner } }
      : {}),
  };
  const owner = attribution.workOwner;
  if (!owner)
    throw new Error(
      'The work owner is unavailable. Reopen this chat and try again.',
    );
  const model = resolveOwnerScopedModelId(selectionModel, owner);
  const selected = resolveGatewayModelEntry(model);
  if (
    !selected ||
    !isOpenCodeGatewayRouteSupported(selected) ||
    !Number.isSafeInteger(options.outputLimit) ||
    options.outputLimit < 1 ||
    options.outputLimit > selected.contextWindow
  )
    throw new Error(
      'This model is unavailable with OpenCode. Choose another model.',
    );
  const entry = {
    ...selected,
    supportedThinkingLevels: [...selected.supportedThinkingLevels],
  };
  const fingerprint = routeFingerprint(entry);
  const outputLimit = options.outputLimit;
  const headers = Object.fromEntries(attributionHeaderPairs(attribution));
  const protocol =
    entry.recommendedHarness === 'claude'
      ? 'anthropic-messages'
      : 'openai-responses';
  const funding = entry.origin === 'org-gateway' ? 'org-gateway' : 'ai-credits';
  if (!sessionId.trim())
    throw new Error('The chat is unavailable. Reopen it and try again.');
  const broker = getCodexGatewayProxyService();
  const abort = new AbortController();
  let brokerLease: CodexGatewayRouteLease | undefined;
  let expectedAccount: string | undefined;
  let initialAccountChanged = false;
  let disposed = false;
  let authorityUnavailable = false;
  let unsubscribe = (): void => {};
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    abort.abort();
    signal.removeEventListener('abort', dispose);
    unsubscribe();
    if (brokerLease) broker.unregisterRoute(brokerLease.routeId);
  };
  unsubscribe = subscribeCanopyCloudAccountChanges((account) => {
    if (!expectedAccount) initialAccountChanged = true;
    else if (accountIdentity(account) !== expectedAccount) dispose();
  });
  signal.addEventListener('abort', dispose, { once: true });
  if (signal.aborted) dispose();
  const assertActive = (): void => {
    signal.throwIfAborted();
    if (disposed || initialAccountChanged)
      throw new Error('The account changed. Send a new message to continue.');
  };
  const assertRoute = async (): Promise<void> => {
    assertActive();
    const policy = await checkModelGatewayRoute(model, owner);
    assertActive();
    const current = resolveGatewayModelEntry(model);
    if (!policy.ok) throw new Error(policy.message);
    if (policy.orgRoute !== (funding === 'org-gateway'))
      throw new Error('This model changed or is unavailable. Select it again.');
    if (!current || routeFingerprint(current) !== fingerprint)
      throw new Error('This model changed or is unavailable. Select it again.');
  };
  try {
    await assertRoute();
    expectedAccount = accountIdentity(await loadCanopyCloudAccount());
    assertActive();
    if (!expectedAccount)
      throw new Error('Sign in to use this model with OpenCode.');
    const cloudBaseUrl = getCanopyCloudBaseUrl();
    const readToken = async (): Promise<{
      token: string;
      credentialVersion?: string;
    }> => {
      await assertRoute();
      if (
        getCanopyCloudBaseUrl() !== cloudBaseUrl ||
        accountIdentity(await loadCanopyCloudAccount()) !== expectedAccount
      )
        throw new Error('The account changed. Send a new message to continue.');
      const credential =
        funding === 'org-gateway'
          ? await resolveOrgGatewayCredential(entry, owner)
          : await getAiCreditsRoutingContext({ owner, forceRefresh: true });
      await assertRoute();
      if (
        getCanopyCloudBaseUrl() !== cloudBaseUrl ||
        accountIdentity(await loadCanopyCloudAccount()) !== expectedAccount
      )
        throw new Error('The account changed. Send a new message to continue.');
      assertActive();
      if (!credential)
        throw new Error('Check your account balance before sending again.');
      if ('apiKey' in credential) {
        if (credential.baseUrl !== entry.baseUrl)
          throw new Error('The gateway changed. Select the model again.');
        return {
          token: credential.apiKey,
          credentialVersion: credential.credentialVersion,
        };
      }
      if (
        !credential.creditsEligible ||
        !credential.creditsEligibilityKnown ||
        credential.accountIdentity !== expectedAccount ||
        credential.cloudBaseUrl !== cloudBaseUrl
      )
        throw new Error('Check your account balance before sending again.');
      return { token: credential.cskToken };
    };
    // Resolve authority before opening a local route; no credential enters the worker contract.
    await readToken();
    const endpoint = funding === 'org-gateway' ? entry.baseUrl : cloudBaseUrl;
    if (!endpoint)
      throw new Error('The gateway is unavailable. Select another model.');
    const requestBaseUrl = getMockLlmOrigin() ?? endpoint;
    const upstreamUrl =
      funding === 'org-gateway'
        ? protocol === 'anthropic-messages'
          ? requestBaseUrl
          : buildOrgGatewayCodexBaseUrl(requestBaseUrl)
        : buildProxyBaseUrl(requestBaseUrl, entry.recommendedHarness);
    const fundingKey = createHash('sha256')
      .update(
        JSON.stringify({
          version: 1,
          account: expectedAccount,
          cloudBaseUrl,
          endpoint,
          funding,
          owner,
          organizationProjectId: attribution.organizationProjectId,
        }),
      )
      .digest('hex');
    const bindingKey = createHash('sha256')
      .update(
        JSON.stringify({
          version: 1,
          account: expectedAccount,
          cloudBaseUrl,
          endpoint,
          funding,
          owner,
          organizationProjectId: attribution.organizationProjectId,
          model: entry.gatewayId,
          protocol,
        }),
      )
      .digest('hex');
    brokerLease = await broker.registerRoute({
      sessionId,
      upstreamUrl,
      allowedPaths: [
        protocol === 'anthropic-messages' ? '/v1/messages' : '/responses',
      ],
      forwardHeaders:
        protocol === 'anthropic-messages'
          ? ['anthropic-version', 'anthropic-beta']
          : [],
      stripCacheControl: entry.promptCachePassthrough === false,
      inferencePolicy: {
        providerType: 'opencode',
        modelId: entry.gatewayId,
        toolSchemaProfile: entry.toolSchemaProfile,
        headers,
      },
      resolveToken: async () => {
        try {
          return await readToken();
        } catch {
          authorityUnavailable = true;
          return null;
        }
      },
      ...(funding === 'org-gateway' && entry.organizationId
        ? {
            onCredentialRejected: (
              status: 401 | 403,
              version?: string,
            ): Promise<void> =>
              markOrgGatewayCredentialRejected(
                entry.organizationId ?? '',
                status,
                version,
                expectedAccount,
              ),
          }
        : {}),
    });
    if (disposed || signal.aborted) {
      broker.unregisterRoute(brokerLease.routeId);
      assertActive();
    }
    const capturedLease = brokerLease;
    const { route } = prepareOpenCodeInferenceRoute({
      bindingKey,
      selection: { modelId: selectionModel, fundingKey },
      protocol,
      baseUrl: capturedLease.baseUrl,
      headers,
      model: {
        id: entry.gatewayId,
        contextWindow: entry.contextWindow,
        outputLimit,
        supportsVision: entry.supportsImages === true,
      },
    });
    return {
      route,
      funding,
      signal: abort.signal,
      dispose,
      failureError: (
        fallback?: unknown,
        requestRejected?: boolean,
      ): Error & { api_error_status?: number } => {
        const originalMessage =
          fallback instanceof Error
            ? fallback.message
            : typeof fallback === 'string'
              ? fallback
              : undefined;
        const fallbackMessage = originalMessage
          ? (parseCanopyProxyError(originalMessage)?.message ?? originalMessage)
          : undefined;
        const failure = capturedLease.readInferenceFailure?.();
        // Only the worker's explicit pre-prompt admission refusals bypass proxy
        // presentation. Keep a terminal status so stale transport events cannot
        // turn an actionable local refusal into an automatic retry.
        if (
          requestRejected &&
          !authorityUnavailable &&
          !failure &&
          originalMessage
        ) {
          return Object.assign(new Error(originalMessage), {
            api_error_status: 400,
          });
        }
        const observed = failure?.proxyFailure;
        const status = authorityUnavailable ? undefined : failure?.status;
        const code = authorityUnavailable
          ? 'invalid_request'
          : observed && observed.code !== 'upstream_unavailable'
            ? observed.code
            : status === 401
              ? 'credentials_unavailable'
              : 'invalid_request';
        const error = new Error(
          JSON.stringify({
            error: {
              canopy_proxy: AI_CREDITS_PROXY_ERROR_MARKER,
              code,
              message: authorityUnavailable
                ? 'The selected account or model is unavailable. Select the model again.'
                : observed?.message ||
                  fallbackMessage ||
                  'OpenCode stopped this request. Send a new message to continue.',
              ...(observed?.reason ? { reason: observed.reason } : {}),
              ...(observed?.correlationId
                ? { correlation_id: observed.correlationId }
                : {}),
            },
          }),
        );
        return Object.assign(
          error,
          status === undefined ? {} : { api_error_status: status },
        );
      },
    };
  } catch (error) {
    dispose();
    throw error;
  }
}

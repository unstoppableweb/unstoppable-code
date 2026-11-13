import { AI_CREDITS_PIPELINE_ROUTE_HEADER } from '@canopy/protocol/llm-gateway';
import type { PipelineRemoteOwner } from '@canopy/core-runtime/node/pipeline/host';
import type {
  WorkerPipelineOwnerResult,
  WorkerPipelineOwnerValues,
} from '@canopy/protocol/canopy-core';
import type { CloudRunnerActivation } from '@canopy/protocol/pipeline-relay';

/*
 * The runner's model routes (CP-68, P9). The web core answers a model step's
 * `owner.model.routing` (or `invocation`) with a non-secret `routeId`; the
 * runner resolves it here, with the AI Credits session its activation
 * carries, into the provider environment the step runs with: the web core's
 * LLM proxy, the session key as the bearer, and the route id as a header the
 * proxy attributes the step's usage by. Nothing here crosses the relay.
 *
 * Without a session in the activation the runner resolves nothing, so a
 * routed step runs without a route and pauses as an authentication failure.
 */

/** The Codex model provider a routed Codex step uses. */
export const PIPELINE_RUNNER_CODEX_PROVIDER_ID = 'canopy_ai_credits';

type OwnerValues = Omit<WorkerPipelineOwnerValues, 'requestId'>;
type AiCreditsSession = NonNullable<CloudRunnerActivation['aiCredits']>;

interface Route {
  readonly provider: 'claude' | 'codex';
  readonly model: string;
  readonly routeId: string;
}

function routeOf(
  answer: WorkerPipelineOwnerResult,
  provider: string | undefined,
): Route | null {
  if (answer.kind === 'model.routing') {
    const override = answer.override;
    return override?.routeId === undefined
      ? null
      : {
          provider: override.provider,
          model: override.model,
          routeId: override.routeId,
        };
  }
  if (
    answer.kind === 'model.invocation' &&
    answer.aiCreditsRouted &&
    answer.routeId !== undefined &&
    (provider === 'claude' || provider === 'codex')
  )
    return {
      provider,
      model: answer.runtimeModel,
      routeId: answer.routeId,
    };
  return null;
}

function claudeEnv(session: AiCreditsSession, route: Route): OwnerValues {
  const env: Record<string, string> = {
    ANTHROPIC_BASE_URL: `${session.proxyOrigin}/api/v1/llm-proxy/anthropic`,
    ANTHROPIC_AUTH_TOKEN: session.token,
    ANTHROPIC_API_KEY: '',
    // As desktop's routed Claude env: the gateway refuses inline tool
    // definitions (CAN-4647).
    CLAUDE_CODE_INLINE_TOOLS: 'false',
    // Claude Code sends these on every request to the proxy, which reads the
    // route and strips it before forwarding.
    ANTHROPIC_CUSTOM_HEADERS: `${AI_CREDITS_PIPELINE_ROUTE_HEADER}: ${route.routeId}`,
  };
  if (!route.model.startsWith('anthropic/'))
    env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS = '1';
  return { env };
}

function codexConfig(session: AiCreditsSession, route: Route): OwnerValues {
  return {
    codexConfig: {
      model_provider: PIPELINE_RUNNER_CODEX_PROVIDER_ID,
      model: route.model,
      model_providers: {
        [PIPELINE_RUNNER_CODEX_PROVIDER_ID]: {
          name: 'AI Credits',
          // Codex appends its own `/responses`, which the proxy route expects.
          base_url: `${session.proxyOrigin}/api/v1/llm-proxy/openai/responses`,
          wire_api: 'responses',
          requires_openai_auth: false,
          // A sandbox has no loopback broker: the session key is the bearer.
          experimental_bearer_token: session.token,
          http_headers: { [AI_CREDITS_PIPELINE_ROUTE_HEADER]: route.routeId },
        },
      },
    },
  };
}

/**
 * The runner's `remoteOwner.resolveOwnerValues` for its activation's AI
 * Credits session, or undefined when it carries none.
 */
export function pipelineRunnerOwnerRoutes(
  aiCredits: CloudRunnerActivation['aiCredits'],
): PipelineRemoteOwner['resolveOwnerValues'] {
  if (aiCredits === undefined || aiCredits === null) return undefined;
  const session: AiCreditsSession = {
    ...aiCredits,
    proxyOrigin: aiCredits.proxyOrigin.replace(/\/+$/, ''),
  };
  return (request, answer) => {
    const action = request.request;
    const provider =
      action.action === 'owner.model.invocation'
        ? action.harness
        : action.action === 'owner.model.routing'
          ? action.provider
          : undefined;
    const route = routeOf(answer, provider);
    if (route === null) return Promise.resolve(undefined);
    return Promise.resolve(
      route.provider === 'claude'
        ? claudeEnv(session, route)
        : codexConfig(session, route),
    );
  };
}

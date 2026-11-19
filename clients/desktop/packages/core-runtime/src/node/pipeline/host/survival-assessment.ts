import { isDeepStrictEqual } from 'node:util';
import {
  WorkerPipelineSurvivalAssessmentSchema,
  type WorkerPipelineHostLaunch,
  type WorkerPipelineNativeRouteEvidence,
  type WorkerPipelineSurvivalAssessment,
  type WorkerPipelineSetupFailure,
} from '@canopy/protocol/canopy-core';
import type { PipelineOwnerRunIdentity } from './supervisor';

type Blocker = WorkerPipelineSurvivalAssessment['blockers'][number]['code'];

const EXPLANATIONS: Readonly<Record<Blocker, string>> = {
  policy:
    'Organization model policy could not be verified for running without the app.',
  gateway: 'The model uses an AI gateway that still needs the app.',
  'account-proxy': 'The model uses the account proxy running in this app.',
  'ai-credits': 'AI Credits routing still needs the app.',
  'environment-route':
    'The model uses connection settings that have not been verified without the app.',
  'native-auth-unknown':
    'Model sign-in could not be verified for running without the app.',
  'dynamic-selection':
    'A later model selection cannot be verified before this workflow starts.',
  'unsupported-route':
    'This model route is not yet supported while the app is closed.',
  ollama:
    'Ollama model steps have not been verified while the app is closed, even with an external server.',
  'network-proxy':
    'This model uses a network proxy that has not been verified while the app is closed.',
  'host-step': 'This workflow requires a desktop action.',
  'owner-mcp':
    'This workflow uses MCP configuration or credentials that have not been verified without the app.',
  'managed-configuration':
    'This workflow uses managed configuration that still needs the app.',
  'setup-lease':
    'This workflow still needs the app to prepare its Agent or resources.',
  'configuration-unverified':
    'Background model routing has not been verified for this run.',
  unknown:
    'A workflow dependency could not be verified for running without the app.',
};

const SETUP_EXPLANATIONS: Readonly<Record<WorkerPipelineSetupFailure, string>> =
  {
    'resource-selection':
      'The selected Agent or resources have unverified content, ownership or installed-item settings.',
    'unsupported-platform':
      'Start-time setup verification is not supported on this operating system.',
    'managed-policy':
      'Managed model configuration could not be confirmed absent.',
    'codex-profile-mismatch':
      'The Codex profile used for setup differs from the profile used to start the model.',
    'dynamic-settings':
      'Model settings are selected during the run and cannot be verified at start.',
    'dynamic-directory':
      'The model working folder is selected during the run and cannot be verified at start.',
    'outside-worktree':
      'Model setup reaches outside this workflow’s verified worktree.',
    'claude-profile-mismatch':
      'The Claude configuration folder differs from the verified start-time profile.',
    'native-mcp': 'Native MCP configuration could not be confirmed absent.',
    'agent-configuration':
      'Auto-loaded Agent configuration has not been prepared for running without the app.',
    'preferences-fact':
      'The app’s saved model preferences could not be verified.',
    'policy-fact':
      'The saved model policy configuration could not be verified.',
    'gateway-fact':
      'The saved model gateway configuration could not be verified.',
    'claude-profile-fact':
      'The Claude profile’s settings or resources could not be verified.',
    'codex-profile-fact':
      'The Codex profile’s configuration could not be verified.',
    'worktree-fact':
      'The worktree’s model configuration could not be verified.',
    'settings-dependency':
      'Model settings contain an app-dependent or unrecognized setup option.',
    'codex-config-read':
      'Codex did not return verifiable layered configuration.',
    'codex-provider':
      'The configured Codex provider is not a verified native route.',
    'codex-connection': 'Codex uses a custom model connection.',
    'codex-tools':
      'Codex has configured MCP, hooks or app capabilities that still need the app.',
    'codex-providers':
      'Codex has custom provider definitions that have not been verified.',
    'codex-layer':
      'A Codex configuration layer is outside the verified start-time snapshot.',
    'ambient-resources':
      'Auto-loaded plugins or resources have not been prepared for running without the app.',
    'mod-admission':
      'The app could not verify permission to load the model’s Mods.',
    'changed-facts':
      'Model configuration changed while the workflow was being prepared.',
    'invalid-snapshot':
      'The model’s start-time setup snapshot could not be validated.',
    'setup-inspection':
      'The app could not complete start-time model setup verification.',
    'daemon-shape':
      'This workflow contains a step or option outside the verified background model subset.',
    'daemon-snapshot':
      'The background service did not receive a valid start-time model setup snapshot.',
    'daemon-facts':
      'The background service could not verify the saved start-time configuration and resource facts.',
    'daemon-route':
      'The background service could not validate the native model route observation.',
    'daemon-leases':
      'The background service could not validate the prepared model setup answers.',
    'daemon-validation':
      'The background service could not independently validate this workflow’s start-time setup.',
  };

/** The setup failure an owner-bound launch without a granted assessment pauses with. */
export function unadmittedPipelineSetupFailure(
  launch: Pick<
    WorkerPipelineHostLaunch,
    'nativeSetupFailure' | 'nativeStartSetup' | 'nativeRouteEvidence'
  >,
): WorkerPipelineSetupFailure | undefined {
  // Without route evidence the app's route blockers explain the pause, and
  // this service never validated the setup.
  return (
    launch.nativeSetupFailure ??
    (launch.nativeStartSetup && launch.nativeRouteEvidence
      ? 'daemon-validation'
      : undefined)
  );
}

/** A truthful persisted pause assessment, not an admission by negative inference. */
export function pausedPipelineSurvivalAssessment(input: {
  readonly identity: PipelineOwnerRunIdentity;
  readonly evidence?: WorkerPipelineNativeRouteEvidence;
  readonly blockers: readonly Blocker[];
  readonly setupFailure?: WorkerPipelineSetupFailure;
}): WorkerPipelineSurvivalAssessment {
  const evidence = isDeepStrictEqual(input.evidence?.identity, input.identity)
    ? input.evidence
    : undefined;
  const routes = evidence?.routes ?? [];
  const blockers = [...new Set(input.blockers)];
  if (input.evidence && !evidence && !blockers.includes('unknown'))
    blockers.push('unknown');
  if (blockers.length === 0) blockers.push('configuration-unverified');
  return WorkerPipelineSurvivalAssessmentSchema.parse({
    version: 1,
    identity: input.identity,
    assessedAt: new Date().toISOString(),
    disposition: 'pauses',
    routes,
    credentialFamilies: [
      ...new Set(
        routes.flatMap((route) =>
          route.authentication === 'unknown' ? [] : [route.authentication],
        ),
      ),
    ],
    coveredOwnerKinds: [],
    startLeaseRefs: [],
    blockers: blockers.map((code) => ({
      code,
      explanation:
        code === 'setup-lease' && input.setupFailure
          ? SETUP_EXPLANATIONS[input.setupFailure]
          : EXPLANATIONS[code],
    })),
    ledgerAfterQuit: 'unavailable',
    epochs: evidence
      ? [
          {
            authority: 'desktop-route-observation',
            version: evidence.configurationEpoch,
          },
        ]
      : [],
  });
}

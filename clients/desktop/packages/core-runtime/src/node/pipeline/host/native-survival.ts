import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import type { PlatformOperatingSystem } from '../../../platform/platform-services';
import {
  WORKER_PIPELINE_OWNER_AGENT_ACTION_NOT_SENT_TEXT,
  WORKER_PIPELINE_OWNER_AGENT_ACTION_OUTCOME_UNKNOWN_TEXT,
  WorkerPipelineStartSetupSchema,
  WorkerPipelinePluginSelectionsSchema,
  WorkerPipelineSurvivalAssessmentSchema,
  resolveNativePipelineModel,
  resolvePipelineGovernedModelId,
  pipelineModelCatalogIdentity,
  type WorkerPipelineHostRequest,
  type WorkerPipelineNativeRouteEvidence,
  type WorkerPipelineOwnerResult,
  type WorkerPipelineSurvivalAssessment,
  type WorkerPipelineSetupFact,
  type WorkerPipelineSetupFailure,
} from '@canopy/protocol/canopy-core';
import type { PipelineHostLaunch } from './protocol';
import type {
  PipelineOwnerRunAuthority,
  PipelineOwnerRunIdentity,
} from './supervisor';
import { prepareNativePipelineOwnerRun } from './native-owner';
import {
  isManagedPipelineEvidence,
  prepareManagedPipelineOwnerRun,
  type ManagedPipelineOwnerPorts,
} from './managed-owner';
import {
  preparePipelineOwnerSetupLeases,
  type PipelineOwnerSetupLease,
} from './setup-leases';
import {
  pipelineSetupFactRoots,
  readPipelineSetupFactVersion,
  claudeNativeConfigurationFacts,
  codexNativeConfigurationFacts,
} from './setup-facts';
import {
  localPipelineAgentId,
  localPipelineAgentMatches,
  localPipelinePluginFacts,
  localPipelineSelectionsMatch,
  readLocalPipelineAgentStore,
} from './local-agent-setup';

type SurvivalBlockerCode =
  WorkerPipelineSurvivalAssessment['blockers'][number]['code'];

/** The model answers a closed launch is admitted with, native or managed. */
interface PreparedModelAnswers {
  readonly authority: PipelineOwnerRunAuthority;
  readonly routes: WorkerPipelineNativeRouteEvidence['routes'];
  readonly credentialFamilies: WorkerPipelineSurvivalAssessment['credentialFamilies'];
  readonly epochs: WorkerPipelineSurvivalAssessment['epochs'];
  readonly assumption: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function onlyKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

/** Only the closed, direct-model subset; no helper calls, nesting or host work. */
function closedDirectSteps(
  start: PipelineHostLaunch,
  evidence: WorkerPipelineNativeRouteEvidence,
): boolean {
  const launch = start.launch;
  if (
    launch.isolatedJobs ||
    launch.repositoryActions ||
    Object.keys(launch.pluginCollectionSnapshots ?? {}).length > 0
  )
    return false;
  const pipeline = launch.pipeline;
  if (
    pipeline.env !== undefined ||
    pipeline.defaults !== undefined ||
    pipeline.dependencies !== undefined ||
    !onlyKeys(pipeline, [
      'name',
      'description',
      'icon',
      'version',
      'readonly',
      'scope',
      'on',
      'jobs',
      'model_aliases',
    ]) ||
    !record(pipeline.jobs)
  )
    return false;
  let count = 0;
  for (const job of Object.values(pipeline.jobs)) {
    if (
      !record(job) ||
      job.env !== undefined ||
      !onlyKeys(job, [
        'name',
        'needs',
        'if',
        'outputs',
        'timeout_minutes',
        'max_retries',
        'max_iterations',
        'continue_on_error',
        'steps',
      ]) ||
      job.strategy !== undefined ||
      job.isolation !== undefined ||
      job.working_directory !== undefined ||
      !Array.isArray(job.steps)
    )
      return false;
    for (const step of job.steps) {
      if (
        !record(step) ||
        step.uses !== 'builtin/agent-prompt' ||
        step.env !== undefined ||
        !onlyKeys(step, [
          'id',
          'name',
          'if',
          'uses',
          'with',
          'continue_on_error',
          'timeout_minutes',
          'skip_on_missing_action',
          'log_format_hint',
        ]) ||
        step.working_directory !== undefined ||
        step.run !== undefined ||
        !record(step.with)
      )
        return false;
      const inputs = step.with;
      // Unknown action inputs cannot silently acquire a future owner dependency.
      const known = new Set([
        'prompt',
        'system_prompt',
        'model',
        'permission_preset',
        'thinking_effort',
        'setting_sources',
        'schema',
        'fast_mode',
      ]);
      if (
        Object.keys(inputs).some((key) => !known.has(key)) ||
        typeof inputs.model !== 'string' ||
        !evidence.routes.some(
          (route) =>
            route.selection ===
            (typeof inputs.model === 'string'
              ? (launch.modelAliasResolutions?.[inputs.model]?.base ??
                inputs.model)
              : undefined),
        )
      )
        return false;
      count += 1;
    }
  }
  return count > 0 && count <= 256;
}

function reference(
  fact: Pick<WorkerPipelineSetupFact, 'id' | 'version'>,
): string {
  return createHash('sha256')
    .update(JSON.stringify([fact.id, fact.version]))
    .digest('hex');
}

/**
 * Production admission: route observations are frozen at launch, while content
 * is independently re-digested here before every owner-less lease use. The app
 * remains current authority while connected; this grants no writer custody.
 */
export async function prepareNativePipelineSurvival(
  identity: PipelineOwnerRunIdentity,
  start: PipelineHostLaunch,
  dataRoot: string,
  signal: AbortSignal,
  operatingSystem: PlatformOperatingSystem | null,
  onDecline?: (reason: WorkerPipelineSetupFailure) => void,
  /**
   * The daemon's Cloud account services, only where account authority is
   * selected (CAN-6997): governed-native and AI Credits evidence is then
   * answered from them. Without it such evidence stays app-dependent.
   */
  managed?: ManagedPipelineOwnerPorts & {
    readonly onBlockers?: (blockers: readonly SurvivalBlockerCode[]) => void;
  },
): Promise<PipelineOwnerRunAuthority | undefined> {
  const decline = (reason: WorkerPipelineSetupFailure): undefined => {
    onDecline?.(reason);
    return undefined;
  };
  const evidence = start.launch.nativeRouteEvidence;
  const parsed = WorkerPipelineStartSetupSchema.safeParse(
    start.launch.nativeStartSetup,
  );
  if (signal.aborted) return undefined;
  if (!evidence) {
    // The desktop withholds evidence for a route it blocked: its own setup
    // diagnosis and route blockers explain the pause, not this service.
    if (start.launch.nativeSetupFailure)
      return decline(start.launch.nativeSetupFailure);
    return start.launch.nativeRouteBlockers?.length
      ? undefined
      : decline('daemon-route');
  }
  if (operatingSystem !== 'darwin' && operatingSystem !== 'linux')
    return decline('unsupported-platform');
  if (
    !start.launch.modelCatalog ||
    createHash('sha256')
      .update(pipelineModelCatalogIdentity(start.launch.modelCatalog))
      .digest('hex') !== evidence.catalogFingerprint ||
    evidence.routes.some((route) => {
      const resolved =
        route.selection === null
          ? undefined
          : resolveNativePipelineModel(
              route.selection,
              start.launch.modelCatalog,
            );
      // Credits invoke the policy id, not the native selector. Independently
      // validate it too: approving sonnet cannot authorize a different model.
      const credits = route.effectiveRoute === 'ai-credits';
      return (
        !resolved ||
        resolved.requestModel !== route.requestModel ||
        (credits
          ? resolvePipelineGovernedModelId(
              route.requestModel,
              start.launch.modelCatalog,
            ) !== route.runtimeModel
          : resolved.runtimeModel !== route.runtimeModel) ||
        resolved.harness !== route.harness ||
        (credits
          ? route.source !== 'ai-gateway'
          : resolved.source !== route.source)
      );
    })
  )
    return decline('daemon-route');
  if (!parsed.success) {
    // Preserve the more specific desktop setup diagnosis when no snapshot
    // was produced; a malformed supplied snapshot is a separate failure.
    return decline(start.launch.nativeSetupFailure ?? 'daemon-snapshot');
  }
  if (!closedDirectSteps(start, evidence)) return decline('daemon-shape');
  const setup = parsed.data;
  const environment = {
    ...start.processEnvironment,
    ...start.launch.codexEnvironment?.environment,
    ...start.launch.secretEnv,
    ...start.launch.env,
  };
  const roots = pipelineSetupFactRoots({
    cwd: start.launch.cwd,
    dataRoot,
    environment,
  });
  const facts = new Map<string, WorkerPipelineSetupFact>();
  for (const fact of setup.facts) {
    if (
      facts.has(fact.id) ||
      fact.id !== `${fact.root}:${fact.relativePath}:${fact.projection}`
    )
      return decline('daemon-facts');
    facts.set(fact.id, fact);
  }
  // A caller cannot omit the profile/configuration projections and still claim
  // that a schema-valid content hash proves all setup dependencies absent.
  const required = [
    'data:preferences.json:preferences',
    'data:model-policy-marker.json:content',
    'data:model-gateway-marker.json:content',
  ];
  const aliases = Object.keys(start.launch.modelAliasResolutions ?? {});
  if (aliases.length)
    required.push(
      'data:agent-models.json:content',
      'data:workspace-context.json:content',
      'data:resource-install-receipts.json:absence',
    );
  if (evidence.routes.some((route) => route.harness === 'codex'))
    required.push(
      'codex-config:config.toml:content',
      'worktree:.codex/config.toml:content',
      ...codexNativeConfigurationFacts(operatingSystem).map(
        (fact) => `${fact.root}:${fact.relativePath}:${fact.projection}`,
      ),
    );
  if (evidence.routes.some((route) => route.harness === 'claude')) {
    required.push(
      ...claudeNativeConfigurationFacts(operatingSystem, environment).map(
        (fact) => `${fact.root}:${fact.relativePath}:${fact.projection}`,
      ),
    );
    for (const name of [
      'settings.json',
      'plugins/installed_plugins.json',
      'skills',
      'plugins/synced',
      'dev-mods',
    ])
      required.push(`claude-config:${name}:content`);
    for (const name of ['settings.json', 'settings.local.json', 'skills'])
      required.push(`worktree:.claude/${name}:content`);
    if (
      !setup.leases.some(
        (lease) => lease.request.action === 'owner.claude.modAdmission',
      )
    )
      return decline('daemon-facts');
  }
  if (required.some((id) => !facts.has(id))) return decline('daemon-facts');
  let closed = false;
  let frozenAiCreditsConsent = false;
  const liveVersions = new Map(
    [...facts.values()].map((fact) => [fact.id, fact.version]),
  );
  const factCurrent = async (fact: WorkerPipelineSetupFact): Promise<boolean> =>
    (await readPipelineSetupFactVersion(
      roots[fact.root],
      fact,
      operatingSystem,
      { frozenAiCreditsConsent },
    )) === liveVersions.get(fact.id);
  const current = async (): Promise<boolean> => {
    if (closed) return false;
    for (const fact of facts.values())
      if (!(await factCurrent(fact))) return false;
    return !closed;
  };
  if (!(await current()) || signal.aborted || setup.facts.length > 255)
    return decline('daemon-facts');
  if (aliases.length) {
    const store = await readLocalPipelineAgentStore(roots.data).catch(
      () => undefined,
    );
    for (const aliasId of aliases) {
      const agentId = localPipelineAgentId(start.launch, aliasId);
      const lease = setup.leases.find(
        (candidate) =>
          candidate.jobId === '_run' &&
          candidate.stepId === '_run' &&
          candidate.request.action === 'owner.model.agentAlias' &&
          candidate.request.agentId === agentId,
      );
      const selected = WorkerPipelinePluginSelectionsSchema.safeParse(
        lease?.result.kind === 'model.agentAlias'
          ? lease.result.alias?.pluginSelections
          : undefined,
      );
      if (
        !agentId ||
        !lease ||
        !required.every((id) => lease.factIds.includes(id)) ||
        !localPipelineAgentMatches(store, agentId, lease.result) ||
        lease.result.kind !== 'model.agentAlias' ||
        lease.result.alias?.base !==
          start.launch.modelAliasResolutions?.[aliasId]?.base ||
        start.launch.modelAliasResolutions?.[aliasId]?.plugins !==
          (selected.success && selected.data.pluginRefs.length > 0)
      )
        return decline('daemon-leases');
      if (lease.result.kind !== 'model.agentAlias' || !lease.result.alias)
        return decline('daemon-leases');
      if (!selected.success) return decline('daemon-leases');
      const selections = selected.data;
      // Routes record the alias's base, not its id (see closedDirectSteps).
      // Only this Agent's routes need its resource facets, as for the
      // producer, which also refuses an Agent no step selects.
      const baseModel = lease.result.alias.base;
      const harnesses = [
        ...new Set(
          evidence.routes
            .filter((route) => route.selection === baseModel)
            .map((route) => route.harness),
        ),
      ];
      if (harnesses.length === 0) return decline('daemon-leases');
      const resourceFacts = await localPipelinePluginFacts({
        dataRoot: roots.data,
        cwd: await realpath(start.launch.cwd),
        selections,
        harnesses,
      });
      if (
        !resourceFacts ||
        resourceFacts.some(
          (fact) =>
            !lease.factIds.includes(
              `${fact.root}:${fact.relativePath}:${fact.projection}`,
            ),
        )
      )
        return decline('daemon-facts');
      if (selections?.pluginRefs.length && harnesses.includes('codex')) {
        const expanded = setup.leases.find(
          (candidate) =>
            candidate.request.action === 'owner.codex.pluginRefs' &&
            localPipelineSelectionsMatch(
              candidate.request.selections,
              selections,
            ),
        );
        if (
          !expanded ||
          expanded.result.kind !== 'codex.pluginRefs' ||
          !localPipelineSelectionsMatch(
            expanded.result.selections,
            selections,
          ) ||
          expanded.result.warnings.length ||
          !lease.factIds.every((id) => expanded.factIds.includes(id))
        )
          return decline('daemon-leases');
      }
    }
    if (!(await current())) return decline('daemon-facts');
  }
  // This is a frozen observation identity, not a claim of live settings.
  // Independent disk validation is awaited before any answer below.
  const isConfigurationCurrent = (epoch: string): boolean =>
    !closed && epoch === evidence.configurationEpoch;
  const preferences = facts.get('data:preferences.json:preferences');
  // The "on" consent the launch observed, read live: any other mode, or
  // another preferences observation, is no consent.
  const aiCreditsConsent = async (): Promise<string | undefined> =>
    preferences &&
    readPipelineSetupFactVersion(roots.data, preferences, operatingSystem, {
      frozenAiCreditsConsent: true,
      requireAiCreditsConsent: true,
      expectedPreferencesVersion: preferences.version,
    });
  let native: PreparedModelAnswers;
  if (managed && isManagedPipelineEvidence(evidence)) {
    const prepared = await prepareManagedPipelineOwnerRun(
      identity,
      evidence,
      {
        ...managed,
        governedModelId: (model) =>
          resolvePipelineGovernedModelId(model, start.launch.modelCatalog),
      },
      {
        isConfigurationCurrent,
        isAiCreditsConsentCurrent: async () =>
          (await aiCreditsConsent()) !== undefined,
        signal,
      },
    );
    if (prepared.kind !== 'managed-model-answers') {
      if (prepared.decision.kind === 'pauses')
        managed.onBlockers?.(prepared.decision.blockers);
      return undefined;
    }
    native = {
      authority: prepared.authority,
      routes: evidence.routes,
      // V1 observers reject new enum values and unknown fields. Keep Cloud
      // custody in the existing epoch record until a revision is negotiated.
      credentialFamilies: prepared.decision.credentialFamilies.filter(
        (family) => family !== 'cloud-account',
      ),
      epochs: [
        {
          authority: 'cloud-account-credential',
          version: String(prepared.decision.credentialGeneration),
        },
      ],
      assumption:
        'Organization policy and AI Credits are read from the account this service holds before every model step; an unknown or blocking answer pauses the run. AI Credits steps use routes this service opened when they started, and their children never receive the account credential.',
    };
  } else {
    const prepared = prepareNativePipelineOwnerRun(identity, evidence, {
      isConfigurationCurrent,
      recordPolicyRefusal: (): void => undefined,
    });
    if (prepared.kind !== 'native-model-answers')
      return decline('daemon-route');
    native = {
      authority: prepared.authority,
      routes: [...prepared.assessment.routes],
      credentialFamilies: [
        ...new Set(
          evidence.routes
            .map((route) => route.authentication)
            .filter((family) => family !== 'unknown'),
        ),
      ],
      epochs: [],
      assumption:
        'Account and policy route decisions are frozen from the trusted desktop launch observation once the starting app disconnects, and stay frozen until the run settles: a reopened app has no context for the run. No Cloud or gateway credentials are held by this authority.',
    };
  }
  if (managed && evidence.aiCredits === 'required') {
    // q-43 C: validate the live mode at admission, then freeze spending
    // consent for survival: opting out ends no step, and each new AI Credits
    // route re-reads it. Other preferences and setup content remain live
    // dependencies.
    const version = await aiCreditsConsent();
    if (!preferences || !version || !(await current())) {
      native.authority.dispose();
      return decline('daemon-facts');
    }
    liveVersions.set(preferences.id, version);
    frozenAiCreditsConsent = true;
  }
  const leases: PipelineOwnerSetupLease[] = [];
  for (const lease of setup.leases) {
    const request = lease.request;
    const result = lease.result;
    if (
      (request.action !== 'owner.claude.modAdmission' &&
        request.action !== 'owner.model.agentAlias' &&
        request.action !== 'owner.codex.pluginRefs') ||
      (result.kind !== 'claude.modAdmission' &&
        result.kind !== 'model.agentAlias' &&
        result.kind !== 'codex.pluginRefs')
    ) {
      native.authority.dispose();
      return decline('daemon-facts');
    }
    const leaseFacts = lease.factIds.map((id) => facts.get(id));
    if (leaseFacts.some((fact) => fact === undefined)) {
      native.authority.dispose();
      return decline('daemon-facts');
    }
    leases.push({
      identity,
      jobId: lease.jobId,
      stepId: lease.stepId,
      request,
      result,
      facts: leaseFacts.flatMap((fact) =>
        fact ? [{ id: fact.id, version: fact.version }] : [],
      ),
    });
  }
  const prepared =
    leases.length > 0
      ? await preparePipelineOwnerSetupLeases(identity, leases, {
          isFactCurrent: async (_identity, fact) => {
            const spec = facts.get(fact.id);
            return (
              spec !== undefined &&
              spec.version === fact.version &&
              (await factCurrent(spec))
            );
          },
        })
      : undefined;
  if (prepared?.kind === 'app-dependent') {
    native.authority.dispose();
    return decline('daemon-leases');
  }
  const setupAuthority = prepared?.authority;
  const survivalAssessment = WorkerPipelineSurvivalAssessmentSchema.parse({
    version: 1,
    identity,
    assessedAt: new Date().toISOString(),
    disposition: 'continues',
    routes: native.routes,
    credentialFamilies: native.credentialFamilies,
    coveredOwnerKinds: [
      'model.invocation',
      'model.routing',
      'model.release',
      'model.policy',
      'model.policyRefusal',
      ...new Set(leases.map((lease) => lease.result.kind)),
    ],
    startLeaseRefs: leases.map((lease) =>
      reference({
        id: JSON.stringify([lease.jobId, lease.stepId, lease.request]),
        version: lease.facts.map((fact) => fact.version).join(':'),
      }),
    ),
    blockers: [],
    ledgerAfterQuit: 'unavailable',
    assumptions: [native.assumption],
    epochs: [
      {
        authority: 'frozen-desktop-route-observation',
        version: evidence.configurationEpoch,
      },
      ...native.epochs,
      ...setup.facts.map((fact) => ({
        authority: `content:${reference({ id: fact.id, version: '' })}`,
        version: fact.version,
      })),
    ],
  });
  const answersFirst = native.authority.answersFirst;
  return {
    survivalAssessment,
    ...(native.authority.bindCheckpoint && {
      bindCheckpoint: native.authority.bindCheckpoint,
    }),
    retire: (): void => {
      native.authority.retire?.();
      setupAuthority?.retire?.();
    },
    discardAnswer: (request): void => {
      native.authority.discardAnswer?.(request);
      setupAuthority?.discardAnswer?.(request);
    },
    ...(answersFirst !== undefined && {
      answersFirst: (request: WorkerPipelineHostRequest): boolean =>
        !closed && answersFirst(request),
    }),
    answer: async (request, requestSignal) => {
      if (
        closed ||
        requestSignal.aborted ||
        request.executionId !== identity.executionId ||
        request.owner !== identity.owner ||
        request.childExecutionId !== null
      )
        return undefined;
      // Ledger degradation never executes/replays an operation. Issued tools
      // are separately fenced by the host's connection epoch.
      let degraded: WorkerPipelineOwnerResult | undefined;
      switch (request.request.action) {
        case 'owner.ledger.open':
          degraded = { kind: 'ledger.open', attempt: null };
          break;
        case 'owner.ledger.codexTools':
          degraded = { kind: 'ledger.codexTools', tools: null };
          break;
        case 'owner.ledger.close':
          degraded = { kind: 'ledger.close' };
          break;
        case 'owner.ledger.codexToolsDispose':
          degraded = { kind: 'ledger.codexToolsDispose' };
          break;
        // A step's agent action tools need the app (CAN-7742): none for a
        // new attempt. The supervisor also asks here for a call it withdrew
        // from an app that left mid-call and may have posted, so a dispatch
        // reads outcome unknown, never "nothing was posted".
        case 'owner.agentActions.open':
          degraded = { kind: 'agentActions.open', tools: null };
          break;
        case 'owner.agentActions.call':
          degraded = {
            kind: 'agentActions.call',
            text:
              request.request.key === 'dispatch_action'
                ? WORKER_PIPELINE_OWNER_AGENT_ACTION_OUTCOME_UNKNOWN_TEXT
                : WORKER_PIPELINE_OWNER_AGENT_ACTION_NOT_SENT_TEXT,
            isError: true,
          };
          break;
      }
      if (degraded) return { result: { status: 'owner', value: degraded } };
      if (
        request.request.action === 'owner.model.release' ||
        request.request.action === 'owner.model.policyRefusal'
      )
        return native.authority.answer(request, requestSignal);
      if (requestSignal.aborted || !(await current())) return undefined;
      return (
        (await native.authority.answer(request, requestSignal)) ??
        (await setupAuthority?.answer(request, requestSignal))
      );
    },
    dispose: (): void => {
      closed = true;
      native.authority.dispose();
      setupAuthority?.dispose();
      facts.clear();
    },
  };
}

import { randomUUID } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { constants } from 'node:os';
import * as path from 'node:path';
import { createCanopyDispatcher } from '@canopy/core-runtime';
import {
  createActivationExecutionSecretSource,
  refusingExecutionSecretSource,
} from '@canopy/core-runtime/node/execution-secrets';
import { isTerminalPipelineExecution } from '@canopy/core-runtime/node/pipeline';
import { PIPELINE_HOST_DEFINITIONS } from '@canopy/core-runtime/node/pipeline/host';
import { createOwnedProcessHostPort } from '@canopy/core-platform/execution-host';
import { DAEMON_PIPELINE_HOST_ENTRY } from '@canopy/core-platform/execution-host/daemon-payload';
import { createExecutionProcessServices } from '@canopy/core-platform/supervision/execution-process';
import {
  WORKER_PIPELINE_GRANTS,
  WorkerPipelineExecutionStartParamsSchema,
  type CanopyCallerDescriptor,
  type WorkerPipelineExecution,
} from '@canopy/protocol/canopy-core';
import type { CloudRunnerActivation } from '@canopy/protocol/pipeline-relay';
import { brandEnvName } from '../../../brand/env';
import {
  pipelineRunnerStartedReport,
  readPipelineRunnerBundle,
  verifyPipelineRunnerBundle,
  type PipelineRunnerBundle,
} from './bundle';
import {
  PIPELINE_RUNNER_BUNDLE_LAYOUT,
  PIPELINE_RUNNER_HOST_BUDGET,
  assertPipelineRunnerNotInit,
  createPipelineRunner,
  pipelineRunnerLayout,
  verifyPipelineRunnerLayout,
  type PipelineRunnerLayout,
} from './runner';
import {
  parsePipelineRunnerActivation,
  pipelineRunnerStoreCensus,
  pipelineRunnerLeaseOf,
  pipelineRunnerRelayExitCode,
  servePipelineRunnerRelay,
} from './relay';

/*
 * The cloud runner's process (CAN-6200, cloud pipelines CP-10), bundled as
 * `runner/pipeline-runner.js` and run by the bundle's Node runtime under an
 * init process. It reports its version, bundle digest and tool versions as
 * its first line, then:
 *
 *   report    exits.
 *   verify    checks every bundle file against the record, then exits.
 *   run --start <file> --data <dir> --checkout <dir>
 *             runs one portable start through the runner composition and
 *             exits with its outcome. It is the local stand-in for the web
 *             core: the relay entry that serves `worker.pipeline.*` to the
 *             web core is CP-11. A run with owner requests waits for an owner
 *             that never subscribes, so only owner-free workflows finish.
 *
 * Every line on stdout is one JSON object.
 */

/** The web core's stand-in: the caller grants the relay will carry. */
const LOCAL_CALLER: CanopyCallerDescriptor = {
  principalId: 'pipeline-runner',
  clientInstanceId: 'pipeline-runner:local',
  authorityId: 'pipeline-runner',
  interfaceKind: 'worker',
  grants: [WORKER_PIPELINE_GRANTS.read, WORKER_PIPELINE_GRANTS.write],
};

const EXIT_FAILED = 1;
const EXIT_USAGE = 2;

function print(line: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

function flag(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? undefined : args[index + 1];
}

async function directoryFlag(
  args: readonly string[],
  name: string,
): Promise<string> {
  const value = flag(args, name);
  if (!value || !path.isAbsolute(value))
    throw new UsageError(`--${name} needs an absolute directory.`);
  return realpath(value);
}

class UsageError extends Error {}

interface RunnerProcess {
  readonly layout: PipelineRunnerLayout;
  readonly launchHost: () => ReturnType<
    ReturnType<typeof createOwnedProcessHostPort>['launch']
  >;
  readonly stopHosts: () => Promise<void>;
}

/** The layout and host port of one runner process over its bundle. */
async function runnerProcess(
  bundleRoot: string,
  bundle: PipelineRunnerBundle,
  args: readonly string[],
): Promise<RunnerProcess> {
  const dataRoot = await directoryFlag(args, 'data');
  const checkout = await directoryFlag(args, 'checkout');
  const at = (member: string): string => path.join(bundleRoot, member);
  const binPath = [
    path.dirname(at(PIPELINE_RUNNER_BUNDLE_LAYOUT.gh)),
    path.dirname(at(PIPELINE_RUNNER_BUNDLE_LAYOUT.nodeRuntime)),
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
  ].join(':');
  // The host and steps keep the runner's own home and locale; nothing here
  // overrides them (a Codex home is the host's to set up, not the runner's).
  const inherited = Object.fromEntries(
    ['HOME', 'LANG', 'TZ'].flatMap((name) => {
      const value = process.env[name];
      return value === undefined ? [] : [[name, value]];
    }),
  );
  const layout = pipelineRunnerLayout({
    bundleRoot,
    dataRoot,
    checkout,
    processEnvironment: { ...inherited, PATH: binPath },
    providerBinaries: true,
  });
  const missing = await verifyPipelineRunnerLayout(layout);
  if (missing.length > 0)
    throw new Error(`The runner layout is missing ${missing.join(', ')}.`);
  const hosts = createOwnedProcessHostPort({
    services: createExecutionProcessServices({ os: 'linux' }),
    shell: { executable: at(bundle.record.daemon), args: [] },
    cwd: dataRoot,
    // The host refuses a data root that is not its own, and finds the
    // bundle's tools through their overrides: on Linux it would otherwise
    // look beside the daemon executable.
    environment: () => ({
      ...inherited,
      PATH: binPath,
      CANOPY_DATA_DIR: dataRoot,
      [brandEnvName('CLAUDE_BINARY_PATH')]: at(
        PIPELINE_RUNNER_BUNDLE_LAYOUT.claude,
      ),
      [brandEnvName('CODEX_BINARY_PATH')]: at(
        PIPELINE_RUNNER_BUNDLE_LAYOUT.codex,
      ),
      [brandEnvName('GH_BINARY_PATH')]: at(PIPELINE_RUNNER_BUNDLE_LAYOUT.gh),
      [brandEnvName('RTK_BINARY_PATH')]: at(PIPELINE_RUNNER_BUNDLE_LAYOUT.rtk),
    }),
    diagnostics: (_stream, bytes) => process.stderr.write(bytes),
  });
  return {
    layout,
    launchHost: () =>
      hosts.launch({
        entry: DAEMON_PIPELINE_HOST_ENTRY,
        serviceName: 'Pipeline host',
        budget: PIPELINE_RUNNER_HOST_BUDGET,
      }),
    stopHosts: () => hosts.shutdown(),
  };
}

async function runStart(
  bundleRoot: string,
  bundle: PipelineRunnerBundle,
  args: readonly string[],
): Promise<number> {
  const startFile = flag(args, 'start');
  if (!startFile) throw new UsageError('run needs --start <file>.');
  const params = WorkerPipelineExecutionStartParamsSchema.parse(
    JSON.parse(await readFile(startFile, 'utf8')),
  );
  if (!params.portableLaunch)
    throw new UsageError('The start must be a portable start.');
  const { layout, launchHost, stopHosts } = await runnerProcess(
    bundleRoot,
    bundle,
    args,
  );
  const runner = createPipelineRunner({
    layout,
    launchHost,
    stopHosts,
    // Secrets come with a relay activation (CP-27); a local run has none.
    secrets: refusingExecutionSecretSource,
    targetId: flag(args, 'target-id') ?? 'pipeline-runner:local',
  });
  const dispatcher = createCanopyDispatcher({
    profile: 'worker',
    definitions: PIPELINE_HOST_DEFINITIONS,
    handlers: runner.handlers,
  });
  // The init process forwards a container stop: stop the host and its step
  // trees before exiting, rather than leaving them to the kill that follows.
  const stopOn = (signal: NodeJS.Signals): void => {
    print({ event: 'pipeline-runner.stopping', signal });
    void runner.supervisor
      .stop()
      .then(stopHosts)
      .finally(() => process.exit(128 + constants.signals[signal]));
  };
  process.once('SIGTERM', stopOn);
  process.once('SIGINT', stopOn);
  try {
    const { execution } = await dispatcher.instruction(
      'worker.pipeline.execution.start',
      params,
      { caller: LOCAL_CALLER, metadata: { idempotencyKey: randomUUID() } },
    );
    print({ event: 'pipeline-runner.run', execution });
    const done = await new Promise<WorkerPipelineExecution>(
      (resolve, reject) => {
        dispatcher
          .openStream(
            'worker.pipeline.execution.events',
            { executionId: execution.executionId },
            {
              caller: LOCAL_CALLER,
              onFrame: (frame) => {
                if (frame.kind === 'end') {
                  reject(
                    new Error(
                      `The events stream ended (${frame.outcome}) before the run settled.`,
                    ),
                  );
                  return;
                }
                const { item } = frame;
                if (item.kind === 'output')
                  print({
                    event: 'pipeline-runner.output',
                    jobId: item.jobId,
                    stepId: item.stepId,
                    stream: item.stream,
                    text: item.text,
                  });
                else if (item.kind === 'execution') {
                  print({
                    event: 'pipeline-runner.execution',
                    status: item.execution.status,
                  });
                  if (isTerminalPipelineExecution(item.execution))
                    resolve(item.execution);
                }
              },
            },
          )
          .catch(reject);
      },
    );
    print({ event: 'pipeline-runner.settled', execution: done });
    return done.status === 'success' ? 0 : EXIT_FAILED;
  } finally {
    await runner.supervisor.stop();
    await stopHosts();
  }
}

async function readActivation(source: string): Promise<CloudRunnerActivation> {
  let text: string;
  if (source === '-') {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin)
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    text = Buffer.concat(chunks).toString('utf8');
  } else text = await readFile(source, 'utf8');
  const activation = parsePipelineRunnerActivation(text);
  // Its error would name what the body holds; the runner never prints it.
  if (activation === null) throw new UsageError('The activation is not valid.');
  return activation;
}

async function serveRelay(
  bundleRoot: string,
  bundle: PipelineRunnerBundle,
  args: readonly string[],
): Promise<number> {
  const source = flag(args, 'activation');
  if (!source) throw new UsageError('relay needs --activation <file|->.');
  const activation = await readActivation(source);
  const { layout, launchHost, stopHosts } = await runnerProcess(
    bundleRoot,
    bundle,
    args,
  );
  // The grant is staged in memory as the runner starts (CAN-6215).
  const secrets = createActivationExecutionSecretSource(activation.secrets);
  const runner = createPipelineRunner({
    layout,
    launchHost,
    stopHosts,
    secrets,
    // Its TTL comes with the first portable start; one incarnation serves
    // one delegation.
    remoteOwner: { lease: pipelineRunnerLeaseOf(activation) },
    targetId:
      flag(args, 'target-id') ?? `pipeline-runner:${activation.delegationId}`,
  });
  print({
    event: 'pipeline-runner.relay',
    delegationId: activation.delegationId,
    leaseEpoch: activation.leaseEpoch,
    credentialId: activation.credentialId,
    expiresAt: activation.expiresAt,
  });
  const relay = servePipelineRunnerRelay({
    runner,
    activation,
    onConnection: (event) =>
      print({ event: 'pipeline-runner.relay.connection', ...event }),
  });
  // The supervisor checkpoints a running run as paused, and its state stays
  // on the data root for the next incarnation. On a stop signal the relay
  // stays up meanwhile, so the web core sees each pause.
  let stopping: Promise<void> | null = null;
  const stopRuns = (): Promise<void> => (stopping ??= runner.supervisor.stop());
  // The runs its host ran when the signal came, which the stop checkpoints.
  let runningAtSignal = 0;
  let signalled = false;
  const stopOn = (signal: NodeJS.Signals): void => {
    print({ event: 'pipeline-runner.stopping', signal });
    signalled = true;
    runningAtSignal = runner.supervisor.runningExecutionIds().length;
    void stopRuns().finally(() => relay.stop());
  };
  process.once('SIGTERM', stopOn);
  process.once('SIGINT', stopOn);
  try {
    const end = await relay.ended;
    // What it left is read from its store once it stopped: nothing is
    // admitted after, and every checkpoint and orphan is on disk.
    await stopRuns();
    const left = await pipelineRunnerStoreCensus(layout.dataRoot);
    const code = pipelineRunnerRelayExitCode({
      end,
      signalled,
      runningAtSignal,
      ...left,
    });
    print({
      event: 'pipeline-runner.relay.ended',
      end,
      runningAtSignal,
      ...left,
      code,
    });
    return code;
  } finally {
    await stopRuns();
    await stopHosts();
    secrets.dispose();
  }
}

async function main(args: readonly string[]): Promise<number> {
  assertPipelineRunnerNotInit();
  // The entry runs from `<bundle>/runner/`.
  const bundleRoot = path.resolve(path.dirname(process.argv[1] ?? ''), '..');
  const bundle = await readPipelineRunnerBundle(bundleRoot);
  print(pipelineRunnerStartedReport(bundle));
  switch (args[0]) {
    case 'report':
      return 0;
    case 'verify': {
      const problems = await verifyPipelineRunnerBundle(
        bundleRoot,
        bundle.record,
      );
      print({ event: 'pipeline-runner.verified', problems });
      return problems.length === 0 ? 0 : EXIT_FAILED;
    }
    case 'run':
      return runStart(bundleRoot, bundle, args.slice(1));
    case 'relay':
      return serveRelay(bundleRoot, bundle, args.slice(1));
    default:
      throw new UsageError(
        'Usage: pipeline-runner report | verify | run | relay.',
      );
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    print({ event: 'pipeline-runner.failed', message });
    process.exitCode = error instanceof UsageError ? EXIT_USAGE : EXIT_FAILED;
  },
);

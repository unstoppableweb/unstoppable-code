/**
 * The CAN-7176 child chat writer: a plain Node process that composes the real
 * chat repository over a scratch root and runs the R0 workload's steps on
 * request. Each request is one line of JSON on a Unix socket and is answered,
 * after its commit resolves, with the commit's revision. When the step named
 * by R0_PAUSE_STEP reaches the journal boundary named by R0_PAUSE_AT, the
 * child prints `paused <boundary>` and waits for its parent to kill it.
 */
import { createServer, type Socket } from 'node:net';
import { createInterface } from 'node:readline';
import type { DeltaJournalBoundary } from '../../lib/chat-delta-journal/writer';
import { STEPS, openAt, scope } from './chat-r0-commit-workload';

const root = process.env.R0_WRITER_ROOT ?? '';
const socketPath = process.env.R0_WRITER_SOCKET ?? '';
const pauseStep = process.env.R0_PAUSE_STEP;
const pauseAt = process.env.R0_PAUSE_AT;
if (!root || !socketPath)
  throw new Error('R0 child writer: missing root or socket');

let current = '';
const repository = openAt(
  root,
  'format 4',
  async (point: DeltaJournalBoundary): Promise<void> => {
    if (current !== pauseStep || point !== pauseAt) return;
    process.stdout.write(`paused ${point}\n`);
    await new Promise<never>(() => undefined);
  },
);

let chain: Promise<void> = Promise.resolve();

function serve(socket: Socket): void {
  const lines = createInterface({ input: socket });
  lines.on('line', (line) => {
    const request: unknown = JSON.parse(line);
    const step =
      typeof request === 'object' && request !== null && 'step' in request
        ? request.step
        : undefined;
    if (typeof step !== 'number' || !STEPS[step])
      throw new Error(`R0 child writer: invalid request ${line}`);
    chain = chain.then(async (): Promise<void> => {
      const work = STEPS[step];
      current = work.id;
      const commit = await repository.transact(
        scope,
        work.mutations,
        work.options,
      );
      socket.write(
        `${JSON.stringify({ step, revision: commit.revision, applied: commit.applied })}\n`,
      );
    });
  });
}

createServer(serve).listen(socketPath, () => {
  process.stdout.write('ready\n');
});

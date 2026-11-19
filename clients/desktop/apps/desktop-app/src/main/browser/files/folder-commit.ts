import { getDesktopNodeRuntime } from '../../lib/node-runtime';
import { cleanTrustedNodeEnvironment } from '../../lib/trusted-node-environment';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { z } from 'zod';

/**
 * Commits a copy's temp file to its name from inside the checked folder.
 * Node has no `linkat` or `renameat`, and a link or rename by absolute paths
 * looks up its two names one after the other: a parent folder swapped for a
 * link in between would find the source in the real folder and the
 * destination outside. A helper process whose working folder is the checked
 * folder commits by bare names instead, so both resolve in that folder however
 * its parents change. The caller compares the folder the helper is bound to
 * with the one it checked before it asks for the commit.
 *
 * On Windows, Node turns the bare names into full paths from the working
 * folder's path. There the binding relies on the helper's open working folder
 * keeping that folder and its parents from being renamed or removed, which is
 * not verified on Windows yet.
 */

interface FileIdentity {
  dev: number;
  ino: number;
}

export interface CommitRequest {
  tempName: string;
  temp: FileIdentity;
  name: string;
  overwrite: boolean;
}

const outcomeSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('committed') }),
  z.object({
    type: z.literal('refused'),
    reason: z.enum([
      'bad_request',
      'temp_changed',
      'folder_at_name',
      'not_placed',
    ]),
  }),
  z.object({ type: z.literal('failed'), code: z.string() }),
]);
const boundSchema = z.object({
  type: z.literal('bound'),
  dev: z.number(),
  ino: z.number(),
});

export type CommitOutcome = z.infer<typeof outcomeSchema>;

export interface BoundFolder {
  /** The folder the helper's names resolve in. */
  readonly identity: FileIdentity;
  /** Commits once. The helper exits after it replies. */
  commit(request: CommitRequest): Promise<CommitOutcome>;
  /** Ends the helper, committing nothing that was not already asked for. */
  close(): void;
}

const HELPER_TIMEOUT_MS = 30_000;

/**
 * Prints the identity of its working folder, then reads one commit request.
 * The temp file must still be the one written. Without overwrite the commit
 * is a hard link, which fails if anything has the name; with it, a rename,
 * refused when a folder has the name. The temp name is removed whenever it
 * is still the copy, and the reply says whether the name holds the copy.
 */
const COMMIT_SCRIPT = String.raw`
const { linkSync, lstatSync, renameSync, unlinkSync } = require('node:fs');

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}
function codeOf(error) {
  return error && typeof error === 'object' && 'code' in error
    ? String(error.code)
    : 'UNKNOWN';
}
function bare(name) {
  return (
    typeof name === 'string' &&
    name !== '' &&
    name !== '.' &&
    name !== '..' &&
    !/[\\/\0]/.test(name)
  );
}
function holdsCopy(name, temp) {
  try {
    const stat = lstatSync(name);
    return stat.isFile() && stat.dev === temp.dev && stat.ino === temp.ino;
  } catch {
    return false;
  }
}
function commit(request) {
  const temp = request && request.temp;
  if (
    !bare(request && request.tempName) ||
    !bare(request && request.name) ||
    !temp ||
    typeof temp.dev !== 'number' ||
    typeof temp.ino !== 'number'
  )
    return { type: 'refused', reason: 'bad_request' };
  const { tempName, name, overwrite } = request;
  if (!holdsCopy(tempName, temp))
    return { type: 'refused', reason: 'temp_changed' };
  let outcome = { type: 'committed' };
  try {
    if (overwrite === true) {
      let existing;
      try {
        existing = lstatSync(name);
      } catch (error) {
        if (codeOf(error) !== 'ENOENT') throw error;
      }
      if (existing && existing.isDirectory())
        outcome = { type: 'refused', reason: 'folder_at_name' };
      else renameSync(tempName, name);
    } else {
      linkSync(tempName, name);
    }
  } catch (error) {
    outcome = { type: 'failed', code: codeOf(error) };
  }
  if (outcome.type === 'committed' && !holdsCopy(name, temp))
    outcome = { type: 'refused', reason: 'not_placed' };
  if (holdsCopy(tempName, temp)) {
    try {
      unlinkSync(tempName);
    } catch {
      /* The caller removes it by identity. */
    }
  }
  return outcome;
}

const here = lstatSync('.');
send({ type: 'bound', dev: here.dev, ino: here.ino });
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
  const end = input.indexOf('\n');
  if (end === -1) return;
  process.stdin.destroy();
  let request;
  try {
    request = JSON.parse(input.slice(0, end));
  } catch {
    request = undefined;
  }
  send(commit(request));
});
`;

function parsed<T>(schema: z.ZodType<T>, line: string): T {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error('The commit helper sent an unreadable reply.');
  }
  const result = schema.safeParse(value);
  if (!result.success)
    throw new Error('The commit helper sent an unexpected reply.');
  return result.data;
}

/** Starts the helper in `folder` and waits for the folder it is bound to. */
export async function bindFolder(folder: string): Promise<BoundFolder> {
  const child = spawn(
    (await getDesktopNodeRuntime()).nodeProcess.command,
    ['--disable-sigusr1', '--input-type=commonjs', '--eval', COMMIT_SCRIPT],
    {
      cwd: folder,
      env: cleanTrustedNodeEnvironment(process.env),
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
    },
  );
  const reader = createInterface({ input: child.stdout });
  const lines = reader[Symbol.asyncIterator]();
  let timer: NodeJS.Timeout | undefined;
  const stopped = new Promise<never>((_, reject) => {
    child.once('error', reject);
    timer = setTimeout(() => {
      reject(new Error('The commit helper did not reply in time.'));
    }, HELPER_TIMEOUT_MS);
    timer.unref();
  });
  stopped.catch(() => undefined);
  // A helper that already exited cannot take the request; its reply never comes.
  child.stdin.on('error', () => undefined);
  const finish = (): void => {
    clearTimeout(timer);
    reader.close();
    child.kill();
  };
  const nextLine = async (): Promise<string> => {
    const line = await Promise.race([lines.next(), stopped]);
    if (line.done) throw new Error('The commit helper stopped.');
    return line.value;
  };
  try {
    const bound = parsed(boundSchema, await nextLine());
    return {
      identity: { dev: bound.dev, ino: bound.ino },
      async commit(request): Promise<CommitOutcome> {
        child.stdin.end(`${JSON.stringify(request)}\n`);
        try {
          return parsed(outcomeSchema, await nextLine());
        } finally {
          finish();
        }
      },
      close: finish,
    };
  } catch (error) {
    finish();
    throw error;
  }
}

import { randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  rename,
  unlink,
  type FileHandle,
} from 'node:fs/promises';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { canopyLaunchDetails } from '@canopy/core-client/node';
import type {
  PlatformOwnedChild,
  PlatformOwnedChildServices,
} from '@canopy/core-runtime';
import type { CanopyErrorKind } from '@canopy/protocol/canopy-core';
import { redactSecrets } from '@canopy/protocol/secret-redaction';
import type { W5HandoffStage } from '../lib/w5-handoff-store';

type LaunchFacts = ReturnType<typeof canopyLaunchDetails>;
interface EndpointFacts {
  readonly endpointSelection: 'direct' | 'alias';
  readonly socketPathBytes: number;
  readonly bindSiblingBytes: number;
}
interface AttemptFacts extends LaunchFacts {
  readonly attemptId: string;
  readonly loadDiagnostic?: string;
  readonly stderrTail?: string;
  readonly stderrEnd?: 'eof' | 'drain_deadline' | 'truncated' | 'unavailable';
  readonly daemonPid?: number;
}
export interface DaemonHandoffFacts extends LaunchFacts {
  readonly stage?: W5HandoffStage;
  readonly errorKind?: CanopyErrorKind;
  readonly refusal?: string;
}
interface Options {
  readonly directory: string;
  readonly appVersion: string;
  readonly home: string;
  readonly warn: (facts: {
    readonly file: string;
    readonly kind: 'attempt' | 'handoff' | 'write_failed';
  }) => void;
}
const FILE_LIMIT = 256 * 1024;
const RING_LIMIT = 8 * 1024;
const utf8Tail = (text: string, limit: number): string => {
  let bytes = Buffer.from(text);
  if (bytes.length <= limit) return text;
  bytes = bytes.subarray(bytes.length - limit);
  let start = 0;
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
  return bytes.subarray(start).toString('utf8');
};
const field = (value: unknown, name: string): unknown =>
  typeof value === 'object' && value !== null
    ? Object.getOwnPropertyDescriptor(value, name)?.value
    : undefined;
const sameNode = (a: Stats, b: Stats): boolean =>
  a.dev === b.dev && a.ino === b.ino;
const privateFile = (stats: Stats): boolean =>
  stats.isFile() && stats.uid === process.getuid?.() && stats.nlink === 1;

async function checkedFile(path: string): Promise<FileHandle> {
  const before = await lstat(path).catch((error: unknown) => {
    if (field(error, 'code') === 'ENOENT') return undefined;
    throw error;
  });
  if (before && !privateFile(before))
    throw new Error('Unsafe diagnostic file.');
  // Node opens file descriptors close-on-exec. EXCL protects an absent path.
  const flags =
    constants.O_WRONLY |
    constants.O_APPEND |
    constants.O_CREAT |
    constants.O_NOFOLLOW |
    (before ? 0 : constants.O_EXCL);
  const handle = await open(path, flags, 0o600);
  try {
    const opened = await handle.stat();
    if (
      !privateFile(opened) ||
      (before && !sameNode(before, opened)) ||
      !sameNode(opened, await lstat(path))
    )
      throw new Error('Diagnostic file identity changed.');
    await handle.chmod(0o600);
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

export function createDaemonStartDiagnostics(options: Options): {
  wrap(services: PlatformOwnedChildServices): PlatformOwnedChildServices;
  endpoint(facts: EndpointFacts): void;
  attempt(facts: AttemptFacts): Promise<void>;
  handoff(
    facts: DaemonHandoffFacts,
  ): DaemonHandoffFacts & Partial<EndpointFacts>;
  dispose(): void;
  flush(): Promise<void>;
} {
  const file = join(options.directory, 'background-service.log');
  let endpoint: EndpointFacts | undefined;
  let writes = Promise.resolve();
  let latestAttemptId: string | undefined;
  let disposed = false;
  const active = new Set<() => void>();
  function sanitize(value: string, limit: number, tail = false): string {
    const assignments = value.replace(
      /\b[A-Za-z_][A-Za-z0-9_]*=(?:"(?:\\[\s\S]|[^"\\]|\\$)*(?:"|$)|'(?:\\[\s\S]|[^'\\]|\\$)*(?:'|$)|\\[^\r\n]|[^\s"'\\]|\\(?=\r|\n|$))*/g,
      (assignment) =>
        `${assignment.slice(0, assignment.indexOf('=') + 1)}[redacted]`,
    );
    const redacted = redactSecrets(assignments)
      .replace(/[a-fA-F0-9]{32,}/g, '[redacted]')
      .replace(/[A-Za-z0-9+/_-]{40,}={0,2}/g, '[redacted]')
      .split('<user-home>')
      .join('~')
      .split(options.home)
      .join('~');
    if (tail) return utf8Tail(redacted, limit);
    const bytes = Buffer.from(redacted);
    let end = Math.min(bytes.length, limit);
    while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
    return bytes.subarray(0, end).toString('utf8');
  }
  async function write(
    kind: 'attempt' | 'handoff',
    facts: object,
  ): Promise<void> {
    const line =
      JSON.stringify({
        v: 1,
        kind,
        at: new Date().toISOString(),
        os: 'linux',
        appVersion: options.appVersion,
        ...facts,
      }) + '\n';
    writes = writes
      .then(async (): Promise<void> => {
        await mkdir(options.directory, { recursive: true, mode: 0o700 });
        let handle = await checkedFile(file);
        try {
          if (
            (await handle.stat()).size + Buffer.byteLength(line) >
            FILE_LIMIT
          ) {
            const rotated = `${file}.1`;
            const target = await lstat(rotated).catch((error: unknown) => {
              if (field(error, 'code') === 'ENOENT') return undefined;
              throw error;
            });
            if (target) {
              const previous = await checkedFile(rotated);
              try {
                if (!sameNode(await previous.stat(), await lstat(rotated)))
                  throw new Error('Rotated diagnostic identity changed.');
                await unlink(rotated);
              } finally {
                await previous.close();
              }
            }
            if (!sameNode(await handle.stat(), await lstat(file)))
              throw new Error('Diagnostic identity changed before rotation.');
            await rename(file, rotated);
            await handle.close();
            handle = await checkedFile(file);
          }
          await handle.writeFile(line);
          options.warn({ file: 'background-service.log', kind });
        } finally {
          await handle.close();
        }
      })
      .catch(() => {
        options.warn({ file: 'background-service.log', kind: 'write_failed' });
      });
    await writes;
  }
  async function attempt(facts: AttemptFacts): Promise<void> {
    const { loadDiagnostic, stderrTail, ...closed } = facts;
    await write('attempt', {
      ...closed,
      ...(loadDiagnostic !== undefined && {
        loadDiagnostic: sanitize(loadDiagnostic, 1024),
      }),
      ...(stderrTail !== undefined && {
        stderrTail: sanitize(stderrTail, 4096, true),
      }),
    });
  }
  return {
    endpoint(facts): void {
      endpoint = facts;
    },
    attempt,
    handoff(facts): DaemonHandoffFacts & Partial<EndpointFacts> {
      const result = { ...facts, ...endpoint };
      const { cause, ...rest } = result;
      void write('handoff', {
        ...rest,
        ...(cause && { claimCause: cause }),
        ...(latestAttemptId && { attemptId: latestAttemptId }),
      }).catch((): void => {});
      return result;
    },
    wrap(services): PlatformOwnedChildServices {
      return {
        async spawn(request) {
          const attemptId = randomUUID();
          latestAttemptId = attemptId;
          let child: PlatformOwnedChild;
          try {
            child = await services.spawn({
              ...request,
              captureStderr: !disposed,
            });
          } catch (error) {
            const diagnostic = field(error, 'loadDiagnostic');
            void attempt({
              attemptId,
              ...canopyLaunchDetails({
                errno: field(error, 'spawnErrno'),
                nativeStage: field(error, 'reason'),
              }),
              ...(typeof diagnostic === 'string' && {
                loadDiagnostic: diagnostic,
              }),
            }).catch(() => undefined);
            throw error;
          }
          const stream: Readable | undefined = child.stderr;
          let ring = Buffer.alloc(0);
          let ringStartsMidRecord = false;
          let discardedWord = false;
          let discardedName = false;
          let discardedAssignment = false;
          let discardedQuote: string | undefined;
          let discardedEscape = false;
          const discardedDecoder = new TextDecoder();
          function discardCharacter(character: string): void {
            ringStartsMidRecord = true;
            if (discardedAssignment) {
              if (discardedEscape) discardedEscape = false;
              else if (character === '\\') discardedEscape = true;
              else if (discardedQuote !== undefined) {
                if (character === discardedQuote) discardedQuote = undefined;
              } else if (character === '"' || character === "'")
                discardedQuote = character;
              else if (/\s/.test(character)) discardedAssignment = false;
              if (discardedAssignment) return;
            }
            if (/\w/.test(character)) {
              if (!discardedWord) discardedName = /[A-Za-z_]/.test(character);
              discardedWord = true;
            } else {
              discardedAssignment = character === '=' && discardedName;
              discardedWord = false;
              discardedName = false;
            }
            ringStartsMidRecord = character !== '\n';
          }
          function discard(bytes: Buffer): void {
            ringStartsMidRecord = true;
            for (const character of discardedDecoder.decode(bytes, {
              stream: true,
            }))
              discardCharacter(character);
          }
          let ended = stream?.readableEnded ?? false;
          let truncated = false;
          let finished = false;
          let drainDeadline: AbortSignal | undefined;
          let exit: Awaited<typeof child.exited> | undefined;
          function dispose(): void {
            if (finished) return;
            finished = true;
            drainDeadline?.removeEventListener('abort', deadlineReached);
            stream?.destroy();
            ring = Buffer.alloc(0);
            active.delete(dispose);
          }
          function finalize(
            stderrEnd: 'eof' | 'drain_deadline' | 'truncated' | 'unavailable',
          ): void {
            if (finished || !exit) return;
            // Eviction may remove NAME= and the opening quote of a multiline value.
            let start = 0;
            while (ringStartsMidRecord && start < ring.length) {
              discard(ring.subarray(start, start + 1));
              start++;
            }
            const stderrTail = ring.subarray(start).toString('utf8');
            const facts = {
              attemptId,
              daemonPid: child.pid,
              ...canopyLaunchDetails({
                exitCode: exit.code,
                signal: exit.signal,
              }),
              ...(stream && { stderrTail }),
              stderrEnd,
            };
            dispose();
            void attempt(facts);
          }
          active.add(dispose);
          if (disposed) dispose();
          stream?.on('data', (chunk: Buffer): void => {
            if (finished) return;
            const evicted = ring.length + chunk.length - RING_LIMIT;
            if (evicted > 0) {
              discard(ring.subarray(0, evicted));
              const evictedChunkBytes = Math.max(0, evicted - ring.length);
              if (evictedChunkBytes > 0)
                discard(chunk.subarray(0, evictedChunkBytes));
            }
            ring =
              chunk.length >= RING_LIMIT
                ? Buffer.from(chunk.subarray(-RING_LIMIT))
                : Buffer.concat([ring, chunk]).subarray(-RING_LIMIT);
          });
          function deadlineReached(): void {
            finalize('drain_deadline');
          }
          const end = (): void => {
            ended = true;
            finalize('eof');
          };
          const interrupted = (): void => {
            if (ended) return;
            truncated = true;
            finalize('truncated');
          };
          stream?.once('end', end);
          stream?.once('close', interrupted);
          stream?.once('error', interrupted);
          void child.exited.then((facts): void => {
            if (finished) return;
            exit = facts;
            if (!stream) finalize('unavailable');
            else if (ended) finalize('eof');
            else if (truncated) finalize('truncated');
            else {
              drainDeadline = AbortSignal.timeout(500);
              drainDeadline.addEventListener('abort', deadlineReached, {
                once: true,
              });
            }
          }, dispose);
          return {
            ...child,
            commit(signal): void {
              child.commit(signal);
              if (latestAttemptId === attemptId) latestAttemptId = undefined;
              dispose();
            },
            terminate(signal): Promise<void> {
              return child.terminate(signal);
            },
          };
        },
      };
    },
    dispose(): void {
      disposed = true;
      for (const close of active) close();
    },
    flush(): Promise<void> {
      return writes;
    },
  };
}

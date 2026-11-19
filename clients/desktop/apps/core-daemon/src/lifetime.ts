import {
  createWindowsClosureWitness,
  type GitReadSelections,
  hostPlatformOperatingSystem,
} from '@canopy/core-platform';

/** A daemon run whose required closure is unconfirmed, on any platform. */
export const EXIT_CLOSURE_UNCONFIRMED = 70;
/** The last stdout a qualification run writes, once closure is accepted. */
export const CLOSURE_RECEIPT = 'canopy-daemon-closure-v1 accepted\n';
/** Starts the one stdout line `--git-receipt v1` adds, before any other output. */
export const GIT_RECEIPT_PREFIX = 'canopy-daemon-git-v1 ';
/**
 * The Git receipt line's UTF-8 bytes at most, newline included. Escaping can
 * grow a path sixfold; this keeps the line within a qualifier's stdout limit.
 */
export const GIT_RECEIPT_LINE_LIMIT = 16 * 1024;
const UNCONFIRMED = 'Daemon closure is unconfirmed.';

export interface DaemonOutcome {
  readonly code: number;
  /** Fixed text for stderr; empty writes nothing. */
  readonly message: string;
}

/** What the daemon's work reports to its lifetime owner. */
export interface DaemonLifetime {
  /** The launcher passed `--closure-receipt v1`; only Windows honors it. */
  requestClosureReceipt(): void;
  /** The launcher passed `--git-receipt v1`; every OS honors it. */
  requestGitReceipt(): void;
  /** `RunningCanopyDaemon.seal`'s result; acceptance needs every one true. */
  recordSeal(sealed: boolean): void;
  /** The Gits the daemon ran, once its Git host stopped; the last record wins. */
  recordGitSelections(selections: GitReadSelections): void;
}

export interface DaemonLifetimeHost {
  readonly windows: boolean;
  setDefaultExit(code: number): void;
  writeErr(text: string, done: () => void): void;
  writeOut(text: string, done: (error?: Error | null) => void): void;
  exit(code: number): void;
}

export function nodeDaemonLifetimeHost(): DaemonLifetimeHost {
  let windows = false;
  try {
    windows = hostPlatformOperatingSystem() === 'win32';
  } catch {
    // An unsupported host has no verdict channel; startup refuses it.
  }
  return {
    windows,
    setDefaultExit: (code): void => {
      process.exitCode = code;
    },
    writeErr: (text, done): void => {
      process.stderr.write(text, () => done());
    },
    writeOut: (text, done): void => {
      process.stdout.write(text, done);
    },
    // Exit explicitly: a timed-out phase or a still-bound endpoint can keep the
    // loop alive, and a dead owner lets the next daemon's stale-owner proof reclaim it.
    exit: (code): void => process.exit(code),
  };
}

/** One reported Git: only these fields reach the receipt. */
interface GitReceiptEntry {
  readonly path: string;
  readonly version: string | null;
}

function gitReceiptText(
  selections: readonly GitReceiptEntry[],
  overflow: boolean,
): string {
  return `${GIT_RECEIPT_PREFIX}${JSON.stringify({ selections, overflow })}\n`;
}

/**
 * One JSON line of the selected Gits' paths and validated versions. JSON
 * escapes every control character, so a path cannot end the line early.
 * Paths are not secret, and only a qualifier asks for them. A selection that
 * would pass GIT_RECEIPT_LINE_LIMIT is left out and flagged as overflow.
 */
export function gitReceiptLine({
  selections,
  overflow,
}: GitReadSelections): string {
  const kept: GitReceiptEntry[] = [];
  let dropped = overflow;
  for (const { executable, version } of selections) {
    const entry = { path: executable, version };
    // Measured with `false`, the longer flag, so the final line fits either way.
    if (
      Buffer.byteLength(gitReceiptText([...kept, entry], false)) <=
      GIT_RECEIPT_LINE_LIMIT
    )
      kept.push(entry);
    else dropped = true;
  }
  return gitReceiptText(kept, dropped);
}

/**
 * Owns one daemon lifetime: a single closure witness run encloses all of the
 * work on every OS, so the first possible helper is already inside it, and
 * finalize follows as soon as the work settles. A recorded unconfirmed seal
 * converts nominal success to exit 70 on every OS, without masking prior
 * failures. Only Windows honors a requested receipt: it additionally requires
 * this live witness's full acceptance, rechecked after the write completes.
 * A requested Git receipt precedes all of that, once the work recorded its
 * selections; it changes no exit status or text.
 */
export async function runDaemonLifetime(
  host: DaemonLifetimeHost,
  work: (lifetime: DaemonLifetime) => Promise<DaemonOutcome>,
  mapFailure: (error: unknown) => DaemonOutcome,
  witness = createWindowsClosureWitness(),
): Promise<void> {
  let receipt = false;
  let gitReceipt = false;
  let sealed: boolean | undefined;
  let gitSelections: GitReadSelections | undefined;
  const lifetime: DaemonLifetime = {
    requestClosureReceipt: (): void => {
      if (!host.windows || receipt) return;
      receipt = true;
      host.setDefaultExit(EXIT_CLOSURE_UNCONFIRMED);
    },
    requestGitReceipt: (): void => {
      gitReceipt = true;
    },
    recordSeal: (ok): void => {
      sealed = sealed !== false && ok;
    },
    recordGitSelections: (selections): void => {
      gitSelections = selections;
    },
  };
  let outcome: DaemonOutcome;
  try {
    outcome = await witness.run(() => work(lifetime));
  } catch (error) {
    outcome = mapFailure(error);
  }
  const report = witness.finalize();
  const accepted = (): boolean => sealed === true && witness.accepts(report);
  // A failed write leaves the receipt missing, which the qualifier refuses.
  const gitLine =
    gitReceipt && gitSelections ? gitReceiptLine(gitSelections) : '';
  const afterGitReceipt = (next: () => void): void =>
    gitLine === '' ? next() : host.writeOut(gitLine, () => next());
  const end = ({ code, message }: DaemonOutcome): void =>
    afterGitReceipt(() =>
      host.writeErr(message === '' ? '' : `${message}\n`, () =>
        host.exit(code),
      ),
    );
  if (outcome.code !== 0) return end(outcome);
  if (sealed === false)
    return end({ code: EXIT_CLOSURE_UNCONFIRMED, message: UNCONFIRMED });
  if (!receipt) return end(outcome);
  if (!accepted())
    return end({ code: EXIT_CLOSURE_UNCONFIRMED, message: UNCONFIRMED });
  afterGitReceipt(() =>
    host.writeOut(CLOSURE_RECEIPT, (error) =>
      host.exit(!error && accepted() ? 0 : EXIT_CLOSURE_UNCONFIRMED),
    ),
  );
}

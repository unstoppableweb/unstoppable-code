import { mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import { writeFileAtomically } from '../lib/atomic-file';
import { isMissingFileError } from '../lib/fs-utils';

const RemoteWebPreviewFileSchema = z.object({
  version: z.literal(1),
  allowWebPreview: z.boolean(),
});

/**
 * This computer's web preview consent (CAN-7712): whether paired desktop
 * computers that control it may open its local web servers.
 *
 * It lives in its own file, `remote-web-preview.json` beside
 * `remote-control.json`, which builds that predate it never read or write,
 * so an older build rewriting `remote-control.json` can't drop an opt-out.
 * The file is read once; after that the in-memory state is authoritative.
 * A missing file, one that can't be read or parsed, or a directory in its
 * place, reads as off: preview is off until the person turns it on, and a
 * damaged file never turns it back on.
 *
 * Invariants (each pinned by the host authorization golden):
 *
 * 1. Effective consent (`peek`) is on only while the person's latest
 *    choice is on and the write that carries it found on durably in the
 *    file: it saved on, or on was already there, unchanged since the last
 *    success, so there was nothing to write (or the file held on when first
 *    read, before any choice). An opt-out takes effect in memory before any
 *    I/O; after it, an earlier on still in the file never counts until the
 *    write carrying a later opt-in has run.
 * 2. One writer: writes run one at a time on a single chain, each saving
 *    the latest choice as it starts (temporary file, fsync, rename, then
 *    the directory's fsync). Choices made meanwhile fold into the next
 *    write. So an off chosen after an on is always written after it: an
 *    opt-out always wins.
 * 3. Only a confirmed outcome sets what the file holds: a write that
 *    resolved, a valid file read, or a file confirmed missing (ENOENT),
 *    which is off. Anything else leaves the file's value unknown and reads
 *    off: a failed write (it may still have landed, since the rename comes
 *    before the directory's fsync), and a read that failed (EIO, EACCES, a
 *    directory in place) or found contents that don't parse. While it is
 *    unknown, the next write is never skipped. Only a choice is ever
 *    written, never the off a failed read falls back to, so a saved opt-in
 *    the person never changed survives a failed read. While the choice is
 *    off after a failed write, off is retried in the background, with
 *    backoff, until it lands or a later choice saves; a failed opt-in is not
 *    taken (the choice falls back to off, which is then written, unless the
 *    person chose again meanwhile); `flush` (shutdown cleanup) waits for the
 *    write in flight, then saves the latest choice once more if it hasn't
 *    landed, for at most 2 s in all.
 * 4. No change is accepted once the quit's flush has started: `set` is
 *    refused, so nothing is taken that nothing would save.
 * 5. Each `set` reports its own choice: it settles with the write that
 *    carried that choice, failing only if that write failed. A choice that
 *    a later one overtook before its write ran resolves once a write carries
 *    the later choice, since nothing of it is left to save.
 *
 * Accepted residual risks:
 *
 * - An opt-in whose write failed may still have reached the file (the
 *   rename can land before a later step fails). Off is written over it by
 *   the retry, but a restart before that lands reads on. That matches the
 *   person's own last choice, on.
 * - If an off follows an on that reached the file, and every off write
 *   keeps failing until the app quits, the bounded quit flush included, a
 *   restart reads the earlier on although the latest choice was off. That
 *   needs persistent storage failure, and is mitigated by the off retry,
 *   the quit flush, Allow incoming, and the `canopy-remote-web-preview`
 *   flag, which stays off for users until CAN-7715.
 */
export class RemoteWebPreviewStore {
  /** The person's latest choice; null before the first read. */
  private desired: boolean | null = null;
  /** Counts choices, so a failed opt-in can tell whether one came after. */
  private choices = 0;
  /** What the file last durably held; null before the first read. */
  private saved: boolean | null = null;
  /**
   * The effective consent (invariant 1). An opt-out or a failed write
   * clears it, so an earlier on still in the file never turns preview back
   * on before the write carrying a later opt-in has run.
   */
  private onSaved = false;
  private load: Promise<void> | null = null;
  /**
   * A write failed, and may still have landed (the rename comes before the
   * directory's fsync), so the file may not hold `saved`.
   */
  private savedUnknown = false;
  /** `set` calls not yet answered by a write (invariant 5). */
  private waiting: Array<{
    choice: number;
    resolve: () => void;
    reject: (error: unknown) => void;
  }> = [];
  /** The single writer: every write runs on this chain, one at a time. */
  private chain: Promise<void> = Promise.resolve();
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryDelayMs: number;
  private disposed = false;
  /** The app is quitting: the last save has been attempted. */
  private closing = false;

  constructor(
    private readonly path: string,
    private readonly options: {
      /** First retry of a failed off; doubles up to a minute. */
      retryMs?: number;
      /** Writes the file; atomic, durable and owner-only by default. */
      writeFile?: (path: string, contents: string) => Promise<void>;
      /** Reads the file; `fs.readFile` by default. */
      readFile?: (path: string) => Promise<string>;
    } = {},
  ) {
    this.retryDelayMs = options.retryMs ?? 1_000;
  }

  /** The consent now, without I/O; off before the first read. */
  peek(): boolean {
    return this.onSaved;
  }

  /**
   * The file's value couldn't be confirmed when it was read, and no choice
   * has been made since: preview reads off, but the file may still hold an
   * opt-in that a later read finds, so the person is offered to save off.
   */
  choiceUnread(): boolean {
    return this.saved !== null && this.savedUnknown && this.choices === 0;
  }

  async read(): Promise<boolean> {
    await this.loaded();
    return this.peek();
  }

  /**
   * Records the person's choice and saves it. An opt-out reads as off from
   * this call on, whether or not its save succeeds. Rejects only when the
   * write that carried this choice failed; resolves when it saved, or when
   * a later choice overtook this one before its write ran.
   */
  set(allow: boolean): Promise<void> {
    // Invariant 4: once the quit's flush began, nothing would save a later
    // change, so it is refused rather than accepted and lost.
    if (this.closing)
      return Promise.reject(new Error('This computer is quitting.'));
    // Invariant 1: the choice applies in memory before any I/O.
    this.desired = allow;
    this.choices += 1;
    if (!allow) this.onSaved = false;
    const choice = this.choices;
    const answer = new Promise<void>((resolve, reject) => {
      this.waiting.push({ choice, resolve, reject });
    });
    void this.enqueue().catch(() => undefined);
    return answer;
  }

  /**
   * For shutdown: waits for the write in flight, then saves the latest
   * choice if it hasn't landed, in at most `timeoutMs` in all. A save that
   * still fails leaves the file as it was.
   */
  async flush(timeoutMs = 2_000): Promise<void> {
    this.closing = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    if (this.disposed) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    await Promise.race([
      this.enqueue().catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
        timer.unref?.();
      }),
    ]);
    if (timer) clearTimeout(timer);
  }

  /** Stops retrying a failed off. */
  dispose(): void {
    this.disposed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  /** Queues one write of the latest choice behind any write in flight. */
  private enqueue(): Promise<void> {
    const run = this.chain.then(() => this.writeLatest());
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async writeLatest(): Promise<void> {
    await this.loaded();
    // Invariant 2: the latest choice as this write starts; one that already
    // landed needs no write.
    const value = this.desired;
    const choice = this.choices;
    // With no choice made yet, `desired` is only what the file read as, off
    // after a read that failed: nothing is written over the file, which may
    // still hold the person's opt-in.
    if (value === null || choice === 0) return;
    if (value === this.saved && !this.savedUnknown) {
      // The file already holds the latest choice; an on there counts now.
      if (value) this.onSaved = true;
      this.answer(choice, null);
      return;
    }
    try {
      await mkdir(dirname(this.path), { recursive: true });
      const contents = `${JSON.stringify({ version: 1, allowWebPreview: value }, null, 2)}\n`;
      await (this.options.writeFile
        ? this.options.writeFile(this.path, contents)
        : // Durable: a choice reported saved survives a power loss.
          writeFileAtomically(this.path, contents, {
            mode: 0o600,
            durable: true,
          }));
    } catch (error) {
      // The write may have landed: the file's value is unknown until a
      // write succeeds, so the next one is never skipped.
      this.savedUnknown = true;
      this.onSaved = false;
      // A failed opt-in is not taken, unless the person chose again since:
      // the choice falls back to off, never to an on the file held before.
      if (value && this.choices === choice) this.desired = false;
      // Invariant 3: an off is written eventually, including one owed
      // because a failed opt-in may have left on in the file.
      if (this.desired === false) this.scheduleRetry();
      this.answer(choice, { error });
      throw error;
    }
    this.saved = value;
    this.savedUnknown = false;
    // Counts only if no choice came since: an opt-out meanwhile must hold,
    // and a later opt-in confirms when its own write runs.
    if (value && this.choices === choice) this.onSaved = true;
    this.retryDelayMs = this.options.retryMs ?? 1_000;
    this.answer(choice, null);
  }

  /**
   * Invariant 5: settles the `set` calls a write carrying `choice` answers.
   * That choice's own call gets the write's outcome; earlier ones, which a
   * later choice overtook before their write ran, resolve.
   */
  private answer(choice: number, failure: { error: unknown } | null): void {
    const answered = this.waiting.filter((call) => call.choice <= choice);
    this.waiting = this.waiting.filter((call) => call.choice > choice);
    for (const call of answered) {
      if (failure && call.choice === choice) call.reject(failure.error);
      else call.resolve();
    }
  }

  /** Saves the latest choice again later, if an off still hasn't landed. */
  private scheduleRetry(): void {
    if (this.disposed || this.closing || this.retryTimer) return;
    const delay = this.retryDelayMs;
    this.retryDelayMs = Math.min(delay * 2, 60_000);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.disposed || this.closing) return;
      void this.enqueue().catch(() => undefined);
    }, delay);
    this.retryTimer.unref?.();
  }

  private loaded(): Promise<void> {
    if (this.saved !== null) return Promise.resolve();
    this.load ??= this.readFile().then(({ value, known }) => {
      this.load = null;
      if (this.saved !== null) return;
      this.saved = value;
      // Invariant 3: a file whose value wasn't confirmed reads off, and the
      // next save is never skipped as already saved.
      this.savedUnknown = !known;
      // A choice made before the file was read stands, and an on in the file
      // counts only while that choice is on: an opt-out made first holds.
      const desired = this.desired ?? value;
      this.desired = desired;
      this.onSaved = desired && value;
    });
    return this.load;
  }

  /**
   * The file's value, and whether it is confirmed: a valid file read, or
   * one confirmed missing (ENOENT), which is off. Anything else (a read
   * error such as EIO or EACCES, a directory in place, or contents that
   * don't parse) reads off with the value unknown.
   */
  private async readFile(): Promise<{ value: boolean; known: boolean }> {
    let text: string;
    try {
      text = await (this.options.readFile
        ? this.options.readFile(this.path)
        : readFile(this.path, 'utf8'));
    } catch (error) {
      return { value: false, known: isMissingFileError(error) };
    }
    try {
      const parsed = RemoteWebPreviewFileSchema.safeParse(JSON.parse(text));
      if (parsed.success)
        return { value: parsed.data.allowWebPreview, known: true };
    } catch {
      // Not JSON: damaged, like a file that fails the schema.
    }
    return { value: false, known: false };
  }
}

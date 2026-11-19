import { StringDecoder } from 'node:string_decoder';
import { MergedSecretRedactor } from './merged-redactor';

/**
 * The most a RunWithSecrets stream returns, as Claude's Bash tool caps its
 * output (30,000 characters). Longer output keeps its start and its end.
 */
export const RUN_WITH_SECRETS_OUTPUT_MAX_CHARS = 30_000;

/**
 * The most raw text a stream keeps until the command ends, so it can be
 * redacted again if the chat's secrets change while the command runs.
 */
export const RUN_WITH_SECRETS_RAW_MAX_CHARS = 1_000_000;

/** Returned instead of output that can't be checked against new secrets. */
export const RUN_WITH_SECRETS_OUTPUT_WITHHELD_LONG =
  "[Output withheld: this chat's secrets changed while the command ran, and its output was too long to check again.]";

/** Returned instead of output when a value it must hide can't be read back. */
export const RUN_WITH_SECRETS_OUTPUT_WITHHELD_UNREADABLE =
  "[Output withheld: a secret this chat holds couldn't be read back to hide it.]";

/** Keeps the first and the last half of `text` past the output cap. */
function truncate(text: string): string {
  if (text.length <= RUN_WITH_SECRETS_OUTPUT_MAX_CHARS) return text;
  const half = RUN_WITH_SECRETS_OUTPUT_MAX_CHARS / 2;
  return `${text.slice(0, half)}\n\n[${text.length - RUN_WITH_SECRETS_OUTPUT_MAX_CHARS} characters of output truncated]\n\n${text.slice(text.length - half)}`;
}

/**
 * One output stream of a RunWithSecrets command. Bytes are decoded and
 * passed through the secret redactor as they arrive; only redacted text is
 * kept for the result, bounded to its first and last half past the cap.
 *
 * The raw text is also kept, up to {@link RUN_WITH_SECRETS_RAW_MAX_CHARS},
 * until the command ends, and never leaves this object: when the chat came
 * to hold new values while the command ran, the result is the raw text
 * redacted once against every value, then cut, so a new value is matched
 * against the original text and not against text already redacted or cut.
 */
export class RedactedOutput {
  private readonly decoder = new StringDecoder('utf8');
  private readonly redactor: MergedSecretRedactor;
  private head = '';
  private tail = '';
  private omitted = 0;
  private raw = '';
  private rawOverflowed = false;
  private finalRedactions: number | null = null;
  private readonly half = RUN_WITH_SECRETS_OUTPUT_MAX_CHARS / 2;

  constructor(
    private readonly groups: ReadonlyArray<Readonly<Record<string, string>>>,
  ) {
    this.redactor = new MergedSecretRedactor(groups);
  }

  /** Values redacted from the returned text. */
  get redactions(): number {
    return this.finalRedactions ?? this.redactor.redactions;
  }

  write(chunk: Buffer): void {
    this.take(this.decoder.write(chunk));
  }

  /**
   * Flushes the decoder and the redactor's carry and returns the stream.
   * `fresh` holds the values the chat came to hold while the command ran.
   */
  finish(fresh: ReadonlyArray<Readonly<Record<string, string>>> = []): string {
    this.take(this.decoder.end());
    this.keep(this.redactor.flush());
    const raw = this.raw;
    this.raw = '';
    if (fresh.length === 0) {
      if (this.omitted === 0) return this.head + this.tail;
      return `${this.head}\n\n[${this.omitted} characters of output truncated]\n\n${this.tail}`;
    }
    if (this.rawOverflowed) return RUN_WITH_SECRETS_OUTPUT_WITHHELD_LONG;
    const full = new MergedSecretRedactor([...this.groups, ...fresh]);
    const text = truncate(full.redact(raw));
    this.finalRedactions = full.redactions;
    return text;
  }

  private take(text: string): void {
    if (!text) return;
    if (!this.rawOverflowed) {
      this.raw += text;
      if (this.raw.length > RUN_WITH_SECRETS_RAW_MAX_CHARS) {
        this.raw = '';
        this.rawOverflowed = true;
      }
    }
    this.keep(this.redactor.push(text));
  }

  private keep(text: string): void {
    if (!text) return;
    let rest = text;
    if (this.head.length < this.half) {
      const room = this.half - this.head.length;
      this.head += rest.slice(0, room);
      rest = rest.slice(room);
    }
    if (!rest) return;
    this.tail += rest;
    if (this.tail.length > this.half) {
      this.omitted += this.tail.length - this.half;
      this.tail = this.tail.slice(this.tail.length - this.half);
    }
  }
}

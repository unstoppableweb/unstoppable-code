import {
  isAgentSecretName,
  SecretValueRedactor,
} from '@canopy/protocol/agent-secrets';

/*
 * One redactor over many values that may share a name: the chat's live
 * values and every value ever written to a secrets file. Running a redactor
 * per group in turn would let one value's match cut into another's before
 * it is seen, so every value is matched against the original text in one
 * pass. A redactor takes one value per name, so repeated names get internal
 * aliases, and each placeholder is renamed back to the secret's own name.
 */

const PLACEHOLDER = /\[secret:([A-Z_][A-Z0-9_]{0,63})\]/g;

export class MergedSecretRedactor {
  private readonly redactor: SecretValueRedactor;
  private readonly realNames = new Map<string, string>();

  constructor(groups: ReadonlyArray<Readonly<Record<string, string>>>) {
    const values: Record<string, string> = {};
    const seen = new Set<string>();
    for (const group of groups)
      for (const [name, value] of Object.entries(group)) {
        const key = `${name}\0${value}`;
        if (seen.has(key)) continue;
        seen.add(key);
        let alias = name;
        for (let index = 2; alias in values; index += 1)
          alias = `${name.slice(0, 56)}__V${index}`;
        if (!isAgentSecretName(alias)) continue;
        values[alias] = value;
        this.realNames.set(alias, name);
      }
    this.redactor = new SecretValueRedactor(values);
  }

  get redactions(): number {
    return this.redactor.redactions;
  }

  /** Redacts a streamed chunk; the redactor holds back a possible match. */
  push(chunk: string): string {
    return this.rename(this.redactor.push(chunk));
  }

  flush(): string {
    return this.rename(this.redactor.flush());
  }

  /** See {@link SecretValueRedactor.heldOverflowed}. */
  get heldOverflowed(): boolean {
    return this.redactor.heldOverflowed;
  }

  /** The held text, unredacted; see {@link SecretValueRedactor.takeHeld}. */
  takeHeld(): string {
    return this.redactor.takeHeld();
  }

  redact(text: string): string {
    return this.rename(this.redactor.redact(text));
  }

  private rename(text: string): string {
    return text.replace(PLACEHOLDER, (whole, alias: string) => {
      const name = this.realNames.get(alias);
      return name ? `[secret:${name}]` : whole;
    });
  }
}

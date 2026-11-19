import { realpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { getChatSecretStore } from './chat-secret-store';

/*
 * A nudge, not a guarantee: Claude's Read of a file WriteSecretsFile wrote,
 * or a Grep naming it, is denied with a pointer to RunWithSecrets, so the
 * agent uses the secrets by name instead of pulling them into the
 * conversation. Any other read (a shell command, a copy, a search over its
 * folder) still sees the plain text, as WriteSecretsFile's warning says.
 * What protects the values in Canopy's own views is content-based redaction
 * (`view-redaction.ts`).
 */

/** Why Claude's Read of a secrets file is refused. */
export const SECRET_FILE_READ_REDIRECT =
  'This file holds secrets written by WriteSecretsFile, so reading it would show their values. Use RunWithSecrets with the secret names instead, for example to run the command that reads this file.';

/**
 * The redirect for a Claude Read or Grep naming `filePath` (absolute, or
 * relative to `cwd`) when it is a secrets file; else null, also when that
 * can't be checked.
 */
export async function secretFileReadRedirect(
  filePath: unknown,
  cwd: string | undefined,
): Promise<string | null> {
  if (typeof filePath !== 'string' || !filePath) return null;
  const path = isAbsolute(filePath)
    ? filePath
    : cwd
      ? resolve(cwd, filePath)
      : null;
  if (path === null) return null;
  try {
    const store = getChatSecretStore();
    await store.ensureLoaded();
    return store.isSecretFile(await realpath(path))
      ? SECRET_FILE_READ_REDIRECT
      : null;
  } catch {
    return null;
  }
}

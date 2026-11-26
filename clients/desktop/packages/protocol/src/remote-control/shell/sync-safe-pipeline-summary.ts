/**
 * Redaction for pipeline summaries that become durable cloud inventory
 * (CAN-2830), shared by the desktop's eager sync and the web's Remote
 * Control write-through so both paths store exactly the same shape. The
 * live `portal.pipeline.list` command answers a user's own live request;
 * the synced document is durable cloud storage built from
 * repository-controlled YAML, so credential-like content in trigger-input
 * defaults, options and descriptions is dropped before it is ever stored.
 *
 * The policy fails closed: repository-defined values never sync. Input
 * defaults and choice options are omitted entirely, whatever they hold
 * (a `pin` of `123456` is a credential that no pattern can tell from a
 * count), so a synced summary carries only the input's structure: name,
 * type, required, min/max, UI hints, and a description that is short and
 * does not look like a credential (known token shapes, URLs carrying a
 * password, basic or bearer values, …). The live command, answering the
 * user's own request on their own machine, keeps the full summary; the
 * web asks the paired desktop live before it dispatches a run.
 */
import type {
  RemoteControlPipelineInputDefinition,
  RemoteControlPipelineSummary,
} from './index';

/**
 * Whole-word credential vocabulary, matched against the tokens of an input
 * name (snake_case, kebab-case and camelCase are all split), so `author`
 * or `concert` are ordinary while `deploy_token`, `apiKey`, `ACCESS_KEY`
 * and `client-secret` are sensitive.
 */
const SENSITIVE_TOKENS = new Set([
  'token',
  'tokens',
  'secret',
  'secrets',
  'password',
  'passwd',
  'pwd',
  'credential',
  'credentials',
  'apikey',
  'auth',
  'bearer',
  'cookie',
  'session',
  'jwt',
  'certificate',
  'cert',
  'privatekey',
  'pin',
  'passcode',
  'passphrase',
  'otp',
  'totp',
  'mfa',
]);
/** Two-token compounds that are sensitive together, harmless apart. */
const SENSITIVE_COMPOUNDS = new Set([
  'api key',
  'private key',
  'access key',
  'secret key',
  'client secret',
  'ssh key',
  'signing key',
  'encryption key',
  'access code',
  'security code',
  'auth code',
  'verification code',
]);

function tokenizeInputName(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0);
}

/** Shapes of well-known credentials plus generic long high-entropy tokens. */
const CREDENTIAL_LIKE_VALUE: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}/,
  /\bsk-[A-Za-z0-9_-]{20,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  /\bglpat-[A-Za-z0-9_-]{20,}/,
  /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}/,
  /\bnpm_[A-Za-z0-9]{36}\b/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/i,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s@]+@/i,
  /\b(?:token|secret|password|passwd|api[_-]?key)\s*[=:]\s*\S{8,}/i,
  /\b[A-Za-z0-9+/_-]{40,}={0,2}\b/,
];

export function isSensitivePipelineInputName(name: string): boolean {
  const tokens = tokenizeInputName(name);
  if (tokens.some((token) => SENSITIVE_TOKENS.has(token))) return true;
  for (let index = 0; index + 1 < tokens.length; index += 1) {
    if (SENSITIVE_COMPOUNDS.has(`${tokens[index]} ${tokens[index + 1]}`)) {
      return true;
    }
  }
  return false;
}

export function looksLikeCredential(value: string): boolean {
  return CREDENTIAL_LIKE_VALUE.some((pattern) => pattern.test(value));
}

const MAX_SYNCED_DESCRIPTION_LENGTH = 512;

function syncableDescription(description: unknown): string | undefined {
  return typeof description === 'string' &&
    description.length <= MAX_SYNCED_DESCRIPTION_LENGTH &&
    !looksLikeCredential(description)
    ? description
    : undefined;
}

function sanitizeInput(
  name: string,
  input: RemoteControlPipelineInputDefinition,
): RemoteControlPipelineInputDefinition {
  // `default` and `options` are repository-defined values: never synced.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- stripped on purpose
  const { default: _default, options: _options, description, ...rest } = input;
  // A credential-named input's description is the likeliest place for an
  // example value; it is dropped with the values.
  const keptDescription = isSensitivePipelineInputName(name)
    ? undefined
    : syncableDescription(description);
  return {
    ...rest,
    ...(keptDescription !== undefined ? { description: keptDescription } : {}),
  };
}

/**
 * The summary with every credential-like value removed; the shape stays a
 * `RemoteControlPipelineSummary`, so the synced document still renders exactly
 * like a live one, minus the values that must not leave the machine.
 */
export function sanitizePipelineSummaryForSync(
  summary: RemoteControlPipelineSummary,
): RemoteControlPipelineSummary {
  // `revision` digests the whole file, redacted values included, so it never
  // leaves the machine; a synced row is reviewed before it runs (CAN-7513).
  const {
    description,
    taskReadyInputs,
    planReadyInputs,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- stripped on purpose
    revision: _revision,
    ...rest
  } = summary;
  const sanitizeInputs = (
    inputs: Record<string, RemoteControlPipelineInputDefinition> | undefined,
  ): Record<string, RemoteControlPipelineInputDefinition> | undefined =>
    inputs
      ? Object.fromEntries(
          Object.entries(inputs).map(([name, input]) => [
            name,
            sanitizeInput(name, input),
          ]),
        )
      : undefined;
  const sanitizedTaskReadyInputs = sanitizeInputs(taskReadyInputs);
  const sanitizedPlanReadyInputs = sanitizeInputs(planReadyInputs);
  return {
    ...rest,
    description: syncableDescription(description) ?? '',
    ...(sanitizedTaskReadyInputs !== undefined
      ? { taskReadyInputs: sanitizedTaskReadyInputs }
      : {}),
    ...(sanitizedPlanReadyInputs !== undefined
      ? { planReadyInputs: sanitizedPlanReadyInputs }
      : {}),
  };
}

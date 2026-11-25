import type { ClaudeConnectorAvailability } from '@canopy/protocol/remote-control/shell';

export type ClaudeConnectorManagedRoute =
  | 'account_proxy'
  | 'ai_credits'
  | 'organization_gateway';
const DISABLED_SELECTORS = new Set(['', '0', 'false', 'off', 'no']);
const PROVIDER_SELECTORS = [
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_MANTLE',
];

const MANAGED_ENV_KEYS = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
];

interface ClaudeLaunchSettingsEvidence {
  /** The inline flag settings already being passed to this SDK launch. */
  settingsEnv?: Readonly<Record<string, unknown>>;
  managedEnv?: Readonly<Record<string, string | undefined>>;
}

/** Without launch settings, env is an already-effective environment. */
export function classifyClaudeConnectorAvailability(
  launchId: string,
  env: Readonly<Record<string, string | undefined>>,
  managedRoute?: ClaudeConnectorManagedRoute,
  apiKeySource?: unknown,
  launchSettings?: ClaudeLaunchSettingsEvidence,
): ClaudeConnectorAvailability {
  const unknown = { launchId, status: 'unknown', cause: 'unknown' } as const;
  const settingsEnv = launchSettings?.settingsEnv ?? {};
  const flagEnv = (key: string): string | undefined => {
    const value = settingsEnv[key];
    return typeof value === 'string' ? value : undefined;
  };
  const knownEnv = (key: string): string | undefined =>
    flagEnv(key) ?? env[key];
  if (
    PROVIDER_SELECTORS.some(
      (key) =>
        !DISABLED_SELECTORS.has((knownEnv(key) ?? '').trim().toLowerCase()),
    )
  )
    return unknown;
  const sdkReportsApiAuth =
    apiKeySource === 'ANTHROPIC_API_KEY' ||
    apiKeySource === 'apiKeyHelper' ||
    apiKeySource === '/login managed key';
  if (sdkReportsApiAuth)
    return { launchId, status: 'suppressed', cause: 'api_auth' };

  if (managedRoute) {
    const selectedEnv = launchSettings?.managedEnv;
    // The CLI applies settings.env after process env. An already selected
    // route is not proof on its own: only the admitted flag tier can pin its
    // endpoint, bearer, and explicit API-key unset over user/project/local.
    // Mod admission also merges into that tier, before we inspect it here.
    const pinned =
      !launchSettings ||
      (selectedEnv !== undefined &&
        MANAGED_ENV_KEYS.every(
          (key) =>
            flagEnv(key) !== undefined && flagEnv(key) === selectedEnv[key],
        ));
    if (!pinned) {
      if (
        apiKeySource === 'oauth' &&
        !flagEnv('ANTHROPIC_API_KEY')?.trim() &&
        !flagEnv('ANTHROPIC_AUTH_TOKEN')?.trim()
      )
        return { launchId, status: 'eligible', cause: 'native' };
      // Preserve the configuration actually supplied to this child, with
      // explicit uncertainty about the CLI's later settings application.
      // A known displaced setting must not retain the selected route label.
      const launchedSelectedRoute =
        selectedEnv !== undefined &&
        MANAGED_ENV_KEYS.every(
          (key) =>
            env[key] === selectedEnv[key] &&
            (flagEnv(key) === undefined || flagEnv(key) === selectedEnv[key]),
        );
      return launchedSelectedRoute
        ? { ...unknown, launchRoute: managedRoute }
        : unknown;
    }
    return pinned &&
      apiKeySource !== 'oauth' &&
      !knownEnv('ANTHROPIC_API_KEY')?.trim() &&
      knownEnv('ANTHROPIC_AUTH_TOKEN')?.trim() &&
      knownEnv('ANTHROPIC_BASE_URL')?.trim()
      ? { launchId, status: 'suppressed', cause: managedRoute }
      : unknown;
  }

  // An inherited credential may be cleared or replaced by unseen settings.
  // Use a known inline flag or the SDK init source to establish API auth.
  const authEnv = launchSettings ? flagEnv : knownEnv;
  if (
    authEnv('ANTHROPIC_API_KEY')?.trim() ||
    authEnv('ANTHROPIC_AUTH_TOKEN')?.trim() ||
    authEnv('CLAUDE_CODE_OAUTH_TOKEN')?.trim()
  )
    return { launchId, status: 'suppressed', cause: 'api_auth' };
  if (
    knownEnv('ANTHROPIC_BASE_URL')?.trim() ||
    knownEnv('ANTHROPIC_CUSTOM_HEADERS')?.trim() ||
    knownEnv('CLAUDE_ENV_FILE')?.trim()
  )
    return unknown;
  // `none` covers OAuth but also bearer and third-party routes on recent
  // CLIs. Do not infer eligibility from ambiguous or absent evidence.
  return apiKeySource === 'oauth'
    ? { launchId, status: 'eligible', cause: 'native' }
    : unknown;
}

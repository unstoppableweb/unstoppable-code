import { z } from 'zod';

/**
 * Plugin installs a Remote Control browser controller may start (CAN-7442):
 * the fixed messages a computer answers with and the path-free result a
 * browser receives. The computer's plugin service and its browser result
 * projection share these constants, so a reworded message fails a test instead
 * of silently reaching a browser as the generic failure.
 */

/** A remote install from a stored source that is not public https. */
export const REMOTE_PLUGIN_SOURCE_REFUSAL =
  'Remote control can only install plugins from public https sources. Install it on this computer to use a private or local source.';

/** A remote install whose source is not the one this computer has stored. */
export const REMOTE_PLUGIN_SOURCE_MISMATCH =
  'Remote control can only install this plugin from the source this computer has for it. Refresh its marketplace on this computer, then try again.';

export const PLUGIN_UNINSTALL_PENDING_MESSAGE =
  'Finish uninstalling this plugin before adding it again.';
export const PLUGIN_NOT_IN_MARKETPLACE_MESSAGE =
  'Plugin not found in the marketplace.';
export const BUILT_IN_PLUGIN_MARKETPLACE_REQUIRED_MESSAGE =
  'Built-in plugin installs require the built-in or curated marketplace.';
export const PLUGIN_PROVIDER_REQUIRED_MESSAGE =
  'At least one provider is required.';
export const UNKNOWN_PLUGIN_PROVIDER_MESSAGE =
  'Unknown plugin provider requested.';
export const CLAUDE_FACET_UNAVAILABLE_MESSAGE = 'Claude facet is unavailable.';
export const CODEX_FACET_UNAVAILABLE_MESSAGE = 'Codex facet is unavailable.';

/** What a browser sees for any install failure not in the fixed list. */
export const REMOTE_PLUGIN_INSTALL_FAILED_MESSAGE =
  "Couldn't install this plugin. Check the desktop app for details.";

/**
 * Install failures a browser receives as the computer wrote them. Each is
 * fixed copy with nothing from a URL, path or tool output. The source
 * refusal is not here because the computer appends the URL check's reason to
 * it, and the credentialed-source failure quotes the source.
 */
const BROWSER_PLUGIN_INSTALL_MESSAGES: ReadonlySet<string> = new Set([
  REMOTE_PLUGIN_SOURCE_MISMATCH,
  PLUGIN_UNINSTALL_PENDING_MESSAGE,
  PLUGIN_NOT_IN_MARKETPLACE_MESSAGE,
  BUILT_IN_PLUGIN_MARKETPLACE_REQUIRED_MESSAGE,
  PLUGIN_PROVIDER_REQUIRED_MESSAGE,
  UNKNOWN_PLUGIN_PROVIDER_MESSAGE,
  CLAUDE_FACET_UNAVAILABLE_MESSAGE,
  CODEX_FACET_UNAVAILABLE_MESSAGE,
]);

/**
 * An install failure as a browser may see it: the text itself only when it
 * exactly equals a fixed message, else {@link REMOTE_PLUGIN_INSTALL_FAILED_MESSAGE}.
 */
export function browserPluginInstallError(error: unknown): string {
  return typeof error === 'string' && BROWSER_PLUGIN_INSTALL_MESSAGES.has(error)
    ? error
    : REMOTE_PLUGIN_INSTALL_FAILED_MESSAGE;
}

const RemotePluginProviderInstallStatusSchema = z
  .object({
    available: z.boolean(),
    installed: z.boolean(),
    enabled: z.boolean().optional(),
    version: z.string().optional(),
  })
  .strict();

/**
 * The plugin row a browser receives from an install: display and status
 * fields only. No source, cache or install path, details, external source,
 * harness record or provider error text.
 */
export const RemoteInstalledPluginSchema = z
  .object({
    name: z.string(),
    displayName: z.string().optional(),
    marketplaceId: z.string(),
    version: z.string().optional(),
    builtIn: z.boolean().optional(),
    curated: z.boolean().optional(),
    providerSupport: z
      .object({ claude: z.string(), codex: z.string() })
      .strict()
      .optional(),
    globalInstallStatus: z
      .object({
        claude: RemotePluginProviderInstallStatusSchema.optional(),
        codex: RemotePluginProviderInstallStatusSchema.optional(),
        checkedAt: z.string(),
      })
      .strict()
      .optional(),
    cachedAt: z.string().optional(),
  })
  .strict();
export type RemoteInstalledPlugin = z.infer<typeof RemoteInstalledPluginSchema>;

/** `plugins:install-plugin` as a browser receives it. */
export const RemotePluginInstallResultSchema = z
  .object({
    success: z.boolean(),
    error: z.string().optional(),
    data: RemoteInstalledPluginSchema.optional(),
  })
  .strict();
export type RemotePluginInstallResult = z.infer<
  typeof RemotePluginInstallResultSchema
>;

const RemotePluginProviderOutcomeSchema = z
  .object({ installed: z.boolean(), error: z.string().optional() })
  .strict();
export type RemotePluginProviderOutcome = z.infer<
  typeof RemotePluginProviderOutcomeSchema
>;

export const RemotePluginProviderOutcomesSchema = z
  .object({
    claude: RemotePluginProviderOutcomeSchema.optional(),
    codex: RemotePluginProviderOutcomeSchema.optional(),
  })
  .strict();
export type RemotePluginProviderOutcomes = z.infer<
  typeof RemotePluginProviderOutcomesSchema
>;

/**
 * `plugins:install-built-in-plugin` as a browser receives it. `success` is
 * true when at least one requested provider installed; each provider's
 * outcome says which.
 */
export const RemoteBuiltInPluginInstallResultSchema = z
  .object({
    success: z.boolean(),
    error: z.string().optional(),
    data: z
      .object({
        plugin: RemoteInstalledPluginSchema,
        providerOutcomes: RemotePluginProviderOutcomesSchema,
      })
      .strict()
      .optional(),
  })
  .strict();
export type RemoteBuiltInPluginInstallResult = z.infer<
  typeof RemoteBuiltInPluginInstallResultSchema
>;

/** Providers a built-in or curated install may name. */
export const REMOTE_PLUGIN_INSTALL_PROVIDERS = ['claude', 'codex'] as const;
export type RemotePluginInstallProvider =
  (typeof REMOTE_PLUGIN_INSTALL_PROVIDERS)[number];

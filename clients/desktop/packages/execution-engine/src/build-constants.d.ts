/** Build-time constants injected by Electron Vite and/or the CLI esbuild. */
declare const __DEP_CLAUDE_CLI__: string;
declare const __DEP_CLAUDE_SDK__: string;
declare const __DEP_CODEX_CLI__: string;
declare const __DEP_GH_CLI__: string;
declare const __DEP_RTK_CLI__: string;
declare const __DEP_OCTOKIT__: string;
/** Root package.json `cursor-cli` pin, projected at build time (see electron.vite.config.ts). */
declare const __CANOPY_CURSOR_CLI__: {
  version: string;
  artifacts: Partial<
    Record<
      string,
      { url: string; sha256: string; archiveBytes: number; filesSha256: string }
    >
  >;
};
declare const __CANOPY_CLOUD_BASE_URL__: string;
declare const __CANOPY_RELEASE_FLAVOR__: string | undefined;
/** CLI bundle includes an explicitly opted-in Linux ARM64 development target. */
declare const __CANOPY_CLI_LINUX_ARM64_DEVELOPMENT__: boolean;

/**
 * Per-build default Unstoppable Domains OAuth environment (`production` |
 * `staging` | `sandbox`), injected by `electron.vite.config.ts`. `production`
 * for production release builds; `staging` for internal/staging and local dev
 * builds. A runtime `CANOPY_UD_OAUTH_ENV` override still wins in dev. Resolved
 * in `apps/desktop-app/src/main/unstoppable-domains/config.ts`.
 */
declare const __CANOPY_UD_OAUTH_ENV__: string;
declare const __CANOPY_MOCK_LLM_BASE_URL__: string | undefined;
declare const __CANOPY_LINEAR_API_BASE_URL__: string | undefined;
declare const __CANOPY_DEV_MCP_PROXY_PORT__: number | undefined;

declare const __CANOPY_LAUNCHDARKLY_DESKTOP_CLIENT_SIDE_ID__:
  | string
  | undefined;

/**
 * Client secret for Canopy's own pre-registered Google "Desktop app" OAuth
 * client, used by the first-party Google Workspace MCP connectors (ECW-8473).
 *
 * Google requires `client_secret` at token exchange even for installed-app
 * clients, while stating that in this context "the client secret is obviously
 * not treated as a secret" — it is meant to be embedded in distributed code.
 * The curated MCP catalog deliberately never carries credentials
 * (`CuratedMcpOAuthHints`), so the value is bundled into the Electron main
 * bundle at build time from `CANOPY_GOOGLE_OAUTH_CLIENT_SECRET` instead of
 * being served to clients or persisted in a server definition on disk.
 */
declare const __CANOPY_GOOGLE_OAUTH_CLIENT_SECRET__: string | undefined;

/**
 * Build-time gate for UI-automation/E2E-only code paths. `false` in every
 * normal/production build (so gated branches are dead-code-eliminated); only an
 * explicit `CANOPY_E2E_BUILD=1` build sets it `true`. Never read from a runtime
 * environment variable in a shipped build.
 */
declare const __CANOPY_E2E__: boolean;

/**
 * The local-only build profile (`CANOPY_LOCAL_ONLY=true`). `false`, or not
 * defined at all, in every other bundle. Read it only through
 * `isLocalOnlyBuild()` with the `typeof` guard; see docs/local-only-build.md.
 */
declare const __CANOPY_LOCAL_ONLY__: boolean;

/**
 * The self-host build profile (`CANOPY_SELF_HOST=true`). `false`, or not
 * defined at all, in every other bundle. Read it only through
 * `isSelfHostBuild()` with the `typeof` guard; see docs/local-only-build.md.
 */
declare const __CANOPY_SELF_HOST__: boolean;

/**
 * Build policy for Ollama, enabled by default and overridable with
 * CANOPY_OLLAMA_ENABLED. The shared capability helper combines it with the
 * runtime platform identifier: process.platform in main/preload and
 * window.platform in the renderer. The build host does not determine support.
 */
declare const __CANOPY_OLLAMA_ENABLED__: boolean;
declare const __CANOPY_OLLAMA_PLATFORM__: NodeJS.Platform;

declare namespace NodeJS {
  interface Process {
    defaultApp?: boolean;
    resourcesPath?: string;
  }
}

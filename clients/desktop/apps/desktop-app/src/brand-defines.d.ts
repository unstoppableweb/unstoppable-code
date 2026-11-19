/**
 * Vite build-time brand constants.
 *
 * `electron.vite.config.ts` injects these via `define:` so both the renderer
 * and main bundles can reference the active brand identity without importing
 * any runtime module. The renderer in particular wants these for splash
 * screens and `<title>` tags rendered before the main brand bundle loads.
 *
 * Values come from `BRAND.id`, `BRAND.displayName`, and `BRAND.cliName`
 * resolved through `@canopy/brand/current` at build time.
 */
declare const __CANOPY_BRAND_ID__: string;
declare const __CANOPY_BRAND_DISPLAY_NAME__: string;
declare const __CANOPY_BRAND_CLI_NAME__: string;
declare const __CANOPY_RELEASE_FLAVOR__: string;
declare const __CANOPY_INTERNAL_RELEASE_INDICATOR__: string;
declare const __CANOPY_UPDATE_BASE_URL__: string;
declare const __CANOPY_SOURCE_BUILD__: boolean;
/**
 * The local-only build profile (`CANOPY_LOCAL_ONLY=true`). Read it only
 * through `isLocalOnlyBuild()` or the preload constant; see
 * docs/local-only-build.md.
 */
declare const __CANOPY_LOCAL_ONLY__: boolean;
declare const __CANOPY_E2E__: boolean;
declare const __CANOPY_POSTHOG_ENABLED__: boolean;
declare const __CANOPY_OLLAMA_ENABLED__: boolean;
declare const __CANOPY_OLLAMA_PLATFORM__: NodeJS.Platform;
declare const __CANOPY_DESKTOP_SIDEBAR_SHADOW__: boolean;
declare const __CANOPY_DESKTOP_SHARED_SIDEBAR__: boolean;
declare const __CANOPY_UD_OAUTH_ENV__: string;

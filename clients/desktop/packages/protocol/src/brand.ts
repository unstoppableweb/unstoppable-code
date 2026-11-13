/**
 * Brand pack contract types.
 *
 * This file is the single source of truth for the brand pack shape and is
 * imported by main, renderer, web server, web client, CLI, and tests. It
 * intentionally has NO Node, React, Electron, Prisma, or app imports.
 *
 * Three distinct runtime "views" of a brand are exported:
 *
 *  1. {@link BrandPackManifest}    — validated shape of `brands/<id>/brand.json`.
 *                                    Asset fields are repo-relative paths.
 *  2. {@link DesktopBrandRuntime}  — what `.cache/brand/<id>/desktop-brand.ts`
 *                                    exports. Asset fields are inline SVG
 *                                    markup + absolute filesystem paths.
 *                                    Consumed via `@canopy/brand/current`.
 *  3. {@link WebBrandRuntime}      — what `.cache/brand/web-brands.ts` exports
 *                                    per brand. Asset fields are public URLs
 *                                    + inline SVG content. Consumed via
 *                                    `@canopy/brand/web`.
 *
 * The single-name `BrandPack` is intentionally NOT exported. Code must pick
 * the concrete type for its layer.
 */

// ---------------------------------------------------------------------------
// Shared identity + config (everything except `assets`)
// ---------------------------------------------------------------------------

/** Brand pack schema version. Bump when fields are added/removed/changed. */
export type BrandSchemaVersion = 5;

/** Production, release-candidate, vs development data-directory selector. */
export type CanopyRuntimeMode = 'prod' | 'rc' | 'dev';

/** Build-flavor-aware secure-data-directory selector. */
export type CanopySecureStorageMode = 'prod' | 'rc' | 'internal' | 'dev';

/** Release flavors that can include a brand in build automation. */
export type BrandReleaseFlavor = 'internal' | 'rc' | 'stable';

const BRAND_RELEASE_FLAVORS = ['internal', 'rc', 'stable'] as const;

export type ProductBuild = BrandReleaseFlavor | 'dev';

export interface BrandBuildIdentity {
  readonly brandId: string;
  readonly build: ProductBuild;
}

/** Build-tool input only; never pass the running process's environment. */
export function productBuild(value: unknown): ProductBuild {
  if (
    value === 'stable' ||
    value === 'internal' ||
    value === 'rc' ||
    value === 'dev'
  ) {
    return value;
  }
  throw new Error('Invalid compiled product build.');
}

export function brandBuildIdentity(
  brandId: string,
  build: unknown,
): BrandBuildIdentity {
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(brandId)) {
    throw new Error('Invalid compiled brand identity.');
  }
  return Object.freeze({ brandId, build: productBuild(build) });
}

/** Shared by desktop, CLI and daemon bundlers. Not a runtime environment API. */
export function buildIdentityDefines(
  brandId: string,
  build: unknown,
  testBuild: boolean,
): Record<string, string> {
  return {
    __CANOPY_BUILD_IDENTITY__: JSON.stringify(
      brandBuildIdentity(brandId, build),
    ),
    __CANOPY_TEST_DATA_OVERRIDES__: JSON.stringify(testBuild),
  };
}

export const BRAND_THEME_TOKEN_NAMES = [
  'bgBase',
  'bgCard',
  'bgSecondary',
  'bgMuted',
  'bgAccent',
  'bgAccentSubtle',
  'bgDestructive',
  'bgDestructiveSubtle',
  'bgSidebar',
  'bgPopover',
  'bgSuccess',
  'bgSuccessSubtle',
  'bgWarning',
  'bgWarningSubtle',
  'bgInfo',
  'bgInfoSubtle',
  'fgPrimary',
  'fgSecondary',
  'fgEmphasis',
  'border',
  'ring',
  'shadowSm',
  'shadowMd',
  'shadowLg',
  'shadowXl',
  'shadowFocus',
  'radius',
] as const;

export type BrandThemeTokenName = (typeof BRAND_THEME_TOKEN_NAMES)[number];

export const BRAND_THEME_ENGINE_IDS = ['ui-kit-v1'] as const;

export type BrandThemeEngineId = (typeof BRAND_THEME_ENGINE_IDS)[number];

export const BRAND_COLOR_MODES = ['light', 'dark', 'system'] as const;

export type BrandColorMode = (typeof BRAND_COLOR_MODES)[number];

export function isBrandColorMode(value: unknown): value is BrandColorMode {
  return BRAND_COLOR_MODES.some((mode) => mode === value);
}

export interface BrandThemeRecipeBase {
  lighter?: string;
  light: string;
  dark: string;
  darker?: string;
}

export interface BrandThemeRecipeTuning {
  neutralTintScale: number;
  surfaceStepScale: number;
  lineAlpha: number;
  maxChroma: number;
  accentChromaScale: number;
  semanticContrastRatio: number;
  solidTone: number;
  mutedAlpha: number;
}

/** Compact build-time inputs expanded by the shared UI-Kit color engine. */
export interface BrandThemeRecipe {
  engine: BrandThemeEngineId;
  base: BrandThemeRecipeBase;
  accent: string;
  contrast?: number;
  neutralTint?: number;
  surfaceHue?: number;
  borderContrast?: number;
  /** Optional brighter dark solid-intent tone; 0 preserves engine selections. */
  darkAccentTone?: number;
  tuning?: Partial<BrandThemeRecipeTuning>;
  radius?: string;
}

/** Canonical application semantic token names, without the CSS `--` prefix. */
export type BrandThemeSemanticTokens = Readonly<Record<string, string>>;

export interface BrandThemePrimitiveValue {
  srgb: string;
  displayP3: string;
  oklch: string;
}

export type BrandThemePrimitiveTokens = Readonly<
  Record<string, BrandThemePrimitiveValue>
>;

export type BrandThemeModeTokens = Record<BrandThemeTokenName, string> & {
  /** Reusable chromatic scales; neutral UI colors are derived semantic values. */
  primitives: BrandThemePrimitiveTokens;
  /** sRGB semantic values generated from the recipe. */
  semantic: BrandThemeSemanticTokens;
  /** Display-P3 equivalents used as a progressive enhancement. */
  displayP3: BrandThemeSemanticTokens;
  /** CSS bindings: chromatic references plus exact derived neutral literals. */
  cssBindings: BrandThemeSemanticTokens;
  /** Display-P3 CSS bindings, preserving literals and chromatic references. */
  displayP3CssBindings: BrandThemeSemanticTokens;
};

export interface BrandThemeSwatchColors {
  background: string;
  accent: string;
}

export interface BrandDefaultThemeDefinition {
  /** Stable theme id. The default theme is selected when no data-theme is set. */
  id: 'default';
  /** User-facing theme picker label. */
  label: string;
  /** Normalized source recipe used to generate every color/effect token. */
  recipe: Required<Omit<BrandThemeRecipe, 'base'>> & {
    base: Required<BrandThemeRecipeBase>;
  };
  /** Compact colors used by theme picker swatches. */
  swatch: {
    light: BrandThemeSwatchColors;
    dark: BrandThemeSwatchColors;
  };
  /** CSS token values applied in light mode. */
  light: BrandThemeModeTokens;
  /** CSS token values applied in dark mode. */
  dark: BrandThemeModeTokens;
}

export interface BrandThemeDefinition {
  /**
   * Initial color mode (`light`, `dark`, or `system`) applied when no persisted
   * user choice exists.
   *
   * NOTE: OPTIONAL IN `brand.json` (see
   * {@link BrandPackManifestThemeDefinition}) but required on this runtime
   * type -- `scripts/brand/load-brand.mjs` normalizes an omitted value to
   * `system`, so brand authors may leave it out and still get a valid brand.
   */
  defaultColorMode: BrandColorMode;
  /** The brand-owned replacement for the built-in Default theme. */
  default: BrandDefaultThemeDefinition;
}

/**
 * Mobile app store listings for a brand's hosted web download surface. When a
 * brand declares this block, the web /download page renders a mobile apps
 * section with the declared store links; omit the whole block for brands
 * without published mobile apps.
 */
export interface BrandWebMobileApps {
  /** Apple App Store listing URL. Must be https. */
  appStoreUrl?: string;
  /** Google Play listing URL. Must be https. */
  playStoreUrl?: string;
}

export interface BrandWebMarketingLink {
  label: string;
  href: string;
}

export interface BrandWebMarketingLinkGroup {
  heading: string;
  links: BrandWebMarketingLink[];
}

/** Brand-owned links and destinations for the hosted marketing surface. */
export interface BrandWebMarketing {
  /** Scheduling destination for sales/demo calls. Must be https. */
  demoUrl: string;
  /** Cross-origin marketing chat destination. Must be https. */
  chatUrl: string;
  /**
   * Origin of the brand's storefront / legacy marketing site. Must be https.
   *
   * The field name is historical. For `unstoppable-code` this is the
   * e-commerce storefront at `unstoppabledomains.com`, a separate domain
   * from the marketing apex `unstoppable.ai`. Renaming the field would be
   * a brand-schema break (BrandSchemaVersion bump plus validator changes
   * in `scripts/brand/load-brand.mjs`), so only the value moves.
   */
  legacySiteOrigin: string;
  /**
   * Entity credited in the marketing footer copyright line, rendered as
   * `Copyright © <year> <copyrightHolder>. All rights reserved.` The year is
   * always computed at render time, so the brand pack never carries a stale
   * one.
   *
   * OPTIONAL IN `brand.json`; defaults to {@link BrandCore.displayName} when
   * omitted, exactly like {@link BrandCore.shortName}. It is required on this
   * type because `scripts/brand/load-brand.mjs` resolves the fallback while
   * normalizing the manifest, so every runtime view carries a real value.
   *
   * That is deliberately NOT a schema change: {@link BrandSchemaVersion} is
   * bumped when a field is added, removed, or changed in a way that invalidates
   * an existing pack. An existing schema-v4 marketing pack written before this
   * field existed still loads and still renders a correct footer, so there is
   * nothing for a migration to do and no reason to invalidate it.
   */
  copyrightHolder: string;
  footerLinkGroups: BrandWebMarketingLinkGroup[];
  footerUtilityLinks: BrandWebMarketingLink[];
  socialLinks: BrandWebMarketingLink[];
  /**
   * Public source repository for the brand's client apps. When declared, the
   * marketing surface links to it and claims the apps are open source; when
   * omitted, every brand-gated open-source surface is hidden. The FAQ answer
   * is part of the brand-owned marketing copy and is not gated on this field
   * (see docs/branding.md).
   *
   * OPTIONAL, so existing schema-v4 marketing packs stay valid without a
   * {@link BrandSchemaVersion} bump, for the same reason given on
   * {@link BrandWebMarketing.copyrightHolder}.
   */
  sourceRepository?: BrandSourceRepository;
}

/** Public client source repository declared by a marketing brand. */
export interface BrandSourceRepository {
  /** https URL of the public client source repository. */
  url: string;
  /** SPDX license identifier of the published client source, e.g. `MIT`. */
  license: string;
}

export interface BrandLinuxPackaging {
  maintainerEmail: string;
}

/**
 * The shared identity / configuration block that all three brand views
 * (manifest, desktop runtime, web runtime) extend. Asset shape is the only
 * thing that differs per layer; everything else is identical.
 */
export interface BrandCore {
  /** Schema version literal. */
  schemaVersion: BrandSchemaVersion;
  /** lower-kebab brand id; matches the `brands/<id>/` directory name. */
  id: string;
  /** Externally-visible product display name, e.g. "Canopy". */
  displayName: string;
  /** Compact display name; defaults to displayName when omitted in manifest. */
  shortName: string;
  /** lower-kebab namespace used for tool names, resource keys, etc. */
  internalName: string;
  /** binary name without `.exe`. */
  cliName: string;
  /** Optional Linux packaging contact; required for Linux readiness. */
  linux?: BrandLinuxPackaging;
  /** Electron appId / Windows app user model id. */
  appId: string;
  /** Externally-visible product description. */
  description: string;
  /** Author / vendor name. */
  author: string;
  /** Display name used in the server / desktop integration log surface. */
  serverDisplayName: string;
  /** Brand-owned theme definitions. */
  theme: BrandThemeDefinition;

  storage: {
    /** Final per-build roots; inactive until CAN-5786. Omitted packs use legacy primaries. */
    buildDataDirNames?: Readonly<Record<ProductBuild, string>>;
    dataDirNames: {
      /** Production candidates, primary first. e.g. [".canopy"]. */
      prod: string[];
      /** Release-candidate candidates, primary first. e.g. [".canopy-rc"]. */
      rc: string[];
      /** Development candidates, primary first. e.g. [".canopy-dev"]. */
      dev: string[];
    };
    secureDataDirNames: {
      /** Production secure data directory name. No fallback candidates. */
      prod: string;
      /** Release-candidate secure data directory name. No fallback candidates. */
      rc: string;
      /** Internal-build secure data directory name. No fallback candidates. */
      internal: string;
      /** Development secure data directory name. No fallback candidates. */
      dev: string;
    };
    /** Project-root config file names, primary first. */
    configFileNames: string[];
    /** Project-root config directory names, primary first. */
    projectConfigDirNames: string[];
  };

  environment: {
    /** Env-var prefix list, primary first; e.g. ["SOMEBRAND", "CANOPY"]. */
    prefixes: string[];
  };

  tools: {
    /** Tool namespace; used for MCP / dynamic-tool name construction. */
    namespace: string;
  };

  desktopIntegration: {
    /** Mount prefix for branded localhost routes, e.g. "/somebrand". */
    routePrefix: `/${string}`;
    /** Alternate token header, e.g. "X-SomeBrand-Integration-Token". */
    tokenHeaderName: string;
    /** Env var the hook script reads its bearer token from. */
    tokenEnvVar: string;
  };

  dictation: {
    /** Binary name without `.exe`, e.g. "somebrand-dictate". */
    binaryName: string;
    /** macOS bundle id for the dictation helper. */
    bundleId: string;
    /** Human-readable display name for the dictation helper. */
    displayName: string;
  };

  /** Optional GitHub App used for Copilot device-flow sign-in. Public id. */
  copilot?: {
    /** GitHub App client id, e.g. "Iv23li…". Never a secret. */
    gitHubAppClientId: string;
  };

  web: {
    /** Exact hosts; may include `localhost` for dev. May be `[]` for non-web brands. */
    hostnames: string[];
    /** Path segment under `/api/v1/`. */
    apiNamespace: string;
    /** Path segment under `/.well-known/`. */
    wellKnownNamespace: string;
    /** Browser-tab title. */
    title: string;
    /** Default `<meta name="description">` value. */
    description: string;
    /** Optional mobile app store listings; see {@link BrandWebMobileApps}. */
    mobileApps?: BrandWebMobileApps;
    /** Optional brand-owned marketing surface and corporate destinations. */
    marketing?: BrandWebMarketing;
  };

  release: {
    /** Release flavors that produce artifacts for this brand. */
    enabled: BrandReleaseFlavor[];
    /** Artifact-name prefix; usually equal to cliName. */
    artifactPrefix: string;
  };
}

// ---------------------------------------------------------------------------
// 1. Manifest — what brand.json validates to
// ---------------------------------------------------------------------------

/**
 * Asset shape of `brands/<id>/brand.json`. Every value is a **repo-relative
 * path** (typically `./...`) to a file inside the brand directory. The
 * `prepare-brand.mjs` script reads these files and emits the inlined /
 * absolute / public-URL forms exposed on the runtime types below.
 */
export interface BrandPackManifestAssets {
  /** Repo-relative path to the source SVG, e.g. "./logo.svg". */
  logoSvg: string;
  /** Repo-relative path to the master PNG used to derive platform icons. */
  appIconPng: string;
  /** Optional pre-built macOS icon. Derived from {@link appIconPng} when omitted. */
  macIconIcns?: string;
  /** Optional pre-built Windows icon. Derived from {@link appIconPng} when omitted. */
  windowsIconIco?: string;
  /** Optional pre-built Linux icon directory. Derived from {@link appIconPng} when omitted. */
  linuxIconDir?: string;
  /** Optional pre-built web icon. Derived from {@link appIconPng} when omitted. */
  webIconPng?: string;
}

export interface BrandPackManifestDefaultThemeDefinition {
  id: 'default';
  label: string;
  recipe: BrandThemeRecipe;
}

export interface BrandPackManifestThemeDefinition {
  defaultColorMode?: BrandColorMode;
  default: BrandPackManifestDefaultThemeDefinition;
}

/**
 * The shape `brands/<id>/brand.json` validates to. Returned by
 * `scripts/brand/load-brand.mjs`.
 *
 * NOTE: asset slots that are optional on the manifest (`macIconIcns`,
 * `windowsIconIco`, `linuxIconDir`, `webIconPng`) become REQUIRED on the
 * runtime types because the prepare step either fills them from the manifest
 * or generates them — or fails the build. `shortName` and
 * `web.marketing.copyrightHolder` follow the same rule: omittable in the JSON,
 * defaulted from `displayName` by the loader, and required here.
 */
export interface BrandPackManifest extends Omit<BrandCore, 'theme'> {
  theme: BrandPackManifestThemeDefinition;
  assets: BrandPackManifestAssets;
}

// ---------------------------------------------------------------------------
// 2. Desktop runtime — what `@canopy/brand/current` exports
// ---------------------------------------------------------------------------

/**
 * Asset shape of `.cache/brand/<id>/desktop-brand.ts`. Contains inlined SVG
 * markup (renderer-safe) plus paths to materialized platform raster icons
 * (main / CLI / packaging). Paths may be repo-relative in generated build
 * cache modules so renderer bundles do not expose local checkout locations.
 *
 * Every slot is required: prepare-brand.mjs fills missing manifest entries.
 */
export interface DesktopBrandAssets {
  /** Inline SVG markup, ready for innerHTML / dangerouslySetInnerHTML. */
  logoSvg: string;
  /** Path to the cached SVG file inside `.cache/brand/<id>/`. */
  logoSvgPath: string;
  /** Path to the master raster icon under `.cache/brand/<id>/electron-resources/`. */
  appIconPng: string;
  /** Path to the macOS .icns under `electron-resources/`. */
  macIconIcns: string;
  /** Path to the Windows .ico under `electron-resources/`. */
  windowsIconIco: string;
  /** Path to the Linux icon directory under `electron-resources/`. */
  linuxIconDir: string;
  /** Path to the web icon PNG under `electron-resources/`. */
  webIconPng: string;
}

/** What `@canopy/brand/current` exports — consumed by main, renderer, and CLI. */
export interface DesktopBrandRuntime extends BrandCore {
  assets: DesktopBrandAssets;
}

// ---------------------------------------------------------------------------
// 3. Web runtime — what `@canopy/brand/web` exports per brand
// ---------------------------------------------------------------------------

/**
 * Asset shape of each entry in `.cache/brand/web-brands.ts`. URLs reference
 * `apps/web/public/brand/<id>/...` so they resolve from the Next public
 * folder in dev, production, and tests.
 */
export interface WebBrandAssets {
  /** Public URL for the SVG logo, e.g. "/brand/canopy/logo.svg". */
  logoSvgUrl: string;
  /** Inline SVG markup, identical to {@link DesktopBrandAssets.logoSvg}. */
  logoSvgContent: string;
  /** Public URL for the master raster icon. */
  appIconPngUrl: string;
  /** Public URL for the web icon. */
  webIconPngUrl: string;
}

/** Per-brand shape exported in `.cache/brand/web-brands.ts`. */
export interface WebBrandRuntime extends BrandCore {
  assets: WebBrandAssets;
}

// ---------------------------------------------------------------------------
// Build-materialized artifact contracts
// ---------------------------------------------------------------------------

/**
 * Shape of `.cache/brand/web-brands.ts`. Static-typed so that hostname
 * resolution code can rely on a fixed export surface.
 */
export interface WebBrandsArtifact {
  /** Ordered list of every brand whose `web.hostnames` is non-empty. */
  readonly WEB_BRANDS: readonly WebBrandRuntime[];
  /** Hostname → brand lookup. Hostnames are normalized to lower-case, port-stripped. */
  readonly BRAND_BY_HOSTNAME: ReadonlyMap<string, WebBrandRuntime>;
}

// ---------------------------------------------------------------------------
// Module-alias contracts (documentation only — paths are resolved by bundler config)
// ---------------------------------------------------------------------------

/**
 * Canonical alias for the currently-selected desktop brand. Resolves to
 * `<repo>/.cache/brand/current/desktop-brand.ts` which re-exports from
 * the selected brand's materialized file.
 *
 * Importers MUST use this alias instead of any `<id>/desktop-brand.ts`
 * relative path.
 */
export const DESKTOP_BRAND_CURRENT_ALIAS = '@canopy/brand/current' as const;

/**
 * Canonical alias for the multi-brand web artifact. Resolves to
 * `<repo>/.cache/brand/web-brands.ts`. Independent of which desktop brand
 * was last prepared — the file always exports every brand.
 */
export const WEB_BRANDS_ALIAS = '@canopy/brand/web' as const;

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/** Lowercase kebab/snake-safe path-segment identifier. */
const LOWER_KEBAB_REGEX = /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/;
/** Uppercase snake env-var prefix. */
const UPPER_SNAKE_REGEX = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/;
const BRAND_RELEASE_FLAVOR_SET = new Set<string>(BRAND_RELEASE_FLAVORS);

/** A non-throwing validation result for {@link validateBrandCore}. */
export interface BrandValidationResult {
  ok: boolean;
  errors: readonly string[];
}

function pushIf(errors: string[], condition: boolean, message: string): void {
  if (condition) errors.push(message);
}

function isLowerKebab(value: unknown): value is string {
  return typeof value === 'string' && LOWER_KEBAB_REGEX.test(value);
}

function isUpperSnake(value: unknown): value is string {
  return typeof value === 'string' && UPPER_SNAKE_REGEX.test(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function toUnknownRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  return Object.fromEntries(Object.entries(value));
}

function isDirectoryName(value: unknown): value is string {
  if (!isNonEmptyString(value)) {
    return false;
  }
  const trimmed = value.trim();
  return (
    trimmed.length > 0 &&
    trimmed !== '.' &&
    trimmed !== '..' &&
    !trimmed.includes('/') &&
    !trimmed.includes('\\')
  );
}

function hasDuplicateStrings(values: readonly unknown[]): boolean {
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const normalized = value.trim();
    if (seen.has(normalized)) {
      return true;
    }
    seen.add(normalized);
  }
  return false;
}

function validateThemeSwatch(
  swatch: Record<string, unknown> | undefined,
  label: string,
  errors: string[],
): void {
  if (typeof swatch !== 'object' || swatch === null || Array.isArray(swatch)) {
    errors.push(`${label} is required`);
    return;
  }
  pushIf(
    errors,
    !isNonEmptyString(swatch.background),
    `${label}.background must be a non-empty string`,
  );
  pushIf(
    errors,
    !isNonEmptyString(swatch.accent),
    `${label}.accent must be a non-empty string`,
  );
}

function validateThemeModeTokens(
  tokens: Record<string, unknown> | undefined,
  label: string,
  errors: string[],
): void {
  if (typeof tokens !== 'object' || tokens === null || Array.isArray(tokens)) {
    errors.push(`${label} is required`);
    return;
  }
  for (const tokenName of BRAND_THEME_TOKEN_NAMES) {
    pushIf(
      errors,
      !isNonEmptyString(tokens[tokenName]),
      `${label}.${tokenName} must be a non-empty string`,
    );
  }
  const primitives = tokens.primitives;
  if (
    typeof primitives !== 'object' ||
    primitives === null ||
    Array.isArray(primitives) ||
    Object.keys(primitives).length === 0
  ) {
    errors.push(`${label}.primitives must be a non-empty token map`);
  } else {
    for (const [name, value] of Object.entries(primitives)) {
      const primitive = toUnknownRecord(value);
      pushIf(
        errors,
        !isNonEmptyString(name) ||
          primitive === undefined ||
          !isNonEmptyString(primitive.srgb) ||
          !isNonEmptyString(primitive.displayP3) ||
          !isNonEmptyString(primitive.oklch),
        `${label}.primitives must contain sRGB, Display-P3, and OKLCH values`,
      );
    }
  }
  for (const semanticField of [
    'semantic',
    'displayP3',
    'cssBindings',
    'displayP3CssBindings',
  ] as const) {
    const semantic = tokens[semanticField];
    if (
      typeof semantic !== 'object' ||
      semantic === null ||
      Array.isArray(semantic) ||
      Object.keys(semantic).length === 0
    ) {
      errors.push(`${label}.${semanticField} must be a non-empty token map`);
      continue;
    }
    for (const [name, value] of Object.entries(semantic)) {
      pushIf(
        errors,
        !isNonEmptyString(name) || !isNonEmptyString(value),
        `${label}.${semanticField} must contain non-empty token values`,
      );
    }
  }
}

function validateThemeRecipe(
  recipe: Record<string, unknown> | undefined,
  label: string,
  errors: string[],
): void {
  if (typeof recipe !== 'object' || recipe === null || Array.isArray(recipe)) {
    errors.push(`${label} is required`);
    return;
  }
  pushIf(
    errors,
    recipe.engine !== 'ui-kit-v1',
    `${label}.engine must be "ui-kit-v1"`,
  );
  pushIf(
    errors,
    !isNonEmptyString(recipe.accent),
    `${label}.accent must be a non-empty string`,
  );
  const base = toUnknownRecord(recipe.base);
  if (typeof base !== 'object' || base === null || Array.isArray(base)) {
    errors.push(`${label}.base is required`);
  } else {
    for (const mode of ['lighter', 'light', 'dark', 'darker'] as const) {
      pushIf(
        errors,
        !isNonEmptyString(base[mode]),
        `${label}.base.${mode} must be a non-empty string`,
      );
    }
  }
  for (const field of [
    'contrast',
    'neutralTint',
    'surfaceHue',
    'borderContrast',
    'darkAccentTone',
  ] as const) {
    pushIf(
      errors,
      typeof recipe[field] !== 'number' || !Number.isFinite(recipe[field]),
      `${label}.${field} must be a finite number`,
    );
  }
  const tuning = toUnknownRecord(recipe.tuning);
  if (typeof tuning !== 'object' || tuning === null || Array.isArray(tuning)) {
    errors.push(`${label}.tuning must be an object`);
  } else {
    for (const field of [
      'neutralTintScale',
      'surfaceStepScale',
      'lineAlpha',
      'maxChroma',
      'accentChromaScale',
      'semanticContrastRatio',
      'solidTone',
      'mutedAlpha',
    ] as const) {
      pushIf(
        errors,
        typeof tuning[field] !== 'number' || !Number.isFinite(tuning[field]),
        `${label}.tuning.${field} must be a finite number`,
      );
    }
  }
  pushIf(
    errors,
    !isNonEmptyString(recipe.radius),
    `${label}.radius must be a non-empty string`,
  );
}

/**
 * Validate the contract-level invariants of a {@link BrandCore} record.
 * Performs lightweight structural validation; full asset-resolution checks
 * belong to the prepare-brand backend script.
 *
 * `directoryName` is used only to enforce `id === directory name`. Pass the
 * literal `null` when not known (the check is skipped).
 *
 * IMPORTANT: this validates the NORMALIZED runtime core produced by
 * `scripts/brand/load-brand.mjs`, not a raw `brand.json` manifest. Fields the
 * loader supplies for an omitted manifest key -- currently
 * `theme.defaultColorMode`, which normalizes to `system` -- are REQUIRED here
 * even though `docs/branding.md` correctly documents them as optional in the
 * manifest. Pointing this at a raw manifest would reject conforming brand
 * packs.
 */
export function validateBrandCore(
  candidate: unknown,
  directoryName: string | null = null,
): BrandValidationResult {
  const errors: string[] = [];

  if (
    typeof candidate !== 'object' ||
    candidate === null ||
    Array.isArray(candidate)
  ) {
    return { ok: false, errors: ['brand pack must be a JSON object'] };
  }

  const record = candidate as Record<string, unknown>;

  pushIf(
    errors,
    record.schemaVersion !== 5,
    `schemaVersion must be 5 (got ${String(record.schemaVersion)})`,
  );

  pushIf(errors, !isLowerKebab(record.id), 'id must be lower-kebab');
  if (
    directoryName !== null &&
    typeof record.id === 'string' &&
    record.id !== directoryName
  ) {
    errors.push(
      `id "${String(record.id)}" must equal directory name "${directoryName}"`,
    );
  }

  pushIf(
    errors,
    !isNonEmptyString(record.displayName),
    'displayName must be a non-empty string',
  );
  if (record.shortName !== undefined) {
    pushIf(
      errors,
      !isNonEmptyString(record.shortName),
      'shortName must be a non-empty string when provided',
    );
  }
  pushIf(
    errors,
    !isLowerKebab(record.internalName),
    'internalName must be lower-kebab',
  );
  pushIf(errors, !isLowerKebab(record.cliName), 'cliName must be lower-kebab');
  pushIf(
    errors,
    !isNonEmptyString(record.appId),
    'appId must be a non-empty string',
  );
  pushIf(
    errors,
    !isNonEmptyString(record.description),
    'description must be a non-empty string',
  );
  pushIf(
    errors,
    !isNonEmptyString(record.author),
    'author must be a non-empty string',
  );
  pushIf(
    errors,
    !isNonEmptyString(record.serverDisplayName),
    'serverDisplayName must be a non-empty string',
  );

  if (record.linux !== undefined) {
    const linux = toUnknownRecord(record.linux);
    if (!linux) {
      errors.push('linux must be an object when provided');
    } else {
      const email = linux.maintainerEmail;
      pushIf(
        errors,
        typeof email !== 'string' ||
          email !== email.trim() ||
          Array.from(email).some((character) => {
            const code = character.charCodeAt(0);
            return code < 32 || (code >= 127 && code <= 159);
          }) ||
          !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(email),
        'linux.maintainerEmail must be a trimmed email address without control characters',
      );
    }
  }

  const theme = record.theme as Record<string, unknown> | undefined;
  if (typeof theme !== 'object' || theme === null || Array.isArray(theme)) {
    errors.push('theme is required');
  } else {
    pushIf(
      errors,
      !isBrandColorMode(theme.defaultColorMode),
      'theme.defaultColorMode must be one of light, dark, system',
    );
    const defaultTheme = theme.default as Record<string, unknown> | undefined;
    if (
      typeof defaultTheme !== 'object' ||
      defaultTheme === null ||
      Array.isArray(defaultTheme)
    ) {
      errors.push('theme.default is required');
    } else {
      pushIf(
        errors,
        defaultTheme.id !== 'default',
        'theme.default.id must be "default"',
      );
      pushIf(
        errors,
        !isNonEmptyString(defaultTheme.label),
        'theme.default.label must be a non-empty string',
      );
      validateThemeRecipe(
        toUnknownRecord(defaultTheme.recipe),
        'theme.default.recipe',
        errors,
      );
      const swatch = defaultTheme.swatch as Record<string, unknown> | undefined;
      if (
        typeof swatch !== 'object' ||
        swatch === null ||
        Array.isArray(swatch)
      ) {
        errors.push('theme.default.swatch is required');
      } else {
        validateThemeSwatch(
          swatch.light as Record<string, unknown> | undefined,
          'theme.default.swatch.light',
          errors,
        );
        validateThemeSwatch(
          swatch.dark as Record<string, unknown> | undefined,
          'theme.default.swatch.dark',
          errors,
        );
      }
      validateThemeModeTokens(
        defaultTheme.light as Record<string, unknown> | undefined,
        'theme.default.light',
        errors,
      );
      validateThemeModeTokens(
        defaultTheme.dark as Record<string, unknown> | undefined,
        'theme.default.dark',
        errors,
      );
    }
  }

  const storage = record.storage as Record<string, unknown> | undefined;
  if (
    typeof storage !== 'object' ||
    storage === null ||
    Array.isArray(storage)
  ) {
    errors.push('storage is required');
  } else {
    const dataDirNames = storage.dataDirNames as
      | Record<string, unknown>
      | undefined;
    if (
      typeof dataDirNames !== 'object' ||
      dataDirNames === null ||
      Array.isArray(dataDirNames)
    ) {
      errors.push('storage.dataDirNames is required');
    } else {
      const prodDataDirNames = dataDirNames.prod;
      const devDataDirNames = dataDirNames.dev;
      const rcDataDirNames = dataDirNames.rc ?? devDataDirNames;
      pushIf(
        errors,
        !Array.isArray(prodDataDirNames) ||
          prodDataDirNames.some((v) => !isNonEmptyString(v)) ||
          prodDataDirNames.length === 0,
        'storage.dataDirNames.prod must be a non-empty string array',
      );
      if (Array.isArray(prodDataDirNames)) {
        pushIf(
          errors,
          hasDuplicateStrings(prodDataDirNames),
          'storage.dataDirNames.prod must not contain duplicate entries',
        );
      }
      pushIf(
        errors,
        !Array.isArray(devDataDirNames) ||
          devDataDirNames.some((v) => !isNonEmptyString(v)) ||
          devDataDirNames.length === 0,
        'storage.dataDirNames.dev must be a non-empty string array',
      );
      if (Array.isArray(devDataDirNames)) {
        pushIf(
          errors,
          hasDuplicateStrings(devDataDirNames),
          'storage.dataDirNames.dev must not contain duplicate entries',
        );
      }
      pushIf(
        errors,
        !Array.isArray(rcDataDirNames) ||
          rcDataDirNames.some((v) => !isNonEmptyString(v)) ||
          rcDataDirNames.length === 0,
        'storage.dataDirNames.rc must be a non-empty string array',
      );
      if (Array.isArray(rcDataDirNames)) {
        pushIf(
          errors,
          hasDuplicateStrings(rcDataDirNames),
          'storage.dataDirNames.rc must not contain duplicate entries',
        );
      }
    }
    const secureDataDirNames = storage.secureDataDirNames as
      | Record<string, unknown>
      | undefined;
    if (
      typeof secureDataDirNames !== 'object' ||
      secureDataDirNames === null ||
      Array.isArray(secureDataDirNames)
    ) {
      errors.push('storage.secureDataDirNames is required');
    } else {
      pushIf(
        errors,
        !isDirectoryName(secureDataDirNames.prod),
        'storage.secureDataDirNames.prod must be a directory name, not a path',
      );
      pushIf(
        errors,
        !isDirectoryName(secureDataDirNames.dev),
        'storage.secureDataDirNames.dev must be a directory name, not a path',
      );
      pushIf(
        errors,
        !isDirectoryName(secureDataDirNames.rc ?? secureDataDirNames.dev),
        'storage.secureDataDirNames.rc must be a directory name, not a path',
      );
      pushIf(
        errors,
        !isDirectoryName(secureDataDirNames.internal),
        'storage.secureDataDirNames.internal must be a directory name, not a path',
      );
    }
    pushIf(
      errors,
      !Array.isArray(storage.configFileNames) ||
        (storage.configFileNames as unknown[]).some(
          (v) => !isNonEmptyString(v),
        ) ||
        (storage.configFileNames as unknown[]).length === 0,
      'storage.configFileNames must be a non-empty string array',
    );
    if (Array.isArray(storage.configFileNames)) {
      pushIf(
        errors,
        hasDuplicateStrings(storage.configFileNames),
        'storage.configFileNames must not contain duplicate entries',
      );
    }
    pushIf(
      errors,
      !Array.isArray(storage.projectConfigDirNames) ||
        (storage.projectConfigDirNames as unknown[]).some(
          (v) => !isNonEmptyString(v),
        ) ||
        (storage.projectConfigDirNames as unknown[]).length === 0,
      'storage.projectConfigDirNames must be a non-empty string array',
    );
    if (Array.isArray(storage.projectConfigDirNames)) {
      pushIf(
        errors,
        hasDuplicateStrings(storage.projectConfigDirNames),
        'storage.projectConfigDirNames must not contain duplicate entries',
      );
    }
  }

  const environment = record.environment as Record<string, unknown> | undefined;
  if (
    typeof environment !== 'object' ||
    environment === null ||
    Array.isArray(environment)
  ) {
    errors.push('environment is required');
  } else {
    const prefixes = environment.prefixes;
    if (
      !Array.isArray(prefixes) ||
      prefixes.length === 0 ||
      prefixes.some((v) => !isUpperSnake(v))
    ) {
      errors.push(
        'environment.prefixes must be a non-empty array of UPPER_SNAKE strings',
      );
    }
    if (Array.isArray(prefixes)) {
      pushIf(
        errors,
        hasDuplicateStrings(prefixes),
        'environment.prefixes must not contain duplicate entries',
      );
    }
  }

  const tools = record.tools as Record<string, unknown> | undefined;
  if (typeof tools !== 'object' || tools === null || Array.isArray(tools)) {
    errors.push('tools is required');
  } else {
    pushIf(
      errors,
      !isLowerKebab(tools.namespace),
      'tools.namespace must be lower-kebab',
    );
  }

  const desktopIntegration = record.desktopIntegration as
    | Record<string, unknown>
    | undefined;
  if (
    typeof desktopIntegration !== 'object' ||
    desktopIntegration === null ||
    Array.isArray(desktopIntegration)
  ) {
    errors.push('desktopIntegration is required');
  } else {
    const routePrefix = desktopIntegration.routePrefix;
    if (
      typeof routePrefix !== 'string' ||
      !routePrefix.startsWith('/') ||
      (routePrefix.length > 1 && routePrefix.endsWith('/'))
    ) {
      errors.push(
        'desktopIntegration.routePrefix must start with "/" and have no trailing slash (except "/")',
      );
    }
    pushIf(
      errors,
      !isNonEmptyString(desktopIntegration.tokenHeaderName),
      'desktopIntegration.tokenHeaderName must be a non-empty string',
    );
    pushIf(
      errors,
      !isUpperSnake(desktopIntegration.tokenEnvVar),
      'desktopIntegration.tokenEnvVar must be UPPER_SNAKE',
    );
  }

  const dictation = record.dictation as Record<string, unknown> | undefined;
  if (
    typeof dictation !== 'object' ||
    dictation === null ||
    Array.isArray(dictation)
  ) {
    errors.push('dictation is required');
  } else {
    pushIf(
      errors,
      !isLowerKebab(dictation.binaryName),
      'dictation.binaryName must be lower-kebab',
    );
    pushIf(
      errors,
      !isNonEmptyString(dictation.bundleId),
      'dictation.bundleId must be a non-empty string',
    );
    pushIf(
      errors,
      !isNonEmptyString(dictation.displayName),
      'dictation.displayName must be a non-empty string',
    );
  }

  if (record.copilot !== undefined) {
    const copilot = toUnknownRecord(record.copilot);
    if (!copilot) {
      errors.push('copilot must be an object when provided');
    } else {
      pushIf(
        errors,
        !isNonEmptyString(copilot.gitHubAppClientId),
        'copilot.gitHubAppClientId must be a non-empty string',
      );
    }
  }

  const web = record.web as Record<string, unknown> | undefined;
  if (typeof web !== 'object' || web === null || Array.isArray(web)) {
    errors.push('web is required');
  } else {
    if (web.hostnames === undefined) {
      // hostnames optional in manifest, default to []
    } else if (
      !Array.isArray(web.hostnames) ||
      (web.hostnames as unknown[]).some((v) => !isNonEmptyString(v))
    ) {
      errors.push('web.hostnames must be a string array when provided');
    }
    pushIf(
      errors,
      !isLowerKebab(web.apiNamespace),
      'web.apiNamespace must be lower-kebab',
    );
    pushIf(
      errors,
      !isLowerKebab(web.wellKnownNamespace),
      'web.wellKnownNamespace must be lower-kebab',
    );
    pushIf(
      errors,
      !isNonEmptyString(web.title),
      'web.title must be a non-empty string',
    );
    pushIf(
      errors,
      !isNonEmptyString(web.description),
      'web.description must be a non-empty string',
    );
    if (web.mobileApps !== undefined) {
      if (
        typeof web.mobileApps !== 'object' ||
        web.mobileApps === null ||
        Array.isArray(web.mobileApps)
      ) {
        errors.push('web.mobileApps must be an object when provided');
      } else {
        const mobileApps = web.mobileApps as Record<string, unknown>;
        const urlFields: ReadonlyArray<readonly [string, unknown]> = [
          ['web.mobileApps.appStoreUrl', mobileApps.appStoreUrl],
          ['web.mobileApps.playStoreUrl', mobileApps.playStoreUrl],
        ];
        let declared = 0;
        for (const [label, value] of urlFields) {
          if (value === undefined) continue;
          declared += 1;
          pushIf(
            errors,
            typeof value !== 'string' || !value.startsWith('https://'),
            `${label} must be an https:// URL`,
          );
        }
        pushIf(
          errors,
          declared === 0,
          'web.mobileApps must declare at least one store URL',
        );
      }
    }
  }

  const release = record.release as Record<string, unknown> | undefined;
  if (
    typeof release !== 'object' ||
    release === null ||
    Array.isArray(release)
  ) {
    errors.push('release is required');
  } else {
    if (!Array.isArray(release.enabled)) {
      errors.push('release.enabled must be an array');
    } else {
      const seenReleaseFlavors = new Set<string>();
      for (const entry of release.enabled) {
        if (typeof entry !== 'string' || !BRAND_RELEASE_FLAVOR_SET.has(entry)) {
          errors.push(
            'release.enabled must contain only internal, rc, or stable',
          );
          break;
        }
        if (seenReleaseFlavors.has(entry)) {
          errors.push('release.enabled must not contain duplicate entries');
          break;
        }
        seenReleaseFlavors.add(entry);
      }
    }
    pushIf(
      errors,
      !isLowerKebab(release.artifactPrefix),
      'release.artifactPrefix must be lower-kebab',
    );
  }

  return { ok: errors.length === 0, errors };
}

/**
 * De-duplicate a string array, preserving the first occurrence of each entry.
 * Used by the loader to enforce "fallback priority arrays preserve order and
 * de-dupe" for {@link BrandCore.environment.prefixes} and the various
 * `storage.*` lists.
 */
export function dedupePreserveOrder(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Release channel helpers (shared by the desktop updater and web downloads)
// ---------------------------------------------------------------------------

/**
 * Resolve the electron-builder update channel name for a brand. Canopy uses
 * the default `latest` channel; whitelabel brands publish under their
 * {@link BrandCore.release.artifactPrefix}.
 */
export function getBrandUpdateChannelName(
  brand: Pick<BrandCore, 'id' | 'release'>,
): string {
  return brand.id === 'canopy' ? 'latest' : brand.release.artifactPrefix;
}

/**
 * Resolve the electron-builder update metadata filename for a channel and
 * platform. `platform` accepts Node `process.platform`-style values; anything
 * other than `darwin` / `win32` is treated as Linux. When `arch` is omitted,
 * x64 is assumed for the Linux filename.
 */
export function getBrandUpdateChannelFilename(
  channel: string,
  platform: string,
  arch?: string,
): string {
  if (platform === 'darwin') {
    return `${channel}-mac.yml`;
  }
  if (platform === 'win32') {
    return `${channel}.yml`;
  }

  const archSuffix = arch === undefined || arch === 'x64' ? '' : `-${arch}`;
  return `${channel}-linux${archSuffix}.yml`;
}

/**
 * Core daemon executable name without `.exe` (Phase 0B D1): the CLI name plus
 * `d`, e.g. `canopyd`.
 */
export function daemonName(brand: Pick<BrandCore, 'cliName'>): string {
  return `${brand.cliName}d`;
}

// ---------------------------------------------------------------------------
// Branded route / tool name builders (derived from BrandCore)
// ---------------------------------------------------------------------------

/**
 * Concatenate {@link BrandCore.desktopIntegration.routePrefix} with a trailing
 * segment, normalizing the join so callers don't have to track whether the
 * prefix already ends in `/`.
 */
export function joinDesktopIntegrationRoute(
  routePrefix: BrandCore['desktopIntegration']['routePrefix'],
  trailing: string,
): string {
  const prefix = routePrefix.endsWith('/')
    ? routePrefix.slice(0, -1)
    : routePrefix;
  const tail = trailing.startsWith('/') ? trailing : `/${trailing}`;
  return `${prefix}${tail}`;
}

/**
 * Build the four canonical desktop-integration route paths from a brand core.
 * Used by the transport layer so handler registration, wrapper scripts, and
 * conformance tests all derive the same strings.
 */
export interface DesktopIntegrationRoutes {
  readonly routePrefix: BrandCore['desktopIntegration']['routePrefix'];
  /** `${routePrefix}/mcp/worktree-session` */
  readonly mcpWorktreeSession: string;
  /** `${routePrefix}/hooks/claude-terminal/worktree-session` */
  readonly hooksClaudeTerminalWorktreeSession: string;
  /** `${routePrefix}/mcp/proxy` */
  readonly mcpProxy: string;
}

export function buildDesktopIntegrationRoutes(
  brand: Pick<BrandCore, 'desktopIntegration'>,
): DesktopIntegrationRoutes {
  const prefix = brand.desktopIntegration.routePrefix;
  return {
    routePrefix: prefix,
    mcpWorktreeSession: joinDesktopIntegrationRoute(
      prefix,
      '/mcp/worktree-session',
    ),
    hooksClaudeTerminalWorktreeSession: joinDesktopIntegrationRoute(
      prefix,
      '/hooks/claude-terminal/worktree-session',
    ),
    mcpProxy: joinDesktopIntegrationRoute(prefix, '/mcp/proxy'),
  };
}

/**
 * Build the MCP / dynamic tool names a brand advertises. Live advertised
 * tools MUST derive from this builder so the renderer transcript renderer and
 * the main-process registration agree on the wire name.
 */
export interface InjectedToolNamesForBrand {
  readonly claude: {
    readonly askUserQuestion: string;
    readonly getScriptOutput: string;
    readonly getGitPreferences: string;
    readonly saveMemory: string;
    readonly searchMemory: string;
    readonly readMemory: string;
    readonly readPipelineYaml: string;
    readonly showFiles: string;
    readonly showCapabilities: string;
    readonly showVisual: string;
    readonly previewVisual: string;
    readonly getFileComments: string;
    readonly respondToFileComment: string;
    readonly searchActions: string;
    readonly dispatchAction: string;
    readonly searchWatchers: string;
    readonly setupWatchers: string;
    readonly watchGithubItems: string;
    readonly getGithubPullRequestStatus: string;
    readonly watchCommand: string;
    readonly scheduleWakeup: string;
    readonly deleteWatchers: string;
    readonly setAutoArchive: string;
    readonly setWorkEntryAutoDelete: string;
    readonly setBaseBranch: string;
    readonly startForkedAgent: string;
    readonly startBranchedAgent: string;
    readonly getCodeGraphContext: string;
    readonly buildOrUpdateCodeGraph: string;
    readonly queryCodeGraph: string;
    readonly searchCodeGraph: string;
    readonly explainCodeSymbol: string;
    readonly getImpactRadius: string;
    readonly detectChangedSymbols: string;
    readonly compareChangeImpact: string;
    readonly getReviewContext: string;
    readonly searchDeferredTools: string;
    readonly loadDeferredTools: string;
    readonly addLedgerEntry: string;
    readonly searchLedgerEntries: string;
    readonly updateLedgerEntry: string;
    readonly delegateTask: string;
    readonly getDelegateOutput: string;
    readonly inspectDelegate: string;
    readonly listDelegates: string;
    readonly stopDelegate: string;
    readonly manageDelegateWorktree: string;
    readonly messageDelegate: string;
    readonly requestSteering: string;
  };
  readonly codex: {
    readonly askUserQuestion: string;
    readonly getScriptOutput: string;
    readonly getGitPreferences: string;
    readonly saveMemory: string;
    readonly searchMemory: string;
    readonly readMemory: string;
    readonly readPipelineYaml: string;
    readonly showFiles: string;
    readonly showCapabilities: string;
    readonly showVisual: string;
    readonly previewVisual: string;
    readonly getFileComments: string;
    readonly respondToFileComment: string;
    readonly searchActions: string;
    readonly dispatchAction: string;
    readonly searchWatchers: string;
    readonly setupWatchers: string;
    readonly watchGithubItems: string;
    readonly getGithubPullRequestStatus: string;
    readonly watchCommand: string;
    readonly scheduleWakeup: string;
    readonly deleteWatchers: string;
    readonly setAutoArchive: string;
    readonly setWorkEntryAutoDelete: string;
    readonly setBaseBranch: string;
    readonly startForkedAgent: string;
    readonly startBranchedAgent: string;
    readonly getCodeGraphContext: string;
    readonly buildOrUpdateCodeGraph: string;
    readonly queryCodeGraph: string;
    readonly searchCodeGraph: string;
    readonly explainCodeSymbol: string;
    readonly getImpactRadius: string;
    readonly detectChangedSymbols: string;
    readonly compareChangeImpact: string;
    readonly getReviewContext: string;
    readonly searchDeferredTools: string;
    readonly loadDeferredTools: string;
    readonly addLedgerEntry: string;
    readonly searchLedgerEntries: string;
    readonly updateLedgerEntry: string;
    readonly delegateTask: string;
    readonly getDelegateOutput: string;
    readonly inspectDelegate: string;
    readonly listDelegates: string;
    readonly stopDelegate: string;
    readonly manageDelegateWorktree: string;
    readonly messageDelegate: string;
    readonly requestSteering: string;
  };
  readonly appAdvisor: {
    readonly claudeNamespacePrefix: string;
    readonly codexNamespacePrefix: string;
  };
}

export function buildInjectedToolNamesForBrand(
  brand: Pick<BrandCore, 'tools'>,
): InjectedToolNamesForBrand {
  const namespace = brand.tools.namespace;
  return {
    claude: {
      askUserQuestion: `mcp__${namespace}_ui__AskUserQuestion`,
      getScriptOutput: `mcp__${namespace}__GetScriptOutput`,
      getGitPreferences: `mcp__${namespace}__GetGitPreferences`,
      saveMemory: `mcp__${namespace}__SaveMemory`,
      searchMemory: `mcp__${namespace}__SearchMemory`,
      readMemory: `mcp__${namespace}__ReadMemory`,
      readPipelineYaml: `mcp__${namespace}__ReadPipelineYaml`,
      showFiles: `mcp__${namespace}__ShowFiles`,
      showCapabilities: `mcp__${namespace}__ShowCapabilities`,
      showVisual: `mcp__${namespace}__ShowVisual`,
      previewVisual: `mcp__${namespace}__PreviewVisual`,
      getFileComments: `mcp__${namespace}__GetFileComments`,
      respondToFileComment: `mcp__${namespace}__RespondToFileComment`,
      searchActions: `mcp__${namespace}__SearchActions`,
      dispatchAction: `mcp__${namespace}__DispatchAction`,
      searchWatchers: `mcp__${namespace}__SearchWatchers`,
      setupWatchers: `mcp__${namespace}__SetupWatchers`,
      watchGithubItems: `mcp__${namespace}__WatchGitHubItems`,
      getGithubPullRequestStatus: `mcp__${namespace}__GetGitHubPullRequestStatus`,
      watchCommand: `mcp__${namespace}__WatchCommand`,
      scheduleWakeup: `mcp__${namespace}__ScheduleWakeup`,
      deleteWatchers: `mcp__${namespace}__DeleteWatchers`,
      setAutoArchive: `mcp__${namespace}__SetChatAutoArchive`,
      setWorkEntryAutoDelete: `mcp__${namespace}__SetWorkEntryAutoDelete`,
      setBaseBranch: `mcp__${namespace}__SetBaseBranch`,
      startForkedAgent: `mcp__${namespace}__StartForkedAgent`,
      startBranchedAgent: `mcp__${namespace}__StartBranchedAgent`,
      getCodeGraphContext: `mcp__${namespace}__GetCodeGraphContext`,
      buildOrUpdateCodeGraph: `mcp__${namespace}__BuildOrUpdateCodeGraph`,
      queryCodeGraph: `mcp__${namespace}__QueryCodeGraph`,
      searchCodeGraph: `mcp__${namespace}__SearchCodeGraph`,
      explainCodeSymbol: `mcp__${namespace}__ExplainCodeSymbol`,
      getImpactRadius: `mcp__${namespace}__GetImpactRadius`,
      detectChangedSymbols: `mcp__${namespace}__DetectChangedSymbols`,
      compareChangeImpact: `mcp__${namespace}__CompareChangeImpact`,
      getReviewContext: `mcp__${namespace}__GetReviewContext`,
      searchDeferredTools: `mcp__${namespace}__SearchDeferredTools`,
      loadDeferredTools: `mcp__${namespace}__LoadDeferredTools`,
      addLedgerEntry: `mcp__${namespace}__AddFeedEntry`,
      searchLedgerEntries: `mcp__${namespace}__SearchFeedEntries`,
      updateLedgerEntry: `mcp__${namespace}__UpdateFeedEntry`,
      delegateTask: `mcp__${namespace}__DelegateTask`,
      getDelegateOutput: `mcp__${namespace}__GetDelegateOutput`,
      inspectDelegate: `mcp__${namespace}__InspectDelegate`,
      listDelegates: `mcp__${namespace}__ListDelegates`,
      stopDelegate: `mcp__${namespace}__StopDelegate`,
      manageDelegateWorktree: `mcp__${namespace}__ManageDelegateWorktree`,
      messageDelegate: `mcp__${namespace}__MessageDelegate`,
      requestSteering: `mcp__${namespace}__RequestSteering`,
    },
    codex: {
      askUserQuestion: `${namespace}_ask_user_question`,
      getScriptOutput: `${namespace}_get_script_output`,
      getGitPreferences: `${namespace}_get_git_preferences`,
      saveMemory: `${namespace}_save_memory`,
      searchMemory: `${namespace}_search_memory`,
      readMemory: `${namespace}_read_memory`,
      readPipelineYaml: `${namespace}_read_pipeline_yaml`,
      showFiles: `${namespace}_show_files`,
      showCapabilities: `${namespace}_show_capabilities`,
      showVisual: `${namespace}_show_visual`,
      previewVisual: `${namespace}_preview_visual`,
      getFileComments: `${namespace}_get_file_comments`,
      respondToFileComment: `${namespace}_respond_to_file_comment`,
      searchActions: `${namespace}_search_actions`,
      dispatchAction: `${namespace}_dispatch_action`,
      searchWatchers: `${namespace}_search_watchers`,
      setupWatchers: `${namespace}_setup_watchers`,
      watchGithubItems: `${namespace}_watch_github_items`,
      getGithubPullRequestStatus: `${namespace}_get_github_pull_request_status`,
      watchCommand: `${namespace}_watch_command`,
      scheduleWakeup: `${namespace}_schedule_wakeup`,
      deleteWatchers: `${namespace}_delete_watchers`,
      setAutoArchive: `${namespace}_set_chat_auto_archive`,
      setWorkEntryAutoDelete: `${namespace}_set_work_entry_auto_delete`,
      setBaseBranch: `${namespace}_set_base_branch`,
      startForkedAgent: `${namespace}_start_forked_agent`,
      startBranchedAgent: `${namespace}_start_branched_agent`,
      getCodeGraphContext: `${namespace}_get_code_graph_context`,
      buildOrUpdateCodeGraph: `${namespace}_build_or_update_code_graph`,
      queryCodeGraph: `${namespace}_query_code_graph`,
      searchCodeGraph: `${namespace}_search_code_graph`,
      explainCodeSymbol: `${namespace}_explain_code_symbol`,
      getImpactRadius: `${namespace}_get_impact_radius`,
      detectChangedSymbols: `${namespace}_detect_changed_symbols`,
      compareChangeImpact: `${namespace}_compare_change_impact`,
      getReviewContext: `${namespace}_get_review_context`,
      searchDeferredTools: `${namespace}_search_deferred_tools`,
      loadDeferredTools: `${namespace}_load_deferred_tools`,
      addLedgerEntry: `${namespace}_add_feed_entry`,
      searchLedgerEntries: `${namespace}_search_feed_entries`,
      updateLedgerEntry: `${namespace}_update_feed_entry`,
      delegateTask: `${namespace}_spawn_delegate`,
      getDelegateOutput: `${namespace}_get_delegate_output`,
      inspectDelegate: `${namespace}_inspect_delegate`,
      listDelegates: `${namespace}_list_delegates`,
      stopDelegate: `${namespace}_stop_delegate`,
      manageDelegateWorktree: `${namespace}_manage_delegate_worktree`,
      messageDelegate: `${namespace}_message_delegate`,
      requestSteering: `${namespace}_request_steering`,
    },
    appAdvisor: {
      claudeNamespacePrefix: `mcp__${namespace}_app_advisor__`,
      codexNamespacePrefix: `${namespace}_app_advisor_`,
    },
  };
}

/**
 * Build the conventional web API / well-known URL prefixes from a brand.
 * Used by the web resolver and by any desktop client constructing absolute
 * URLs into the multi-brand web deployment.
 */
export interface BrandPathPrefix {
  /** `/api/v1/${brand.web.apiNamespace}` */
  readonly api: string;
  /** `/.well-known/${brand.web.wellKnownNamespace}` */
  readonly wellKnown: string;
}

export function buildBrandPathPrefix(
  brand: Pick<BrandCore, 'web'>,
): BrandPathPrefix {
  return {
    api: `/api/v1/${brand.web.apiNamespace}`,
    wellKnown: `/.well-known/${brand.web.wellKnownNamespace}`,
  };
}

function buildThemeDeclarations(tokens: BrandThemeModeTokens): string {
  return [
    ...Object.entries(tokens.primitives).map(
      ([tokenName, value]) => `  --primitive-${tokenName}: ${value.srgb};`,
    ),
    ...Object.entries(tokens.cssBindings).map(
      ([tokenName, value]) => `  --${tokenName}: ${value};`,
    ),
    `  --radius: ${tokens.radius};`,
  ].join('\n');
}

function buildDisplayP3ThemeDeclarations(tokens: BrandThemeModeTokens): string {
  return [
    ...Object.entries(tokens.primitives).map(
      ([tokenName, value]) => `  --primitive-${tokenName}: ${value.displayP3};`,
    ),
    ...Object.entries(tokens.displayP3CssBindings).map(
      ([tokenName, value]) => `  --${tokenName}: ${value};`,
    ),
  ].join('\n');
}

/**
 * Build CSS that replaces the shared built-in Default theme with the active
 * brand's Default theme. The selectors intentionally require the absence of
 * `data-theme`, so named user-selected themes such as `ocean` still win.
 */
export function buildBrandDefaultThemeCss(
  theme: BrandDefaultThemeDefinition,
): string {
  return [
    ':root:not([data-theme]) {',
    buildThemeDeclarations(theme.light),
    '}',
    '',
    ':root:not([data-theme]).dark {',
    buildThemeDeclarations(theme.dark),
    '}',
    '',
    '@supports (color: color(display-p3 1 1 1)) {',
    '  :root:not([data-theme]) {',
    buildDisplayP3ThemeDeclarations(theme.light)
      .split('\n')
      .map((line) => `  ${line}`)
      .join('\n'),
    '  }',
    '',
    '  :root:not([data-theme]).dark {',
    buildDisplayP3ThemeDeclarations(theme.dark)
      .split('\n')
      .map((line) => `  ${line}`)
      .join('\n'),
    '  }',
    '}',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Web brand resolver contract (signatures only)
// ---------------------------------------------------------------------------

/**
 * Public function signatures of `apps/web/src/lib/brand.ts`. The
 * implementation is owned by the backend plan, but the signatures live here
 * so callers can compile against the contract without depending on the
 * resolver module.
 *
 * Host normalization rules:
 *  - lowercase, port stripped.
 *  - exact match against `brand.web.hostnames`.
 *  - `localhost`, `127.0.0.1`, and missing host resolve to the default
 *    Canopy brand unless `CANOPY_WEB_DEFAULT_BRAND` selects another valid
 *    brand.
 *  - Unknown production host returns a `404` `Not found` response with no
 *    brand-name leakage unless `CANOPY_WEB_ALLOW_UNKNOWN_HOST_DEFAULT=true`.
 */
export interface WebBrandResolverContract {
  resolveBrandFromHost(hostHeader: string | null): WebBrandRuntime;
  requireBrandForRequest(
    requestOrHeaders: Request | Headers,
  ): WebBrandRuntime | Response;
  getBrandPathPrefix(brand: WebBrandRuntime): BrandPathPrefix;
}

// ---------------------------------------------------------------------------
// Shared brand-aware helper signatures
// ---------------------------------------------------------------------------

/**
 * Storage / data-root helper signatures. Implementation lives in
 * `packages/desktop-shared/src/lib/canopy-data-dir.ts` and is consumed by
 * both main-process Electron code and CLI code. The renderer reads the
 * resolved path via IPC pass-through.
 *
 * `source === 'fallback'` triggers a non-blocking renderer notice (frontend
 * plan), so this field is part of the IPC contract surface.
 */
export interface CanopyDataDirContract {
  getCanopyDataDir(): string;
  getCanopySecureDataDir(): string;
  getCanopySecureStorageMode(): CanopySecureStorageMode;
  getInternalLegacySharedSecureDataDir(): string | null;
  getBrandDataDirCandidates(): string[];
  getBrandSecureDataDir(): string;
  getPrimaryBrandDataDir(): string;
  getResolvedCanopyDataDir(mode?: CanopyRuntimeMode): {
    path: string;
    source: 'override' | 'primary' | 'fallback' | 'fresh';
    allCandidates: string[];
  };
  getResolvedCanopySecureDataDir(mode?: CanopySecureStorageMode): {
    path: string;
    source: 'override' | 'primary' | 'fresh';
  };
  resetResolvedCanopyDataDirForTests(): void;
}

/** Resolved data-dir result returned by {@link CanopyDataDirContract.getResolvedCanopyDataDir}. */
export interface ResolvedCanopyDataDir {
  path: string;
  source: 'override' | 'primary' | 'fallback' | 'fresh';
  allCandidates: string[];
}

/** Resolved secure data-dir result returned by {@link CanopyDataDirContract.getResolvedCanopySecureDataDir}. */
export interface ResolvedCanopySecureDataDir {
  path: string;
  source: 'override' | 'primary' | 'fresh';
}

/** Project-config helper signatures (per brand). */
export interface BrandProjectConfigContract {
  getProjectConfigFileCandidates(repoPath: string): string[];
  getPrimaryProjectConfigFilePath(repoPath: string): string;
  findExistingProjectConfigFile(repoPath: string): Promise<string | null>;
  getProjectActionsDirCandidates(repoPath: string): string[];
  getProjectPipelinesDirCandidates(repoPath: string): string[];
}

/** Brand-aware environment variable helpers (per brand). */
export interface BrandEnvContract {
  brandEnvName(suffix: string): string;
  brandEnvCandidates(suffix: string): string[];
  getBrandEnv(
    env: Record<string, string | undefined>,
    suffix: string,
  ): string | undefined;
  setBrandEnv(
    target: Record<string, string>,
    suffix: string,
    value: string,
  ): void;
}

// ---------------------------------------------------------------------------
// Vite-injected brand defines (declared globally in apps/desktop-app)
// ---------------------------------------------------------------------------

/**
 * The shape of the `__CANOPY_BRAND_*__` global constants injected by Vite at
 * build time. These globals are declared in
 * `apps/desktop-app/src/brand-defines.d.ts` so both main and renderer compile.
 */
export interface BrandViteDefines {
  __CANOPY_BRAND_ID__: string;
  __CANOPY_BRAND_DISPLAY_NAME__: string;
  __CANOPY_BRAND_CLI_NAME__: string;
}

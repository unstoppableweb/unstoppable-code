#!/usr/bin/env node
// Shared brand manifest loader/validator; direct execution prints normalized brand JSON.
// Usage: node scripts/brand/load-brand.mjs [brand-id] (defaults to CANOPY_BRAND or canopy)

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isCliEntrypoint } from './is-cli-entrypoint.mjs';
import { generateThemeFromRecipe } from './theme-generator.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(__dirname, '..', '..');

const LOWER_KEBAB_REGEX = /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/;
const UPPER_SNAKE_REGEX = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/;
const SAFE_DISPLAY_REGEX = /^[A-Za-z0-9 .,-]+$/;
const BUNDLE_ID_REGEX = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;
const RELEASE_FLAVORS = new Set(['internal', 'rc', 'stable']);
const BRAND_COLOR_MODES = new Set(['light', 'dark', 'system']);

/**
 * Heading the web marketing footer gives the group it synthesizes from
 * `web.marketing.socialLinks`. Kept here so the manifest validator can reserve
 * it; see the collision check in `loadBrand`.
 */
const SYNTHESIZED_SOCIAL_GROUP_HEADING = 'Connect';
const SOURCE_CODE_FOOTER_LABEL = 'Source code';
const SPDX_LICENSE_ID_PATTERN = /^[A-Za-z0-9.+-]+$/;

function assertNoDuplicateStrings(values, label) {
  const seen = new Set();
  for (const value of values) {
    if (seen.has(value)) {
      throw new Error(`${label} must not contain duplicate entries`);
    }
    seen.add(value);
  }
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
}

function assertArrayOfStrings(value, label) {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((entry) => typeof entry !== 'string' || entry.length === 0)
  ) {
    throw new Error(`${label} must be a non-empty string array`);
  }
}

function validateHttpsUrl(value, label) {
  if (typeof value !== 'string' || !value.startsWith('https://')) {
    throw new Error(`${label} must be an https:// URL`);
  }
}

// Kept in step with the manifest validator in packages/protocol/src/brand.ts.
const EMAIL_ADDRESS_PATTERN = /^[^\s@<>()]+@[^\s@<>()]+\.[^\s@<>()]+$/;
const HOMEBREW_CASK_PATTERN =
  /^[a-z0-9][a-z0-9_.-]*\/[a-z0-9][a-z0-9_.-]*\/[a-z0-9][a-z0-9_.-]*$/;
const ANDROID_PACKAGE_PATTERN =
  /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;
const SHA256_FINGERPRINT_PATTERN = /^[0-9A-F]{2}(:[0-9A-F]{2}){31}$/;
const HOSTNAME_PATTERN =
  /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/**
 * Android Digital Asset Links (CAN-7958): package, certificate fingerprints
 * and app-link hosts are declared together or not at all.
 */
function validateAndroidAppLinks(mobileApps) {
  const { androidPackage, androidCertFingerprints, androidAppLinkHosts } =
    mobileApps;
  const declared = [
    androidPackage,
    androidCertFingerprints,
    androidAppLinkHosts,
  ].filter((value) => value !== undefined).length;
  if (declared === 0) return;
  if (declared !== 3) {
    throw new Error(
      'web.mobileApps.androidPackage, androidCertFingerprints and androidAppLinkHosts must be declared together',
    );
  }
  if (
    typeof androidPackage !== 'string' ||
    !ANDROID_PACKAGE_PATTERN.test(androidPackage)
  ) {
    throw new Error(
      'web.mobileApps.androidPackage must be an Android application id',
    );
  }
  assertArrayOfStrings(
    androidCertFingerprints,
    'web.mobileApps.androidCertFingerprints',
  );
  if (
    androidCertFingerprints.some(
      (entry) => !SHA256_FINGERPRINT_PATTERN.test(entry),
    )
  ) {
    throw new Error(
      'web.mobileApps.androidCertFingerprints must be upper-case colon-separated SHA-256 fingerprints',
    );
  }
  assertArrayOfStrings(
    androidAppLinkHosts,
    'web.mobileApps.androidAppLinkHosts',
  );
  if (androidAppLinkHosts.some((entry) => !HOSTNAME_PATTERN.test(entry))) {
    throw new Error(
      'web.mobileApps.androidAppLinkHosts must be lower-case hostnames',
    );
  }
}

/**
 * Origin used only to resolve a candidate root-relative href. Never fetched,
 * never rendered; `.invalid` is reserved by RFC 2606 so it can never resolve.
 */
const ROOT_RELATIVE_PROBE_ORIGIN = 'https://brand-href-probe.invalid';

/**
 * Whether an href really is ROOT-RELATIVE — same origin, no matter who parses
 * it.
 *
 * A `startsWith('/')` check is NOT that test, and the gap is exploitable rather
 * than theoretical:
 *
 *   * `//evil.example.com` is protocol-relative and resolves cross-origin.
 *   * `/\evil.example.com` resolves cross-origin too: the WHATWG URL parser
 *     normalizes `\` to `/` for special schemes.
 *   * `/<TAB>/evil.example.com` resolves cross-origin as well: ASCII tab, LF,
 *     and CR are stripped BEFORE parsing.
 *
 * None of those are root-relative, yet all three start with `/`. It matters
 * downstream because the marketing chrome classifies a link as external with
 * `/^(?:https?:|mailto:)/`, so any of these shapes is treated as INTERNAL and
 * rendered as a same-site `<Link>` — a cross-origin footer navigation with no
 * `rel="noopener noreferrer"`. Resolving against a probe origin and requiring
 * the result to stay on it is the only check that tracks what a browser will
 * actually do.
 */
function isRootRelativeHref(href) {
  if (!href.startsWith('/')) return false;
  try {
    return (
      new URL(href, `${ROOT_RELATIVE_PROBE_ORIGIN}/`).origin ===
      ROOT_RELATIVE_PROBE_ORIGIN
    );
  } catch {
    return false;
  }
}

function validateMarketingLink(value, label, options = {}) {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  assertString(value.label, `${label}.label`);
  assertString(value.href, `${label}.href`);
  if (options.httpsOnly) {
    validateHttpsUrl(value.href, `${label}.href`);
    return;
  }
  if (
    !isRootRelativeHref(value.href) &&
    !value.href.startsWith('https://') &&
    !value.href.startsWith('mailto:')
  ) {
    throw new Error(
      `${label}.href must be a root-relative, mailto:, or https:// URL`,
    );
  }
}

function assertDirectoryName(value, label) {
  assertString(value, label);
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  if (trimmed.includes('/') || trimmed.includes('\\')) {
    throw new Error(`${label} must be a directory name, not a path`);
  }
  if (trimmed === '.' || trimmed === '..') {
    throw new Error(`${label} must not be a path traversal segment`);
  }
  if (directoryCollisionKey(trimmed).length === 0) {
    throw new Error(
      `${label} must resolve to a non-empty directory name on Windows`,
    );
  }
}

function directoryCollisionKey(value) {
  return value
    .trim()
    .replace(/[. ]+$/u, '')
    .normalize('NFC')
    .toLowerCase();
}

function validateIdentifier(value, label) {
  assertString(value, label);
  if (!LOWER_KEBAB_REGEX.test(value)) {
    throw new Error(`${label} must be lower-kebab`);
  }
}

function validateEnvPrefix(value, label) {
  assertString(value, label);
  if (!UPPER_SNAKE_REGEX.test(value)) {
    throw new Error(`${label} must be UPPER_SNAKE`);
  }
}

function validateDisplayString(value, label) {
  assertString(value, label);
  if (!SAFE_DISPLAY_REGEX.test(value)) {
    throw new Error(
      `${label} may only contain letters, numbers, spaces, periods, commas, and hyphens`,
    );
  }
}

function validateBundleId(value, label) {
  assertString(value, label);
  if (!BUNDLE_ID_REGEX.test(value)) {
    throw new Error(`${label} must be a reverse-DNS bundle identifier`);
  }
}

const ALLOWED_LOGO_SVG_ELEMENTS = new Set([
  'circle',
  'defs',
  'desc',
  'ellipse',
  'g',
  'lineargradient',
  'path',
  'polygon',
  'polyline',
  'rect',
  'stop',
  'svg',
  'title',
  'use',
]);

export function collectLogoSvgSafetyErrors(
  brandId,
  content,
  label = 'assets.logoSvg',
) {
  const errors = [];
  if (/<\s*script\b/i.test(content)) {
    errors.push(`${brandId}: ${label} must not contain <script>`);
  }
  if (/<\s*foreignobject\b/i.test(content)) {
    errors.push(`${brandId}: ${label} must not contain <foreignObject>`);
  }
  if (/\bjavascript\s*:/i.test(content)) {
    errors.push(`${brandId}: ${label} must not contain javascript: URLs`);
  }

  const tagPattern = /<\s*\/?\s*([A-Za-z][A-Za-z0-9:-]*)\b([^>]*)>/g;
  for (const match of content.matchAll(tagPattern)) {
    const [, rawElementName, rawAttributes] = match;
    const elementName = rawElementName.toLowerCase();
    if (!ALLOWED_LOGO_SVG_ELEMENTS.has(elementName)) {
      errors.push(
        `${brandId}: ${label} contains unsupported <${rawElementName}> element`,
      );
    }

    const attributePattern = /(?:^|[\s/])([A-Za-z_:][A-Za-z0-9_:.-]*)\s*=/g;
    for (const attributeMatch of rawAttributes.matchAll(attributePattern)) {
      const attributeName = attributeMatch[1];
      if (/^on/i.test(attributeName)) {
        errors.push(
          `${brandId}: ${label} must not contain event handler attribute ${attributeName}`,
        );
      }
    }
  }

  return errors;
}

function validateLogoSvgSafety(brandId, logoSvgPath, label) {
  const errors = collectLogoSvgSafetyErrors(
    brandId,
    readFileSync(logoSvgPath, 'utf8'),
    label,
  );
  if (errors.length > 0) {
    throw new Error(errors.join('\n'));
  }
}

function normalizeArray(value, label) {
  const normalized = value.map((entry) => entry.trim()).filter(Boolean);
  assertNoDuplicateStrings(normalized, label);
  return normalized;
}

function normalizeHostnames(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error('web.hostnames must be a string array');
  }
  const normalized = value
    .map((entry) => {
      assertString(entry, 'web.hostnames[]');
      return entry.toLowerCase().replace(/:\d+$/, '');
    })
    .filter(Boolean);
  assertNoDuplicateStrings(normalized, 'web.hostnames');
  return normalized;
}

function validateReleaseEnabled(value) {
  if (!Array.isArray(value)) {
    throw new Error('release.enabled must be an array');
  }
  assertNoDuplicateStrings(value, 'release.enabled');
  for (const entry of value) {
    if (!RELEASE_FLAVORS.has(entry)) {
      throw new Error(
        'release.enabled must contain only internal, rc, or stable',
      );
    }
  }
}

function normalizeTheme(value) {
  if (!isRecord(value)) throw new Error('theme is required');
  if (!isRecord(value.default)) throw new Error('theme.default is required');
  if (value.default.id !== 'default') {
    throw new Error('theme.default.id must be "default"');
  }
  assertString(value.default.label, 'theme.default.label');
  const generated = generateThemeFromRecipe(
    value.default.recipe,
    'theme.default.recipe',
  );
  // Only an omitted key falls back to the default. An explicitly declared
  // value -- including `null` -- must survive validation on its own, so a
  // manifest cannot smuggle an unsupported mode past `brand:validate`.
  const defaultColorMode =
    value.defaultColorMode === undefined ? 'system' : value.defaultColorMode;
  if (!BRAND_COLOR_MODES.has(defaultColorMode)) {
    throw new Error(
      'theme.defaultColorMode must be one of light, dark, system',
    );
  }
  return {
    defaultColorMode,
    default: {
      id: 'default',
      label: value.default.label.trim(),
      ...generated,
    },
  };
}

function resolveAssetPath(brandDir, assetPath, label) {
  assertString(assetPath, label);
  if (assetPath.includes('\0')) {
    throw new Error(`${label} contains an invalid path segment`);
  }
  const resolved = resolve(brandDir, assetPath);
  const relativePath = relative(brandDir, resolved);
  if (
    relativePath !== '' &&
    (relativePath === '..' ||
      relativePath.startsWith(`..${sep}`) ||
      isAbsolute(relativePath))
  ) {
    throw new Error(`${label} must stay inside ${brandDir}`);
  }
  if (!existsSync(resolved)) {
    throw new Error(`${label} does not exist: ${resolved}`);
  }
  return resolved;
}

function resolveOptionalAssetPath(brandDir, assetPath, label) {
  if (assetPath === undefined) return undefined;
  return resolveAssetPath(brandDir, assetPath, label);
}

export function loadBrand(brandId, options = {}) {
  validateIdentifier(brandId, 'brand id');
  const root = options.repoRoot ?? repoRoot;
  const brandDir = resolve(root, 'brands', brandId);
  const manifestPath = resolve(brandDir, 'brand.json');
  if (!existsSync(manifestPath)) {
    throw new Error(`Brand manifest not found: ${manifestPath}`);
  }

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (!isRecord(manifest)) {
    throw new Error(`${manifestPath} must contain a JSON object`);
  }
  if (manifest.schemaVersion !== 5) {
    throw new Error(`${manifestPath}: schemaVersion must be 5`);
  }
  if (manifest.id !== brandId) {
    throw new Error(
      `${manifestPath}: id must equal directory name "${brandId}"`,
    );
  }

  validateIdentifier(manifest.id, 'id');
  validateIdentifier(manifest.internalName, 'internalName');
  validateIdentifier(manifest.cliName, 'cliName');
  validateDisplayString(manifest.displayName, 'displayName');
  assertString(manifest.description, 'description');
  assertString(manifest.author, 'author');
  validateDisplayString(manifest.serverDisplayName, 'serverDisplayName');
  validateBundleId(manifest.appId, 'appId');
  if (manifest.linux !== undefined) {
    if (!isRecord(manifest.linux))
      throw new Error('linux must be an object when provided');
    const email = manifest.linux.maintainerEmail;
    if (
      typeof email !== 'string' ||
      email !== email.trim() ||
      Array.from(email).some((character) => {
        const code = character.charCodeAt(0);
        return code < 32 || (code >= 127 && code <= 159);
      }) ||
      !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(email)
    ) {
      throw new Error(
        'linux.maintainerEmail must be a trimmed email address without control characters',
      );
    }
  }
  const theme = normalizeTheme(manifest.theme);

  if (!isRecord(manifest.storage)) throw new Error('storage is required');
  if (!isRecord(manifest.storage.dataDirNames)) {
    throw new Error('storage.dataDirNames is required');
  }
  if (!isRecord(manifest.storage.secureDataDirNames)) {
    throw new Error('storage.secureDataDirNames is required');
  }
  assertArrayOfStrings(
    manifest.storage.dataDirNames.prod,
    'storage.dataDirNames.prod',
  );
  assertArrayOfStrings(
    manifest.storage.dataDirNames.dev,
    'storage.dataDirNames.dev',
  );
  const rcDataDirNames =
    manifest.storage.dataDirNames.rc ?? manifest.storage.dataDirNames.dev;
  assertArrayOfStrings(rcDataDirNames, 'storage.dataDirNames.rc');
  assertDirectoryName(
    manifest.storage.secureDataDirNames.prod,
    'storage.secureDataDirNames.prod',
  );
  assertDirectoryName(
    manifest.storage.secureDataDirNames.dev,
    'storage.secureDataDirNames.dev',
  );
  const rcSecureDataDirName =
    manifest.storage.secureDataDirNames.rc ??
    manifest.storage.secureDataDirNames.dev;
  assertDirectoryName(rcSecureDataDirName, 'storage.secureDataDirNames.rc');
  assertDirectoryName(
    manifest.storage.secureDataDirNames.internal,
    'storage.secureDataDirNames.internal',
  );
  const internalSecureDataDirName =
    manifest.storage.secureDataDirNames.internal.trim();
  const internalSecureDataDirKey = directoryCollisionKey(
    internalSecureDataDirName,
  );
  if (
    [
      manifest.storage.secureDataDirNames.prod.trim(),
      rcSecureDataDirName.trim(),
      manifest.storage.secureDataDirNames.dev.trim(),
    ]
      .map(directoryCollisionKey)
      .includes(internalSecureDataDirKey)
  ) {
    throw new Error(
      'storage.secureDataDirNames.internal must be unique across secure storage modes',
    );
  }
  if (
    [
      ...manifest.storage.dataDirNames.prod,
      ...rcDataDirNames,
      ...manifest.storage.dataDirNames.dev,
    ]
      .map(directoryCollisionKey)
      .includes(internalSecureDataDirKey)
  ) {
    throw new Error(
      'storage.secureDataDirNames.internal must not match an ordinary data directory',
    );
  }
  const buildDataDirNames = manifest.storage.buildDataDirNames ?? {
    stable: manifest.storage.dataDirNames.prod[0],
    internal: `${manifest.storage.dataDirNames.prod[0]}-internal`,
    rc: rcDataDirNames[0],
    dev: manifest.storage.dataDirNames.dev[0],
  };
  if (!isRecord(buildDataDirNames))
    throw new Error('storage.buildDataDirNames is required');
  for (const build of ['stable', 'internal', 'rc', 'dev']) {
    assertDirectoryName(
      buildDataDirNames[build],
      `storage.buildDataDirNames.${build}`,
    );
  }
  if (
    new Set(Object.values(buildDataDirNames).map(directoryCollisionKey))
      .size !== 4
  ) {
    throw new Error(
      'storage.buildDataDirNames must be distinct for every build',
    );
  }
  assertArrayOfStrings(
    manifest.storage.configFileNames,
    'storage.configFileNames',
  );
  assertArrayOfStrings(
    manifest.storage.projectConfigDirNames,
    'storage.projectConfigDirNames',
  );

  if (!isRecord(manifest.environment))
    throw new Error('environment is required');
  assertArrayOfStrings(manifest.environment.prefixes, 'environment.prefixes');
  for (const prefix of manifest.environment.prefixes) {
    validateEnvPrefix(prefix, 'environment.prefixes[]');
  }

  if (!isRecord(manifest.tools)) throw new Error('tools is required');
  validateIdentifier(manifest.tools.namespace, 'tools.namespace');

  if (!isRecord(manifest.desktopIntegration)) {
    throw new Error('desktopIntegration is required');
  }
  const routePrefix = manifest.desktopIntegration.routePrefix;
  assertString(routePrefix, 'desktopIntegration.routePrefix');
  if (
    !routePrefix.startsWith('/') ||
    (routePrefix.length > 1 && routePrefix.endsWith('/'))
  ) {
    throw new Error(
      'desktopIntegration.routePrefix must start with "/" and have no trailing slash',
    );
  }
  assertString(
    manifest.desktopIntegration.tokenHeaderName,
    'desktopIntegration.tokenHeaderName',
  );
  validateEnvPrefix(
    manifest.desktopIntegration.tokenEnvVar,
    'desktopIntegration.tokenEnvVar',
  );

  if (!isRecord(manifest.dictation)) throw new Error('dictation is required');
  validateIdentifier(manifest.dictation.binaryName, 'dictation.binaryName');
  validateBundleId(manifest.dictation.bundleId, 'dictation.bundleId');
  validateDisplayString(
    manifest.dictation.displayName,
    'dictation.displayName',
  );

  if (manifest.copilot !== undefined) {
    if (!isRecord(manifest.copilot)) {
      throw new Error('copilot must be an object when provided');
    }
    assertString(
      manifest.copilot.gitHubAppClientId,
      'copilot.gitHubAppClientId',
    );
  }

  if (!isRecord(manifest.web)) throw new Error('web is required');
  validateIdentifier(manifest.web.apiNamespace, 'web.apiNamespace');
  validateIdentifier(manifest.web.wellKnownNamespace, 'web.wellKnownNamespace');
  assertString(manifest.web.title, 'web.title');
  assertString(manifest.web.description, 'web.description');

  if (manifest.web.mobileApps !== undefined) {
    if (!isRecord(manifest.web.mobileApps)) {
      throw new Error('web.mobileApps must be an object when provided');
    }
    const { appStoreUrl, playStoreUrl } = manifest.web.mobileApps;
    for (const [label, value] of [
      ['web.mobileApps.appStoreUrl', appStoreUrl],
      ['web.mobileApps.playStoreUrl', playStoreUrl],
    ]) {
      if (value === undefined) continue;
      if (typeof value !== 'string' || !value.startsWith('https://')) {
        throw new Error(`${label} must be an https:// URL`);
      }
    }
    if (appStoreUrl === undefined && playStoreUrl === undefined) {
      throw new Error('web.mobileApps must declare at least one store URL');
    }
    validateAndroidAppLinks(manifest.web.mobileApps);
  }

  // Contact addresses (CAN-7958). Optional and additive like copyrightHolder;
  // outside `marketing` because Terms and Privacy render without it.
  for (const field of ['supportEmail', 'legalEmail', 'privacyEmail']) {
    const value = manifest.web[field];
    if (value === undefined) continue;
    if (typeof value !== 'string' || !EMAIL_ADDRESS_PATTERN.test(value)) {
      throw new Error(`web.${field} must be an email address when provided`);
    }
  }
  if (manifest.web.demoUrl !== undefined) {
    validateHttpsUrl(manifest.web.demoUrl, 'web.demoUrl');
  }

  let normalizedMarketing;
  if (manifest.web.marketing !== undefined) {
    if (!isRecord(manifest.web.marketing)) {
      throw new Error('web.marketing must be an object when provided');
    }
    const marketing = manifest.web.marketing;
    for (const field of ['demoUrl', 'chatUrl', 'legacySiteOrigin']) {
      validateHttpsUrl(marketing[field], `web.marketing.${field}`);
    }

    // Footer copyright entity. Brand-owned so no marketing surface hard-codes a
    // company name; the year itself is rendered dynamically, never stored here.
    //
    // OPTIONAL, defaulted from displayName — the same treatment shortName gets.
    // Making it required would have invalidated every existing schema-v4
    // marketing pack written before the field existed, which is precisely what
    // a BrandSchemaVersion bump is for. There is nothing for a migration to do
    // here (displayName is always present and is the right credit line for a
    // brand that never stated otherwise), so the field is additive and v4 stays
    // honest. A value that IS declared must still be a real string.
    if (marketing.copyrightHolder !== undefined) {
      assertString(marketing.copyrightHolder, 'web.marketing.copyrightHolder');
    }
    const copyrightHolder = marketing.copyrightHolder ?? manifest.displayName;

    if (!Array.isArray(marketing.footerLinkGroups)) {
      throw new Error('web.marketing.footerLinkGroups must be an array');
    }
    marketing.footerLinkGroups.forEach((group, groupIndex) => {
      const label = `web.marketing.footerLinkGroups[${groupIndex}]`;
      if (!isRecord(group)) throw new Error(`${label} must be an object`);
      assertString(group.heading, `${label}.heading`);
      if (!Array.isArray(group.links)) {
        throw new Error(`${label}.links must be an array`);
      }
      group.links.forEach((link, linkIndex) => {
        validateMarketingLink(link, `${label}.links[${linkIndex}]`);
      });
      // Link keys are namespaced by their group heading, so the same label may
      // legitimately appear in two different groups — only within one group is
      // it a collision.
      assertNoDuplicateStrings(
        group.links.map((link) => link.label),
        `${label}.links[].label`,
      );
    });
    assertNoDuplicateStrings(
      marketing.footerLinkGroups.map((group) => group.heading),
      'web.marketing.footerLinkGroups[].heading',
    );

    for (const field of ['footerUtilityLinks', 'socialLinks']) {
      const links = marketing[field];
      if (!Array.isArray(links)) {
        throw new Error(`web.marketing.${field} must be an array`);
      }
      links.forEach((link, linkIndex) => {
        validateMarketingLink(link, `web.marketing.${field}[${linkIndex}]`, {
          httpsOnly: true,
        });
      });
      assertNoDuplicateStrings(
        links.map((link) => link.label),
        `web.marketing.${field}[].label`,
      );
    }

    // The marketing footer renders `socialLinks` as an appended group with this
    // exact heading rather than storing it as a normal group (the rest of the
    // app wants the social links on their own). That makes the heading a
    // reserved word for any brand that ships social links: declaring it too
    // would render two `Connect` columns under one React key. Scoped to the
    // colliding case — with no social links nothing is appended and the heading
    // is the brand's to use.
    if (marketing.socialLinks.length > 0) {
      const conflictIndex = marketing.footerLinkGroups.findIndex(
        (group) => group.heading === SYNTHESIZED_SOCIAL_GROUP_HEADING,
      );
      if (conflictIndex !== -1) {
        throw new Error(
          `web.marketing.footerLinkGroups[${conflictIndex}].heading must not be "${SYNTHESIZED_SOCIAL_GROUP_HEADING}" when web.marketing.socialLinks is non-empty: the footer appends its own "${SYNTHESIZED_SOCIAL_GROUP_HEADING}" group for those links`,
        );
      }
    }

    // Public client source. OPTIONAL and additive like copyrightHolder: an
    // omitted field hides every open-source surface. The license must look like
    // an SPDX identifier so the web's SPDX license URL is always well formed.
    if (marketing.sourceRepository !== undefined) {
      const sourceRepository = marketing.sourceRepository;
      if (!isRecord(sourceRepository)) {
        throw new Error(
          'web.marketing.sourceRepository must be an object when provided',
        );
      }
      validateHttpsUrl(
        sourceRepository.url,
        'web.marketing.sourceRepository.url',
      );
      // The web parses this with `new URL()` at render time to derive the fork
      // command, so a value that is only https-prefixed must fail the build.
      if (!URL.canParse(sourceRepository.url)) {
        throw new Error(
          'web.marketing.sourceRepository.url must be a valid URL',
        );
      }
      if (
        typeof sourceRepository.license !== 'string' ||
        !SPDX_LICENSE_ID_PATTERN.test(sourceRepository.license)
      ) {
        throw new Error(
          'web.marketing.sourceRepository.license must be an SPDX license identifier',
        );
      }
      // The marketing footer appends a link with this exact label to the
      // Connect group and keys it by label. Keep in sync with
      // SOURCE_CODE_FOOTER_LABEL in apps/web/src/lib/marketing-surface.ts.
      const conflictIndex = marketing.socialLinks.findIndex(
        (link) => link.label === SOURCE_CODE_FOOTER_LABEL,
      );
      if (conflictIndex !== -1) {
        throw new Error(
          `web.marketing.socialLinks[${conflictIndex}].label must not be "${SOURCE_CODE_FOOTER_LABEL}" when web.marketing.sourceRepository is declared: the footer appends its own "${SOURCE_CODE_FOOTER_LABEL}" link`,
        );
      }
    }

    // Canonical marketing origin (CAN-7958). Optional and additive: without
    // it nothing redirects to a marketing apex and the support silo uses the
    // request origin. A value must be a bare https origin.
    if (marketing.canonicalOrigin !== undefined) {
      validateHttpsUrl(
        marketing.canonicalOrigin,
        'web.marketing.canonicalOrigin',
      );
      if (
        !URL.canParse(marketing.canonicalOrigin) ||
        new URL(marketing.canonicalOrigin).origin !== marketing.canonicalOrigin
      ) {
        throw new Error(
          'web.marketing.canonicalOrigin must be an https origin with no path or trailing slash',
        );
      }
    }
    if (
      marketing.homebrewCask !== undefined &&
      (typeof marketing.homebrewCask !== 'string' ||
        !HOMEBREW_CASK_PATTERN.test(marketing.homebrewCask))
    ) {
      throw new Error(
        'web.marketing.homebrewCask must name a cask as <owner>/<tap>/<cask>',
      );
    }

    normalizedMarketing = { ...marketing, copyrightHolder };
  }

  if (!isRecord(manifest.release)) throw new Error('release is required');
  validateReleaseEnabled(manifest.release.enabled);
  validateIdentifier(manifest.release.artifactPrefix, 'release.artifactPrefix');

  if (!isRecord(manifest.assets)) throw new Error('assets is required');
  const assets = {
    logoSvg: manifest.assets.logoSvg,
    ...(manifest.assets.wordmarkSvg === undefined
      ? {}
      : { wordmarkSvg: manifest.assets.wordmarkSvg }),
    appIconPng: manifest.assets.appIconPng,
    macIconIcns: manifest.assets.macIconIcns,
    windowsIconIco: manifest.assets.windowsIconIco,
    linuxIconDir: manifest.assets.linuxIconDir,
    webIconPng: manifest.assets.webIconPng ?? manifest.assets.appIconPng,
  };
  const resolvedAssets = {
    logoSvg: resolveAssetPath(brandDir, assets.logoSvg, 'assets.logoSvg'),
    wordmarkSvg: resolveOptionalAssetPath(
      brandDir,
      assets.wordmarkSvg,
      'assets.wordmarkSvg',
    ),
    appIconPng: resolveAssetPath(
      brandDir,
      assets.appIconPng,
      'assets.appIconPng',
    ),
    macIconIcns: resolveOptionalAssetPath(
      brandDir,
      assets.macIconIcns,
      'assets.macIconIcns',
    ),
    windowsIconIco: resolveOptionalAssetPath(
      brandDir,
      assets.windowsIconIco,
      'assets.windowsIconIco',
    ),
    linuxIconDir: resolveOptionalAssetPath(
      brandDir,
      assets.linuxIconDir,
      'assets.linuxIconDir',
    ),
    webIconPng: resolveAssetPath(
      brandDir,
      assets.webIconPng,
      'assets.webIconPng',
    ),
  };
  if (
    resolvedAssets.linuxIconDir !== undefined &&
    !statSync(resolvedAssets.linuxIconDir).isDirectory()
  ) {
    throw new Error(
      `assets.linuxIconDir must be a directory: ${resolvedAssets.linuxIconDir}`,
    );
  }
  validateLogoSvgSafety(manifest.id, resolvedAssets.logoSvg, 'assets.logoSvg');
  if (resolvedAssets.wordmarkSvg !== undefined) {
    validateLogoSvgSafety(
      manifest.id,
      resolvedAssets.wordmarkSvg,
      'assets.wordmarkSvg',
    );
  }

  return {
    ...manifest,
    shortName: manifest.shortName ?? manifest.displayName,
    theme,
    storage: {
      buildDataDirNames: Object.fromEntries(
        Object.entries(buildDataDirNames).map(([build, name]) => [
          build,
          name.trim(),
        ]),
      ),
      dataDirNames: {
        prod: normalizeArray(
          manifest.storage.dataDirNames.prod,
          'storage.dataDirNames.prod',
        ),
        rc: normalizeArray(rcDataDirNames, 'storage.dataDirNames.rc'),
        dev: normalizeArray(
          manifest.storage.dataDirNames.dev,
          'storage.dataDirNames.dev',
        ),
      },
      secureDataDirNames: {
        prod: manifest.storage.secureDataDirNames.prod.trim(),
        rc: rcSecureDataDirName.trim(),
        internal: internalSecureDataDirName,
        dev: manifest.storage.secureDataDirNames.dev.trim(),
      },
      configFileNames: normalizeArray(
        manifest.storage.configFileNames,
        'storage.configFileNames',
      ),
      projectConfigDirNames: normalizeArray(
        manifest.storage.projectConfigDirNames,
        'storage.projectConfigDirNames',
      ),
    },
    environment: {
      prefixes: normalizeArray(
        manifest.environment.prefixes,
        'environment.prefixes',
      ),
    },
    web: {
      ...manifest.web,
      hostnames: normalizeHostnames(manifest.web.hostnames),
      // Only re-key `marketing` when the brand declares one, so brands without
      // a marketing surface keep `web.marketing === undefined` rather than
      // gaining an explicit `undefined` property.
      ...(normalizedMarketing === undefined
        ? {}
        : { marketing: normalizedMarketing }),
    },
    assets,
    __paths: {
      brandDir,
      manifestPath,
      ...resolvedAssets,
    },
  };
}

export function listBrandIds(options = {}) {
  const root = options.repoRoot ?? repoRoot;
  const brandsDir = resolve(root, 'brands');
  if (!existsSync(brandsDir)) return [];
  return readdirSync(brandsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

if (isCliEntrypoint(import.meta.url)) {
  const brandId = process.argv[2] ?? process.env.CANOPY_BRAND ?? 'canopy';
  const brand = loadBrand(brandId);
  delete brand.__paths;
  process.stdout.write(`${JSON.stringify(brand, null, 2)}\n`);
}

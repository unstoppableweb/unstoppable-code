import Color from 'colorjs.io';
import {
  CHART_CATEGORICAL_PRIMITIVES,
  evaluateChartPalette,
} from './chart-palette.mjs';
import {
  generatedCategoricalTokenNames,
  generatedChartCategoricalTokenNames,
  generatedIntentPrimitiveAliases,
  generatedSemanticTokenNames as engineSemanticTokenNames,
} from './color-engine.generated.mjs';
import {
  SWATCH_POLICY,
  swatchDistance,
  swatchLightness,
} from './swatch-palette.mjs';

const INTENT_FAMILIES = [
  'accent',
  'destructive',
  'attention',
  'positive',
  'special',
];

// Engine color strings round sRGB channels and alpha for output. Allow the
// resulting sub-hundredth contrast drift when rechecking those serialized
// values in the Canopy adapter.
const SERIALIZED_CONTRAST_EPSILON = 0.005;
const SOLID_CONTROL_CONTRAST_RATIO = 4.5;

const EMPHASIS_FOREGROUND_BINDING = Object.freeze({
  kind: 'literal',
  srgb: '#FFFFFF',
  displayP3: 'color(display-p3 1 1 1)',
  alpha: 1,
});

const INTENT_PRIMITIVE_FAMILIES = Object.freeze({
  accent: 'accent',
  ...generatedIntentPrimitiveAliases,
});

const ENGINE_ON_FOREGROUND_TOKENS = new Set(
  engineSemanticTokenNames.filter((tokenName) =>
    tokenName.startsWith('fg-on-'),
  ),
);

const SURFACE_SHADOW_RING_TOKENS = new Set(
  ['xs', 'sm', 'md', 'lg', 'xl'].map((size) => `shadow-surface-${size}`),
);

// The engine aims tertiary text at 3.4:1 and intent inks at 3:1. Canopy holds
// text to WCAG AA, including on the hover, selection and popover fills that
// rows sit on. Light-mode intent inks keep the engine target: small text uses
// the -strong inks below instead (docs/design/colors.md).
const TEXT_CONTRAST_RATIO = 4.5;
const PAGE_SURFACES = ['surface-base', 'surface-primary', 'surface-secondary'];
const STRONG_INKS = Object.freeze({
  'fg-accent-strong': 'accent',
  'fg-success-strong': 'positive',
  'fg-warning-strong': 'attention',
  'fg-destructive-strong': 'destructive',
  'fg-special-strong': 'special',
});
// Light strong inks never get paler than the step they first shipped with.
const LIGHT_STRONG_INK_MIN_STEP = 600;
// Info is not an engine intent: it uses the blue scale at the steps fg-blue
// uses, and its tint is the ink at 16% (bg-info-subtle in canopy-tokens-core.css).
const INFO_INK_STEP = Object.freeze({ light: 600, dark: 300 });
const INFO_TINT_ALPHA = 0.16;

// Engine tokens nothing in Canopy reads. The engine draws them from a fixed
// blue, so in a green-accent theme they would not match the accent anyway.
const UNUSED_ENGINE_TOKENS = new Set([
  'glow-accent-hover',
  'glow-accent-pressed',
  'shadow-button-accent',
  '_checkbox-shadow-checked',
  '_radio-shadow-checked',
]);

export const generatedSemanticTokenNames = Object.freeze([
  ...engineSemanticTokenNames
    .filter(
      (tokenName) =>
        !ENGINE_ON_FOREGROUND_TOKENS.has(tokenName) &&
        !UNUSED_ENGINE_TOKENS.has(tokenName),
    )
    .map(canonicalSemanticTokenName),
  ...Object.keys(STRONG_INKS),
  'fg-info',
]);

export function canonicalSemanticTokenName(engineName) {
  return engineName.startsWith('surface-')
    ? `bg-${engineName.slice('surface-'.length)}`
    : engineName;
}

function primitiveFamilyNamesForToken(tokenName, primitiveScales) {
  for (const family of INTENT_FAMILIES) {
    if (tokenName.endsWith(`-${family}`) || tokenName.includes(`-${family}-`)) {
      return [INTENT_PRIMITIVE_FAMILIES[family]];
    }
  }
  if (tokenName === 'chart-negative') {
    return [INTENT_PRIMITIVE_FAMILIES.destructive];
  }
  if (tokenName === 'chart-info') {
    return [INTENT_PRIMITIVE_FAMILIES.special];
  }
  if (
    tokenName.startsWith('categorical-') ||
    tokenName.startsWith('chart-categorical-')
  ) {
    return Object.keys(primitiveScales).filter((name) => name !== 'neutral');
  }
  return [];
}

function displayP3Value(value) {
  return new Color(value).to('p3').toString({ precision: 6 });
}

// The engine builds each scale at one hue in wide gamut, then clips it to
// sRGB, which can turn the sRGB hue far enough that one scale reads as two
// colors (cyan 950 looks blue). Past this spread, Canopy maps the wide-gamut
// stops into sRGB by lowering chroma only, so sRGB keeps the P3 hue.
const SCALE_HUE_SPREAD_LIMIT = 20;
// Stops paler than this have no reliable hue after 8-bit rounding.
const SCALE_HUE_MIN_CHROMA = 0.04;

function srgbHueSpread(stops) {
  const hues = stops
    .map((stop) => new Color(stop.hex).to('oklch').coords)
    .filter(([, chroma]) => chroma > SCALE_HUE_MIN_CHROMA)
    .map(([, , hue]) => hue);
  if (hues.length < 2) return 0;
  const reference = hues[Math.floor(hues.length / 2)];
  const offsets = hues.map((hue) => ((hue - reference + 540) % 360) - 180);
  return Math.max(...offsets) - Math.min(...offsets);
}

function srgbStopKeepingHue(stop) {
  const color = new Color(stop.wideGamutCss).toGamut({
    space: 'srgb',
    method: 'oklch.c',
  });
  const srgb = color
    .to('srgb')
    .toString({ format: 'hex', collapse: false })
    .toUpperCase();
  return { srgb, oklch: new Color(srgb).to('oklch').toString() };
}

function buildPrimitives(theme) {
  const primitives = {};
  for (const [family, stops] of Object.entries(theme.debug.primitiveScales)) {
    if (family === 'neutral') continue;
    const keepHue = srgbHueSpread(stops) > SCALE_HUE_SPREAD_LIMIT;
    for (const stop of stops) {
      const srgb = keepHue
        ? srgbStopKeepingHue(stop)
        : { srgb: stop.hex, oklch: stop.oklchCss };
      primitives[`${family}-${stop.step}`] = {
        srgb: srgb.srgb,
        displayP3: displayP3Value(stop.wideGamutCss),
        oklch: srgb.oklch,
      };
    }
  }
  return primitives;
}

function candidatesForToken(
  tokenName,
  metadata,
  theme,
  primitives,
  { darkAccentTone = 0 } = {},
) {
  const families = primitiveFamilyNamesForToken(
    tokenName,
    theme.debug.primitiveScales,
  );
  const target = new Color(metadata.oklchCss);
  const isIntentRole = INTENT_FAMILIES.some(
    (family) =>
      tokenName.endsWith(`-${family}`) || tokenName.includes(`-${family}-`),
  );
  const usesBrightDarkSolids = theme.mode === 'dark' && darkAccentTone > 0;
  const requestedLightness =
    usesBrightDarkSolids && isIntentRole ? darkAccentTone : null;
  return Object.entries(primitives)
    .filter(([name]) =>
      families.some(
        (family) => name === family || name.startsWith(`${family}-`),
      ),
    )
    .map(([primitive, value]) => ({
      kind: 'primitive',
      primitive,
      alpha: metadata.oklch.alpha,
      delta:
        requestedLightness === null
          ? target.deltaEOK(new Color(value.oklch))
          : Math.abs(
              new Color(value.oklch).to('oklch').coords[0] - requestedLightness,
            ),
    }))
    .sort((left, right) => left.delta - right.delta);
}

function colorWithAlpha(value, alpha, gamut = 'srgb') {
  const color = new Color(value).to(gamut === 'displayP3' ? 'p3' : 'srgb');
  const roundedAlpha = Math.round(alpha * 1000) / 1000;
  if (gamut === 'displayP3') {
    const channel = (number) =>
      Math.round(Math.max(0, Math.min(1, number)) * 1e6) / 1e6;
    return `color(display-p3 ${color.coords.map(channel).join(' ')} / ${roundedAlpha})`;
  }
  const channel = (number) =>
    Math.round(Math.max(0, Math.min(1, number)) * 255);
  return `rgba(${color.coords.map(channel).join(', ')}, ${roundedAlpha})`;
}

function bindingValue(binding, primitives, gamut = 'srgb') {
  if (binding.kind === 'literal') {
    return gamut === 'displayP3' ? binding.displayP3 : binding.srgb;
  }
  const primitive = primitives[binding.primitive];
  const value = gamut === 'displayP3' ? primitive.displayP3 : primitive.srgb;
  return binding.alpha < 1
    ? colorWithAlpha(value, binding.alpha, gamut)
    : value;
}

function compositeOver(value, background) {
  const foreground = new Color(value).to('srgb');
  const base = new Color(background).to('srgb');
  const alpha = foreground.alpha ?? 1;
  if (alpha >= 1) return foreground;
  return new Color(
    'srgb',
    foreground.coords.map(
      (channel, index) => channel * alpha + base.coords[index] * (1 - alpha),
    ),
  );
}

function contrastRatio(foreground, background) {
  const fg = new Color(foreground).to('srgb');
  const bg = new Color(background).to('srgb');
  const [lighter, darker] = [fg.luminance, bg.luminance].sort(
    (left, right) => right - left,
  );
  return (lighter + 0.05) / (darker + 0.05);
}

function cssBindingValue(binding, gamut = 'srgb') {
  if (binding.kind === 'literal') {
    return gamut === 'displayP3' ? binding.displayP3 : binding.srgb;
  }
  const reference = `var(--primitive-${binding.primitive})`;
  if (binding.alpha >= 1) return reference;
  const interpolationSpace = gamut === 'displayP3' ? 'display-p3' : 'srgb';
  return `color-mix(in ${interpolationSpace}, ${reference} ${Math.round(binding.alpha * 1000) / 10}%, transparent)`;
}

function canonicalizeEngineCssReferences(value) {
  return value.replace(
    /var\(--color-([^)]+)\)/g,
    (_match, tokenName) => `var(--${canonicalSemanticTokenName(tokenName)})`,
  );
}

// Dark floating surfaces (menus, popovers, dialogs) sit on near-black chrome
// where the engine's grey perimeter disappears. Light them from the top and
// outline them in black so the edge reads on both the sidebar and the canvas.
const DARK_FLOATING_SHADOW_TOKEN = 'shadow-surface-xl';
const DARK_FLOATING_SHADOW_EDGE =
  'inset 0 .5px 0 0 #ffffff38, inset 0 0 0 .5px #ffffff1a, 0 0 0 .5px #00000099, ';

function applyDarkFloatingShadowPolicy(value) {
  const elevationLayers = value.replace(
    /^inset 0 0 0 \.5px (?:[\w-]+\([^)]*\)|[^,]+), 0 0 0 \.5px (?:[\w-]+\([^)]*\)|[^,]+), /,
    '',
  );
  if (elevationLayers === value) {
    throw new Error(
      `Unexpected ${DARK_FLOATING_SHADOW_TOKEN} format: ${value}`,
    );
  }
  return `${DARK_FLOATING_SHADOW_EDGE}${elevationLayers}`;
}

// Black drop layers vanish on dark fills, and the engine's warm-grey ring takes
// on the tint of whatever sits behind it. Dark in-page surfaces (raised cards)
// wear one neutral white ring instead, the same edge the floating policy uses.
const DARK_IN_PAGE_SHADOW = 'inset 0 0 0 .5px #ffffff1a';

function applyCanopyShadowPolicy(tokenName, value, mode) {
  if (!SURFACE_SHADOW_RING_TOKENS.has(tokenName)) return value;
  const halfPixelRings = value
    .replaceAll('inset 0px 0px 0px 1px', 'inset 0px 0px 0px 0.5px')
    .replaceAll('0px 0px 0px 1px', '0px 0px 0px 0.5px');
  if (mode !== 'dark') return halfPixelRings;
  return tokenName === DARK_FLOATING_SHADOW_TOKEN
    ? applyDarkFloatingShadowPolicy(halfPixelRings)
    : DARK_IN_PAGE_SHADOW;
}

function applyTooltipShadowPolicy(value, lineColor) {
  const elevationLayers = value.replace(
    /^0 0 0 \.5px [^,]+, inset 0 0 0 \.5px [^,]+, /,
    '',
  );
  if (elevationLayers === value) {
    throw new Error(`Unexpected shadow-tooltip format: ${value}`);
  }
  return `0 0 0 0.5px ${lineColor}, ${elevationLayers}`;
}

function literalBindingForToken(theme, tokenName, metadata) {
  return {
    kind: 'literal',
    srgb: applyCanopyShadowPolicy(
      tokenName,
      theme.tokens[tokenName],
      theme.mode,
    ),
    displayP3: applyCanopyShadowPolicy(
      tokenName,
      canonicalizeEngineCssReferences(
        theme.displayP3CssVariables[`--color-${tokenName}`] ??
          theme.tokens[tokenName],
      ),
      theme.mode,
    ),
    alpha: metadata?.oklch.alpha ?? 1,
  };
}

function engineTokenValue(tokenName, bindings, primitives) {
  const binding = bindings[tokenName];
  const value = bindingValue(binding, primitives);
  if ((binding.alpha ?? 1) >= 1) return value;
  return compositeOver(
    value,
    bindingValue(bindings['surface-base'], primitives),
  );
}

function constraintsBySubject(theme) {
  const constraints = new Map();
  for (const item of theme.contrastReport) {
    const list = constraints.get(item.foreground) ?? [];
    list.push({
      background: item.background,
      requiredRatio: item.requiredRatio,
    });
    constraints.set(item.foreground, list);
  }
  for (const item of theme.nonTextContrastReport) {
    const list = constraints.get(item.subject) ?? [];
    list.push({
      background: item.background,
      requiredRatio: item.requiredRatio,
    });
    constraints.set(item.subject, list);
  }
  return constraints;
}

const SHARED_INTENT_ENGINE_TOKENS = new Set(
  INTENT_FAMILIES.flatMap((family) => [
    `surface-${family}`,
    `surface-${family}-muted`,
    `fg-${family}`,
    `line-${family}`,
  ]),
);

function resolveSharedIntentBindings({
  bindings,
  candidateMap,
  engineConstraints,
  emphasisConstraints,
  primitives,
}) {
  for (const family of INTENT_FAMILIES) {
    const solidToken = `surface-${family}`;
    const sharedTokenNames = [
      `surface-${family}-muted`,
      `fg-${family}`,
      `line-${family}`,
    ];
    const sourceCandidates = candidateMap.get(`fg-${family}`) ?? [];
    const solidCandidates = candidateMap.get(solidToken) ?? [];
    const solidEmphasisConstraints = emphasisConstraints.filter(
      ({ background }) => background === solidToken,
    );
    let resolved = false;
    for (const source of sourceCandidates) {
      const nextBindings = { ...bindings };
      for (const tokenName of sharedTokenNames) {
        nextBindings[tokenName] = {
          ...source,
          alpha: bindings[tokenName].alpha,
        };
      }
      const rolesPass = sharedTokenNames.every((tokenName) =>
        candidatePasses(
          tokenName,
          nextBindings[tokenName],
          engineConstraints.get(tokenName) ?? [],
          nextBindings,
          primitives,
        ),
      );
      if (!rolesPass) continue;

      const solid = solidCandidates.find(
        (candidate) =>
          candidatePasses(
            solidToken,
            candidate,
            engineConstraints.get(solidToken) ?? [],
            nextBindings,
            primitives,
          ) &&
          candidatePasses(
            'fg-emphasis',
            nextBindings['fg-emphasis'],
            solidEmphasisConstraints,
            { ...nextBindings, [solidToken]: candidate },
            primitives,
          ),
      );
      if (!solid) continue;

      Object.assign(bindings, nextBindings, { [solidToken]: solid });
      resolved = true;
      break;
    }
    if (!resolved) {
      throw new Error(`${family} has no accessible shared primitive binding`);
    }
  }
}

/**
 * Replace a swatch that repeats an earlier one, per the swatch policy. The
 * replacement must pass the swatch's own contrast constraints.
 */
function resolveDistinctSwatches({
  bindings,
  candidateMap,
  engineConstraints,
  primitives,
}) {
  const value = (tokenName) =>
    engineTokenValue(tokenName, bindings, primitives);
  generatedCategoricalTokenNames.forEach((tokenName, index) => {
    const current = value(tokenName);
    const repeats = generatedCategoricalTokenNames
      .slice(0, index)
      .some(
        (earlier) =>
          swatchDistance(value(earlier), current) <
          SWATCH_POLICY.duplicateDistance,
      );
    if (!repeats) return;
    const others = generatedCategoricalTokenNames.filter(
      (other) => other !== tokenName,
    );
    const lightness = swatchLightness(current);
    const familiesInUse = new Set(
      others.map((other) => bindings[other]?.primitive?.split('-')[0]),
    );
    for (const family of SWATCH_POLICY.replacementFamilies) {
      if (familiesInUse.has(family)) continue;
      // The step nearest the replaced swatch's lightness that clears the
      // others, so the swatches keep an even weight.
      let best = null;
      for (const candidate of candidateMap.get(tokenName) ?? []) {
        if (!candidate.primitive?.startsWith(`${family}-`)) continue;
        const candidateValue = bindingValue(candidate, primitives);
        const shift = Math.abs(swatchLightness(candidateValue) - lightness);
        if (shift > SWATCH_POLICY.lightnessTolerance) continue;
        const distance = Math.min(
          ...others.map((other) =>
            swatchDistance(value(other), candidateValue),
          ),
        );
        if (distance < SWATCH_POLICY.replacementDistance) continue;
        if (
          !candidatePasses(
            tokenName,
            candidate,
            engineConstraints.get(tokenName) ?? [],
            bindings,
            primitives,
          )
        ) {
          continue;
        }
        if (!best || shift < best.shift) best = { candidate, shift };
      }
      if (best) {
        bindings[tokenName] = best.candidate;
        return;
      }
    }
    throw new Error(
      `${tokenName} repeats an earlier swatch and no replacement family clears the others`,
    );
  });
}

function candidatePasses(
  tokenName,
  candidate,
  constraints,
  bindings,
  primitives,
) {
  const nextBindings = { ...bindings, [tokenName]: candidate };
  const foreground = engineTokenValue(tokenName, nextBindings, primitives);
  return constraints.every(({ background, requiredRatio }) => {
    const backgroundValue = engineTokenValue(
      background,
      nextBindings,
      primitives,
    );
    return (
      contrastRatio(foreground, backgroundValue) +
        SERIALIZED_CONTRAST_EPSILON >=
      requiredRatio
    );
  });
}

function clearsText(foreground, backgrounds) {
  return backgrounds.every(
    (background) =>
      contrastRatio(foreground, background) >= TEXT_CONTRAST_RATIO,
  );
}

function textBackgrounds(bindings, primitives) {
  const value = (tokenName) => bindingValue(bindings[tokenName], primitives);
  const over = (tokenName, under) =>
    compositeOver(value(tokenName), value(under));
  const pages = PAGE_SURFACES.map(value);
  return {
    pages,
    // Page hover, selected row, and hover inside a card or popover.
    rows: [
      ...pages,
      over('surface-muted', 'surface-base'),
      over('surface-selected', 'surface-base'),
      over('surface-subtle', 'surface-secondary'),
    ],
    neutralBadge: over('surface-muted', 'surface-secondary'),
    tint: (tokenName) => [
      over(tokenName, 'surface-base'),
      over(tokenName, 'surface-secondary'),
    ],
  };
}

// Neutral inks are engine literals, not scale steps: move lightness only,
// keeping chroma and hue, until the ink clears every background.
function literalInkClearing(binding, backgrounds, mode) {
  const [lightness, chroma, hue] = new Color(binding.srgb).to('oklch').coords;
  const direction = mode === 'dark' ? 1 : -1;
  for (let step = 0; step <= 400; step += 1) {
    const candidate = new Color('oklch', [
      Math.max(0, Math.min(1, lightness + direction * step * 0.0025)),
      chroma,
      Number.isNaN(hue) ? 0 : hue,
    ])
      .toGamut({ space: 'srgb', method: 'oklch.c' })
      .to('srgb')
      .toString({ format: 'hex', collapse: false })
      .toUpperCase();
    if (clearsText(candidate, backgrounds)) {
      return {
        kind: 'literal',
        srgb: candidate,
        displayP3: displayP3Value(candidate),
        alpha: 1,
      };
    }
  }
  throw new Error(`No lightness clears ${TEXT_CONTRAST_RATIO}:1`);
}

function applyNeutralInkPolicy(bindings, primitives, mode) {
  const backgrounds = textBackgrounds(bindings, primitives);
  const required = {
    'fg-primary': [...backgrounds.rows, backgrounds.neutralBadge],
    'fg-secondary': [...backgrounds.rows, backgrounds.neutralBadge],
    'fg-tertiary': backgrounds.rows,
  };
  for (const [tokenName, list] of Object.entries(required)) {
    const binding = bindings[tokenName];
    if (clearsText(bindingValue(binding, primitives), list)) continue;
    bindings[tokenName] = literalInkClearing(binding, list, mode);
  }
}

function stepOf(primitiveName) {
  return Number(primitiveName.slice(primitiveName.lastIndexOf('-') + 1));
}

// Walk a scale from startStep toward more contrast; return the first step
// whose ink clears every background backgroundsFor() names for it.
function firstClearingStep(
  primitives,
  family,
  startStep,
  mode,
  backgroundsFor,
) {
  const steps = Object.keys(primitives)
    .filter((name) => name.startsWith(`${family}-`))
    .map(stepOf)
    .sort((left, right) => left - right);
  const ordered =
    mode === 'light'
      ? steps.filter((step) => step >= startStep)
      : steps.filter((step) => step <= startStep).reverse();
  for (const step of ordered) {
    const name = `${family}-${step}`;
    if (clearsText(primitives[name].srgb, backgroundsFor(primitives[name])))
      return name;
  }
  throw new Error(
    `${family} has no step from ${startStep} that clears ${TEXT_CONTRAST_RATIO}:1`,
  );
}

// Inks for small text and for text on intent tints, solved per theme.
function resolveTextInks(bindings, primitives, mode) {
  const backgrounds = textBackgrounds(bindings, primitives);
  const inks = {};
  for (const [tokenName, family] of Object.entries(STRONG_INKS)) {
    const ink = bindings[`fg-${family}`];
    const startStep =
      mode === 'light'
        ? Math.max(stepOf(ink.primitive), LIGHT_STRONG_INK_MIN_STEP)
        : stepOf(ink.primitive);
    const list = [
      ...backgrounds.pages,
      ...backgrounds.tint(`surface-${family}-muted`),
    ];
    inks[tokenName] = firstClearingStep(
      primitives,
      INTENT_PRIMITIVE_FAMILIES[family],
      startStep,
      mode,
      () => list,
    );
  }
  const base = backgrounds.pages[0];
  const card = backgrounds.pages[2];
  inks['fg-info'] = firstClearingStep(
    primitives,
    'blue',
    INFO_INK_STEP[mode],
    mode,
    (primitive) => {
      const tint = colorWithAlpha(primitive.srgb, INFO_TINT_ALPHA);
      return [
        ...backgrounds.pages,
        compositeOver(tint, base),
        compositeOver(tint, card),
      ];
    },
  );
  return inks;
}

export function buildThemeTokenGraph(theme, radius, options = {}) {
  const primitives = buildPrimitives(theme);
  const metadataByToken = new Map(
    theme.debug.colorMetadata.map((metadata) => [metadata.token, metadata]),
  );
  const candidateMap = new Map();
  const bindings = {};

  for (const tokenName of engineSemanticTokenNames) {
    const metadata = metadataByToken.get(tokenName);
    const families = primitiveFamilyNamesForToken(
      tokenName,
      theme.debug.primitiveScales,
    );
    if (!metadata || families.length === 0) {
      bindings[tokenName] = literalBindingForToken(theme, tokenName, metadata);
      continue;
    }
    const candidates = candidatesForToken(
      tokenName,
      metadata,
      theme,
      primitives,
      options,
    );
    if (candidates.length === 0) {
      throw new Error(`${tokenName} has no chromatic primitive candidates`);
    }
    candidateMap.set(tokenName, candidates);
    bindings[tokenName] = candidates[0];
  }

  const emphasisConstraints = theme.contrastReport
    .filter(
      ({ foreground }) =>
        ENGINE_ON_FOREGROUND_TOKENS.has(foreground) &&
        foreground !== 'fg-on-inverse',
    )
    .map(({ background, requiredRatio }) => ({
      background,
      requiredRatio: Math.max(requiredRatio, SOLID_CONTROL_CONTRAST_RATIO),
    }));
  // Solid intent controls use white content in the UI Kit. Feed that fixed
  // foreground into the solver so it can choose accessible surface primitives
  // instead of overwriting a validated foreground after resolution.
  const emphasisCandidates = [EMPHASIS_FOREGROUND_BINDING];

  let emphasisResolved = false;
  for (const emphasisCandidate of emphasisCandidates) {
    const nextBindings = {
      ...bindings,
      'fg-emphasis': emphasisCandidate,
    };
    let allBackgroundsResolved = true;

    for (const { background, requiredRatio } of emphasisConstraints) {
      const candidates = candidateMap.get(background) ?? [bindings[background]];
      const candidate = candidates.find((entry) =>
        candidatePasses(
          'fg-emphasis',
          emphasisCandidate,
          [{ background, requiredRatio }],
          { ...nextBindings, [background]: entry },
          primitives,
        ),
      );
      if (!candidate) {
        allBackgroundsResolved = false;
        break;
      }
      nextBindings[background] = candidate;
    }

    if (
      allBackgroundsResolved &&
      candidatePasses(
        'fg-emphasis',
        emphasisCandidate,
        emphasisConstraints,
        nextBindings,
        primitives,
      )
    ) {
      Object.assign(bindings, nextBindings);
      emphasisResolved = true;
      break;
    }
  }
  if (!emphasisResolved) {
    throw new Error('fg-emphasis has no accessible derived neutral binding');
  }

  const engineConstraints = constraintsBySubject(theme);
  if (theme.mode === 'dark') {
    for (const family of INTENT_FAMILIES) {
      const tokenName = `fg-${family}`;
      engineConstraints.set(tokenName, [
        ...(engineConstraints.get(tokenName) ?? []),
        ...PAGE_SURFACES.map((background) => ({
          background,
          requiredRatio: TEXT_CONTRAST_RATIO,
        })),
      ]);
    }
  }
  for (const [tokenName, constraints] of engineConstraints) {
    if (
      tokenName === 'fg-emphasis' ||
      ENGINE_ON_FOREGROUND_TOKENS.has(tokenName) ||
      SHARED_INTENT_ENGINE_TOKENS.has(tokenName)
    ) {
      continue;
    }
    const candidates = candidateMap.get(tokenName);
    if (!candidates) continue;
    const candidate = candidates.find((entry) =>
      candidatePasses(tokenName, entry, constraints, bindings, primitives),
    );
    if (!candidate) {
      throw new Error(`${tokenName} has no accessible primitive binding`);
    }
    bindings[tokenName] = candidate;
  }

  // UI-Kit defines each intent's surface, foreground, muted fill, and line
  // from one shared color. Resolve those roles as a group when snapping to a
  // canonical primitive so the alias relationship and every contrast rule
  // survive together; only the role-specific alpha may differ.
  resolveSharedIntentBindings({
    bindings,
    candidateMap,
    engineConstraints,
    emphasisConstraints,
    primitives,
  });

  // UI-Kit repeats a swatch hue in themes whose accent matches a status hue.
  resolveDistinctSwatches({
    bindings,
    candidateMap,
    engineConstraints,
    primitives,
  });

  applyNeutralInkPolicy(bindings, primitives, theme.mode);

  const failures = [];
  for (const [tokenName, constraints] of engineConstraints) {
    if (
      tokenName === 'fg-emphasis' ||
      ENGINE_ON_FOREGROUND_TOKENS.has(tokenName) ||
      SHARED_INTENT_ENGINE_TOKENS.has(tokenName)
    ) {
      continue;
    }
    if (
      !candidatePasses(
        tokenName,
        bindings[tokenName],
        constraints,
        bindings,
        primitives,
      )
    ) {
      failures.push(tokenName);
    }
  }
  if (
    !candidatePasses(
      'fg-emphasis',
      bindings['fg-emphasis'],
      emphasisConstraints,
      bindings,
      primitives,
    )
  ) {
    failures.push('fg-emphasis');
  }
  if (failures.length > 0) {
    throw new Error(
      `Primitive bindings failed contrast: ${failures.join(', ')}`,
    );
  }

  const semantic = {};
  const displayP3 = {};
  const cssBindings = {};
  const displayP3CssBindings = {};
  for (const tokenName of engineSemanticTokenNames) {
    if (
      ENGINE_ON_FOREGROUND_TOKENS.has(tokenName) ||
      UNUSED_ENGINE_TOKENS.has(tokenName)
    )
      continue;
    const canonicalName = canonicalSemanticTokenName(tokenName);
    const semanticValue = bindingValue(bindings[tokenName], primitives);
    const displayP3Value = bindingValue(
      bindings[tokenName],
      primitives,
      'displayP3',
    );
    const cssBinding = cssBindingValue(bindings[tokenName]);
    const displayP3CssBinding = cssBindingValue(
      bindings[tokenName],
      'displayP3',
    );
    if (tokenName === 'shadow-tooltip') {
      semantic[canonicalName] = applyTooltipShadowPolicy(
        semanticValue,
        bindingValue(bindings['line-primary'], primitives),
      );
      displayP3[canonicalName] = applyTooltipShadowPolicy(
        displayP3Value,
        bindingValue(bindings['line-primary'], primitives, 'displayP3'),
      );
      cssBindings[canonicalName] = applyTooltipShadowPolicy(
        cssBinding,
        'var(--line-primary)',
      );
      displayP3CssBindings[canonicalName] = applyTooltipShadowPolicy(
        displayP3CssBinding,
        'var(--line-primary)',
      );
      continue;
    }
    semantic[canonicalName] = semanticValue;
    displayP3[canonicalName] = displayP3Value;
    cssBindings[canonicalName] = cssBinding;
    displayP3CssBindings[canonicalName] = displayP3CssBinding;
  }
  // UI-Kit aliases the chart series to `categorical-*`, which repeats hues
  // in some themes. Canopy binds them to a fixed, checked set of primitives.
  const chartPrimitives = CHART_CATEGORICAL_PRIMITIVES[theme.mode];
  generatedChartCategoricalTokenNames.forEach((chartName, index) => {
    const primitiveName = chartPrimitives[index];
    const primitive = primitives[primitiveName];
    if (!primitive) {
      throw new Error(`${chartName} has no primitive ${primitiveName}`);
    }
    const reference = `var(${primitiveCssVariableName(primitiveName)})`;
    semantic[chartName] = primitive.srgb;
    displayP3[chartName] = primitive.displayP3;
    cssBindings[chartName] = reference;
    displayP3CssBindings[chartName] = reference;
  });
  for (const [tokenName, primitiveName] of Object.entries(
    resolveTextInks(bindings, primitives, theme.mode),
  )) {
    const reference = `var(${primitiveCssVariableName(primitiveName)})`;
    semantic[tokenName] = primitives[primitiveName].srgb;
    displayP3[tokenName] = primitives[primitiveName].displayP3;
    cssBindings[tokenName] = reference;
    displayP3CssBindings[tokenName] = reference;
  }
  const chartPalette = evaluateChartPalette(
    generatedChartCategoricalTokenNames.map((name) => semantic[name]),
    semantic['bg-base'],
    theme.mode,
  );
  if (chartPalette.failures.length > 0) {
    throw new Error(
      `Chart palette failed in ${theme.mode}: ${chartPalette.failures.join('; ')}`,
    );
  }
  return {
    primitives,
    semantic,
    displayP3,
    cssBindings,
    displayP3CssBindings,
    radius,
  };
}

export function primitiveCssVariableName(name) {
  return `--primitive-${name}`;
}

export function semanticCssVariableName(name) {
  return `--${name}`;
}

export function buildPrimitiveCssDeclarations(
  primitives,
  gamut = 'srgb',
  indent = '  ',
) {
  return Object.entries(primitives)
    .map(
      ([name, value]) =>
        `${indent}${primitiveCssVariableName(name)}: ${value[gamut]};`,
    )
    .join('\n');
}

export function buildCanonicalSemanticCssDeclarations(
  cssBindings,
  indent = '  ',
) {
  return Object.entries(cssBindings)
    .map(
      ([name, value]) => `${indent}${semanticCssVariableName(name)}: ${value};`,
    )
    .join('\n');
}

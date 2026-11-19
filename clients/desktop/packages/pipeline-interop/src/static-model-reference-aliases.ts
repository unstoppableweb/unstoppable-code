/**
 * Built-in `$` model aliases a pipeline step or hook may name instead of a
 * model id. Pipeline normalization and hook model resolution share them
 * through `resolvePipelineModelAlias` and its lenient variant.
 *
 * Its own module, not a root package.json field: browser bundles that
 * normalize pipelines would otherwise ship the whole root manifest.
 */
export const STATIC_MODEL_REFERENCE_ALIASES: Readonly<Record<string, string>> =
  {
    '$default-codex': 'gpt-6.2-sol',
    $fast: 'gpt-6-luna',
    $cheap: 'sonnet',
    $sol: 'gpt-6.2-sol',
    $luna: 'gpt-6-luna',
    $opus: 'opus[1m]',
    $fable: 'claude-fable-5-1',
    $astra: 'gpt-6.2-astra',
    $terra: 'gpt-6.1-terra',
  };

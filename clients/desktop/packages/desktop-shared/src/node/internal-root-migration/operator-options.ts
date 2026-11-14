import { isAbsolute, resolve } from 'node:path';

export function selectInternalRootArchiveAbandonments(
  requested: readonly string[],
  frozen?: readonly string[],
  kind = 'Archive',
): readonly string[] {
  if (frozen === undefined) return requested;
  const names = [...new Set(frozen)];
  if (
    requested.length &&
    (requested.length !== names.length ||
      requested.some((name) => !names.includes(name)))
  )
    throw new Error(
      `${kind} abandonment is already frozen by the existing apply. Preserve both roots; inventory and resume must use all original opt-ins (${names.join(', ') || 'none'}) or no abandonment flags.`,
    );
  return names;
}

export function parseInternalRootMigrationOptions(args: readonly string[]): {
  readonly brandId: 'canopy' | 'unstoppable-code';
  readonly apply: boolean;
  readonly declareInternal: boolean;
  readonly rebuild: boolean;
  readonly restart: boolean;
  readonly skipMigration: boolean;
  readonly copyClaudeTranscripts: boolean;
  readonly claudeConfigDirs: readonly string[];
  readonly repairPipelineRecords: boolean;
  readonly repairFileTabs: boolean;
  readonly sourceDirectory?: string;
  readonly abandonArchives: readonly string[];
  readonly abandonCommits: readonly number[];
  readonly abandonCheckouts: readonly string[];
} {
  const abandonArchives: string[] = [];
  const commitNames: string[] = [];
  const abandonCheckouts: string[] = [];
  const remaining: string[] = [];
  const claudeConfigDirs: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg?.startsWith('--claude-config-dir=')) {
      claudeConfigDirs.push(arg.slice('--claude-config-dir='.length));
    } else if (arg === '--abandon-commit') {
      commitNames.push(args[++i] ?? '');
    } else if (arg?.startsWith('--abandon-commit=')) {
      commitNames.push(arg.slice('--abandon-commit='.length));
    } else if (arg === '--abandon-checkout') {
      abandonCheckouts.push(args[++i] ?? '');
    } else if (arg?.startsWith('--abandon-checkout=')) {
      abandonCheckouts.push(arg.slice('--abandon-checkout='.length));
    } else if (arg === '--abandon-archive') {
      abandonArchives.push(args[++i] ?? '');
    } else if (arg?.startsWith('--abandon-archive=')) {
      abandonArchives.push(arg.slice('--abandon-archive='.length));
    } else if (arg !== undefined) remaining.push(arg);
  }
  args = remaining;
  const allowed = [
    '--brand=canopy',
    '--brand=unstoppable-code',
    '--apply',
    '--declare-internal',
    '--inventory',
    '--rebuild',
    '--restart',
    '--skip-migration',
    '--copy-claude-transcripts',
    '--repair-pipeline-records',
    '--repair-file-tabs',
  ];
  const sources = args.filter((arg) => arg.startsWith('--source-dir='));
  const skipMigration = args.includes('--skip-migration');
  const copyClaudeTranscripts = args.includes('--copy-claude-transcripts');
  const repairFileTabs = args.includes('--repair-file-tabs');
  if (
    claudeConfigDirs.some(
      (directory) => !isAbsolute(directory) || resolve(directory) !== directory,
    ) ||
    (copyClaudeTranscripts &&
      (args.includes('--repair-pipeline-records') ||
        repairFileTabs ||
        commitNames.length > 0 ||
        abandonArchives.length > 0 ||
        abandonCheckouts.length > 0 ||
        args.some((arg) =>
          [
            '--apply',
            '--inventory',
            '--rebuild',
            '--restart',
            '--skip-migration',
            '--declare-internal',
          ].includes(arg),
        ))) ||
    commitNames.some(
      (name) =>
        !/^[1-9][0-9]*$/.test(name) || !Number.isSafeInteger(Number(name)),
    ) ||
    new Set(commitNames).size !== commitNames.length ||
    abandonCheckouts.some(
      (path) => !isAbsolute(path) || resolve(path) !== path,
    ) ||
    new Set(abandonCheckouts).size !== abandonCheckouts.length ||
    abandonArchives.some(
      (name) => !/^[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/.test(name),
    ) ||
    new Set(abandonArchives).size !== abandonArchives.length ||
    args.some(
      (arg) => !allowed.includes(arg) && !arg.startsWith('--source-dir='),
    ) ||
    new Set(args).size !== args.length ||
    args.filter((arg) => arg.startsWith('--brand=')).length !== 1 ||
    sources.length > 1 ||
    sources.some((arg) => arg === '--source-dir=') ||
    (skipMigration &&
      (claudeConfigDirs.length > 0 ||
        commitNames.length > 0 ||
        abandonArchives.length > 0 ||
        abandonCheckouts.length > 0 ||
        sources.length > 0 ||
        args.some((arg) =>
          [
            '--apply',
            '--inventory',
            '--rebuild',
            '--restart',
            '--declare-internal',
          ].includes(arg),
        ))) ||
    (args.includes('--repair-pipeline-records') &&
      (claudeConfigDirs.length > 0 ||
        commitNames.length > 0 ||
        abandonArchives.length > 0 ||
        abandonCheckouts.length > 0 ||
        args.some((arg) =>
          [
            '--apply',
            '--inventory',
            '--rebuild',
            '--restart',
            '--declare-internal',
            '--skip-migration',
            '--repair-file-tabs',
          ].includes(arg),
        ))) ||
    (repairFileTabs &&
      (claudeConfigDirs.length > 0 ||
        commitNames.length > 0 ||
        abandonArchives.length > 0 ||
        abandonCheckouts.length > 0 ||
        args.some((arg) =>
          [
            '--apply',
            '--inventory',
            '--rebuild',
            '--restart',
            '--declare-internal',
            '--skip-migration',
            '--repair-pipeline-records',
          ].includes(arg),
        ))) ||
    (args.includes('--apply') && args.includes('--inventory')) ||
    (args.includes('--rebuild') && !args.includes('--apply')) ||
    (args.includes('--restart') &&
      (!args.includes('--apply') || args.includes('--rebuild')))
  )
    throw new Error(
      'Usage: node --import tsx apps/desktop-app/scripts/internal-root-migration.ts --brand=canopy|unstoppable-code [--inventory | --apply | --skip-migration | --copy-claude-transcripts | --repair-pipeline-records | --repair-file-tabs] [--claude-config-dir=<absolute-directory>]... [--source-dir=<absolute-directory>] [--declare-internal] [--rebuild | --restart] [--abandon-archive <workspace/worktree>]... [--abandon-commit <id>]... [--abandon-checkout <absolute-path>]...',
    );
  return {
    brandId: args.includes('--brand=canopy') ? 'canopy' : 'unstoppable-code',
    apply: args.includes('--apply'),
    declareInternal: args.includes('--declare-internal'),
    rebuild: args.includes('--rebuild'),
    restart: args.includes('--restart'),
    skipMigration,
    copyClaudeTranscripts,
    claudeConfigDirs,
    repairPipelineRecords: args.includes('--repair-pipeline-records'),
    repairFileTabs,
    abandonArchives,
    abandonCommits: commitNames.map(Number),
    abandonCheckouts,
    ...(sources[0] === undefined
      ? {}
      : { sourceDirectory: sources[0].slice('--source-dir='.length) }),
  };
}

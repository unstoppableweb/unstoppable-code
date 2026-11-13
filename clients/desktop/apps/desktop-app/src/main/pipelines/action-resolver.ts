import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { isPathInside } from '../lib/path-safety';
import type { ExecutionRuntime } from '@canopy/execution-engine/node/pipelines/executor/types';
import type {
  ActionDefinition,
  ActionInputDef,
  ActionOutputDef,
  ActionRuns,
  HostActionNodeFallback,
  Step,
} from '@canopy/execution-engine/types/pipeline';
import { parseLogFormatHint } from '@canopy/execution-engine/types/pipeline';
import { normalizeActionScopes } from '@canopy/execution-engine/pipelines/scope';
import * as configPathsModule from './config-paths';

const ACTION_FILE_NAME = 'action.yml';

export interface ResolvedActionRuntime {
  definition: ActionDefinition;
  actionDir: string;
  manifestPath: string;
  mainPath?: string;
}

function loadConfigPaths(): typeof configPathsModule {
  // Static import: this module is only ever loaded in the Electron main
  // process (the desktop-shared executor uses its own action-resolver), so the
  // path helpers can be bundled directly. A dynamic `require('./config-paths')`
  // does not resolve from the bundled `out/main/index.js`.
  return configPathsModule;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isStep(value: unknown): value is Step {
  return isRecord(value);
}

function isActionInputDef(value: unknown): value is ActionInputDef {
  return isRecord(value);
}

function isActionOutputDef(value: unknown): value is ActionOutputDef {
  return isRecord(value);
}

function isActionInputs(
  value: unknown,
): value is Record<string, ActionInputDef> {
  return isRecord(value) && Object.values(value).every(isActionInputDef);
}

function isActionOutputs(
  value: unknown,
): value is Record<string, ActionOutputDef> {
  return isRecord(value) && Object.values(value).every(isActionOutputDef);
}

function parseOptionalDescription(
  value: unknown,
  filePath: string,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new Error(`Action "${filePath}" has an invalid description`);
  }
  return value;
}

function parseActionInputs(
  value: unknown,
  filePath: string,
): Record<string, ActionInputDef> | undefined {
  if (value === undefined) return undefined;
  if (!isActionInputs(value)) {
    throw new Error(`Action "${filePath}" has invalid inputs`);
  }
  return value;
}

function parseActionOutputs(
  value: unknown,
  filePath: string,
): Record<string, ActionOutputDef> | undefined {
  if (value === undefined) return undefined;
  if (!isActionOutputs(value)) {
    throw new Error(`Action "${filePath}" has invalid outputs`);
  }
  return value;
}

function parseCompositeSteps(steps: unknown, filePath: string): Step[] {
  if (!Array.isArray(steps)) {
    throw new Error(
      `Composite action "${filePath}" requires an array of runs.steps`,
    );
  }

  return steps.map((step, index) => {
    if (!step || typeof step !== 'object' || Array.isArray(step)) {
      throw new Error(
        `Composite action "${filePath}" has an invalid step at index ${index}`,
      );
    }
    if (!isStep(step)) {
      throw new Error(
        `Composite action "${filePath}" has an invalid step at index ${index}`,
      );
    }
    return step;
  });
}

function parseActionRuns(
  runs: unknown,
  filePath: string,
  bundled: boolean,
): ActionRuns {
  if (!isRecord(runs)) {
    throw new Error(`Invalid action runs block in ${filePath}`);
  }

  const using = runs.using;
  switch (using) {
    case 'node':
    case 'python':
    case 'tsx': {
      const main = runs.main;
      if (typeof main !== 'string' || !main.trim()) {
        throw new Error(`Action "${filePath}" requires a non-empty runs.main`);
      }
      return { using, main };
    }
    case 'composite': {
      const steps = parseCompositeSteps(runs.steps, filePath);
      return { using, steps };
    }
    case 'pipeline':
      return { using };
    case 'host': {
      if (!bundled) {
        throw new Error(
          `Action "${filePath}" uses runs.using "host", which only bundled actions may use`,
        );
      }
      if (runs.fallback === undefined) {
        return { using };
      }
      return { using, fallback: parseHostFallback(runs.fallback, filePath) };
    }
    default:
      throw new Error(`Unsupported action runtime in ${filePath}`);
  }
}

function parseHostFallback(
  fallback: unknown,
  filePath: string,
): HostActionNodeFallback {
  if (!isRecord(fallback) || fallback.using !== 'node') {
    throw new Error(
      `Action "${filePath}" runs.fallback must declare using "node"`,
    );
  }
  const main = fallback.main;
  if (typeof main !== 'string' || !main.trim()) {
    throw new Error(
      `Action "${filePath}" requires a non-empty runs.fallback.main`,
    );
  }
  return { using: 'node', main };
}

function parseActionDefinition(
  raw: string,
  filePath: string,
  options: { bundled: boolean },
): ActionDefinition {
  const parsed = yaml.load(raw, { schema: yaml.JSON_SCHEMA });
  if (!isRecord(parsed)) {
    throw new Error(`Invalid action definition in ${filePath}`);
  }

  const name = parsed.name;
  if (typeof name !== 'string' || !name.trim()) {
    throw new Error(`Action "${filePath}" is missing a valid name`);
  }
  const description = parseOptionalDescription(parsed.description, filePath);
  const inputs = parseActionInputs(parsed.inputs, filePath);
  const outputs = parseActionOutputs(parsed.outputs, filePath);

  return {
    name,
    ...(description !== undefined ? { description } : {}),
    scopes: normalizeActionScopes(parsed.scope, `Action "${filePath}"`),
    ...(parsed.log_format_hint !== undefined
      ? {
          log_format_hint: parseLogFormatHint(
            parsed.log_format_hint,
            `Action "${filePath}"`,
          ),
        }
      : {}),
    ...(inputs !== undefined ? { inputs } : {}),
    ...(outputs !== undefined ? { outputs } : {}),
    runs: parseActionRuns(parsed.runs, filePath, options.bundled),
  };
}

function resolveActionManifestPath(
  usesRef: string,
  runtime: Pick<
    ExecutionRuntime,
    | 'bundledActionsDir'
    | 'getProjectActionsDir'
    | 'getProjectActionsDirCandidates'
  >,
  repoPath?: string,
): { actionDir: string; manifestPath: string; bundled: boolean } {
  const [scope, ...pathParts] = usesRef.split('/');
  const actionPath = pathParts.join('/').trim();
  if (!scope || !actionPath) {
    throw new Error(`Invalid action reference "${usesRef}"`);
  }

  if (scope === 'builtin') {
    const actionDir = path.resolve(runtime.bundledActionsDir, actionPath);
    const manifestPath = path.resolve(actionDir, ACTION_FILE_NAME);
    if (
      !isPathInside(runtime.bundledActionsDir, actionDir) ||
      !isPathInside(runtime.bundledActionsDir, manifestPath)
    ) {
      throw new Error(`Unsafe builtin action reference "${usesRef}"`);
    }
    // Only `builtin/*` refs load from the bundled actions directory.
    return { actionDir, manifestPath, bundled: true };
  }

  if (scope === 'project') {
    if (!repoPath) {
      throw new Error(
        `A repoPath is required to resolve project action "${usesRef}"`,
      );
    }
    const projectActionsDirs = runtime.getProjectActionsDirCandidates?.(
      repoPath,
    ) ?? [runtime.getProjectActionsDir(repoPath)];
    let firstCandidate:
      | { actionDir: string; manifestPath: string; bundled: boolean }
      | undefined;

    for (const projectActionsDir of projectActionsDirs) {
      const actionDir = path.resolve(projectActionsDir, actionPath);
      const manifestPath = path.resolve(actionDir, ACTION_FILE_NAME);
      if (
        !isPathInside(projectActionsDir, actionDir) ||
        !isPathInside(projectActionsDir, manifestPath)
      ) {
        throw new Error(`Unsafe project action reference "${usesRef}"`);
      }
      firstCandidate ??= { actionDir, manifestPath, bundled: false };
      if (fs.existsSync(manifestPath)) {
        return { actionDir, manifestPath, bundled: false };
      }
    }

    if (firstCandidate) {
      return firstCandidate;
    }

    throw new Error(`No project action roots are configured`);
  }

  throw new Error(`Unsupported action scope "${scope}" in "${usesRef}"`);
}

function getActionFilePath(
  usesRef: string,
  repoPath?: string,
): { manifestPath: string; bundled: boolean } {
  const {
    getBundledActionsDir,
    getProjectActionsDir,
    getProjectActionsDirCandidates,
  } = loadConfigPaths();
  return resolveActionManifestPath(
    usesRef,
    {
      bundledActionsDir: getBundledActionsDir(),
      getProjectActionsDir,
      getProjectActionsDirCandidates,
    },
    repoPath,
  );
}

export function resolveAction(
  usesRef: string,
  repoPath?: string,
): ActionDefinition | null {
  const { manifestPath: filePath, bundled } = getActionFilePath(
    usesRef,
    repoPath,
  );
  if (!fs.existsSync(filePath)) {
    return null;
  }

  const raw = fs.readFileSync(filePath, 'utf-8');
  return parseActionDefinition(raw, filePath, { bundled });
}

/**
 * Read the raw, on-disk `action.yml` text for a builtin action by name (no
 * parsing). The name may include the `builtin/` scope prefix or omit it. Path
 * resolution reuses `getActionFilePath` so the same safety checks apply.
 * Returns null when the action does not exist.
 */
export function readBuiltinActionRawManifest(
  actionName: string,
): string | null {
  const normalized = actionName
    .trim()
    .replace(/^builtin\//i, '')
    .trim();
  if (!normalized) {
    return null;
  }
  let filePath: string;
  try {
    filePath = getActionFilePath(`builtin/${normalized}`).manifestPath;
  } catch {
    // Unsafe / malformed reference (e.g. path traversal) — treat as not found.
    return null;
  }
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return fs.readFileSync(filePath, 'utf-8');
}

export function resolveActionRuntime(
  usesRef: string,
  runtime: Pick<
    ExecutionRuntime,
    | 'bundledActionsDir'
    | 'getProjectActionsDir'
    | 'getProjectActionsDirCandidates'
  >,
  repoPath?: string,
): ResolvedActionRuntime | null {
  const { actionDir, manifestPath, bundled } = resolveActionManifestPath(
    usesRef,
    runtime,
    repoPath,
  );

  if (!fs.existsSync(manifestPath)) {
    return null;
  }

  const raw = fs.readFileSync(manifestPath, 'utf-8');
  const definition = parseActionDefinition(raw, manifestPath, { bundled });
  let mainPath: string | undefined;

  switch (definition.runs.using) {
    case 'node':
    case 'python':
    case 'tsx':
      mainPath = path.resolve(actionDir, definition.runs.main);
      if (!isPathInside(actionDir, mainPath)) {
        throw new Error(
          `Action "${usesRef}" has an unsafe runs.main "${definition.runs.main}"`,
        );
      }
      break;
    case 'host':
      if (definition.runs.fallback) {
        mainPath = path.resolve(actionDir, definition.runs.fallback.main);
        if (!isPathInside(actionDir, mainPath)) {
          throw new Error(
            `Action "${usesRef}" has an unsafe runs.main "${definition.runs.fallback.main}"`,
          );
        }
      }
      break;
    case 'composite':
    case 'pipeline':
      break;
  }

  return {
    definition,
    actionDir,
    manifestPath,
    mainPath,
  };
}

export function listBuiltinActions(): string[] {
  const { getBundledActionsDir } = loadConfigPaths();
  const actionsDir = getBundledActionsDir();
  if (!fs.existsSync(actionsDir)) {
    return [];
  }

  return fs
    .readdirSync(actionsDir)
    .filter((entry) => {
      const fullPath = path.join(actionsDir, entry);
      return (
        fs.statSync(fullPath).isDirectory() &&
        fs.existsSync(path.join(fullPath, ACTION_FILE_NAME))
      );
    })
    .sort((left, right) => left.localeCompare(right));
}

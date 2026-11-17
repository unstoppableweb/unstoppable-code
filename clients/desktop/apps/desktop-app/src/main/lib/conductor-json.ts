import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isMissingFileError } from './fs-utils';
import { recordMetadataRead } from '@canopy/desktop-shared/node/work-counters';
import { isRecord } from './type-guards';

export interface ConductorJsonScripts {
  setup?: string;
  launch?: string;
  teardown?: string;
}

export async function readConductorJson(
  repoPath: string,
): Promise<ConductorJsonScripts | null> {
  const filePath = getConductorJsonPath(repoPath);

  try {
    recordMetadataRead('config.read.conductor');
    const raw = await readFile(filePath, 'utf8');
    return parseConductorJson(raw);
  } catch (error) {
    if (isMissingFileError(error)) {
      return null;
    }

    if (error instanceof Error) {
      throw error;
    }

    throw new Error(`Failed to read ${filePath}`);
  }
}

export function getConductorJsonPath(repoPath: string): string {
  return join(repoPath, 'conductor.json');
}

export function parseConductorJson(raw: string): ConductorJsonScripts | null {
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!isRecord(parsed) || !isRecord(parsed.scripts)) {
    return null;
  }

  const mappedScripts: ConductorJsonScripts = {};
  const setup = normalizeConductorScriptValue(parsed.scripts.setup);
  const launch = normalizeConductorScriptValue(parsed.scripts.run);
  const teardown = normalizeConductorScriptValue(parsed.scripts.archive);

  if (setup) {
    mappedScripts.setup = setup;
  }
  if (launch) {
    mappedScripts.launch = launch;
  }
  if (teardown) {
    mappedScripts.teardown = teardown;
  }

  return hasConductorScripts(mappedScripts) ? mappedScripts : null;
}

function normalizeConductorScriptValue(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function hasConductorScripts(value: ConductorJsonScripts): boolean {
  return Boolean(value.setup || value.launch || value.teardown);
}

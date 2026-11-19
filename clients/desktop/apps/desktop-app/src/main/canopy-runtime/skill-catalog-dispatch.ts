import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import { CanopyOperationError } from '@canopy/core-runtime';
import {
  CATALOG_GRANTS,
  CATALOG_SKILL_SOURCE_MAX_SKILLS,
  CatalogSkillCustomSaveParamsSchema,
  type CanopyCallerDescriptor,
  type CanopyJsonValue,
} from '@canopy/protocol/canopy-core';
import type {
  IPCResult,
  IPCResultWithAppError,
} from '@canopy/execution-engine/types/pipeline';
import type {
  FetchAvailableSkillsResponse,
  SaveCustomSkillRequest,
  SkillFileContentResponse,
  SkillFilesResponse,
  SkillUpdateProgress,
} from '@canopy/desktop-shared/types/skills';
import { refreshInvocableInventoryAfterMutation } from '../plugins/invocable-inventory-service';
import { getLockKey } from '../skills/lock-file';
import { SkillServiceResultError } from './core-skill-catalog-host';
import { getDesktopCanopyRuntime } from './desktop-runtime-access';
import { LOCAL_DESKTOP_AUTHORITY_ID } from './desktop-runtime-identity';
import { preserveRuntimeCauseError } from './runtime-cause-error';

/** Electron main acting for the desktop window's skill pages. */
export const SKILL_CATALOG_DESKTOP_CALLER: CanopyCallerDescriptor = {
  principalId: 'local-desktop-user',
  clientInstanceId: 'electron-main-skill-catalog',
  authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
  interfaceKind: 'desktop',
  grants: [CATALOG_GRANTS.read, CATALOG_GRANTS.write],
};

/** The Portal reading a skill for a paired browser. */
export const SKILL_CATALOG_PORTAL_CALLER: CanopyCallerDescriptor = {
  principalId: 'local-desktop-user',
  clientInstanceId: 'electron-main-portal',
  authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
  interfaceKind: 'portal',
  grants: [CATALOG_GRANTS.read],
};

/** True for null, strings, booleans, finite numbers, and arrays and plain objects of those. */
export function isPlainJsonValue(value: unknown): value is CanopyJsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isPlainJsonValue);
  if (typeof value !== 'object') return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Object.values(value).every(isPlainJsonValue);
}

/**
 * Today's IPC result for a core call: a service failure resolves with its
 * text, a guard throw rejects with the guard error, and a typed error without
 * a cause (schema rejection, ledger unavailable) resolves with its fixed text.
 */
async function toIpcResult<T>(
  run: () => Promise<T>,
): Promise<IPCResultWithAppError<T>> {
  try {
    return { success: true, data: await preserveRuntimeCauseError(run()) };
  } catch (error) {
    if (error instanceof SkillServiceResultError)
      return {
        success: false,
        error: error.message,
        ...(error.appError ? { appError: error.appError } : {}),
      };
    if (error instanceof CanopyOperationError)
      return { success: false, error: error.message };
    throw error;
  }
}

const keyed = (): { idempotencyKey: string } => ({
  idempotencyKey: `desktop-skill:${randomUUID()}`,
});

/** Names the wire carries; the service skips any other name, as one the source does not offer. */
const isWireSkillName = (name: string): boolean =>
  name.length > 0 && name.length <= 512;

export async function installSkillsThroughCore(
  source: string,
  skillNames: string[],
): Promise<IPCResultWithAppError<void>> {
  const names = skillNames.filter(isWireSkillName);
  if (names.length > CATALOG_SKILL_SOURCE_MAX_SKILLS)
    return {
      success: false,
      error: `Install up to ${CATALOG_SKILL_SOURCE_MAX_SKILLS.toLocaleString('en-US')} skills at a time.`,
    };
  return toIpcResult(async () => {
    const meta = keyed();
    await getDesktopCanopyRuntime().instruction(
      'core.catalog.skill.install',
      { source, skillNames: names, _meta: meta },
      { caller: SKILL_CATALOG_DESKTOP_CALLER, metadata: meta },
    );
  });
}

export function removeSkillThroughCore(
  sourceId: string,
  skillName: string,
): Promise<IPCResult<void>> {
  return toIpcResult(async () => {
    const meta = keyed();
    await getDesktopCanopyRuntime().instruction(
      'core.catalog.skill.remove',
      { skill: { sourceId, skillName }, _meta: meta },
      { caller: SKILL_CATALOG_DESKTOP_CALLER, metadata: meta },
    );
  });
}

export function updateSkillThroughCore(
  sourceId: string,
  skillName: string,
): Promise<IPCResultWithAppError<void>> {
  return toIpcResult(async () => {
    const meta = keyed();
    await getDesktopCanopyRuntime().instruction(
      'core.catalog.skill.update',
      { skill: { sourceId, skillName }, _meta: meta },
      { caller: SKILL_CATALOG_DESKTOP_CALLER, metadata: meta },
    );
  });
}

/** The record with its values typed, or null when one is not plain JSON. */
function plainJsonRecord(
  value: Record<string, unknown>,
): Record<string, CanopyJsonValue> | null {
  const record: Record<string, CanopyJsonValue> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!isPlainJsonValue(entry)) return null;
    record[key] = entry;
  }
  return record;
}

/** The save's core params without `_meta`, as the wire checks them. */
const CustomSaveRequestSchema = CatalogSkillCustomSaveParamsSchema.omit({
  _meta: true,
});

type CustomSaveRequest = z.output<typeof CustomSaveRequestSchema>;

const FIELD_REFUSALS: Readonly<Record<string, string>> = {
  name: 'Skill names can be up to 512 characters.',
  originalName: 'Skill names can be up to 512 characters.',
  description: 'Skill descriptions can be up to 65,536 characters.',
  body: 'Skill instructions can be up to 2,000,000 characters.',
};

function fileRefusal(
  request: CustomSaveRequest,
  index: PropertyKey | undefined,
  part: PropertyKey | undefined,
): string | null {
  if (index === undefined) return 'A skill can have up to 1,000 files.';
  if (part === 'path') return 'File paths can be up to 4,096 characters.';
  const file = typeof index === 'number' ? request.files?.[index] : undefined;
  return part === 'content' && file
    ? `"${file.path}" is too large. Files can be up to 2,000,000 characters.`
    : null;
}

function metadataRefusal(key: PropertyKey | undefined): string {
  return typeof key === 'string' && key.length <= 512
    ? `The "${key}" metadata value is too large to save.`
    : 'Metadata names can be up to 512 characters.';
}

/** Why a save the wire cannot carry is refused, by its first issue's field (CAN-5873 D8). */
function customSaveRefusal(
  request: CustomSaveRequest,
  path: readonly PropertyKey[],
): string {
  const [field, index, part] = path;
  const fixed = typeof field === 'string' ? FIELD_REFUSALS[field] : undefined;
  if (fixed) return fixed;
  if (field === 'files')
    return (
      fileRefusal(request, index, part) ?? 'This skill is too large to save.'
    );
  if (field === 'extraMetadata' || field === 'preservedMetadata')
    return metadataRefusal(index);
  return 'This skill is too large to save.';
}

export async function saveCustomSkillThroughCore(
  payload: SaveCustomSkillRequest,
): Promise<IPCResultWithAppError<{ name: string }>> {
  const preservedMetadata =
    payload.preservedMetadata === undefined
      ? null
      : plainJsonRecord(payload.preservedMetadata);
  const extraMetadata = payload.extraMetadata ?? null;
  const request = {
    name: payload.name ?? '',
    originalName: payload.originalName ?? null,
    description: payload.description ?? '',
    body: payload.body ?? '',
    extraMetadata,
    preservedMetadata,
    files: payload.files
      ? payload.files.map((file) => ({
          path: file.path,
          content: file.content ?? null,
        }))
      : null,
  };
  if (
    (payload.preservedMetadata !== undefined && preservedMetadata === null) ||
    !isPlainJsonValue(extraMetadata)
  ) {
    const result = await (
      await import('../skills/skill-service')
    ).saveCustomSkill(payload);
    if (result.success)
      refreshInvocableInventoryAfterMutation('skills:save-custom');
    return result;
  }
  const parsed = CustomSaveRequestSchema.safeParse(request);
  if (!parsed.success)
    return {
      success: false,
      error: customSaveRefusal(request, parsed.error.issues[0]?.path ?? []),
    };
  return toIpcResult(async () => {
    const meta = keyed();
    const result = await getDesktopCanopyRuntime().instruction(
      'core.catalog.skill.custom.save',
      { ...parsed.data, _meta: meta },
      { caller: SKILL_CATALOG_DESKTOP_CALLER, metadata: meta },
    );
    return { name: result.skillName };
  });
}

export async function checkSkillUpdatesThroughCore(
  progress: (progress: SkillUpdateProgress) => void,
): Promise<IPCResult<Record<string, boolean>>> {
  progress({
    operation: 'check-updates',
    status: 'running',
    message: 'Checking installed skills for updates...',
  });
  let result: IPCResult<Record<string, boolean>>;
  try {
    result = await toIpcResult(async () => {
      const meta = keyed();
      const runtime = getDesktopCanopyRuntime();
      await runtime.instruction(
        'core.catalog.skill.updates.check',
        { _meta: meta },
        { caller: SKILL_CATALOG_DESKTOP_CALLER, metadata: meta },
      );
      // CAN-5898: the check's result is compact, so every installed skill's
      // state (false clears an old positive) comes from the list it updated.
      const { skills } = await runtime.query(
        'core.catalog.skill.list',
        {},
        { caller: SKILL_CATALOG_DESKTOP_CALLER },
      );
      return Object.fromEntries(
        skills
          .filter((skill) => skill.origin === 'installed')
          .map((skill) => [
            getLockKey(skill.sourceId, skill.skillName),
            skill.updateAvailable,
          ]),
      );
    });
  } catch (error) {
    result = {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  if (result.success)
    progress({
      operation: 'check-updates',
      status: 'complete',
      message: 'Skill update check complete.',
      updateMap: result.data,
    });
  else
    progress({
      operation: 'check-updates',
      status: 'error',
      message: result.error ?? '',
    });
  return result;
}

export function fetchAvailableSkillsThroughCore(
  source: string,
): Promise<IPCResult<FetchAvailableSkillsResponse>> {
  return toIpcResult(async () => {
    const result = await getDesktopCanopyRuntime().query(
      'core.catalog.skill.discover',
      { source },
      { caller: SKILL_CATALOG_DESKTOP_CALLER },
    );
    return {
      source: result.source,
      skills: result.skills,
      riskInfo: result.riskInfo,
      hasMarketplace: result.hasMarketplace,
    };
  });
}

export function listSkillFilesThroughCore(
  sourceId: string,
  skillName: string,
): Promise<IPCResult<SkillFilesResponse>> {
  return toIpcResult(async () => {
    const { files, truncated } = await getDesktopCanopyRuntime().query(
      'core.catalog.skill.files.list',
      { skill: { sourceId, skillName } },
      { caller: SKILL_CATALOG_DESKTOP_CALLER },
    );
    return { files, truncated };
  });
}

export function readSkillFileThroughCore(
  sourceId: string,
  skillName: string,
  filePath: string,
): Promise<IPCResult<SkillFileContentResponse>> {
  return toIpcResult(async () => {
    const { content, truncated, binary } =
      await getDesktopCanopyRuntime().query(
        'core.catalog.skill.file.read',
        { skill: { sourceId, skillName }, filePath },
        { caller: SKILL_CATALOG_DESKTOP_CALLER },
      );
    return { content, truncated, binary };
  });
}

/** For the Portal; throws the guard error, a SkillServiceResultError or a CanopyOperationError. */
export async function readSkillContentThroughCore(
  sourceId: string,
  skillName: string,
): Promise<{
  frontmatter: Record<string, unknown>;
  body: string;
  truncated: boolean;
}> {
  const { frontmatter, body, truncated } = await preserveRuntimeCauseError(
    getDesktopCanopyRuntime().query(
      'core.catalog.skill.read',
      { skill: { sourceId, skillName } },
      { caller: SKILL_CATALOG_PORTAL_CALLER },
    ),
  );
  return { frontmatter, body, truncated };
}

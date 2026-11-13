import { createHash } from 'node:crypto';
import type { SaveCustomSkillRequest } from '@canopy/desktop-shared/types/skills';
import {
  getCustomSkillNameValidationError,
  getSkillFilePathValidationError,
} from '@canopy/desktop-shared/skill-name';
import {
  CATALOG_SKILL_REFUSAL_ERRORS,
  CatalogSkillRefusedError,
  type CatalogSkillCustomSaveRequest,
  type CatalogSkillRef,
  type CatalogSkillRefusal,
  type CoreSkillCatalogHost,
} from '@canopy/core-runtime/node/catalog';
import {
  CatalogSkillFrontmatterSchema,
  skillEntryId,
  type CanopyJsonValue,
  type CatalogSkillCloudShare,
  type CatalogSkillRow,
} from '@canopy/protocol/canopy-core';
import type { InstalledSkillInfo } from '@canopy/protocol/skills';
import type { IPCResult } from '@canopy/execution-engine/types/pipeline';
import { sanitizeName } from '../skills/installer';
import type * as SkillContext from '../skills/skill-install-context';
import type * as SkillService from '../skills/skill-service';
import { getLockKey, parseLockKey } from '../skills/lock-file';
import { deriveSourceId } from '../skills/paths';
import {
  readSkillLockSnapshot,
  skillLockEntryString,
  type SkillLockSnapshot,
} from '../skills/skill-lock-snapshot';
import { parseGitHubSource } from '../skills/source-parser';

/** A skill service `{ success: false, error }` result kept as a refusal's cause (CAN-4124 D12). */
export class SkillServiceResultError extends Error {
  override readonly name = 'SkillServiceResultError';
}

export type SkillCatalogOperation =
  | 'list'
  | 'read'
  | 'filesList'
  | 'fileRead'
  | 'discover'
  | 'install'
  | 'update'
  | 'remove'
  | 'customSave'
  | 'updatesCheck';

export interface DesktopSkillCatalogDeps {
  service: Pick<
    typeof SkillService,
    | 'loadSkills'
    | 'readRawSkill'
    | 'readSkillContent'
    | 'listSkillFiles'
    | 'readSkillFile'
    | 'fetchAvailable'
    | 'installSkills'
    | 'updateSkill'
    | 'removeSkillForContext'
    | 'saveCustomSkill'
    | 'checkUpdates'
  >;
  context: Pick<
    typeof SkillContext,
    | 'assertStoredSkillContext'
    | 'filterStoredSkillContexts'
    | 'annotateSharedSkillInstalls'
  >;
  refreshInventory: (reason: string) => void;
  readLockSnapshot: () => Promise<SkillLockSnapshot>;
}

const FAILURE_REFUSALS: Readonly<
  Record<SkillCatalogOperation, CatalogSkillRefusal>
> = {
  list: 'skills-unavailable',
  read: 'skills-unavailable',
  filesList: 'skills-unavailable',
  fileRead: 'skills-unavailable',
  discover: 'skill-discovery-failed',
  install: 'skill-install-failed',
  update: 'skill-update-failed',
  remove: 'skill-remove-failed',
  customSave: 'skill-save-failed',
  updatesCheck: 'skill-update-check-failed',
};

const failureOf = (operation: SkillCatalogOperation): CatalogSkillRefusal =>
  FAILURE_REFUSALS[operation];

const PATH_INVALID =
  /^(Invalid skill path|Invalid file path|Invalid skill name|Invalid original skill name|Skill directory is unsafe to modify|Original skill directory is unsafe to modify)\.$/;
const NOT_FOUND = [
  /^Skill ".*" not found\.$/,
  /^Skill ".*" no longer found in source\.$/,
  /^SKILL\.md not found for ".*"\.$/,
  /^Built-in skill ".*" not found\.$/,
  /^File ".*" not found\.$/,
  /^Original skill ".*" does not exist\.$/,
];

function isCustomSaveValidation(
  message: string,
  customSave: CatalogSkillCustomSaveRequest | undefined,
): boolean {
  if (customSave === undefined) return false;
  return (
    message === getCustomSkillNameValidationError(customSave.name) ||
    message === 'Skill description is required.' ||
    /^A skill can have at most \d+ files\.$/.test(message) ||
    /^Duplicate file path ".*"\.$/.test(message) ||
    /^File ".*" conflicts with a folder of the same name\.$/.test(message) ||
    (customSave.files ?? []).some(
      (file) => message === getSkillFilePathValidationError(file.path.trim()),
    )
  );
}

/** The refusal a service message names, or null (CAN-4124 D12). */
export function classifySkillServiceMessage(
  message: string,
  operation: SkillCatalogOperation,
  customSave?: CatalogSkillCustomSaveRequest,
): CatalogSkillRefusal | null {
  if (operation === 'customSave' && isCustomSaveValidation(message, customSave))
    return 'skill-invalid';
  if (/^Built-in skills cannot be (removed|updated)\.$/.test(message))
    return 'skill-read-only';
  if (PATH_INVALID.test(message)) return 'skill-path-invalid';
  if (
    message.startsWith('Skill unavailable (') &&
    !message.startsWith('Skill unavailable (local-conflict)')
  )
    return 'skill-context-refused';
  if (NOT_FOUND.some((pattern) => pattern.test(message)))
    return 'skill-not-found';
  if (/^A skill named ".*" already exists\.$/.test(message))
    return 'skill-name-taken';
  if (message.startsWith('Invalid source.')) return 'skill-source-invalid';
  return null;
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const clip = (value: string, max: number): string => value.slice(0, max);

const isPlainObject = (
  value: unknown,
): value is Record<string, CanopyJsonValue> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The frontmatter entries the read result can carry, and whether any were dropped (CAN-5873 D5). */
function wireFrontmatter(frontmatter: Record<string, CanopyJsonValue>): {
  frontmatter: Record<string, CanopyJsonValue>;
  dropped: boolean;
} {
  const kept: Record<string, CanopyJsonValue> = {};
  let dropped = false;
  for (const [key, value] of Object.entries(frontmatter)) {
    if (CatalogSkillFrontmatterSchema.safeParse({ [key]: value }).success)
      kept[key] = value;
    else dropped = true;
  }
  return { frontmatter: kept, dropped };
}

const SKILL_CONTENT_HASH = /^[a-f0-9]{64}$/;

/** The row's link to a cloud custom skill, preferring the author's own share. */
async function cloudShareOf(
  row: InstalledSkillInfo,
  readRawSkill: DesktopSkillCatalogDeps['service']['readRawSkill'],
): Promise<CatalogSkillCloudShare | undefined> {
  const link = row.remote
    ? {
        role: 'author' as const,
        remoteId: row.remote.remoteId,
        contentHash: row.remote.contentHash,
      }
    : row.installedFromShare
      ? {
          role: 'recipient' as const,
          remoteId: row.installedFromShare.remoteId,
          contentHash: row.installedFromShare.contentHash,
        }
      : undefined;
  if (link === undefined || link.remoteId === '' || link.remoteId.length > 512)
    return undefined;
  let localContentHash: string | null;
  try {
    localContentHash = createHash('sha256')
      .update(await readRawSkill(`${row.sourceId}/${row.name}`), 'utf8')
      .digest('hex');
  } catch {
    localContentHash = null;
  }
  return {
    role: link.role,
    remoteId: link.remoteId,
    linkedContentHash:
      link.contentHash !== undefined &&
      SKILL_CONTENT_HASH.test(link.contentHash)
        ? link.contentHash
        : null,
    localContentHash,
  };
}

async function loadDeps(
  overrides: Partial<DesktopSkillCatalogDeps>,
): Promise<DesktopSkillCatalogDeps> {
  return {
    service: overrides.service ?? (await import('../skills/skill-service')),
    context:
      overrides.context ?? (await import('../skills/skill-install-context')),
    refreshInventory:
      overrides.refreshInventory ??
      (await import('../plugins/invocable-inventory-service'))
        .refreshInvocableInventoryAfterMutation,
    readLockSnapshot: overrides.readLockSnapshot ?? readSkillLockSnapshot,
  };
}

const refused = (
  refusal: CatalogSkillRefusal,
  cause: unknown,
): CatalogSkillRefusedError => new CatalogSkillRefusedError(refusal, cause);

/** A `{ success: false, error }` result as a refusal with its text kept as the cause. */
function fail(
  result: { error?: string },
  operation: SkillCatalogOperation,
  customSave?: CatalogSkillCustomSaveRequest,
): CatalogSkillRefusedError {
  const fallback =
    operation === 'read'
      ? 'Skill not found.'
      : CATALOG_SKILL_REFUSAL_ERRORS[failureOf(operation)].message;
  const error = result.error ?? '';
  return refused(
    classifySkillServiceMessage(error, operation, customSave) ??
      failureOf(operation),
    new SkillServiceResultError(error || fallback),
  );
}

/** Runs a service call; a throw (they normally return results) is the operation's failure. */
async function call<T>(
  operation: SkillCatalogOperation,
  run: () => Promise<T> | T,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw refused(failureOf(operation), error);
  }
}

function succeeded<T>(
  result: IPCResult<T>,
  operation: SkillCatalogOperation,
  customSave?: CatalogSkillCustomSaveRequest,
): T | undefined {
  if (!result.success) throw fail(result, operation, customSave);
  return result.data;
}

export function createDesktopSkillCatalogHost(
  overrides: Partial<DesktopSkillCatalogDeps> = {},
): CoreSkillCatalogHost {
  let loaded: Promise<DesktopSkillCatalogDeps> | null = null;
  const deps = (): Promise<DesktopSkillCatalogDeps> =>
    (loaded ??= loadDeps(overrides));

  const guard = async (
    ref: CatalogSkillRef,
    operation: SkillCatalogOperation,
  ): Promise<DesktopSkillCatalogDeps> => {
    const resolved = await deps();
    try {
      await resolved.context.assertStoredSkillContext(
        `${ref.sourceId}/${ref.skillName}`,
      );
    } catch (error) {
      throw refused(
        classifySkillServiceMessage(messageOf(error), operation) ??
          failureOf(operation),
        error,
      );
    }
    return resolved;
  };

  return {
    async list() {
      const { service, context, readLockSnapshot } = await deps();
      const loadedRows =
        succeeded(await call('list', () => service.loadSkills()), 'list') ?? [];
      let rows: typeof loadedRows;
      try {
        rows = await context.filterStoredSkillContexts(loadedRows);
      } catch (error) {
        throw refused('skills-unavailable', error);
      }
      try {
        rows = await context.annotateSharedSkillInstalls(rows);
      } catch {
        // Without the receipts a received skill has no cloud link, so it reads
        // as not uploaded, never as ready; the list itself still answers.
      }
      const lock = await readLockSnapshot();
      return Promise.all(
        rows.slice(0, 10_000).map(async (row): Promise<CatalogSkillRow> => {
          const origin = row.builtIn
            ? 'builtin'
            : row.custom
              ? 'custom'
              : 'installed';
          const entry =
            origin === 'installed' && lock.state === 'ok'
              ? lock.entries.get(getLockKey(row.sourceId, row.name))
              : undefined;
          const hash = skillLockEntryString(entry, 'skillFolderHash');
          const cloudShare = await cloudShareOf(row, service.readRawSkill);
          return {
            entryId: skillEntryId({
              sourceId: row.sourceId,
              skillName: row.name,
            }),
            sourceId: row.sourceId,
            skillName: row.name,
            description: clip(row.description, 4096),
            source: clip(row.source, 1024),
            origin,
            installedAt: clip(row.installedAt, 64),
            updatedAt: clip(row.updatedAt, 64),
            updateAvailable: row.updateAvailable,
            version:
              entry === undefined
                ? null
                : {
                    skillFolderHash:
                      hash !== null && hash !== '' ? hash.slice(0, 128) : null,
                    skillPath: clip(
                      skillLockEntryString(entry, 'skillPath') ?? '',
                      4096,
                    ),
                  },
            ...(cloudShare === undefined ? {} : { cloudShare }),
          };
        }),
      );
    },

    async read(ref) {
      const { service } = await guard(ref, 'read');
      const data = succeeded(
        await call('read', () =>
          service.readSkillContent(ref.sourceId, ref.skillName),
        ),
        'read',
      );
      if (!data)
        throw refused(
          'skill-not-found',
          new SkillServiceResultError('Skill content unavailable.'),
        );
      const json: unknown = JSON.parse(JSON.stringify(data.frontmatter ?? {}));
      const { frontmatter, dropped } = wireFrontmatter(
        isPlainObject(json) ? json : {},
      );
      const body = clip(data.body, 2_000_000);
      return {
        frontmatter,
        body,
        truncated: dropped || body.length < data.body.length,
      };
    },

    async listFiles(ref) {
      const { service } = await guard(ref, 'filesList');
      const data = succeeded(
        await call('filesList', () =>
          service.listSkillFiles(ref.sourceId, ref.skillName),
        ),
        'filesList',
      );
      if (!data) throw refused(failureOf('filesList'), undefined);
      return { files: data.files, truncated: data.truncated };
    },

    async readFile(ref, filePath) {
      const { service } = await guard(ref, 'fileRead');
      const data = succeeded(
        await call('fileRead', () =>
          service.readSkillFile(ref.sourceId, ref.skillName, filePath),
        ),
        'fileRead',
      );
      if (!data) throw refused(failureOf('fileRead'), undefined);
      return {
        content: data.content,
        truncated: data.truncated,
        binary: data.binary,
      };
    },

    async discover(source) {
      const { service } = await deps();
      const data = succeeded(
        await call('discover', () => service.fetchAvailable(source)),
        'discover',
      );
      if (!data) throw refused(failureOf('discover'), undefined);
      return {
        source: data.source,
        skills: data.skills.slice(0, 5000).map((skill) => ({
          name: skill.name,
          description: clip(skill.description, 4096),
          sourcePath: skill.sourcePath,
        })),
        riskInfo: data.riskInfo,
        hasMarketplace: data.hasMarketplace,
        truncated: data.skills.length > 5000,
      };
    },

    async install({ source, skillNames }) {
      const { service, refreshInventory, readLockSnapshot } = await deps();
      succeeded(
        await call('install', () =>
          service.installSkills(source, [...skillNames]),
        ),
        'install',
      );
      refreshInventory('skills:install');
      const parsed = parseGitHubSource(source);
      if (parsed === null) throw refused(failureOf('install'), undefined);
      const sourceId = deriveSourceId(
        'github',
        `${parsed.owner}/${parsed.repo}`,
      );
      const names = [...new Set(skillNames.map((name) => sanitizeName(name)))];
      const lock = await readLockSnapshot();
      return {
        sourceId,
        skillNames: names.filter(
          (name) =>
            lock.state === 'unreadable' ||
            lock.entries.has(getLockKey(sourceId, name)),
        ),
      };
    },

    async update(ref) {
      const { service, refreshInventory } = await guard(ref, 'update');
      succeeded(
        await call('update', () =>
          service.updateSkill(ref.sourceId, ref.skillName),
        ),
        'update',
      );
      refreshInventory('skills:update');
    },

    async remove(ref) {
      const { service, refreshInventory } = await guard(ref, 'remove');
      succeeded(
        await call('remove', () =>
          service.removeSkillForContext(ref.sourceId, ref.skillName),
        ),
        'remove',
      );
      refreshInventory('skills:remove');
    },

    async saveCustom(request) {
      const { service, refreshInventory } = await deps();
      const payload: SaveCustomSkillRequest = {
        name: request.name,
        description: request.description,
        body: request.body,
        ...(request.originalName !== null
          ? { originalName: request.originalName }
          : {}),
        ...(request.extraMetadata !== null
          ? { extraMetadata: request.extraMetadata }
          : {}),
        ...(request.preservedMetadata !== null
          ? { preservedMetadata: request.preservedMetadata }
          : {}),
        ...(request.files !== null
          ? {
              files: request.files.map((file) =>
                file.content === null
                  ? { path: file.path }
                  : { path: file.path, content: file.content },
              ),
            }
          : {}),
      };
      const data = succeeded(
        await call('customSave', () => service.saveCustomSkill(payload)),
        'customSave',
        request,
      );
      if (!data) throw refused(failureOf('customSave'), undefined);
      refreshInventory('skills:save-custom');
      return { skillName: data.name };
    },

    async checkUpdates() {
      const { service } = await deps();
      const data =
        succeeded(
          await call('updatesCheck', () => service.checkUpdates()),
          'updatesCheck',
        ) ?? {};
      const rows: {
        sourceId: string;
        skillName: string;
        updateAvailable: boolean;
      }[] = [];
      for (const [key, updateAvailable] of Object.entries(data)) {
        if (rows.length >= 10_000) break;
        let parsedKey: { sourceId: string; skillName: string };
        try {
          parsedKey = parseLockKey(key);
        } catch {
          continue;
        }
        rows.push({ ...parsedKey, updateAvailable });
      }
      return rows;
    },
  };
}

import {
  type CORE_CATALOG_INSTRUCTION_DEFINITIONS,
  type CORE_CATALOG_QUERY_DEFINITIONS,
  CATALOG_REFRESH_MAX_SOURCES,
  CORE_CATALOG_PUBLISH_CODES,
  type CORE_CATALOG_PUBLISH_INSTRUCTION_DEFINITIONS,
  CORE_CATALOG_SOURCE_CODES,
  type CORE_CATALOG_SOURCE_INSTRUCTION_DEFINITIONS,
  type CORE_CATALOG_SOURCE_QUERY_DEFINITIONS,
  CatalogEntryPublishResultSchema,
  CatalogPluginInstallResultSchema,
  CatalogSelectionUpdateResultSchema,
  CatalogSourceDeleteResultSchema,
  CatalogSourceRefreshResultSchema,
  CatalogSourceUpsertResultSchema,
  isBoundedCanopyJsonValue,
  resolveCatalogEntryIds,
  selectionEntryIds,
  type CanopyErrorKind,
  type CanopyOperationCode,
  type CanopyRetryDirective,
  type CanopyWorkspaceScope,
  type CatalogEntry,
  type CatalogSelectionRefs,
} from '@canopy/protocol/canopy-core';
import { CanopyOperationError } from '../../runtime/errors';
import type {
  CanopyDispatcherHandlerMap,
  CanopyDispatcherInstructionHandlerMap,
  CanopyHandlerContext,
} from '../../runtime/types';
import {
  CatalogHostRefusedError,
  CatalogSelectionNotFoundError,
  CatalogSelectionUnavailableError,
  type CatalogHostRefusal,
  type CatalogPublication,
  type CatalogSelectionRead,
  type CatalogSelectionScope,
  type CatalogSnapshotRead,
  type CoreCatalogHost,
} from './host';
import type { CatalogMutationRuns } from './mutation-runs';
import { catalogContentRevision } from './revision';

export const CORE_CATALOG_SERVED_KINDS = [
  'skill',
  'plugin',
  'mcp_server',
  'collection',
] as const;
export const CORE_CATALOG_SELECTION_RESOURCE = 'core.catalog.selection';
export const CORE_CATALOG_SOURCE_RESOURCE = 'core.catalog.source';
export const CORE_CATALOG_ENTRY_RESOURCE = 'core.catalog.entry';

/** The refresh classification recorded when the refresh was admitted. */
const RecordedRefreshAcknowledgementSchema =
  CatalogSourceRefreshResultSchema.pick({
    acceptedSources: true,
    scanOnlySources: true,
  });

/** An install receipt recorded before per-provider outcomes (CAN-5859). */
const LegacyPluginInstallOutcomeSchema = CatalogPluginInstallResultSchema.pick({
  entryId: true,
  providers: true,
});

const SELECTION_CODES = [
  'core.catalog.selection.invalidState',
  'core.catalog.selection.revisionConflict',
  'core.catalog.selection.notFound',
] as const;

type CatalogQueryDefinitions = typeof CORE_CATALOG_QUERY_DEFINITIONS &
  typeof CORE_CATALOG_SOURCE_QUERY_DEFINITIONS;
type CatalogInstructionDefinitions =
  typeof CORE_CATALOG_INSTRUCTION_DEFINITIONS &
    typeof CORE_CATALOG_SOURCE_INSTRUCTION_DEFINITIONS &
    typeof CORE_CATALOG_PUBLISH_INSTRUCTION_DEFINITIONS;

export interface CoreCatalogHandlers {
  queries: CanopyDispatcherHandlerMap<CatalogQueryDefinitions>;
  instructions: CanopyDispatcherInstructionHandlerMap<CatalogInstructionDefinitions>;
}

const NEVER: CanopyRetryDirective = { kind: 'never' };

function fail(
  kind: CanopyErrorKind,
  message: string,
  options: {
    code?: CanopyOperationCode;
    retry?: CanopyRetryDirective;
    cause?: unknown;
  } = {},
): CanopyOperationError {
  return new CanopyOperationError(
    {
      kind,
      message,
      retry: options.retry ?? NEVER,
      ...(options.code !== undefined ? { code: options.code } : {}),
    },
    options.cause,
  );
}

const keyReusedConflict = (): CanopyOperationError =>
  fail('conflict', 'This idempotency key was used with other parameters.');

const selectionConflict = (cause?: unknown): CanopyOperationError =>
  fail('conflict', 'The selection changed since it was read.', {
    code: 'core.catalog.selection.revisionConflict',
    retry: { kind: 'after_refresh', resource: CORE_CATALOG_SELECTION_RESOURCE },
    cause,
  });

const selectionNotFound = (cause?: unknown): CanopyOperationError =>
  fail('not_found', 'The selection was not found.', {
    code: 'core.catalog.selection.notFound',
    cause,
  });

/** Scope keys that are present with a value. */
const presentKeys = (scope: CanopyWorkspaceScope): string[] =>
  Object.entries(scope)
    .filter(([, value]) => value !== undefined)
    .map(([key]) => key);

/** The selection scope a request names, or the error it answers with. */
export function catalogSelectionScopeOf(
  scope: CanopyWorkspaceScope,
  targetId: string | null | undefined,
): CatalogSelectionScope {
  if (targetId !== null && targetId !== undefined)
    throw fail('invalid_argument', 'Selections have no target here.');
  if (
    presentKeys(scope).some(
      (key) => !['workspaceId', 'worktreeId', 'chatId'].includes(key),
    )
  )
    throw fail(
      'invalid_argument',
      'Scope a selection by a workspace or a chat, or leave it empty for the global defaults.',
    );
  const { workspaceId, worktreeId, chatId } = scope;
  if (
    workspaceId === undefined &&
    worktreeId === undefined &&
    chatId === undefined
  )
    return { kind: 'global' };
  if (
    workspaceId !== undefined &&
    worktreeId === undefined &&
    chatId === undefined
  )
    return { kind: 'workspace', workspaceId };
  if (
    workspaceId !== undefined &&
    worktreeId !== undefined &&
    chatId !== undefined
  )
    return { kind: 'chat', workspaceId, worktreeId, chatId };
  throw fail(
    'invalid_argument',
    "Scope a chat's selection by its workspace, worktree and chat.",
  );
}

async function readSnapshot(
  host: CoreCatalogHost,
): Promise<CatalogSnapshotRead> {
  try {
    return await host.snapshot();
  } catch (error) {
    throw fail('unavailable', 'The catalog cannot be read right now.', {
      retry: { kind: 'same_request' },
      cause: error,
    });
  }
}

async function readSelection(
  host: CoreCatalogHost,
  scope: CatalogSelectionScope,
): Promise<CatalogSelectionRead> {
  try {
    return await host.readSelection(scope);
  } catch (error) {
    if (error instanceof CatalogSelectionNotFoundError)
      throw selectionNotFound(error);
    if (error instanceof CatalogSelectionUnavailableError)
      throw fail('unavailable', 'This selection cannot be read right now.', {
        cause: error,
      });
    throw error;
  }
}

function resolveIds(
  ids: readonly string[],
  snapshot: CatalogSnapshotRead,
  current: CatalogSelectionRead,
): CatalogSelectionRefs {
  const resolution = resolveCatalogEntryIds(ids, [
    snapshot.refs,
    current.selections,
  ]);
  if (!resolution.ok)
    throw fail(
      'invalid_argument',
      `No catalog entry is named ${resolution.unknownId}.`,
    );
  return resolution.refs;
}

/** The payload a host refusal answers with; null when `map` does not name it. */
function refusalError(
  error: unknown,
  map: Partial<
    Record<CatalogHostRefusal, (cause: unknown) => CanopyOperationError>
  >,
): CanopyOperationError | null {
  if (!(error instanceof CatalogHostRefusedError)) return null;
  const build = map[error.refusal];
  return build ? build(error.cause) : null;
}

const exactlyBoth = (providers: readonly string[]): boolean =>
  providers.length === 2 &&
  providers.includes('claude') &&
  providers.includes('codex');

export function createCoreCatalogHandlers(options: {
  host: CoreCatalogHost;
  runs: CatalogMutationRuns;
  clock?: () => Date;
}): CoreCatalogHandlers {
  const { host, runs } = options;
  const clock = options.clock ?? ((): Date => new Date());

  const writeWorkspaceSelection = async (
    scope: Extract<CatalogSelectionScope, { kind: 'workspace' }>,
    params: { expectedRevision: number; selectedItemIds: string[] },
    context: CanopyHandlerContext,
    key: string,
  ): Promise<CatalogSelectionRead> => {
    const current = await readSelection(host, scope);
    const snapshot = await readSnapshot(host);
    const refs = resolveIds(params.selectedItemIds, snapshot, current);
    try {
      return await host.replaceWorkspaceSelection({
        workspaceId: scope.workspaceId,
        expectedRevision: params.expectedRevision,
        refs,
        idempotencyKey: `catalog-selection:${key}`,
        caller: context.caller,
      });
    } catch (error) {
      const unavailable = (cause: unknown): CanopyOperationError =>
        fail('unavailable', 'This selection cannot be saved right now.', {
          cause,
        });
      throw (
        refusalError(error, {
          'workspace-revision-conflict': selectionConflict,
          'workspace-not-found': selectionNotFound,
          'workspace-unavailable': unavailable,
          'workspace-recovery-required': unavailable,
          'workspace-key-reused': (cause) =>
            fail(
              'invalid_argument',
              'This idempotency key was used with other parameters.',
              { cause },
            ),
          'workspace-in-progress': (cause) =>
            fail('unavailable', 'This change is still being saved.', {
              retry: { kind: 'same_idempotency_key' },
              cause,
            }),
          'workspace-outcome-expired': (cause) =>
            fail(
              'failed_precondition',
              'This request already finished; refresh and send a new request.',
              { cause },
            ),
        }) ?? error
      );
    }
  };

  return {
    queries: {
      'core.catalog.snapshot.get': async (params) => {
        const served: readonly string[] = CORE_CATALOG_SERVED_KINDS;
        if (params.kinds.some((kind) => !served.includes(kind)))
          throw fail(
            'capability_unavailable',
            'This core serves skill, plugin, MCP server and collection entries.',
          );
        if (presentKeys(params.scope).some((key) => key !== 'workspaceId'))
          throw fail(
            'invalid_argument',
            'Scope a catalog read by a workspace.',
          );
        const kinds: readonly string[] =
          params.kinds.length > 0 ? params.kinds : served;
        const snapshot = await readSnapshot(host);
        const entries: CatalogEntry[] = snapshot.entries.filter(
          (entry) =>
            kinds.includes(entry.kind) &&
            (params.includeUnavailable || entry.availability === 'available'),
        );
        return {
          revision: catalogContentRevision(
            entries.map((entry) => ({
              ...entry,
              createdAt: '',
              updatedAt: '',
            })),
          ),
          entries,
          generatedAt: clock().toISOString(),
        };
      },
      'core.catalog.selection.get': async (params) => {
        const scope = catalogSelectionScopeOf(params.scope, params.targetId);
        const read = await readSelection(host, scope);
        const snapshot = await readSnapshot(host);
        const offered = new Set(
          snapshot.entries
            .filter((entry) => entry.availability === 'available')
            .map((entry) => entry.entryId),
        );
        const selectedItemIds = selectionEntryIds(read.selections);
        return {
          revision: read.revision,
          selectedItemIds,
          unavailableItemIds: selectedItemIds.filter((id) => !offered.has(id)),
          ...(read.tombstones
            ? { tombstonedItemIds: selectionEntryIds(read.tombstones) }
            : {}),
        };
      },
      'core.catalog.source.list': async (params) => {
        if (
          params.scope &&
          presentKeys(params.scope).some(
            (key) => key !== 'workspaceId' && key !== 'organizationId',
          )
        )
          throw fail('invalid_argument', 'Scope a source read by a workspace.');
        let sources;
        try {
          sources = await host.listSources();
        } catch (error) {
          throw fail('unavailable', 'The sources cannot be read right now.', {
            code: 'core.catalog.sourceUnavailable',
            retry: { kind: 'same_request' },
            cause: error,
          });
        }
        const providers = params.providers;
        const listed = sources.filter(
          (source) =>
            (providers === undefined ||
              source.providers.some((provider) =>
                providers.includes(provider),
              )) &&
            (params.includeDisabled === true || source.enabled),
        );
        return { sources: listed, revision: catalogContentRevision(listed) };
      },
    },
    instructions: {
      'core.catalog.selection.update': async (params, context) => {
        const scope = catalogSelectionScopeOf(params.scope, params.targetId);
        if (scope.kind === 'chat')
          throw fail(
            'capability_unavailable',
            "A chat's selection changes through core.chat.update.",
          );
        const key = params._meta.idempotencyKey;
        const result = (
          read: CatalogSelectionRead,
        ): {
          revision: number;
          selectedItemIds: string[];
          materializationOperation: null;
        } => ({
          revision: read.revision,
          selectedItemIds: selectionEntryIds(read.selections),
          materializationOperation: null,
        });
        if (scope.kind === 'workspace')
          return result(
            await writeWorkspaceSelection(scope, params, context, key),
          );
        // A recorded key replays without reading anything. A new key reads
        // before admission, so a transient read failure stays retryable
        // under the same key instead of becoming its outcome.
        const recorded = await runs.recordedOperationId({
          kind: 'core.catalog.selection.update',
          context,
          params,
        });
        const reads =
          recorded === null
            ? {
                current: await readSelection(host, scope),
                snapshot: await readSnapshot(host),
              }
            : null;
        return runs.run({
          kind: 'core.catalog.selection.update',
          context,
          params,
          codes: SELECTION_CODES,
          keyReused: () =>
            fail(
              'invalid_argument',
              'This idempotency key was used with other parameters.',
            ),
          decode: (outcome) => {
            const parsed =
              CatalogSelectionUpdateResultSchema.safeParse(outcome);
            return parsed.success ? parsed.data : null;
          },
          effect: async () => {
            const { current, snapshot } = reads ?? {
              current: await readSelection(host, scope),
              snapshot: await readSnapshot(host),
            };
            const refs = resolveIds(params.selectedItemIds, snapshot, current);
            // CAN-5898: refuse before writing what the ledger cannot record.
            if (
              !isBoundedCanopyJsonValue({
                revision: Number.MAX_SAFE_INTEGER,
                selectedItemIds: selectionEntryIds(refs),
                materializationOperation: null,
              })
            )
              throw fail(
                'resource_exhausted',
                'This selection is too large to record.',
              );
            const change = await host.replaceGlobalSelection(
              params.expectedRevision,
              refs,
            );
            if (change.outcome === 'conflict') throw selectionConflict();
            return result(change.read);
          },
        });
      },
      'core.catalog.source.upsert': async (params, context) => {
        if (
          params.sourceId !== null ||
          params.expectedRevision !== null ||
          params.locator.kind !== 'git' ||
          params.locator.ref !== null ||
          !params.enabled ||
          !exactlyBoth(params.providers)
        )
          throw fail(
            'capability_unavailable',
            'This core only adds new GitHub sources that track their default branch for both providers.',
          );
        const repository = params.locator.repository;
        return runs.run({
          kind: 'core.catalog.source.upsert',
          context,
          params,
          codes: CORE_CATALOG_SOURCE_CODES.upsert,
          keyReused: keyReusedConflict,
          decode: (outcome) => {
            const parsed = CatalogSourceUpsertResultSchema.safeParse(outcome);
            return parsed.success ? parsed.data : null;
          },
          effect: async () => {
            try {
              return await host.addGitSource(repository);
            } catch (error) {
              throw (
                refusalError(error, {
                  'source-invalid': (cause) =>
                    fail(
                      'invalid_argument',
                      'This repository is not a valid GitHub owner/repo.',
                      { code: 'core.catalog.sourceInvalid', cause },
                    ),
                  'source-provider-rejected': (cause) =>
                    fail(
                      'failed_precondition',
                      'Neither Claude nor Codex accepted this repository as a marketplace.',
                      { code: 'core.catalog.sourceProviderRejected', cause },
                    ),
                }) ??
                fail('unavailable', 'The source could not be added.', {
                  cause:
                    error instanceof CatalogHostRefusedError
                      ? error.cause
                      : error,
                })
              );
            }
          },
        });
      },
      'core.catalog.source.delete': async (params, context) =>
        runs.run({
          kind: 'core.catalog.source.delete',
          context,
          params,
          codes: CORE_CATALOG_SOURCE_CODES.delete,
          keyReused: keyReusedConflict,
          decode: (outcome) => {
            const parsed = CatalogSourceDeleteResultSchema.safeParse(outcome);
            return parsed.success ? parsed.data : null;
          },
          effect: async () => {
            try {
              const removal = await host.deleteSource({
                sourceId: params.sourceId,
                providers: params.providers,
                guard: (current) => {
                  if (current === null) return 'absent';
                  if (
                    current.locator.kind === 'builtin' ||
                    current.locator.kind === 'curated'
                  )
                    return 'builtin';
                  if (
                    params.expectedRevision !== null &&
                    current.revision !== params.expectedRevision
                  )
                    return 'conflict';
                  return 'proceed';
                },
              });
              return {
                sourceId: params.sourceId,
                removedProviders: removal.removedProviders,
                alreadyAbsent: removal.alreadyAbsent,
              };
            } catch (error) {
              throw (
                refusalError(error, {
                  'source-not-found': (cause) =>
                    fail('not_found', 'This source is not registered.', {
                      code: 'core.catalog.sourceNotFound',
                      cause,
                    }),
                  'source-builtin': (cause) =>
                    fail(
                      'failed_precondition',
                      'Built-in sources cannot be removed.',
                      { code: 'core.catalog.sourceBuiltin', cause },
                    ),
                  'source-conflict': (cause) =>
                    fail('conflict', 'The source changed since it was read.', {
                      code: 'core.catalog.sourceConflict',
                      retry: {
                        kind: 'after_refresh',
                        resource: CORE_CATALOG_SOURCE_RESOURCE,
                      },
                      cause,
                    }),
                  'source-provider-failed': (cause) =>
                    fail(
                      'unavailable',
                      'A provider could not remove this source.',
                      {
                        cause,
                      },
                    ),
                }) ?? error
              );
            }
          },
        }),
      'core.catalog.source.refresh': async (params, context) => {
        if (!exactlyBoth(params.providers))
          throw fail(
            'capability_unavailable',
            'This core refreshes both providers of a source.',
          );
        // A retry of a recorded refresh replays its recorded acknowledgement
        // without reading the sources; only a new request reads and checks them.
        const recorded = await runs.recordedOperationId({
          kind: 'core.catalog.source.refresh',
          context,
          params,
        });
        let sources: Awaited<ReturnType<CoreCatalogHost['listSources']>> = [];
        if (recorded === null)
          try {
            sources = await host.listSources();
          } catch (error) {
            throw fail('unavailable', 'The sources cannot be read right now.', {
              retry: { kind: 'same_idempotency_key' },
              cause: error,
            });
          }
        const byId = new Map(
          sources.map((source) => [source.sourceId, source]),
        );
        const requested =
          params.sourceIds === 'all' ? [...byId.keys()] : params.sourceIds;
        // The receipt records every accepted source, so it stays bounded.
        if (requested.length > CATALOG_REFRESH_MAX_SOURCES)
          throw fail(
            'resource_exhausted',
            'This core refreshes at most 100 sources at once.',
            { code: 'core.catalog.refreshTooLarge' },
          );
        const unknown = requested.find((id) => !byId.has(id));
        if (unknown !== undefined && recorded === null)
          throw fail('not_found', 'This source is not registered.', {
            code: 'core.catalog.sourceNotFound',
          });
        const isGit = (id: string): boolean =>
          byId.get(id)?.locator.kind === 'git';
        const all =
          params.sourceIds === 'all' ||
          (requested.length === byId.size &&
            requested.every((id) => byId.has(id)));
        const scanOnlySourceIds =
          params.mode === 'scan'
            ? [...requested]
            : requested.filter((id) => !isGit(id));
        const updateSourceIds =
          params.mode === 'update_then_scan' ? requested.filter(isGit) : [];
        const acknowledgement = {
          acceptedSources: [...requested],
          scanOnlySources: scanOnlySourceIds,
        };
        // CAN-5898: the acknowledgement records at admission, and the
        // outcome names no more than it, so both fit the ledger. A recorded
        // request replays what it recorded, so only a new one is checked.
        if (recorded === null && !isBoundedCanopyJsonValue(acknowledgement))
          throw fail(
            'resource_exhausted',
            'These sources are too many to record in one refresh.',
            { code: 'core.catalog.refreshTooLarge' },
          );
        const accepted = new Set(requested);
        return runs.start({
          kind: 'core.catalog.source.refresh',
          context,
          params,
          codes: CORE_CATALOG_SOURCE_CODES.refresh,
          keyReused: keyReusedConflict,
          acknowledgement,
          acknowledge: (operationId, recorded) => {
            const parsed =
              RecordedRefreshAcknowledgementSchema.safeParse(recorded);
            return {
              operationId,
              acceptedSources: parsed.success
                ? parsed.data.acceptedSources
                : [...requested],
              scanOnlySources: parsed.success
                ? parsed.data.scanOnlySources
                : scanOnlySourceIds,
            };
          },
          effect: async (operationId) => {
            const outcome = await host.refreshSources({
              operationId,
              mode: params.mode,
              all,
              updateSourceIds,
              scanOnlySourceIds,
            });
            // An empty `'all'` names no source that could have failed.
            if (
              requested.length > 0 &&
              requested.every((id) => outcome.failed.includes(id))
            )
              throw fail('unavailable', 'No source could be refreshed.', {
                code: 'core.catalog.refreshUnavailable',
              });
            return {
              refreshed: outcome.refreshed.filter((id) => accepted.has(id)),
              failed: outcome.failed.filter((id) => accepted.has(id)),
            };
          },
        });
      },
      'core.catalog.plugin.install': async (params, context) =>
        runs.run({
          kind: 'core.catalog.plugin.install',
          context,
          params,
          codes: CORE_CATALOG_SOURCE_CODES.install,
          keyReused: keyReusedConflict,
          decode: (outcome) => {
            const parsed = CatalogPluginInstallResultSchema.safeParse(outcome);
            if (parsed.success) return parsed.data;
            const legacy = LegacyPluginInstallOutcomeSchema.safeParse(outcome);
            return legacy.success
              ? {
                  ...legacy.data,
                  installedProviders: [...legacy.data.providers],
                  failedProviders: [],
                }
              : null;
          },
          effect: async () => {
            const notFound = (cause?: unknown): CanopyOperationError =>
              fail('not_found', 'This plugin is not in the catalog.', {
                code: 'core.catalog.pluginNotFound',
                cause,
              });
            const notInstallable = (cause?: unknown): CanopyOperationError =>
              fail(
                'failed_precondition',
                'This plugin cannot be installed for these providers.',
                { code: 'core.catalog.pluginNotInstallable', cause },
              );
            const target = await host.findPlugin(params.entryId);
            if (target === null) throw notFound();
            if (
              target.install === 'none' ||
              (target.install === 'external' &&
                !(
                  params.providers.length === 1 &&
                  params.providers[0] === 'claude'
                ))
            )
              throw notInstallable();
            const installFailed = (cause?: unknown): CanopyOperationError =>
              fail('unavailable', 'The plugin could not be installed.', {
                code: 'core.catalog.pluginInstallFailed',
                cause,
              });
            let installed: readonly string[];
            try {
              ({ installed } = await host.installPlugin(
                target,
                params.providers,
              ));
            } catch (error) {
              throw (
                refusalError(error, {
                  'plugin-not-found': notFound,
                  'plugin-not-installable': notInstallable,
                  'plugin-source-rejected': (cause) =>
                    fail(
                      'failed_precondition',
                      "This plugin's source must be a public https URL.",
                      { code: 'core.catalog.pluginSourceRejected', cause },
                    ),
                  'plugin-uninstall-pending': (cause) =>
                    fail(
                      'failed_precondition',
                      'Finish uninstalling this plugin before adding it again.',
                      { code: 'core.catalog.pluginUninstallPending', cause },
                    ),
                  'plugin-install-failed': installFailed,
                }) ?? error
              );
            }
            // A requested provider the host does not report installed failed.
            const providers = [...params.providers].sort();
            const installedProviders = providers.filter((provider) =>
              installed.includes(provider),
            );
            if (installedProviders.length === 0) throw installFailed();
            return {
              entryId: params.entryId,
              providers,
              installedProviders,
              failedProviders: providers.filter(
                (provider) => !installed.includes(provider),
              ),
            };
          },
        }),
      'core.catalog.entry.publish': async (params, context) =>
        runs.run({
          kind: 'core.catalog.entry.publish',
          context,
          params,
          codes: CORE_CATALOG_PUBLISH_CODES,
          keyReused: keyReusedConflict,
          decode: (outcome) => {
            const parsed = CatalogEntryPublishResultSchema.safeParse(outcome);
            return parsed.success ? parsed.data : null;
          },
          effect: async () => {
            if (
              params.visibility !== 'private' ||
              params.teamId !== null ||
              params.organizationId !== null
            )
              throw fail(
                'invalid_argument',
                'Only a private copy can be published from here.',
                { code: 'core.catalog.visibilityInvalid' },
              );
            const noun = params.kind === 'skill' ? 'skill' : 'plugin';
            const publishPlugin = host.publishPlugin?.bind(host);
            const publishSkill = host.publishSkill?.bind(host);
            const pkg = params.package;
            const publish: (() => Promise<CatalogPublication>) | null =
              params.kind === 'plugin' &&
              pkg === undefined &&
              publishPlugin !== undefined
                ? async () => {
                    const target = await host.findPlugin(params.entryId);
                    if (target === null)
                      throw new CatalogHostRefusedError('plugin-not-found');
                    return publishPlugin(target);
                  }
                : params.kind === 'skill' &&
                    pkg !== undefined &&
                    publishSkill !== undefined
                  ? () => publishSkill(params.entryId, pkg)
                  : null;
            if (publish === null)
              throw params.kind === 'skill' && pkg === undefined
                ? fail(
                    'invalid_argument',
                    'A skill is published with the package the person agreed to.',
                  )
                : params.kind === 'plugin' && pkg !== undefined
                  ? fail(
                      'invalid_argument',
                      'A plugin is published without a package.',
                    )
                  : fail(
                      'capability_unavailable',
                      'This entry cannot be published to the cloud from here.',
                    );
            const notFound = (cause?: unknown): CanopyOperationError =>
              fail('not_found', `This ${noun} is not in the catalog.`, {
                code: 'core.catalog.entryNotFound',
                cause,
              });
            const moved = (cause?: unknown): CanopyOperationError =>
              fail('conflict', `This ${noun} changed since it was read.`, {
                code: 'core.catalog.revisionConflict',
                retry: {
                  kind: 'after_refresh',
                  resource: CORE_CATALOG_ENTRY_RESOURCE,
                },
                cause,
              });
            const entry = (await readSnapshot(host)).entries.find(
              (candidate) =>
                candidate.entryId === params.entryId &&
                candidate.kind === params.kind,
            );
            if (entry === undefined) throw notFound();
            if (entry.revision !== params.expectedRevision) throw moved();
            try {
              const published = await publish();
              return {
                publicationId: published.publicationId,
                remoteEntryId: published.remoteEntryId,
                revision: published.revision,
              };
            } catch (error) {
              throw (
                refusalError(error, {
                  'plugin-not-found': notFound,
                  'publish-entry-not-found': notFound,
                  'publish-source-unsupported': (cause) =>
                    fail(
                      'failed_precondition',
                      params.kind === 'skill'
                        ? 'Only a custom skill can be added to the cloud from here.'
                        : "This plugin's marketplace has no public source the cloud can fetch.",
                      { code: 'core.catalog.entryReadOnly', cause },
                    ),
                  'publish-revision-moved': moved,
                  'publish-package-stale': (cause) =>
                    fail(
                      'conflict',
                      'This skill changed after its files were checked. Check them again.',
                      {
                        code: 'core.catalog.packageStale',
                        retry: {
                          kind: 'after_refresh',
                          resource: CORE_CATALOG_ENTRY_RESOURCE,
                        },
                        cause,
                      },
                    ),
                  'publish-remote-unavailable': (cause) =>
                    fail(
                      'unavailable',
                      'The cloud catalog cannot be reached right now.',
                      // The run records this failure under its key, so only
                      // a new request (and key) reaches the cloud again.
                      { code: 'core.catalog.remoteUnavailable', cause },
                    ),
                }) ?? error
              );
            }
          },
        }),
    },
  };
}

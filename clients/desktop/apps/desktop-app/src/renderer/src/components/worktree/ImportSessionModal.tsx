import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
} from 'react';
import type {
  ChatSessionImportInspectResponse,
  ChatSessionImportRepoSummary,
  SessionCloudExportSummary,
} from '@canopy/desktop-shared/types';
import {
  Stack,
  BusyLabel,
  Button,
  ChoiceField,
  DelayedLoadingPlaceholder,
  Fact,
  FactList,
  Heading,
  ListRow,
  Notice,
  SearchField,
  Skeleton,
  Surface,
} from '@canopy/ui-shared/components';
import { formatByteSize, formatDateTime } from '@canopy/ui-shared/lib';
import { DialogModal } from '../shared';
import { LoadingSpinner } from '../shared/loading/spinners/LoadingSpinner';
import { useGitHubStore } from '@/stores/githubStore';
import { extractIpcErrorMessage } from '@/lib/errors';

interface ImportSessionModalProps {
  workspaceId: string;
  onClose: () => void;
}

interface RepoSummaryListProps {
  repos: ChatSessionImportRepoSummary[];
}

type ImportSessionPhase =
  | 'list'
  | 'inspecting'
  | 'ready'
  | 'importing'
  | 'complete';

const CLOUD_EXPORT_PAGE_SIZE = 25;
const SEARCH_DEBOUNCE_MS = 300;

function formatProvider(
  provider: ChatSessionImportInspectResponse['manifestSummary']['provider'],
): string {
  if (provider === 'claude') return 'Claude';
  if (provider === 'codex') return 'Codex';
  if (provider === 'ollama') return 'Ollama';
  return 'Unspecified';
}

async function discardStagedImport(exportId: string): Promise<void> {
  if (!window.api.chat.discardSessionImport) return;
  await window.api.chat.discardSessionImport({ exportId });
}

interface CloudExportRowProps {
  exportItem: SessionCloudExportSummary;
  confirmingDelete: boolean;
  deleting: boolean;
  onInspect: () => void;
  onDelete: () => void;
}

function CloudExportRow({
  exportItem,
  confirmingDelete,
  deleting,
  onInspect,
  onDelete,
}: CloudExportRowProps): JSX.Element {
  return (
    <Surface
      variant="group"
      padding="tight"
      data-testid={`import-session-cloud-row-${exportItem.id}`}
    >
      <ListRow
        size="lg"
        onClick={onInspect}
        actions={
          <Button
            variant={confirmingDelete ? 'destructive' : 'ghost-destructive'}
            size="compact"
            data-testid={`import-session-cloud-delete-${exportItem.id}`}
            onClick={onDelete}
            disabled={deleting}
          >
            {deleting
              ? 'Deleting…'
              : confirmingDelete
                ? 'Confirm delete'
                : 'Delete'}
          </Button>
        }
        description={[
          formatDateTime(exportItem.createdAt),
          formatByteSize(exportItem.sizeBytes),
          exportItem.workspaceName,
          `${exportItem.repos.length} ${
            exportItem.repos.length === 1 ? 'repository' : 'repositories'
          }`,
        ].join(' · ')}
      >
        {exportItem.title}
      </ListRow>
    </Surface>
  );
}

const SAMPLE_EXPORT_TIME = '2026-01-01T12:00:00.000Z';

/** Plain exports the loading skeleton lays out as the export list. */
const SAMPLE_EXPORTS: SessionCloudExportSummary[] = [
  {
    id: 'skeleton-export-1',
    title: 'Fix the flaky checkout test',
    workspaceName: 'Storefront',
    workspaceType: 'code',
    repos: [{ name: 'storefront', branchName: 'main' }],
    sizeBytes: 482_000,
    createdAt: SAMPLE_EXPORT_TIME,
    updatedAt: SAMPLE_EXPORT_TIME,
  },
  {
    id: 'skeleton-export-2',
    title: 'Draft the release notes',
    workspaceName: 'Storefront',
    workspaceType: 'code',
    repos: [{ name: 'storefront', branchName: 'main' }],
    sizeBytes: 126_000,
    createdAt: SAMPLE_EXPORT_TIME,
    updatedAt: SAMPLE_EXPORT_TIME,
  },
  {
    id: 'skeleton-export-3',
    title: 'Speed up the image build',
    workspaceName: 'Platform',
    workspaceType: 'code',
    repos: [{ name: 'platform', branchName: 'main' }],
    sizeBytes: 98_000,
    createdAt: SAMPLE_EXPORT_TIME,
    updatedAt: SAMPLE_EXPORT_TIME,
  },
];

const noop = (): void => undefined;

function RepoSummaryList({ repos }: RepoSummaryListProps): JSX.Element {
  return (
    <ul className="flex flex-col text-xs fg-secondary gap-1">
      {repos.map((repo, index) => (
        <Surface
          as="li"
          variant="group"
          size="small"
          key={`${repo.remoteUrl ?? repo.name}-${index}`}
        >
          <div className="px-2.5 py-2">
            <div className="font-medium fg-primary">{repo.name}</div>
            {repo.remoteUrl && (
              <div className="mt-0.5 break-all">{repo.remoteUrl}</div>
            )}
            {repo.branchName && (
              <div className="mt-0.5">Branch: {repo.branchName}</div>
            )}
          </div>
        </Surface>
      ))}
    </ul>
  );
}

export function ImportSessionModal({
  workspaceId,
  onClose,
}: ImportSessionModalProps): JSX.Element {
  const [phase, setPhase] = useState<ImportSessionPhase>('list');
  const [exports, setExports] = useState<SessionCloudExportSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [isLoadingList, setIsLoadingList] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(
    null,
  );
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [inspection, setInspection] =
    useState<ChatSessionImportInspectResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [importWarnings, setImportWarnings] = useState<string[]>([]);
  const [installMissingCapabilities, setInstallMissingCapabilities] =
    useState(true);
  const mountedRef = useRef(true);
  const listRequestIdRef = useRef(0);
  const stagedExportIdRef = useRef<string | null>(null);
  const addToast = useGitHubStore((state) => state.addToast);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedSearch(search.trim());
    }, SEARCH_DEBOUNCE_MS);
    return (): void => window.clearTimeout(timer);
  }, [search]);

  const loadExports = useCallback(
    async (cursor?: string): Promise<void> => {
      const requestId = listRequestIdRef.current + 1;
      listRequestIdRef.current = requestId;
      if (cursor) {
        setIsLoadingMore(true);
      } else {
        setIsLoadingList(true);
      }
      setError(null);
      try {
        const response = await window.api.chat.listSessionExports({
          limit: CLOUD_EXPORT_PAGE_SIZE,
          ...(cursor ? { cursor } : {}),
          ...(debouncedSearch ? { q: debouncedSearch } : {}),
        });
        if (!mountedRef.current || listRequestIdRef.current !== requestId) {
          return;
        }
        setExports((current) =>
          cursor ? [...current, ...response.data] : response.data,
        );
        setNextCursor(response.nextCursor);
      } catch (listError: unknown) {
        if (!mountedRef.current || listRequestIdRef.current !== requestId) {
          return;
        }
        if (!cursor) {
          setExports([]);
          setNextCursor(null);
        }
        setError(extractIpcErrorMessage(listError));
      } finally {
        if (mountedRef.current && listRequestIdRef.current === requestId) {
          setIsLoadingList(false);
          setIsLoadingMore(false);
        }
      }
    },
    [debouncedSearch],
  );

  useEffect(() => {
    void loadExports();
  }, [loadExports]);

  useEffect(() => {
    mountedRef.current = true;
    return (): void => {
      mountedRef.current = false;
      listRequestIdRef.current += 1;
      const exportId = stagedExportIdRef.current;
      stagedExportIdRef.current = null;
      if (exportId) {
        void discardStagedImport(exportId).catch(() => undefined);
      }
    };
  }, []);

  const inspectExport = useCallback(
    async (exportId: string): Promise<void> => {
      setPhase('inspecting');
      setInspection(null);
      setError(null);
      setImportWarnings([]);
      setConfirmingDeleteId(null);
      try {
        const response = await window.api.chat.inspectSessionImport({
          workspaceId,
          exportId,
        });
        if (!mountedRef.current) {
          await discardStagedImport(exportId);
          return;
        }
        stagedExportIdRef.current = exportId;
        setInspection(response);
        setPhase('ready');
      } catch (inspectError: unknown) {
        if (!mountedRef.current) return;
        setError(extractIpcErrorMessage(inspectError));
        setPhase('list');
      }
    },
    [workspaceId],
  );

  const handleDeleteExport = useCallback(
    async (exportId: string): Promise<void> => {
      if (confirmingDeleteId !== exportId) {
        setConfirmingDeleteId(exportId);
        return;
      }
      setDeletingId(exportId);
      setError(null);
      try {
        await window.api.chat.deleteSessionExport({ exportId });
        if (!mountedRef.current) return;
        setExports((current) =>
          current.filter((exportItem) => exportItem.id !== exportId),
        );
        setConfirmingDeleteId(null);
      } catch (deleteError: unknown) {
        if (mountedRef.current) {
          setError(extractIpcErrorMessage(deleteError));
        }
      } finally {
        if (mountedRef.current) setDeletingId(null);
      }
    },
    [confirmingDeleteId],
  );

  const discardCurrentStaging = useCallback(async (): Promise<void> => {
    const exportId = stagedExportIdRef.current;
    if (!exportId) return;
    await discardStagedImport(exportId);
    if (stagedExportIdRef.current === exportId) {
      stagedExportIdRef.current = null;
    }
  }, []);

  const handleChooseAnother = useCallback(async (): Promise<void> => {
    setError(null);
    try {
      await discardCurrentStaging();
    } catch (discardError: unknown) {
      setError(extractIpcErrorMessage(discardError));
      return;
    }
    if (!mountedRef.current) return;
    setInspection(null);
    setImportWarnings([]);
    setPhase('list');
  }, [discardCurrentStaging]);

  const handleClose = useCallback(async (): Promise<void> => {
    try {
      await discardCurrentStaging();
    } catch {
      // App shutdown also clears the staging registry. Closing the modal must
      // not be held hostage by a best-effort cleanup failure.
    }
    if (mountedRef.current) onClose();
  }, [discardCurrentStaging, onClose]);

  const warnings = useMemo(
    (): string[] =>
      Array.from(new Set([...(inspection?.warnings ?? []), ...importWarnings])),
    [importWarnings, inspection?.warnings],
  );

  const handleImport = useCallback(async (): Promise<void> => {
    if (!inspection || inspection.match === 'mismatch') return;

    setPhase('importing');
    setError(null);
    try {
      const response = await window.api.chat.importSession({
        exportId: inspection.exportId,
        workspaceId,
        installMissing: installMissingCapabilities,
      });
      if (!mountedRef.current) return;
      setImportWarnings(response.warnings);
      setPhase('complete');
      if (!response.stagingRetained) {
        stagedExportIdRef.current = null;
      }
      if (response.warnings.length === 0) {
        addToast('Session imported.', 'success', undefined, {
          category: 'Chat',
          projectId: response.projectId,
          worktreeId: response.worktreeId,
          chatId: response.chatId,
        });
        onClose();
      } else {
        for (const warning of response.warnings) {
          addToast(warning, 'warning', undefined, {
            category: 'Chat',
            projectId: response.projectId,
            worktreeId: response.worktreeId,
            chatId: response.chatId,
          });
        }
      }
    } catch (importError: unknown) {
      if (!mountedRef.current) return;
      setError(extractIpcErrorMessage(importError));
      setPhase('ready');
    }
  }, [addToast, inspection, installMissingCapabilities, onClose, workspaceId]);

  const isBusy = phase === 'inspecting' || phase === 'importing';
  const isMismatch = inspection?.match === 'mismatch';
  const capabilityReadiness = inspection?.capabilityReadiness ?? [];

  return (
    <DialogModal
      onClose={isBusy ? (): void => {} : (): void => void handleClose()}
      title="Import session"
      subtitle="Move a chat and its working changes into this project"
      titleId="import-session-modal-title"
      maxWidth="2xl"
      closeOnBackdrop={!isBusy}
      dataTestId="import-session-modal"
    >
      <div className="flex flex-col max-h-[75vh] overflow-y-auto text-s fg-primary gap-4 [&>*]:shrink-0">
        <Notice intent="attention" role="none" title="Exports are not redacted">
          They hold the full transcript and uncommitted repository changes, are
          private to your account, and leave out unpushed commits.
        </Notice>

        {phase === 'list' && (
          <Stack gap="item" data-testid="import-session-cloud-list">
            <SearchField
              value={search}
              onValueChange={setSearch}
              aria-label="Search exports"
              placeholder="Search by session title"
              data-testid="import-session-cloud-search"
            />

            {isLoadingList ? (
              <DelayedLoadingPlaceholder slowNote="Still loading exports…">
                <Skeleton
                  loading
                  label="Loading exports"
                  testId="import-session-cloud-loading"
                >
                  <Stack gap="inline">
                    {SAMPLE_EXPORTS.map((exportItem) => (
                      <CloudExportRow
                        key={exportItem.id}
                        exportItem={exportItem}
                        confirmingDelete={false}
                        deleting={false}
                        onInspect={noop}
                        onDelete={noop}
                      />
                    ))}
                  </Stack>
                </Skeleton>
              </DelayedLoadingPlaceholder>
            ) : exports.length === 0 ? (
              <Surface variant="dashed">
                <div className="px-4 py-8 text-center text-s fg-secondary">
                  {debouncedSearch
                    ? 'No session exports match this search.'
                    : 'No session exports are available for this account.'}
                </div>
              </Surface>
            ) : (
              <Stack gap="inline">
                {exports.map((exportItem) => (
                  <CloudExportRow
                    key={exportItem.id}
                    exportItem={exportItem}
                    confirmingDelete={confirmingDeleteId === exportItem.id}
                    deleting={deletingId === exportItem.id}
                    onInspect={() => void inspectExport(exportItem.id)}
                    onDelete={() => void handleDeleteExport(exportItem.id)}
                  />
                ))}
              </Stack>
            )}

            {nextCursor && !isLoadingList && (
              <Button
                size="compact"
                onClick={() => void loadExports(nextCursor)}
                disabled={isLoadingMore}
                className="w-full"
              >
                <BusyLabel busy={isLoadingMore}>Load more</BusyLabel>
              </Button>
            )}
          </Stack>
        )}

        {phase === 'inspecting' && (
          <div className="flex items-center justify-center gap-2 py-10 text-s fg-secondary">
            <LoadingSpinner tone="accent" /> Inspecting export…
          </div>
        )}

        {inspection && phase !== 'inspecting' && (
          <>
            <div
              className="grid gap-3 md:grid-cols-2"
              data-testid="import-session-bundle-summary"
            >
              <Surface as="section" variant="group" padding="compact">
                <div className="flex flex-col gap-2">
                  <Heading level={3} variant="label">
                    Exported session
                  </Heading>
                  <div className="text-s font-medium break-words">
                    {inspection.manifestSummary.title}
                  </div>
                  <FactList columnGap="3" rowGap="1" labelTone="secondary">
                    <Fact label="Provider">
                      {formatProvider(inspection.manifestSummary.provider)}
                    </Fact>
                    <Fact label="Exported">
                      {formatDateTime(inspection.manifestSummary.exportedAt)}
                    </Fact>
                    <Fact label="Project">
                      {inspection.manifestSummary.workspaceType === 'multi-repo'
                        ? 'Multi-repo'
                        : inspection.manifestSummary.workspaceType === 'cowork'
                          ? 'Cowork'
                          : 'Single-repo'}
                    </Fact>
                  </FactList>
                  <RepoSummaryList repos={inspection.manifestSummary.repos} />
                </div>
              </Surface>

              <Surface as="section" variant="group" padding="compact">
                <div className="flex flex-col gap-2">
                  <Heading level={3} variant="label">
                    Destination project
                  </Heading>
                  <div className="text-s font-medium break-words">
                    {inspection.workspaceSummary.workspaceName}
                  </div>
                  <div className="text-xs fg-secondary">
                    {inspection.workspaceSummary.workspaceType === 'cowork'
                      ? 'Cowork project'
                      : `${inspection.workspaceSummary.repoCount} ${
                          inspection.workspaceSummary.repoCount === 1
                            ? 'repository'
                            : 'repositories'
                        }`}
                  </div>
                  <RepoSummaryList repos={inspection.workspaceSummary.repos} />
                </div>
              </Surface>
            </div>

            <Notice
              errorSource="import-session-compatibility-status"
              displayErrorCode="input.not_accepted"
              intent={isMismatch ? 'destructive' : 'positive'}
              data-testid="import-session-compatibility-status"
              title={
                inspection.match === 'exact'
                  ? inspection.manifestSummary.workspaceType === 'cowork'
                    ? 'Compatible Cowork project'
                    : 'Exact repository match'
                  : inspection.match === 'superset'
                    ? 'Compatible repository superset'
                    : inspection.workspaceTypeCompatible
                      ? 'Repository mismatch'
                      : 'Project type mismatch'
              }
            >
              {inspection.match === 'exact'
                ? inspection.manifestSummary.workspaceType === 'cowork'
                  ? 'The session will be imported into a new Work Entry in this Cowork project.'
                  : 'The destination contains exactly the repositories in this bundle.'
                : inspection.match === 'superset'
                  ? 'The destination contains every bundled repository plus additional repositories.'
                  : inspection.workspaceTypeCompatible
                    ? 'Import is blocked because the destination is missing required repositories.'
                    : 'Cowork exports require a Cowork destination, and git-backed exports require a git-backed destination.'}
            </Notice>

            {isMismatch &&
              inspection.workspaceTypeCompatible &&
              inspection.missingRepos.length > 0 && (
                // The compatibility notice above already announces the
                // mismatch; this list only itemizes it, so it stays polite.
                <Notice
                  errorSource="import-session-missing-repositories"
                  displayErrorCode="input.not_accepted"
                  intent="destructive"
                  role="status"
                >
                  <ul
                    data-testid="import-session-missing-repos"
                    className="flex flex-col gap-2"
                  >
                    {inspection.missingRepos.map((repo, index) => (
                      <li key={`${repo.remoteUrl ?? repo.name}-${index}`}>
                        <div className="font-medium">{repo.name}</div>
                        <div className="mt-0.5 break-all fg-secondary">
                          {repo.remoteUrl ?? 'No remote URL recorded'}
                        </div>
                      </li>
                    ))}
                  </ul>
                </Notice>
              )}

            <div
              data-testid="import-session-warnings"
              className={warnings.length > 0 ? 'flex flex-col gap-2' : 'hidden'}
            >
              {warnings.map((warning) => (
                <Notice key={warning} intent="attention">
                  {warning}
                </Notice>
              ))}
            </div>

            {capabilityReadiness.length > 0 && (
              <Surface
                as="section"
                gap="inline"
                variant="group"
                padding="compact"
                data-testid="import-session-capability-readiness"
              >
                <div className="flex flex-col gap-2">
                  <Heading level={3} variant="title">
                    Capabilities and setup
                  </Heading>
                  <ul className="flex flex-col gap-1.5">
                    {capabilityReadiness.map((capability) => (
                      <li
                        key={`${capability.kind}:${capability.name}`}
                        className="text-xs"
                      >
                        <span className="fg-primary">{capability.name}</span>{' '}
                        <span className="fg-secondary">
                          {capability.kind === 'mcp' ? 'MCP server' : 'Plugin'}{' '}
                          ·{' '}
                          {capability.status === 'available'
                            ? 'Available'
                            : capability.installable
                              ? 'Will be installed'
                              : 'Needs setup'}
                        </span>
                        {capability.setupHint && (
                          <span className="block fg-secondary">
                            {capability.setupHint}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                  {capabilityReadiness.some(
                    (capability) =>
                      capability.status === 'missing' && capability.installable,
                  ) && (
                    <ChoiceField
                      checked={installMissingCapabilities}
                      onChange={(event) =>
                        setInstallMissingCapabilities(event.target.checked)
                      }
                      data-testid="import-session-install-missing"
                      label="Install missing plugins with the session"
                    />
                  )}
                  <p className="text-xs fg-secondary">
                    Missing setup is reported but does not block import.
                  </p>
                </div>
              </Surface>
            )}
          </>
        )}

        {phase === 'importing' && (
          <Surface variant="group" padding="compact">
            <div className="flex items-center gap-2 text-xs fg-secondary">
              <LoadingSpinner tone="accent" /> Creating the destination
              worktree, applying changes, and restoring provider context…
            </div>
          </Surface>
        )}

        {phase === 'complete' && (
          <Notice intent="positive">
            The session was imported and opened. Review the warnings above
            before continuing.
          </Notice>
        )}

        {error && (
          <Notice errorSource="import-session-submit" intent="destructive">
            {error}
          </Notice>
        )}

        <div className="flex items-center justify-end gap-2 border-t pt-4">
          {inspection && phase === 'ready' && (
            <Button
              variant="ghost"
              size="compact"
              onClick={() => void handleChooseAnother()}
            >
              Choose another export
            </Button>
          )}
          <Button
            size="compact"
            onClick={() => void handleClose()}
            disabled={isBusy}
          >
            {phase === 'complete' ? 'Done' : 'Cancel'}
          </Button>
          {inspection && phase !== 'complete' && (
            <Button
              variant="primary"
              size="compact"
              data-testid="import-session-confirm"
              onClick={() => void handleImport()}
              disabled={isBusy || isMismatch}
            >
              {phase === 'importing' ? 'Importing…' : 'Import session'}
            </Button>
          )}
        </div>
      </div>
    </DialogModal>
  );
}

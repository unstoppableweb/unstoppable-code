import { reportClientAppError } from '@canopy/desktop-instrumentation/client';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { ShowTipsAgainRow } from './ShowTipsAgainRow';
import {
  type JSX,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  type CliPathStatus,
  type DependencyVersions,
  type ExternalProjectProvider,
  type PreferencesLoadResult,
  type TargetUpdateVersionItem,
  type UpdateState,
} from '@canopy/desktop-shared/types';
import { linuxUpdateCopy } from '@canopy/desktop-shared/lib/linux-update-copy';
import { isCliPathManagementPlatform } from '@canopy/desktop-shared/platform-capabilities';
import {
  Stack,
  BusyLabel,
  Button,
  ConfirmDialog,
  DialogModal,
  ErrorBanner,
  Notice,
  NoticeButton,
  Skeleton,
  StatusLabel,
  Surface,
  ToggleSwitch,
  WindowPage,
  InlineCode,
} from '@canopy/ui-shared/components';
import {
  Badge,
  PickerMenuOption,
  PickerMenuOptionContent,
  PickerMenuOptionDescription,
  PickerMenuOptionLabel,
  SearchField,
} from '@canopy/ui-shared/components';
import {
  ClaudeIcon,
  CodexIcon,
  GitHubIcon,
  TerminalIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import { AppLoadingScreen } from '@/components/onboarding/AppLoadingScreen';
import { ProfileRoleSection } from '@/components/settings/ProfileRoleSection';
import { NavigationModeSection } from '@/components/settings/NavigationModeSection';
import { LaunchAtLoginSection } from '@/components/settings/LaunchAtLoginSection';
import { LedgerAgentRecordingSection } from '@/components/settings/LedgerAgentRecordingSection';
import { SuggestionsSection } from '@/components/settings/SuggestionsSection';
import {
  SettingsGroup,
  SettingsPage,
  SettingsRow,
  SettingsSection,
  SettingsTextField,
} from '@/components/settings/SettingsLayout';
import { useGitHubCliStatus } from '@/hooks/useGitHubCliStatus';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import { useUpdateState } from '@/hooks/useUpdateState';
import { formatVersionLabel } from '@/lib/version-label';
import { pt } from '@/lib/platform-text';
import { uiText } from '@/lib/ui-text';
import { brand, brandText } from '@/lib/brand';
import { openImportProjectsModal } from '@/stores/importProjectsModalStore';
import { openRepoRulesModal } from '@/stores/repoRulesModalStore';
import {
  openReleaseHighlights,
  useReleaseHighlightsStore,
} from '@/stores/releaseHighlightsStore';
import { resolveManualReleaseNotesEntry } from '@/lib/release-highlights/release-highlights';
import {
  CODE_CHAT_DESTINATION_NOTE,
  detectedSources,
  IMPORT_SOURCE_ORDER,
  importSourcesLabel,
  importSourcesList,
} from '@/components/import-projects/importProjectsCopy';

function getManualUpdateStatus(
  updateState: UpdateState,
  hasManualCheck: boolean,
): { text: string | null; tone: string } {
  if (!hasManualCheck) {
    return { text: null, tone: 'fg-secondary' };
  }

  switch (updateState.phase) {
    case 'checking':
      return { text: 'Checking for updates…', tone: 'fg-secondary' };
    case 'not-available':
      return {
        text: `${brandText.appName} is up to date.`,
        tone: 'fg-secondary',
      };
    case 'available':
      return {
        text: `Version ${updateState.info?.version ?? 'latest'} is available.`,
        tone: 'fg-primary',
      };
    case 'downloaded':
      return {
        text: `Version ${updateState.info?.version ?? 'latest'} is ready to install.`,
        tone: 'fg-primary',
      };
    case 'error':
      return {
        text:
          updateState.message ??
          `${brandText.appName} could not complete the update action.`,
        tone: 'fg-destructive',
      };
    default:
      return { text: null, tone: 'fg-secondary' };
  }
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unable to create folder.';
}

// Settings never show the update server's error text.
const VERSION_LIST_ERROR = "Couldn't load versions. Try again.";
const TARGET_UPDATE_ERROR = "Couldn't start this update. Try again.";

function waitForNextPaint(): Promise<void> {
  return new Promise((resolve) => {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => resolve());
    });
  });
}

function getShellIntegrationSummary(status: CliPathStatus | null): string {
  if (!status) {
    return pt(uiText.shellIntegration.checking);
  }

  switch (status.state) {
    case 'unsupported':
      return status.reason === 'dev'
        ? uiText.shellIntegration.unsupportedDev
        : pt(uiText.shellIntegration.unsupportedPlatform);
    case 'missing':
      return pt(uiText.shellIntegration.missing);
    case 'outdated':
      return uiText.shellIntegration.outdated;
    case 'installed':
    case 'correct-symlink':
      return pt(uiText.shellIntegration.installed);
    case 'foreign-symlink':
      return pt(uiText.shellIntegration.foreignSymlink);
    case 'regular-file':
      return pt(uiText.shellIntegration.regularFile);
  }
}

interface DependencyRowProps {
  icon: JSX.Element;
  label: string;
  version: string | undefined;
}

/** A sample version the loading skeleton measures in a version's place. */
const SAMPLE_VERSION = '1.2.30';

function DependencyRow({
  icon,
  label,
  version,
}: DependencyRowProps): JSX.Element {
  return (
    <SettingsRow
      label={
        <span className="inline-flex items-center gap-2">
          <span className="shrink-0 fg-primary">{icon}</span>
          {label}
        </span>
      }
      control={
        <span className="font-mono text-xs tabular-nums fg-secondary">
          {version ?? (
            // The version is the value still on its way: a sample of its
            // real text, measured.
            <Skeleton
              loading
              label={`Loading ${label} version`}
              className="inline-block"
            >
              {SAMPLE_VERSION}
            </Skeleton>
          )}
        </span>
      }
    />
  );
}

interface DependenciesSectionProps {
  dependencyVersions: DependencyVersions | null;
}

function DependenciesSection({
  dependencyVersions,
}: DependenciesSectionProps): JSX.Element {
  return (
    <SettingsSection title="Dependencies" dataTestId="settings-dependencies">
      <SettingsGroup>
        <DependencyRow
          icon={<ClaudeIcon size="md" aria-hidden />}
          label="Claude CLI"
          version={dependencyVersions?.claudeCli}
        />
        <DependencyRow
          icon={<ClaudeIcon size="md" aria-hidden />}
          label="Claude SDK"
          version={dependencyVersions?.claudeSdk}
        />
        <DependencyRow
          icon={<CodexIcon size="md" aria-hidden />}
          label="Codex CLI"
          version={dependencyVersions?.codexCli}
        />
        <DependencyRow
          icon={<GitHubIcon size="md" aria-hidden />}
          label="GitHub CLI"
          version={dependencyVersions?.ghCli}
        />
        <DependencyRow
          icon={<GitHubIcon size="md" aria-hidden />}
          label="Octokit"
          version={dependencyVersions?.octokit}
        />
        <DependencyRow
          icon={<TerminalIcon size="sm" aria-hidden />}
          label="RTK CLI"
          version={dependencyVersions?.rtkCli}
        />
      </SettingsGroup>
    </SettingsSection>
  );
}

function noop(): void {}

/**
 * Get started's import row. It names the tools found on this computer; until
 * the presence check answers, or when it can't, the button reads "other
 * tools" and the description lists every tool the import reads.
 */
function ImportProjectsRow(): JSX.Element {
  const [detected, setDetected] = useState<ExternalProjectProvider[] | null>(
    null,
  );
  useEffect(() => {
    let cancelled = false;
    void window.api.externalProjects
      .readProviderPresence()
      .then((presence) => {
        if (!cancelled) setDetected(detectedSources(presence.providers));
      })
      .catch((error: unknown): void => {
        reportClientAppError(error);
      });
    return (): void => {
      cancelled = true;
    };
  }, []);
  const found = detected ?? [];
  const sources =
    found.length > 0
      ? importSourcesList(found, 'and')
      : importSourcesList(IMPORT_SOURCE_ORDER, 'or');
  return (
    <SettingsRow
      label="Import projects"
      dataTestId="settings-canopy-import-projects"
      description={
        <>
          Bring projects and chats from {sources} into {brandText.appName}.{' '}
          {CODE_CHAT_DESTINATION_NOTE}
        </>
      }
      control={
        <Button
          size="compact"
          onClick={(): void => {
            openImportProjectsModal({ source: 'settings' });
          }}
          data-testid="settings-canopy-import-projects-open"
        >
          Import from {importSourcesLabel(found)}
        </Button>
      }
    />
  );
}

export function CanopyTab(): JSX.Element {
  const linuxCopy = linuxUpdateCopy(brand, __CANOPY_RELEASE_FLAVOR__);
  const targetedUpdatesEnabled =
    __CANOPY_RELEASE_FLAVOR__ === 'internal' ||
    __CANOPY_RELEASE_FLAVOR__ === 'rc';
  const ghStatus = useGitHubCliStatus();
  const {
    appVersion,
    dependencyVersions,
    state: updateState,
  } = useUpdateState();
  const releaseNotesEnabled = useFeatureFlagsStore((state) =>
    state.isEnabled(CLIENT_FEATURE_FLAGS.canopySharedReleaseNotesEnabled.key),
  );
  const releaseEntries = useReleaseHighlightsStore((state) => state.entries);
  useEffect(() => {
    if (releaseNotesEnabled)
      void useReleaseHighlightsStore.getState().loadEntries();
  }, [releaseNotesEnabled]);
  const whatsNewEntry = useMemo(
    () => resolveManualReleaseNotesEntry(appVersion, releaseEntries),
    [appVersion, releaseEntries],
  );
  const [manualCheckRequested, setManualCheckRequested] = useState(false);
  const [cliStatus, setCliStatus] = useState<CliPathStatus | null>(null);
  const [cliPending, setCliPending] = useState(false);
  const [cliMessage, setCliMessage] = useState<string | null>(null);
  const [hasSavedPat, setHasSavedPat] = useState(false);
  const [auditRetentionDays, setAuditRetentionDays] = useState(7);
  const [autoDownloadUpdates, setAutoDownloadUpdates] = useState(true);
  const [automaticUpdateChecks, setAutomaticUpdateChecks] = useState(true);
  const [dataDirStatus, setDataDirStatus] = useState<
    PreferencesLoadResult['__dataDir'] | null
  >(null);
  const [dataDirPromptOpen, setDataDirPromptOpen] = useState(false);
  const [dataDirPending, setDataDirPending] = useState(false);
  const [dataDirMessage, setDataDirMessage] = useState<string | null>(null);
  const [dataDirError, setDataDirError] = useState<string | null>(null);
  const [dataDirSplashVisible, setDataDirSplashVisible] = useState(false);
  const [versionPickerOpen, setVersionPickerOpen] = useState(false);
  const [versionSearch, setVersionSearch] = useState('');
  const [versionItems, setVersionItems] = useState<TargetUpdateVersionItem[]>(
    [],
  );
  const [versionCursor, setVersionCursor] = useState<string | null>(null);
  const [versionLoading, setVersionLoading] = useState(false);
  const [versionError, setVersionError] = useState<string | null>(null);
  const [selectedDowngrade, setSelectedDowngrade] =
    useState<TargetUpdateVersionItem | null>(null);
  const [targetUpdatePending, setTargetUpdatePending] = useState(false);

  const cliStatusRequest = useRef(0);
  const refreshCliStatus = useCallback(async (): Promise<void> => {
    const request = ++cliStatusRequest.current;
    try {
      const nextStatus = await window.api.cli.getStatus();
      if (request === cliStatusRequest.current) setCliStatus(nextStatus);
    } catch {
      if (request === cliStatusRequest.current) {
        setCliMessage('Failed to check CLI integration status.');
      }
    }
  }, []);

  useEffect(() => {
    const requests = cliStatusRequest;
    const refresh = (): void => {
      void refreshCliStatus();
    };
    refresh();
    window.addEventListener('focus', refresh);
    return (): void => {
      window.removeEventListener('focus', refresh);
      ++requests.current;
    };
  }, [refreshCliStatus]);

  useEffect(() => {
    window.api
      .loadGitHubPat()
      .then((token) => {
        setHasSavedPat(typeof token === 'string' && token.trim().length > 0);
      })
      .catch(() => {
        setHasSavedPat(false);
      });
  }, []);

  useEffect(() => {
    window.api
      .loadPreferences()
      .then((prefs) => {
        setAuditRetentionDays(prefs.auditRetentionDays);
        setAutoDownloadUpdates(prefs.autoDownloadUpdates);
        setAutomaticUpdateChecks(prefs.automaticUpdateChecks);
        setDataDirStatus(prefs.__dataDir ?? null);
      })
      .catch(() => {
        setAuditRetentionDays(7);
        setDataDirStatus(null);
      });
  }, []);

  useEffect(() => {
    if (versionPickerOpen) {
      void loadTargetVersions();
    }
    // Load when the modal opens only; searches are submitted explicitly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [versionPickerOpen]);

  async function handleCreatePrimaryDataDir(): Promise<void> {
    setDataDirPending(true);
    setDataDirError(null);
    setDataDirMessage(null);
    setDataDirPromptOpen(false);
    setDataDirSplashVisible(true);
    await waitForNextPaint();

    try {
      const nextStatus = await window.api.createPrimaryDataDir();
      setDataDirStatus(nextStatus);
      setDataDirMessage(
        `Primary data folder created at ${nextStatus.path}. Restarting ${brandText.appName}...`,
      );
      try {
        const restartScheduled = await window.api.restartApp();
        if (!restartScheduled) {
          setDataDirSplashVisible(false);
          setDataDirMessage(
            `Primary data folder created at ${nextStatus.path}. Restart ${brandText.appName} to use it. Existing projects were left in the fallback folder.`,
          );
        }
      } catch {
        setDataDirSplashVisible(false);
        setDataDirMessage(
          `Primary data folder created at ${nextStatus.path}. Restart ${brandText.appName} to use it. Existing projects were left in the fallback folder.`,
        );
      }
    } catch (error) {
      setDataDirSplashVisible(false);
      setDataDirError(getErrorMessage(error));
    } finally {
      setDataDirPending(false);
    }
  }

  async function handleCliAction(): Promise<void> {
    if (!cliStatus) {
      return;
    }

    setCliPending(true);
    setCliMessage(null);

    try {
      const result =
        cliStatus.state === 'installed' || cliStatus.state === 'correct-symlink'
          ? await window.api.cli.uninstallFromPath()
          : await window.api.cli.installToPath();

      setCliMessage(
        result.success
          ? cliStatus.state === 'installed' ||
            cliStatus.state === 'correct-symlink'
            ? pt(uiText.shellIntegration.removeSuccess)
            : cliStatus.state === 'outdated'
              ? uiText.shellIntegration.updateSuccess
              : pt(uiText.shellIntegration.addSuccess)
          : result.error,
      );
      await refreshCliStatus();
    } finally {
      setCliPending(false);
    }
  }

  async function loadTargetVersions(options?: {
    cursor?: string | null;
    append?: boolean;
  }): Promise<void> {
    if (!targetedUpdatesEnabled || !window.api.update.listVersions) {
      return;
    }

    setVersionLoading(true);
    setVersionError(null);
    try {
      const result = await window.api.update.listVersions({
        query: versionSearch,
        cursor: options?.cursor ?? undefined,
        limit: 20,
      });
      setVersionItems((current) =>
        options?.append ? [...current, ...result.items] : result.items,
      );
      setVersionCursor(result.nextCursor);
    } catch {
      setVersionError(VERSION_LIST_ERROR);
    } finally {
      setVersionLoading(false);
    }
  }

  async function startTargetUpdate(
    version: TargetUpdateVersionItem,
  ): Promise<void> {
    setTargetUpdatePending(true);
    setVersionError(null);
    try {
      setManualCheckRequested(true);
      if (!window.api.update.checkForVersion) {
        throw new Error('Targeted updates are not available in this build.');
      }
      await window.api.update.checkForVersion({ tag: version.tag });
      setVersionPickerOpen(false);
      setSelectedDowngrade(null);
    } catch {
      setVersionError(TARGET_UPDATE_ERROR);
    } finally {
      setTargetUpdatePending(false);
    }
  }

  function handleSelectTargetVersion(version: TargetUpdateVersionItem): void {
    if (version.relation === 'downgrade') {
      setSelectedDowngrade(version);
      return;
    }
    void startTargetUpdate(version);
  }

  const manualUpdateStatus = getManualUpdateStatus(
    updateState,
    manualCheckRequested,
  );
  const needsUpdateAuth =
    targetedUpdatesEnabled &&
    ghStatus !== null &&
    !ghStatus.authenticated &&
    !hasSavedPat;
  const supportsCliPathManagement = isCliPathManagementPlatform(
    window.platform,
  );
  const canManageCli =
    cliStatus !== null &&
    supportsCliPathManagement &&
    (cliStatus.state === 'missing' ||
      cliStatus.state === 'outdated' ||
      cliStatus.state === 'installed' ||
      cliStatus.state === 'correct-symlink');
  const isCliInstalled =
    cliStatus?.state === 'installed' || cliStatus?.state === 'correct-symlink';
  const addedSuccessText = pt(uiText.shellIntegration.addSuccess);
  const removedSuccessText = pt(uiText.shellIntegration.removeSuccess);
  const isCliSuccessMessage =
    cliMessage !== null &&
    (cliMessage === addedSuccessText ||
      cliMessage === removedSuccessText ||
      cliMessage === uiText.shellIntegration.updateSuccess);

  useCurrentUiStateReporter(
    'settings.targetUpdate',
    targetedUpdatesEnabled
      ? {
          versionPickerOpen,
          downgradeConfirmationOpen: selectedDowngrade !== null,
          versionSearch,
          versionCount: versionItems.length,
          hasMoreVersions: versionCursor !== null,
          loading: versionLoading,
          pending: targetUpdatePending,
          errorVisible: versionError !== null,
          ...(selectedDowngrade
            ? {
                selectedVersionTag: selectedDowngrade.tag,
                ...(selectedDowngrade.relation
                  ? { selectedVersionRelation: selectedDowngrade.relation }
                  : {}),
              }
            : {}),
        }
      : null,
  );

  return (
    <SettingsPage title="General" dataTestId="settings-tab-canopy">
      {dataDirStatus?.source === 'fallback' && (
        <Notice
          intent="attention"
          data-testid="settings-data-dir-fallback-notice"
          title="Using an existing data folder from a previous install."
          detail={
            <p>
              Switching creates an empty primary data folder and restarts{' '}
              {brandText.appName}. Existing projects are not moved. The restart
              lets {brandText.appName} pick up the new folder.
            </p>
          }
          actions={
            <NoticeButton
              variant="primary"
              onClick={(): void => setDataDirPromptOpen(true)}
              disabled={dataDirPending}
              data-testid="settings-data-dir-create-primary"
            >
              Use primary folder
            </NoticeButton>
          }
        >
          {brandText.appName} is storing local data in{' '}
          <InlineCode>{dataDirStatus.path}</InlineCode> because the primary
          folder is not present.
        </Notice>
      )}

      <ErrorBanner
        errorSource="settings-data-dir-error"
        className=""
        testId="settings-data-dir-error"
        error={
          dataDirError
            ? "Couldn't create the primary data folder. Try again."
            : null
        }
        {...(dataDirError ? { details: dataDirError } : {})}
      />

      {dataDirMessage && (
        <Notice
          intent="positive"
          data-testid="settings-data-dir-primary-created"
        >
          {dataDirMessage}
        </Notice>
      )}

      <SettingsSection title="Workspace">
        <SettingsGroup>
          <NavigationModeSection />
          <ProfileRoleSection />
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection
        title="Get started"
        dataTestId="settings-canopy-get-started"
      >
        <SettingsGroup>
          <ShowTipsAgainRow />
          <ImportProjectsRow />
          <SettingsRow
            label="Cursor rules"
            dataTestId="settings-canopy-import-editor-setup"
            description={
              <>
                Use a project&apos;s Cursor rules in new chats. You review each
                rule first, and the repository stays unchanged.
              </>
            }
            control={
              <Button
                size="compact"
                onClick={(): void => {
                  openRepoRulesModal({ source: 'settings' });
                }}
                data-testid="settings-canopy-import-editor-setup-open"
              >
                Review Cursor rules
              </Button>
            }
          />
        </SettingsGroup>
      </SettingsSection>

      <SuggestionsSection />

      {dataDirPromptOpen && dataDirStatus?.source === 'fallback' && (
        <ConfirmDialog
          title="Use primary data folder?"
          message={
            <Stack gap="item">
              <p>
                This creates a new default primary data folder at{' '}
                <InlineCode>{dataDirStatus.allCandidates[0]}</InlineCode>, then
                restarts {brandText.appName}.
              </p>
              <p className="font-medium fg-primary">
                Projects will not be transitioned.
              </p>
              <p className="text-xs">
                Existing data will remain in{' '}
                <InlineCode>{dataDirStatus.path}</InlineCode>.
              </p>
            </Stack>
          }
          confirmLabel="Create and restart"
          busyLabel="Creating…"
          busy={dataDirPending}
          errorMessage={dataDirError}
          onConfirm={(): void => {
            void handleCreatePrimaryDataDir();
          }}
          onCancel={(): void => setDataDirPromptOpen(false)}
          dataTestId="settings-data-dir-confirm-modal"
          confirmTestId="settings-data-dir-confirm-create"
          cancelTestId="settings-data-dir-confirm-cancel"
        />
      )}

      {versionPickerOpen && targetedUpdatesEnabled && (
        <DialogModal
          onClose={(): void => {
            if (!versionLoading && !targetUpdatePending) {
              setVersionPickerOpen(false);
              setSelectedDowngrade(null);
            }
          }}
          title="Select version"
          titleId="settings-update-version-picker-title"
          maxWidth="lg"
          headerBorder={false}
          footer={
            <Button
              size="compact"
              variant="secondary"
              onClick={(): void => setVersionPickerOpen(false)}
              disabled={targetUpdatePending}
              data-testid="settings-update-version-close"
            >
              Close
            </Button>
          }
          dataTestId="settings-update-version-picker-modal"
          overlayClassName="z-modal"
        >
          <Stack gap="group" data-testid="settings-update-version-picker">
            <form
              className="flex gap-2"
              onSubmit={(event): void => {
                event.preventDefault();
                void loadTargetVersions();
              }}
            >
              <SearchField
                size="sm"
                value={versionSearch}
                onValueChange={setVersionSearch}
                placeholder="Search releases"
                aria-label="Search releases"
                className="flex-1"
                data-testid="settings-update-version-search-input"
              />
              <Button
                size="compact"
                type="submit"
                disabled={versionLoading}
                data-testid="settings-update-version-search"
              >
                Search
              </Button>
            </form>

            <ErrorBanner
              errorSource="canopy-tab-version"
              className=""
              error={versionError}
            />

            <Surface variant="outline" className="overflow-hidden">
              <div
                className="max-h-80 overflow-y-auto p-1"
                data-testid="settings-update-version-list"
              >
                {versionItems.length === 0 && !versionLoading ? (
                  <p
                    className="px-4 py-6 text-center text-s fg-secondary"
                    data-testid="settings-update-version-empty"
                  >
                    No matching releases.
                  </p>
                ) : (
                  versionItems.map((item) => (
                    <PickerMenuOption
                      key={item.tag}
                      onClick={(): void => handleSelectTargetVersion(item)}
                      disabled={targetUpdatePending}
                      data-testid="settings-update-version-option"
                      data-tag={item.tag}
                      data-relation={item.relation ?? 'upgrade'}
                    >
                      <PickerMenuOptionContent>
                        <PickerMenuOptionLabel>
                          {item.version}
                        </PickerMenuOptionLabel>
                        <PickerMenuOptionDescription>
                          {item.tag}
                          {item.releaseDate
                            ? ` - ${new Date(item.releaseDate).toLocaleDateString()}`
                            : ''}
                        </PickerMenuOptionDescription>
                      </PickerMenuOptionContent>
                      {item.relation && item.relation !== 'upgrade' && (
                        <Badge
                          tone={
                            item.relation === 'downgrade'
                              ? 'warning'
                              : 'neutral'
                          }
                        >
                          {item.relation === 'downgrade'
                            ? 'Downgrade'
                            : 'Current'}
                        </Badge>
                      )}
                    </PickerMenuOption>
                  ))
                )}
              </div>
            </Surface>

            <div>
              <Button
                size="compact"
                onClick={(): void => {
                  void loadTargetVersions({
                    cursor: versionCursor,
                    append: true,
                  });
                }}
                disabled={!versionCursor || versionLoading}
                data-testid="settings-update-version-load-more"
              >
                <BusyLabel busy={versionLoading}>Load more</BusyLabel>
              </Button>
            </div>
          </Stack>
        </DialogModal>
      )}

      {selectedDowngrade && targetedUpdatesEnabled && (
        <ConfirmDialog
          title="Install older version?"
          message={
            <span data-testid="settings-update-downgrade-confirmation">
              Downgrading to {selectedDowngrade.version} may make{' '}
              {brandText.appName} unusable. Proceed at your own risk.
            </span>
          }
          confirmLabel="Install older version"
          busyLabel="Starting…"
          busy={targetUpdatePending}
          errorMessage={versionError}
          destructive
          onConfirm={(): void => {
            void startTargetUpdate(selectedDowngrade);
          }}
          onCancel={(): void => setSelectedDowngrade(null)}
          dataTestId="settings-update-downgrade-modal"
          confirmTestId="settings-update-downgrade-proceed"
          cancelTestId="settings-update-downgrade-cancel"
        />
      )}

      <SettingsSection title="System">
        <SettingsGroup>
          <LaunchAtLoginSection />
          <SettingsRow
            label={pt(uiText.shellIntegration.title)}
            description={getShellIntegrationSummary(cliStatus)}
            dataTestId="settings-shell-integration"
            control={
              <Button
                size="compact"
                onClick={() => {
                  void handleCliAction();
                }}
                disabled={!canManageCli || cliPending}
                data-testid="settings-shell-integration-action"
              >
                {cliPending
                  ? isCliInstalled
                    ? 'Removing…'
                    : cliStatus?.state === 'outdated'
                      ? 'Updating…'
                      : 'Installing…'
                  : isCliInstalled
                    ? pt(uiText.shellIntegration.removeButton)
                    : cliStatus?.state === 'outdated'
                      ? uiText.shellIntegration.updateButton
                      : pt(uiText.shellIntegration.addButton)}
              </Button>
            }
          >
            {cliStatus?.bundledCliPath && (
              <p className="text-xs fg-secondary">
                Bundled CLI:{' '}
                <code className="break-all font-mono fg-primary">
                  {cliStatus.bundledCliPath}
                </code>
              </p>
            )}

            {cliStatus?.state === 'foreign-symlink' && (
              <p className="text-xs">
                <StatusLabel>
                  Existing target:{' '}
                  <code className="break-all font-mono fg-primary">
                    {cliStatus.symlinkTarget ?? 'unknown'}
                  </code>
                </StatusLabel>
              </p>
            )}

            {(cliStatus?.state === 'foreign-symlink' ||
              cliStatus?.state === 'regular-file') && (
              <p className="text-xs fg-secondary">
                {pt(uiText.shellIntegration.manualRemovalHelper)}
              </p>
            )}

            {cliMessage && (
              <p
                className="text-xs fg-secondary"
                data-testid="settings-shell-integration-message"
              >
                {isCliSuccessMessage ? (
                  cliMessage
                ) : (
                  <StatusLabel>{cliMessage}</StatusLabel>
                )}
              </p>
            )}
          </SettingsRow>
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection title="Updates">
        <SettingsGroup>
          <SettingsRow
            label="Version"
            description={
              <span data-testid="settings-app-version">
                {brandText.appName}{' '}
                <span className="tabular-nums">
                  {appVersion ? (
                    formatVersionLabel(appVersion)
                  ) : (
                    <Skeleton
                      loading
                      label="Loading version"
                      className="inline-block"
                      testId="settings-app-version-loading"
                    >
                      {SAMPLE_VERSION}
                    </Skeleton>
                  )}
                </span>
              </span>
            }
            control={
              <>
                {targetedUpdatesEnabled && (
                  <Button
                    size="compact"
                    onClick={() => {
                      setVersionPickerOpen(true);
                    }}
                    disabled={
                      updateState.phase === 'checking' || targetUpdatePending
                    }
                    data-testid="settings-update-select-version"
                  >
                    Select version
                  </Button>
                )}
                <Button
                  size="compact"
                  onClick={() => {
                    setManualCheckRequested(true);
                    void window.api.update.checkForUpdates().catch(() => {
                      // Update failures are surfaced through the update store.
                    });
                  }}
                  disabled={updateState.phase === 'checking'}
                  data-testid="settings-update-check"
                >
                  {updateState.phase === 'checking'
                    ? 'Checking…'
                    : 'Check for updates'}
                </Button>
              </>
            }
          >
            {manualUpdateStatus.text && (
              <p
                className={`text-xs ${manualUpdateStatus.tone}`}
                data-testid="settings-update-status"
              >
                {manualUpdateStatus.text}
              </p>
            )}

            {needsUpdateAuth && (
              <p className="text-xs fg-secondary">
                Private release checks need GitHub access. Authenticate with{' '}
                <code className="font-mono fg-primary">gh auth login</code> or
                save a PAT in the Account tab.
              </p>
            )}

            {updateState.phase === 'available' && (
              <div
                className={
                  window.platform === 'linux'
                    ? 'flex flex-col gap-2 text-xs fg-secondary select-text break-words'
                    : 'text-xs fg-secondary'
                }
                data-testid={
                  window.platform === 'linux'
                    ? 'settings-linux-update-guidance'
                    : undefined
                }
              >
                {window.platform === 'linux' &&
                  updateState.info?.manualDownload &&
                  linuxCopy.apt && (
                    <Stack gap="inline">
                      <p>{linuxCopy.apt.introduction}</p>
                      <code
                        className={`block font-mono ${POSTHOG_REPLAY_BLOCK_CLASS}`}
                      >
                        {linuxCopy.apt.command}
                      </code>
                      <p>{linuxCopy.apt.bootstrap}</p>
                    </Stack>
                  )}
                <p>
                  {window.platform === 'linux'
                    ? (updateState.info?.packageManagerUpdate?.guidance ??
                      updateState.info?.manualDownload?.guidance ??
                      'Check for updates again to get the official Linux download and checksum.')
                    : 'Use “Update available” in the sidebar to start the download.'}
                </p>
                {window.platform === 'linux' &&
                  updateState.info?.packageManagerUpdate && (
                    <code
                      className={`block font-mono select-text break-all ${POSTHOG_REPLAY_BLOCK_CLASS}`}
                      data-testid="settings-linux-update-command"
                    >
                      {updateState.info.packageManagerUpdate.command}
                    </code>
                  )}
                {window.platform === 'linux' &&
                  updateState.info?.manualDownload && (
                    <>
                      <Button
                        variant="secondary"
                        size="compact"
                        data-testid="settings-linux-update-download"
                        onClick={(): void => {
                          const url = updateState.info?.manualDownload?.url;
                          if (url)
                            void window.api.browser
                              .openExternal({ url })
                              .catch(() => undefined);
                        }}
                      >
                        {linuxCopy.downloadLabel}
                      </Button>
                      <code className="block font-mono select-text break-all">
                        {updateState.info.manualDownload.checksum.algorithm}:{' '}
                        {updateState.info.manualDownload.checksum.value}
                      </code>
                    </>
                  )}
              </div>
            )}
          </SettingsRow>
          {updateState.phase === 'downloaded' &&
            window.platform !== 'linux' && (
              <SettingsRow
                label="Update ready"
                dataTestId="settings-update-ready"
                description={
                  updateState.installPending
                    ? 'This update will install when all agents are idle.'
                    : 'Restart now or install the update when all agents are idle.'
                }
                control={
                  <>
                    <Button
                      size="compact"
                      onClick={() => {
                        const action = updateState.installPending
                          ? window.api.update.cancelScheduledUpdate()
                          : window.api.update.scheduleUpdate();
                        void action.catch(() => {
                          // Scheduling failures are surfaced through the updater state.
                        });
                      }}
                      data-testid="settings-update-schedule-action"
                    >
                      {updateState.installPending
                        ? 'Cancel scheduled update'
                        : 'Install when idle'}
                    </Button>
                    <Button
                      size="compact"
                      variant="primary"
                      onClick={() => {
                        void window.api.update.installUpdate().catch(() => {
                          // Install failures are surfaced through the updater state.
                        });
                      }}
                      data-testid="settings-update-install-now"
                    >
                      {updateState.installPending
                        ? 'Restart now'
                        : 'Restart to update'}
                    </Button>
                  </>
                }
              />
            )}
          {releaseNotesEnabled && whatsNewEntry && (
            <SettingsRow
              label="What's new"
              description="See the highlights for this release."
              control={
                <Button
                  size="compact"
                  onClick={(): void => openReleaseHighlights(whatsNewEntry)}
                  data-testid="settings-canopy-whats-new"
                >
                  View
                </Button>
              }
            />
          )}
          {/* Every platform: the Linux timers call the same check. A change
              applies at the updater's next tick; turning it back on does not
              check at once. The manual check above still works. */}
          <SettingsRow
            label="Check for updates automatically"
            htmlFor="settings-automatic-update-checks"
            description="Look for new versions at launch and every few hours. Turn off to check only when you choose."
            control={
              <ToggleSwitch
                id="settings-automatic-update-checks"
                checked={automaticUpdateChecks}
                label="Check for updates automatically"
                onChange={(nextValue) => {
                  const previous = automaticUpdateChecks;
                  setAutomaticUpdateChecks(nextValue);
                  void window.api
                    .savePreferences({ automaticUpdateChecks: nextValue })
                    .catch((error: unknown) => {
                      setAutomaticUpdateChecks(previous);
                      reportClientAppError(error);
                    });
                }}
                dataTestId="settings-automatic-update-checks"
              />
            }
          />
          {window.platform !== 'linux' && (
            <SettingsRow
              label="Download updates automatically"
              htmlFor="settings-auto-download-updates"
              description="Fetch updates in the background and show an indicator when one is ready. Turn off to confirm each download."
              control={
                <ToggleSwitch
                  id="settings-auto-download-updates"
                  checked={autoDownloadUpdates}
                  // Locked while automatic checks are off; the stored choice
                  // is kept and still applies after a manual check.
                  disabled={!automaticUpdateChecks}
                  label="Download updates automatically"
                  onChange={(nextValue) => {
                    setAutoDownloadUpdates(nextValue);
                    void window.api.savePreferences({
                      autoDownloadUpdates: nextValue,
                    });
                  }}
                  dataTestId="settings-auto-download-updates"
                />
              }
            />
          )}
        </SettingsGroup>
      </SettingsSection>

      <LedgerAgentRecordingSection />

      <SettingsSection title="Agent observability">
        <SettingsGroup>
          <SettingsRow
            label="Retention days"
            htmlFor="settings-audit-retention-days"
            description="How long to keep audit files for recent agent activity and usage summaries."
            control={
              <SettingsTextField
                id="settings-audit-retention-days"
                type="number"
                width="xs"
                min={1}
                max={90}
                value={auditRetentionDays}
                onChange={(event) => {
                  const nextValue = Math.min(
                    90,
                    Math.max(1, Number.parseInt(event.target.value || '7', 10)),
                  );
                  setAuditRetentionDays(nextValue);
                  void window.api.savePreferences({
                    auditRetentionDays: nextValue,
                  });
                }}
              />
            }
          />
        </SettingsGroup>
      </SettingsSection>

      <DependenciesSection dependencyVersions={dependencyVersions} />
      {/* While the data folder is created and the app restarts, the loading
          screen covers the whole window on the shared window page: nothing
          behind it takes a press or focus, and Escape cannot close Settings
          underneath it. */}
      <WindowPage
        open={dataDirSplashVisible}
        onClose={noop}
        aria-label={`Restarting ${brandText.appName}`}
        dataTestId="data-dir-restart-screen"
      >
        <AppLoadingScreen />
      </WindowPage>
    </SettingsPage>
  );
}

import type { PluginMcpNavigationTarget } from '@canopy/ui-shared/components';
import {
  marketplaceDisplayName,
  pluginDisplayName,
  Notice,
  type UnifiedEntryAlternative,
  type UnifiedEntryBundledServerRow,
} from '@canopy/ui-shared';
import {
  type JSX,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  ClaudeModAdmissionControl,
  PluginDetailHost,
  type PluginDetailHostPlugin,
  type PluginDetailInstallRequest,
  type PluginDetailInstallResult,
} from '@canopy/ui-app/capability';
import type {
  PluginDetailComponentContent,
  PluginDetailComponentType,
  PluginDetailFacetSlot,
} from '@canopy/ui-shared/components';
import type {
  MarketplaceInfo,
  PluginInfo,
} from '@canopy/execution-engine/types/plugins';
import {
  offeredPluginHarnesses,
  pluginHarnessRows,
  type PluginHarnessId,
  type PluginHarnessRow,
} from '@canopy/plugin-interop/harness-support';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { claudeModPluginId } from '@canopy/protocol/claude-mods';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { brandText } from '@/lib/brand';
import {
  applyCodexCompatDisabledToMarketplaceCaches,
  marketplaceSourceOperations,
} from '@/hooks/useMarketplaceList';
import { useShareAccess } from '@/hooks/useShareAccess';
import { usePluginMcpServerHealth } from '@/hooks/usePluginMcpServerHealth';
import { computePluginShareableRef } from '@/hooks/useUnifiedTableData';
import { SharePluginModal } from '@/components/plugins/SharePluginModal';
import { pluginNeedsInstall } from '../../lib/pluginInstallStatus';
import type { MarketplaceShareAction } from '@canopy/ui-shared/lib';
import { formatDate } from '../../lib/format';

function resultError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/** Harness rows for an installed plugin, through the shared row rule. */
function installedPluginHarnessRows(
  plugin: PluginInfo,
  harnesses: readonly PluginHarnessId[],
): PluginHarnessRow[] {
  return pluginHarnessRows({
    harnesses,
    providerSupport: plugin.providerSupport,
    codexCompatDisabled: plugin.codexCompatDisabled,
    facets: plugin.facets,
    installed: plugin.globalInstallStatus
      ? {
          claude: plugin.globalInstallStatus.claude?.installed ?? false,
          codex: plugin.globalInstallStatus.codex?.installed ?? false,
        }
      : true,
  });
}

/** Desktop IPC adapter for the browser-safe shared full-plugin composition. */
export function PluginDetailView({
  plugin,
  marketplace,
  onBack,
  onPluginUpdated,
  relatedContent,
  statusContent,
  sharedContent,
  headerActions,
  headerIcon,
  autoInstall = false,
  shareAction,
  mcpTarget,
  renderPrimaryAction,
  alternatives,
  onOpenEntryId,
  onOpenSource,
  bundledServerRows,
}: {
  onOpenSource?: () => void;
  mcpTarget?: PluginMcpNavigationTarget;
  plugin: PluginInfo;
  marketplace: MarketplaceInfo;
  /** Omitted on a page, whose breadcrumb is the way back (CAN-4261). */
  onBack?: () => void;
  onPluginUpdated: (updated: PluginInfo) => void;
  relatedContent?: ReactNode;
  /** The installed-item Status row, right under the plugin's metadata. */
  statusContent?: ReactNode;
  /** The owner's "Shared by you" section, after the install area. */
  sharedContent?: ReactNode;
  headerActions?: ReactNode;
  headerIcon?: ReactNode;
  /** Install right away, for the Marketplace's Add. Nothing signs in here. */
  autoInstall?: boolean;
  /**
   * The Marketplace's resolved Share (CAN-3704), whose flow the page owns.
   * Omitted elsewhere, where the detail shares a plugin with a public source.
   */
  shareAction?: MarketplaceShareAction;
  /** The shared Try it CTA, shown while the detail has no Install action. */
  renderPrimaryAction?: (action: {
    onInstall: () => void;
    busy: boolean;
  }) => ReactNode;
  /** The same app from other catalogs (CAN-3653). */
  alternatives?: readonly UnifiedEntryAlternative[];
  onOpenEntryId?: (entryId: string) => void;
  /** Installed MCP rows hidden behind this plugin; each opens its settings. */
  bundledServerRows?: readonly UnifiedEntryBundledServerRow[];
}): JSX.Element {
  const [shareOpen, setShareOpen] = useState(false);
  const [compatibilityError, setCompatibilityError] = useState('');
  const { requestShare, shareGateModal } = useShareAccess();
  const shareableRef = useMemo(
    () => computePluginShareableRef(plugin, marketplace),
    [marketplace, plugin],
  );
  const needsInstall = pluginNeedsInstall(plugin);
  const mcpConnectTarget = useMemo(
    () =>
      needsInstall
        ? undefined
        : { marketplaceId: marketplace.id, pluginName: plugin.name },
    [marketplace.id, needsInstall, plugin.name],
  );
  const mcpServerHealth = usePluginMcpServerHealth(
    bundledServerRows,
    mcpConnectTarget,
  );
  // List only the harnesses this build offers; the gates are its own flags.
  const cursorEnabled = useFeatureFlagsStore((state) =>
    state.isEnabled(CLIENT_FEATURE_FLAGS.canopyDesktopCursorHarness.key),
  );
  const copilotEnabled = useFeatureFlagsStore((state) =>
    state.isEnabled(CLIENT_FEATURE_FLAGS.canopyDesktopCopilotHarness.key),
  );
  const opencodeEnabled = useFeatureFlagsStore((state) =>
    state.isEnabled(CLIENT_FEATURE_FLAGS.canopyDesktopOpenCodeHarness.key),
  );
  const harnesses = useMemo(
    () =>
      offeredPluginHarnesses({
        cursor: cursorEnabled,
        copilot: copilotEnabled,
        opencode: opencodeEnabled,
      }),
    [cursorEnabled, copilotEnabled, opencodeEnabled],
  );
  const autoInstallStarted = useRef(false);
  const onPluginUpdatedRef = useRef(onPluginUpdated);
  onPluginUpdatedRef.current = onPluginUpdated;
  const [autoInstalling, setAutoInstalling] = useState(false);
  const [autoInstallError, setAutoInstallError] = useState('');
  const sourceUrl =
    typeof plugin.externalSource === 'string'
      ? plugin.externalSource
      : (plugin.externalSource?.url ?? '');
  useEffect(() => {
    if (!autoInstall || !needsInstall || autoInstallStarted.current) return;
    const release = marketplaceSourceOperations.acquire(
      marketplace.id,
      'install',
    );
    if (!release) return;
    autoInstallStarted.current = true;
    let cancelled = false;
    setAutoInstalling(true);
    void window.plugins
      .installPlugin(marketplace.id, plugin.name, sourceUrl)
      .then((result) => {
        // Leaving details does not cancel installation. Keep the marketplace
        // cache in sync even after this view has unmounted.
        if (result.success && result.data)
          onPluginUpdatedRef.current(result.data);
        else if (!cancelled)
          setAutoInstallError(result.error ?? 'Unable to install. Try again.');
      })
      .catch((cause) => {
        if (!cancelled) setAutoInstallError(resultError(cause).message);
      })
      .finally(() => {
        release();
        if (!cancelled) setAutoInstalling(false);
      });
    return (): void => {
      cancelled = true;
    };
  }, [autoInstall, needsInstall, marketplace.id, plugin.name, sourceUrl]);

  useEffect(() => {
    setCompatibilityError('');
    if (
      needsInstall ||
      plugin.providerSupport.codex !== 'compat' ||
      plugin.codexCompatDisabled === true ||
      plugin.facets.codex ||
      plugin.facets.codexCompatibility
    )
      return;
    let cancelled = false;
    void window.plugins
      .prepareCodexCompatibilityPlugin(plugin.marketplaceId, plugin.name)
      .then((result) => {
        if (cancelled) return;
        if (result.success && result.data) {
          onPluginUpdated(result.data);
        } else {
          setCompatibilityError(
            result.error ?? 'Failed to prepare Codex compatibility details.',
          );
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) setCompatibilityError(resultError(error).message);
      });
    return (): void => {
      cancelled = true;
    };
  }, [needsInstall, onPluginUpdated, plugin]);

  const readComponent = useCallback(
    async (
      _componentType: PluginDetailComponentType,
      componentFile: string,
      activeFacet: PluginDetailFacetSlot | undefined,
    ): Promise<PluginDetailComponentContent | null> => {
      const facet = activeFacet?.facet;
      const facetInstallRoot = facet?.cachePath ?? facet?.installLocation;
      const effectiveInstallLocation =
        facetInstallRoot ?? plugin.cachePath ?? marketplace.installLocation;
      const effectiveSourcePath = facetInstallRoot
        ? ''
        : (facet?.sourcePath ?? (plugin.cachePath ? '' : plugin.sourcePath));
      const result = await window.plugins.readComponentContent(
        effectiveInstallLocation,
        effectiveSourcePath,
        componentFile,
      );
      if (result.success && result.data) return result.data;
      if (result.error) throw new Error(result.error);
      return null;
    },
    [marketplace.installLocation, plugin.cachePath, plugin.sourcePath],
  );

  const install = async (
    request: PluginDetailInstallRequest,
  ): Promise<PluginDetailInstallResult> => {
    const release = marketplaceSourceOperations.acquire(
      marketplace.id,
      'install',
    );
    if (!release)
      throw new Error(
        'This marketplace is busy. Try again when the current operation finishes.',
      );
    try {
      setAutoInstallError('');
      if (request.kind === 'providers') {
        const result = await window.plugins.installBuiltInPlugin({
          marketplaceId: plugin.marketplaceId,
          pluginName: plugin.name,
          providers: request.providers,
        });
        if (!result.success || !result.data)
          throw new Error(result.error ?? 'Unknown error.');
        onPluginUpdated(result.data.plugin);
        return result.data;
      }
      if (!plugin.externalSource)
        throw new Error('Plugin has no external source.');
      const sourceUrl =
        typeof plugin.externalSource === 'string'
          ? plugin.externalSource
          : (plugin.externalSource.url ?? '');
      const result = await window.plugins.installPlugin(
        marketplace.id,
        plugin.name,
        sourceUrl,
      );
      if (!result.success || !result.data)
        throw new Error(result.error ?? 'Failed to install plugin.');
      onPluginUpdated(result.data);
      return { plugin: result.data };
    } finally {
      release();
    }
  };

  const toggleCodexCompat = async (
    disabled: boolean,
  ): Promise<PluginDetailHostPlugin> => {
    try {
      const result = await window.plugins.setCodexCompatDisabled(
        plugin.marketplaceId,
        plugin.name,
        disabled,
      );
      if (!result.success || !result.data)
        throw new Error(
          result.error ?? 'Failed to update Codex compatibility setting.',
        );
      applyCodexCompatDisabledToMarketplaceCaches(
        plugin.marketplaceId,
        plugin.name,
        disabled,
      );
      onPluginUpdated(result.data);
      return result.data;
    } catch (error) {
      throw resultError(error);
    }
  };

  // A Marketplace host resolves Share itself, so the card, detail and click
  // agree. Other hosts keep the local rule: Share only with a public source.
  const resolvedShareAction: MarketplaceShareAction | undefined =
    shareAction ??
    (shareableRef
      ? {
          status: 'shareable',
          onShare: (): void => {
            requestShare(
              {
                title: 'Sign in to share plugins',
                description:
                  'Connect your account to create a public plugin link.',
              },
              () => setShareOpen(true),
            );
          },
        }
      : undefined);

  return (
    <>
      <PluginDetailHost
        plugin={plugin}
        modsControl={
          <ClaudeModAdmissionControl
            pluginId={claudeModPluginId(
              plugin.facets?.claude?.name ?? plugin.name,
              plugin.marketplaceId,
            )}
          />
        }
        mcpTarget={mcpTarget}
        onBack={onBack}
        loadDetail={(): Promise<PluginInfo> => Promise.resolve(plugin)}
        readComponent={readComponent}
        onInstall={install}
        shareAction={resolvedShareAction}
        onToggleCodexCompat={toggleCodexCompat}
        relatedContent={relatedContent}
        headerActions={headerActions}
        renderPrimaryAction={renderPrimaryAction}
        alternatives={alternatives}
        onOpenSource={onOpenSource}
        sourceName={marketplaceDisplayName(marketplace.name)}
        onOpenEntryId={onOpenEntryId}
        bundledServerRows={bundledServerRows}
        mcpServerHealth={mcpServerHealth}
        headerIcon={headerIcon}
        statusContent={statusContent}
        sharedContent={sharedContent}
        // Where an installed plugin runs: every offered harness, signed in or not.
        harnessRows={
          !needsInstall
            ? installedPluginHarnessRows(plugin, harnesses)
            : undefined
        }
        needsInstall={needsInstall}
        loading={autoInstalling}
        brandName={brandText.appName}
        compatibilityError={compatibilityError}
        formatDate={formatDate}
      />
      {autoInstallError && (
        <Notice errorSource="plugin-detail-auto-install" intent="destructive">
          {autoInstallError}
        </Notice>
      )}
      {shareOpen && shareableRef && (
        <SharePluginModal
          pluginRef={shareableRef}
          name={pluginDisplayName(plugin)}
          description={plugin.description}
          onClose={() => setShareOpen(false)}
        />
      )}
      {shareGateModal}
    </>
  );
}

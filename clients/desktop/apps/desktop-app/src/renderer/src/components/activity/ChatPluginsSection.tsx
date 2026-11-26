import { Stack } from '@canopy/ui-shared/components';
import { useOrganizationLayer } from '@/stores/organizationLayerStore';
import { flattenMcpServerRows } from '@canopy/desktop-shared/lib/mcp-server-rows';
import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { PluginsIcon, PlusMediumIcon } from '@canopy/ui-shared/icons/AppIcons';
import {
  ActivityItemRow,
  AddedPluginsList,
  HeaderActionButton,
  ShareActionButton,
  Badge,
  shareAudienceLabelText,
  type AddedPluginItem,
  Heading,
} from '@canopy/ui-shared/components';
import { SkillIcon } from '@canopy/ui-shared/icons';
import { getDocument } from '@canopy/ui-shared/panels';
import { shareTargetFromEnableRef } from '@canopy/desktop-shared/lib/skill-share-nudge';
import { subtractPluginSelections } from '@canopy/desktop-shared/lib/effective-plugin-selections';
import type { ChatTabPluginSelections } from '@canopy/desktop-shared/types';
import { requestComposerAction } from '@/lib/composerShortcutRequests';
import { useActiveChatTabRenderState, useChatStore } from '@/stores/chatStore';
import { useGlobalPluginDefaultsStore } from '@/stores/globalPluginDefaultsStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { useModelCatalogStore } from '@/stores/modelCatalogStore';
import { useGitHubStore } from '@/stores/githubStore';
import {
  editChatPlugins,
  inheritedDefaultLayers,
  renderedChatPluginEditingState,
} from '@/lib/chatPluginEditing';
import { PanelSection } from '@/components/shared/panel-section';
import {
  useChatMentionIndex,
  useChatShareData,
  type ChatShareData,
} from '@/hooks/useChatShareData';
import { collectChatSkillUsage } from '@/lib/chatSkillUsage';
import type { InvocableMentionTarget } from '@/lib/invocableMentionIndex';
import {
  pluginDisplayName,
  resolveShareTarget,
  shareAudienceForTarget,
} from '@/lib/invocableShareTarget';
import {
  requestShare,
  useShareHostAvailable,
} from '@/stores/shareRequestStore';
import type { ChatMessage } from '@/stores/chat/types';
import { McpServerLogo } from '@/components/shared/McpServerLogo';
import type { ActivitySectionRenderProps } from './activity-sections';
import { useDesktopInstalledItemStatuses } from '@/hooks/useDesktopInstalledItemStatuses';
import { installedSelectionIsDisabled } from '@canopy/ui-shared';

function selectedRows(
  selections: ChatTabPluginSelections | undefined,
): (AddedPluginItem & { selection: ChatTabPluginSelections })[] {
  if (!selections) return [];
  const empty = {
    collectionIds: [],
    skillRefs: [],
    pluginRefs: [],
    mcpServerRefs: [],
  };
  return [
    ...selections.pluginRefs.map((ref) => ({
      id: `plugin:${ref.marketplaceId}/${ref.pluginName}`,
      name: ref.pluginName,
      source: ref.marketplaceId,
      selection: { ...empty, pluginRefs: [ref] },
    })),
    ...selections.skillRefs.map((ref) => ({
      id: `skill:${ref.sourceId}/${ref.skillName}`,
      name: ref.skillName,
      source: ref.sourceId,
      selection: { ...empty, skillRefs: [ref] },
    })),
    ...selections.collectionIds.map((id) => ({
      id: `collection:${id}`,
      name: 'Collection',
      source: 'Collection',
      selection: { ...empty, collectionIds: [id] },
    })),
    // A project's shared connection is listed in the MCP servers card, with
    // its state, instead (CAN-6246).
    ...(selections.mcpServerRefs ?? [])
      .filter((ref) => ref.owner?.type !== 'organization')
      .map((ref) => ({
        id: `mcp:${ref.serverId}/${ref.configId}`,
        name: ref.serverId,
        source: ref.configId,
        selection: { ...empty, mcpServerRefs: [ref] },
      })),
  ];
}

type InheritedDefaultLayer = 'project' | 'global';

const INHERITED_DEFAULT_LABELS: Record<InheritedDefaultLayer, string> = {
  project: 'Project default',
  global: 'Global default',
};

/** Re-render when any layer `chatPluginEditingState` reads changes. */
function useChatPluginLayerSubscriptions(
  projectId: string,
  worktreeId: string,
): void {
  useGlobalPluginDefaultsStore((state) => state.selections);
  useGlobalPluginDefaultsStore((state) => state.hydrated);
  useModelCatalogStore((state) => state.snapshot?.agents);
  useChatStore(
    (state) => state.worktreeDefaultPlugins[`${projectId}/${worktreeId}`],
  );
  useProjectsStore(
    (state) =>
      state.projects.find((project) => project.id === projectId)
        ?.defaultPluginSelections,
  );
  useProjectsStore(
    (state) =>
      state.projects.find((project) => project.id === projectId)
        ?.disabledGlobalPluginSelections,
  );
  // The organization's shared set (CAN-6237); also starts its read when no
  // other surface has.
  useOrganizationLayer(projectId, worktreeId);
}

const NO_USAGE: readonly InvocableMentionTarget[] = [];

/**
 * The skills and commands the active chat used, for the "Used in this chat"
 * group. The transcript is read only while the chat is settled: a streaming
 * turn keeps that chat's last settled answer instead of re-deriving it on
 * every token, and switching chats never shows another chat's rows.
 */
function useChatSkillUsage(
  projectId: string,
  worktreeId: string,
): readonly InvocableMentionTarget[] {
  const chatId = useChatStore(
    (state) => state.worktreeChats[`${projectId}/${worktreeId}`]?.activeTabId,
  );
  // `null` while streaming, so streamed text never re-renders the rail.
  const settledMessages = useChatStore((state): ChatMessage[] | null => {
    const chats = state.worktreeChats[`${projectId}/${worktreeId}`];
    const tab = chats?.tabs.find((item) => item.id === chats.activeTabId);
    if (!tab || tab.status === 'streaming') return null;
    return tab.messages;
  });
  const mentionIndex = useChatMentionIndex();
  const computed = useMemo(
    () =>
      settledMessages === null
        ? null
        : collectChatSkillUsage(settledMessages, mentionIndex),
    [mentionIndex, settledMessages],
  );
  const retained = useRef<{
    chatId: string | undefined;
    usage: readonly InvocableMentionTarget[];
  } | null>(null);
  if (retained.current?.chatId !== chatId) retained.current = null;
  if (computed !== null) retained.current = { chatId, usage: computed };
  const current = retained.current;
  return current !== null && current.chatId === chatId
    ? current.usage
    : NO_USAGE;
}

export function useChatPluginsHasContent(
  projectId: string,
  worktreeId: string,
): boolean {
  const chatId = useActiveChatTabRenderState(
    `${projectId}/${worktreeId}`,
    (entry) => entry.tab?.id,
  );
  useChatPluginLayerSubscriptions(projectId, worktreeId);
  const used = useChatSkillUsage(projectId, worktreeId);
  return (
    chatId !== undefined &&
    (used.length > 0 ||
      selectedRows(
        renderedChatPluginEditingState(useChatStore.getState(), {
          projectId,
          worktreeId,
          chatId,
        })?.effective,
      ).length > 0)
  );
}

/**
 * One used skill or command. Every used item gets a row, shareable or not; a
 * plugin-owned row names its plugin and its Share opens that plugin's dialog.
 */
function UsedInvocableRow({
  target,
  data,
  hostAvailable,
}: {
  target: InvocableMentionTarget;
  data: ChatShareData;
  hostAvailable: boolean;
}): JSX.Element {
  const rowRef = useRef<HTMLDivElement | null>(null);
  // `null` for a Cursor chat's inherited home-folder row: the user's own file,
  // used in this chat, but not a Canopy resource that can be shared.
  const shareTarget = shareTargetFromEnableRef(target.entry.enableRef);
  const pluginName =
    shareTarget?.kind === 'plugin'
      ? pluginDisplayName(shareTarget, data.marketplaces)
      : null;
  const shareable =
    hostAvailable &&
    shareTarget !== null &&
    resolveShareTarget(shareTarget, data.installedSkills, data.marketplaces)
      .status === 'resolved';
  const audience =
    shareable && shareTarget ? shareAudienceForTarget(shareTarget, data) : null;
  const sharedState = audience?.status === 'shared' ? audience : null;
  const sharedAudience = sharedState?.audience;
  const audienceLabel = sharedAudience
    ? shareAudienceLabelText(sharedAudience, sharedState?.teamName)
    : null;
  const hasMetadata = Boolean(pluginName || sharedAudience);
  const shareName =
    pluginName ??
    (shareTarget?.kind === 'skill' ? shareTarget.name : target.label);
  return (
    <div ref={rowRef}>
      <ActivityItemRow
        dataTestId="chat-used-invocable-row"
        icon={<SkillIcon size="sm" aria-hidden="true" />}
        labelTitle={target.entry.description || undefined}
        label={
          <span
            className="block truncate"
            data-testid="chat-used-invocable-name"
            title={target.label}
          >
            {target.label}
          </span>
        }
        secondaryContent={
          hasMetadata ? (
            <div
              className="flex min-w-0 items-center gap-2"
              data-testid="chat-used-invocable-metadata"
            >
              {pluginName ? (
                <span
                  className="min-w-0 truncate text-xs fg-tertiary"
                  data-testid="chat-used-invocable-plugin"
                  title={`From ${pluginName}`}
                >
                  From {pluginName}
                </span>
              ) : null}
              {/* DESIGN.md's plain-metadata rule has a bounded exception here:
                Used in this chat uses a quiet audience pill on line two. */}
              {sharedAudience ? (
                <Badge
                  data-testid="chat-used-invocable-audience"
                  className={pluginName ? 'max-w-1/2' : 'max-w-full'}
                >
                  <span
                    className="min-w-0 truncate"
                    data-share-audience={sharedAudience}
                    title={audienceLabel ?? undefined}
                  >
                    {audienceLabel}
                  </span>
                </Badge>
              ) : null}
            </div>
          ) : undefined
        }
      >
        {shareable && shareTarget ? (
          <ShareActionButton
            placement="row"
            ariaLabel={`Share ${shareName}`}
            dataTestId="chat-used-invocable-share"
            onClick={() => {
              requestShare(shareTarget, {
                source: 'activity_panel',
                ownerDocument: getDocument(rowRef.current),
              });
            }}
          />
        ) : null}
      </ActivityItemRow>
    </div>
  );
}

export function ChatPluginsSection({
  projectId,
  worktreeId,
}: ActivitySectionRenderProps): JSX.Element {
  const installedStatus = useDesktopInstalledItemStatuses();
  const snapshot = useActiveChatTabRenderState(
    `${projectId}/${worktreeId}`,
    useShallow(({ tab }) => {
      return {
        id: tab?.id,
        selections: tab?.pluginSelections,
        tombstones: tab?.disabledGlobalPluginSelections,
        inheritedPluginDefaultsVersion: tab?.inheritedPluginDefaultsVersion,
        model: tab?.model,
        readOnly: tab?.readOnly,
        status: tab?.status,
      };
    }),
  );
  useChatPluginLayerSubscriptions(projectId, worktreeId);
  const used = useChatSkillUsage(projectId, worktreeId);
  const hostAvailable = useShareHostAvailable();
  const shareData = useChatShareData(used.length > 0);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const target = useMemo(
    () => (snapshot.id ? { projectId, worktreeId, chatId: snapshot.id } : null),
    [projectId, worktreeId, snapshot.id],
  );
  const resolved = target
    ? renderedChatPluginEditingState(useChatStore.getState(), target)
    : null;
  const pluginIdsRef = useRef<string[]>([]);
  pluginIdsRef.current = (resolved?.effective?.pluginRefs ?? []).map(
    (ref) => `plugin:${ref.marketplaceId}/${ref.pluginName}`,
  );
  const selectedPluginIds = JSON.stringify(pluginIdsRef.current);
  const [logoUrls, setLogoUrls] = useState<Record<string, string>>({});
  const [displayNames, setDisplayNames] = useState<Record<string, string>>({});
  useEffect(() => {
    let cancelled = false;
    if (selectedPluginIds === '[]') return;
    const ids = pluginIdsRef.current;
    const selected = new Map<string, string>(
      ids.map((id) => {
        const slash = id.lastIndexOf('/');
        return [id.slice(0, slash + 1) + id.slice(slash + 1).toLowerCase(), id];
      }),
    );
    // Decoration reads existing metadata only; never refresh provider catalogs.
    void window.plugins
      .loadMarketplacesCacheOnly()
      .then((result) => {
        if (cancelled || !result.success || !result.data) return;
        const urls: Record<string, string> = {};
        const names: Record<string, string> = {};
        for (const marketplace of result.data.marketplaces) {
          for (const plugin of marketplace.plugins) {
            const id = `plugin:${marketplace.id}/${plugin.name.toLowerCase()}`;
            const selectedId = selected.get(id);
            const logoUrl =
              plugin.logoUrl ??
              plugin.facets.codex?.logoUrl ??
              plugin.facets.claude?.logoUrl;
            if (selectedId) {
              if (logoUrl) urls[selectedId] = logoUrl;
              const displayName = plugin.displayName?.trim();
              if (displayName) names[selectedId] = displayName;
            }
          }
        }
        setLogoUrls(urls);
        setDisplayNames(names);
      })
      .catch(() => {
        // A missing catalog is non-fatal: retain the plugin placeholder.
      });
    return (): void => {
      cancelled = true;
    };
  }, [selectedPluginIds]);
  const mcpRefsRef = useRef<
    NonNullable<ChatTabPluginSelections['mcpServerRefs']>
  >([]);
  mcpRefsRef.current = resolved?.effective?.mcpServerRefs ?? [];
  const selectedMcpRefs = JSON.stringify(mcpRefsRef.current);
  const [mcpMetadata, setMcpMetadata] = useState<
    Record<string, { name: string; logoUrl?: string; curatedKey?: string }>
  >({});
  useEffect(() => {
    let cancelled = false;
    if (selectedMcpRefs === '[]') return;
    const refs = mcpRefsRef.current;
    // Use the same local index as the picker; do not refresh integrations.
    void window.mcpServers
      .loadIndex()
      .then((index) => {
        if (cancelled) return;
        const metadata: Record<
          string,
          { name: string; logoUrl?: string; curatedKey?: string }
        > = {};
        const servers = flattenMcpServerRows(index.servers);
        for (const ref of refs) {
          const server = servers.find((entry) => entry.id === ref.serverId);
          if (!server) continue;
          const config = server.configs.find(
            (entry) => entry.id === ref.configId,
          );
          const multipleConfigs =
            server.configs.filter((entry) => entry.enabled).length > 1;
          metadata[`mcp:${ref.serverId}/${ref.configId}`] = {
            name:
              multipleConfigs && config
                ? `${server.name} — ${config.name}`
                : server.name,
            logoUrl: server.logoUrl,
            curatedKey: server.curatedKey,
          };
        }
        setMcpMetadata(metadata);
      })
      .catch(() => {
        // Keep the existing fallback when local metadata is unavailable.
      });
    return (): void => {
      cancelled = true;
    };
  }, [selectedMcpRefs]);
  const selectedCollectionIds = JSON.stringify(
    resolved?.effective?.collectionIds ?? [],
  );
  const [collectionNames, setCollectionNames] = useState<
    Record<string, string>
  >({});
  useEffect(() => {
    if (selectedCollectionIds === '[]') return;
    let cancelled = false;
    void window.collections
      .loadIndex()
      .then((collections) => {
        if (cancelled) return;
        setCollectionNames(
          Object.fromEntries(
            collections.map((collection) => [
              `collection:${collection.id}`,
              collection.name,
            ]),
          ),
        );
      })
      .catch(() => {
        // Keep the readable fallback if the local index is unavailable.
      });
    return (): void => {
      cancelled = true;
    };
  }, [selectedCollectionIds]);
  const locked = new Set(selectedRows(resolved?.agent).map((row) => row.id));
  const inheritedLayers = resolved ? inheritedDefaultLayers(resolved) : {};
  const inheritedLayerById = new Map<string, InheritedDefaultLayer>([
    ...selectedRows(inheritedLayers.global).map(
      (row): [string, InheritedDefaultLayer] => [row.id, 'global'],
    ),
    ...selectedRows(inheritedLayers.project).map(
      (row): [string, InheritedDefaultLayer] => [row.id, 'project'],
    ),
  ]);
  const rows = selectedRows(resolved?.effective).map((row) => {
    const inheritedLayer = inheritedLayerById.get(row.id);
    return {
      ...row,
      installedDisabled:
        installedStatus.state.kind === 'ready' &&
        [
          ...row.selection.pluginRefs.map((ref) => ({
            kind: 'plugin' as const,
            ...ref,
          })),
          ...row.selection.skillRefs.map((ref) => ({
            kind: 'skill' as const,
            ...ref,
          })),
          ...row.selection.collectionIds.map((collectionId) => ({
            kind: 'collection' as const,
            collectionId,
          })),
          ...(row.selection.mcpServerRefs ?? []).map((ref) => ({
            kind: 'mcp-config' as const,
            ...ref,
          })),
        ].some(
          (ref) =>
            installedStatus.state.kind === 'ready' &&
            installedSelectionIsDisabled(installedStatus.state.snapshot, ref),
        ),
      name:
        collectionNames[row.id] ??
        mcpMetadata[row.id]?.name ??
        displayNames[row.id] ??
        row.name,
      locked: locked.has(row.id),
      source: inheritedLayer
        ? `${row.source} · ${INHERITED_DEFAULT_LABELS[inheritedLayer]}`
        : row.source,
    };
  });
  const disabled =
    !target || pending || snapshot.readOnly || snapshot.status === 'streaming';
  const openPicker = (): void => {
    if (!target || disabled) return;
    setError(null);
    if (!requestComposerAction({ scope: 'chat', ...target }, 'plugins')) {
      useGitHubStore
        .getState()
        .addToast('Open this chat to add plugins.', 'error', undefined, {
          forceInApp: true,
          projectId,
          worktreeId,
        });
    }
  };
  return (
    <PanelSection
      title="Plugins"
      hasExpandableContent={rows.length > 0 || used.length > 0}
      actionOnlyCard
      actionOnlyLabel="Add plugins"
      icon={<PluginsIcon />}
      headerAction={
        <HeaderActionButton
          iconOnly
          aria-label="Add plugins"
          data-testid="activity-plugins-add"
          disabled={disabled}
          onClick={openPicker}
        >
          <PlusMediumIcon size={16} />
        </HeaderActionButton>
      }
    >
      <Stack gap="item">
        {used.length > 0 && rows.length === 0 && !error ? null : (
          <AddedPluginsList
            items={rows}
            renderIcon={(item) => (
              <span
                data-testid="activity-plugin-avatar"
                data-inherited-default={inheritedLayerById.get(item.id)}
                className="flex size-4 shrink-0 items-center justify-center"
              >
                <McpServerLogo
                  key={
                    mcpMetadata[item.id]?.curatedKey ??
                    mcpMetadata[item.id]?.logoUrl ??
                    logoUrls[item.id] ??
                    'placeholder'
                  }
                  curatedKey={mcpMetadata[item.id]?.curatedKey}
                  logoUrl={mcpMetadata[item.id]?.logoUrl ?? logoUrls[item.id]}
                  size={16}
                  shape="circle"
                  fit="cover"
                  fallback="monogram"
                  name={item.name}
                  imgTestId="activity-plugin-logo"
                  fallbackTestId="activity-plugin-icon"
                />
              </span>
            )}
            disabled={disabled}
            error={error}
            onDisable={(id) => {
              const row = rows.find((item) => item.id === id);
              if (!target || !row || row.locked || pending) return;
              setPending(true);
              setError(null);
              void editChatPlugins(useChatStore.getState, target, (current) =>
                subtractPluginSelections(current, row.selection),
              )
                .catch((reason: unknown) =>
                  setError(
                    reason instanceof Error ? reason.message : String(reason),
                  ),
                )
                .finally(() => setPending(false));
            }}
          />
        )}
        {used.length > 0 ? (
          <div
            data-testid="chat-used-invocables"
            className="flex flex-col gap-1"
          >
            <Heading level={4} variant="label">
              Used in this chat
            </Heading>
            {used.map((target) => (
              <UsedInvocableRow
                key={target.entry.id}
                target={target}
                data={shareData}
                hostAvailable={hostAvailable}
              />
            ))}
          </div>
        ) : null}
      </Stack>
    </PanelSection>
  );
}

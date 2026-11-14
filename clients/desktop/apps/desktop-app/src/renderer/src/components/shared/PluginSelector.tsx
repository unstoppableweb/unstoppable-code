import type {
  PluginDetails,
  PluginInfo,
} from '@canopy/execution-engine/types/plugins';
import {
  cursorLoadsPluginMemberKind,
  cursorPluginFacetProvider,
  type CursorLoadablePluginMemberKind,
} from '@canopy/desktop-shared/lib/cursor-capabilities';
import type { CapabilityUnavailable } from '@canopy/protocol/capability-bundle';
import {
  INHERITED_DEFAULT_BADGE_LABELS,
  mcpSelectionKey,
  mcpServerRowSurface,
  pluginSelectionKey,
  skillSelectionKey,
  UnavailableRemoveAction,
  withUnavailableRows,
} from '@canopy/ui-app/capability';
import { UNIFIED_ENTRY_SURFACE_LABELS } from '@canopy/ui-shared';
import type { SelectionTableCopy } from '@canopy/ui-shared/lib';
import { type JSX, useCallback, useEffect, useMemo, useState } from 'react';
import { useCollectionList } from '@/hooks/useCollectionList';
import {
  PROVIDER_CONNECTOR_SOURCE_ID,
  useUnifiedTableData,
  type UnifiedTableRow,
} from '@/hooks/useUnifiedTableData';
import { CollectionModal } from '../pages/CollectionsTab';
import { UnifiedTableDetailOverlays } from '../pages/UnifiedTableDetailOverlays';
import { useUnifiedTableDetailView } from '../pages/unifiedTableDetailView';
import { UnifiedTable } from './UnifiedTable';
import { normalizePluginSelections } from '@canopy/execution-engine/lib/plugin-selections-normalization';
import {
  getUnsupportedReason,
  type PluginSelectorProviderScope,
} from './pluginSelectorScope';
import type { ProviderSupportScope } from './ProviderSupportIcons';
import type { ChatTabPluginSelections } from '@canopy/desktop-shared/types';

export type { PluginSelectorProviderScope };

/**
 * What a Cursor-style session (Cursor, Copilot) loads from a plugin, for the
 * row's member preview: the facet it reads (Claude first, else native Codex),
 * less the member kinds that never load there. Same rule as the detail
 * page's Cursor row and the resolver, read from the shared export.
 */
function cursorPreviewDetails(
  plugin: PluginInfo,
): Pick<PluginDetails, 'skills' | 'commands' | 'mcpServers'> | undefined {
  const provider = cursorPluginFacetProvider(plugin.facets);
  const facet = plugin.facets[provider]?.details;
  if (!facet) return undefined;
  const loads = (kind: CursorLoadablePluginMemberKind): boolean =>
    cursorLoadsPluginMemberKind(provider, kind);
  return {
    skills: loads('skills') ? facet.skills : [],
    mcpServers: loads('mcpServers') ? facet.mcpServers : [],
    commands: loads('commands') ? facet.commands : [],
  };
}

/** Default layers a chat inherits, for badging matching picker rows. */
export interface PluginSelectorInheritedDefaults {
  project?: ChatTabPluginSelections;
  global?: ChatTabPluginSelections;
}

const PROVIDER_SCOPE_LABELS: Record<PluginSelectorProviderScope, string> = {
  claude: 'Claude',
  codex: 'Codex',
  ollama: 'Ollama',
  cursor: 'Cursor',
  antigravity: 'Antigravity',
  copilot: 'GitHub Copilot',
  opencode: 'OpenCode',
  mixed: 'All supported providers',
};

interface PluginSelectorProps {
  selections: ChatTabPluginSelections;
  onChange: (selections: ChatTabPluginSelections) => void;
  /** What selecting means in this picker; words only. */
  selectionCopy?: SelectionTableCopy;
  /**
   * Scope hint controlling which plugin rows are selectable. Defaults to
   * `'mixed'` (every plugin enabled). `undefined` is treated identically to
   * `'mixed'`.
   */
  providerScope?: PluginSelectorProviderScope;
  /**
   * Provider-scoped selections with unsupported plugin refs removed. Used by
   * modal save buttons so stale selections from a previous provider cannot be
   * persisted again just because the user opened and saved the picker.
   */
  onSanitizedChange?: (selections: ChatTabPluginSelections) => void;
  /**
   * Skills that are forced on for the surface and cannot be removed. Matching
   * skill rows render checked + disabled (`toggleMode: 'locked'`) regardless of
   * provider scope. Used by the embedded pipeline-editor chat drawer to surface
   * its required brand-specific pipeline-writing skill as a locked entry.
   */
  lockedSkillRefs?: { sourceId: string; skillName: string }[];
  /**
   * Selections inherited from the current assistant. These rows stay checked
   * and cannot be removed while that assistant remains selected.
   */
  lockedSelections?: ChatTabPluginSelections;
  /**
   * Default layers the chat inherits. Matching rows get a neutral badge
   * naming the layer (the project layer wins when both supply a row). The
   * rows stay toggleable.
   */
  inheritedDefaults?: PluginSelectorInheritedDefaults;
  /**
   * Records of selected capabilities the chat can no longer use. Matching rows
   * get their status and a Remove action, and a selected one the inventory no
   * longer lists gets a row of its own. Desktop chats do not record any yet.
   */
  unavailable?: readonly CapabilityUnavailable[];
  /**
   * Pads the selector inside its own `px-6 py-3` gutter. Defaults to `true`
   * for full-bleed dialogs; pass `false` when the host panel already pads.
   */
  inset?: boolean;
}

const NO_UNAVAILABLE: readonly CapabilityUnavailable[] = [];

function selectionRowKeys(
  selections: ChatTabPluginSelections | undefined,
): string[] {
  if (!selections) return [];
  const normalized = normalizePluginSelections(selections);
  return [
    ...normalized.collectionIds,
    ...normalized.skillRefs.map((r) =>
      skillSelectionKey(r.sourceId, r.skillName),
    ),
    ...normalized.pluginRefs.map((r) =>
      pluginSelectionKey(r.marketplaceId, r.pluginName),
    ),
    ...(normalized.mcpServerRefs ?? []).map((r) =>
      mcpSelectionKey(r.serverId, r.configId),
    ),
  ];
}

function withInheritedDefaultBadge(
  row: UnifiedTableRow,
  layer: keyof PluginSelectorInheritedDefaults | undefined,
): UnifiedTableRow {
  if (!layer) return row;
  return {
    ...row,
    badges: [
      ...(row.badges ?? []),
      { label: INHERITED_DEFAULT_BADGE_LABELS[layer], tone: 'neutral' },
    ],
  };
}

function buildSelections(
  collections: Set<string>,
  skills: Set<string>,
  plugins: Set<string>,
  mcpKeys: Set<string>,
): ChatTabPluginSelections {
  return {
    collectionIds: Array.from(collections).sort(),
    skillRefs: Array.from(skills)
      .sort()
      .map((k) => {
        const lastSlash = k.lastIndexOf('/');
        return {
          sourceId: k.slice(0, lastSlash),
          skillName: k.slice(lastSlash + 1),
        };
      }),
    pluginRefs: Array.from(plugins)
      .sort()
      .map((k) => {
        const lastSlash = k.lastIndexOf('/');
        return {
          marketplaceId: k.slice(0, lastSlash),
          pluginName: k.slice(lastSlash + 1),
        };
      }),
    mcpServerRefs: Array.from(mcpKeys)
      .sort()
      .map((k) => {
        const slash = k.indexOf('/');
        return {
          serverId: k.slice(0, slash),
          configId: k.slice(slash + 1),
        };
      }),
  };
}

function withMcpSurfaceBadge(row: UnifiedTableRow): UnifiedTableRow {
  if (
    row.kind !== 'mcp' ||
    row.rowOrigin !== 'catalog' ||
    row.sourceId === PROVIDER_CONNECTOR_SOURCE_ID ||
    !('configs' in row.original)
  )
    return row;
  return {
    ...row,
    badges: [
      ...(row.badges ?? []),
      {
        label: UNIFIED_ENTRY_SURFACE_LABELS[mcpServerRowSurface(row.original)],
        tone: 'neutral',
      },
    ],
  };
}

function unionSets(base: Set<string>, incoming: Set<string>): Set<string> {
  return new Set<string>([
    ...Array.from<string>(base),
    ...Array.from<string>(incoming),
  ]);
}

export function PluginSelector({
  selections,
  onChange,
  providerScope,
  onSanitizedChange,
  lockedSkillRefs,
  lockedSelections,
  inheritedDefaults,
  unavailable = NO_UNAVAILABLE,
  inset = true,
  selectionCopy,
}: PluginSelectorProps): JSX.Element {
  const effectiveScope: PluginSelectorProviderScope = providerScope ?? 'mixed';
  const inheritedLayerByKey = useMemo(
    () =>
      new Map<string, keyof PluginSelectorInheritedDefaults>([
        ...selectionRowKeys(inheritedDefaults?.global).map(
          (key): [string, keyof PluginSelectorInheritedDefaults] => [
            key,
            'global',
          ],
        ),
        ...selectionRowKeys(inheritedDefaults?.project).map(
          (key): [string, keyof PluginSelectorInheritedDefaults] => [
            key,
            'project',
          ],
        ),
      ]),
    [inheritedDefaults?.global, inheritedDefaults?.project],
  );
  const normalizedLocked = useMemo(
    () =>
      normalizePluginSelections(
        lockedSelections ?? {
          collectionIds: [],
          skillRefs: [],
          pluginRefs: [],
          mcpServerRefs: [],
        },
      ),
    [lockedSelections],
  );
  const lockedSkillKeys = useMemo(
    () =>
      new Set(
        [...(lockedSkillRefs ?? []), ...normalizedLocked.skillRefs].map(
          (r) => `${r.sourceId}/${r.skillName}`,
        ),
      ),
    [lockedSkillRefs, normalizedLocked.skillRefs],
  );
  const lockedSelectionKeys = useMemo(
    () =>
      new Set([
        ...normalizedLocked.collectionIds,
        ...Array.from(lockedSkillKeys),
        ...normalizedLocked.pluginRefs.map(
          (r) => `${r.marketplaceId}/${r.pluginName}`,
        ),
        ...(normalizedLocked.mcpServerRefs ?? []).map(
          (r) => `${r.serverId}/${r.configId}`,
        ),
      ]),
    [lockedSkillKeys, normalizedLocked],
  );
  const lockedCollectionIds = useMemo(
    () => new Set(normalizedLocked.collectionIds),
    [normalizedLocked.collectionIds],
  );
  const lockedPluginKeys = useMemo(
    () =>
      new Set(
        normalizedLocked.pluginRefs.map(
          (ref) => `${ref.marketplaceId}/${ref.pluginName}`,
        ),
      ),
    [normalizedLocked.pluginRefs],
  );
  const lockedMcpKeys = useMemo(
    () =>
      new Set(
        (normalizedLocked.mcpServerRefs ?? []).map(
          (ref) => `${ref.serverId}/${ref.configId}`,
        ),
      ),
    [normalizedLocked.mcpServerRefs],
  );
  const providerIconScope: ProviderSupportScope =
    effectiveScope === 'codex'
      ? 'codex'
      : effectiveScope === 'claude' || effectiveScope === 'ollama'
        ? 'claude'
        : 'mixed';

  // Always funnel inbound selections through the shared normalization helper
  // so legacy `bundleIds` payloads still hydrate as `collectionIds` even when
  // an upstream caller has not yet been migrated.
  const normalized = useMemo(
    () => normalizePluginSelections(selections),
    [selections],
  );
  // Under the `cursor` scope, skills cannot be added, but the ones the chat
  // already carries stay persisted (rendered checked, and removable only by
  // unchecking) so they return when the chat leaves Cursor.
  const persistedKeys = useMemo(
    () =>
      new Set<string>([
        ...normalized.collectionIds,
        ...normalized.skillRefs.map((r) => `${r.sourceId}/${r.skillName}`),
        ...normalized.pluginRefs.map(
          (r) => `${r.marketplaceId}/${r.pluginName}`,
        ),
      ]),
    [normalized],
  );
  const [selectedCollectionIds, setSelectedCollectionIds] = useState<
    Set<string>
  >(() => new Set(normalized.collectionIds));
  const [selectedSkillKeys, setSelectedSkillKeys] = useState<Set<string>>(
    () =>
      new Set(normalized.skillRefs.map((r) => `${r.sourceId}/${r.skillName}`)),
  );
  const [selectedPluginKeys, setSelectedPluginKeys] = useState<Set<string>>(
    () =>
      new Set(
        normalized.pluginRefs.map((r) => `${r.marketplaceId}/${r.pluginName}`),
      ),
  );
  const [selectedMcpKeys, setSelectedMcpKeys] = useState<Set<string>>(
    () =>
      new Set(
        (normalized.mcpServerRefs ?? []).map(
          (r) => `${r.serverId}/${r.configId}`,
        ),
      ),
  );

  // Resync internal state when the parent changes the selections prop. The
  // normalization helper still funnels any legacy `bundleIds` into
  // `collectionIds` before we read.
  useEffect(() => {
    setSelectedCollectionIds(new Set(normalized.collectionIds));
    setSelectedSkillKeys(
      new Set(normalized.skillRefs.map((r) => `${r.sourceId}/${r.skillName}`)),
    );
    setSelectedPluginKeys(
      new Set(
        normalized.pluginRefs.map((r) => `${r.marketplaceId}/${r.pluginName}`),
      ),
    );
    setSelectedMcpKeys(
      new Set(
        (normalized.mcpServerRefs ?? []).map(
          (r) => `${r.serverId}/${r.configId}`,
        ),
      ),
    );
  }, [normalized]);

  const [viewingCollectionId, setViewingCollectionId] = useState<string | null>(
    null,
  );
  const detailView = useUnifiedTableDetailView(setViewingCollectionId);
  const { closeDetails, viewingSkill, viewingPlugin, viewingMcpServerId } =
    detailView;

  useEffect(() => {
    const hasChildOverlay =
      viewingCollectionId != null ||
      viewingSkill != null ||
      viewingPlugin != null ||
      viewingMcpServerId != null;
    if (!hasChildOverlay) return;

    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      closeDetails();
    }

    document.addEventListener('keydown', handleKeyDown, true);
    return (): void => {
      document.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [
    viewingCollectionId,
    viewingSkill,
    viewingPlugin,
    viewingMcpServerId,
    closeDetails,
  ]);

  const { refresh: refreshCollections } = useCollectionList();

  // Unified table data (skills + plugins + Collections)
  const retainedDisabledKeys = useMemo(
    () =>
      new Set([
        ...Array.from(selectedPluginKeys, (key) => `plugin:${key}`),
        ...Array.from(selectedSkillKeys, (key) => `skill:${key}`),
        ...Array.from(selectedCollectionIds, (key) => `collection:${key}`),
        ...Array.from(selectedMcpKeys, (key) => `mcp:${key}`),
      ]),
    [
      selectedPluginKeys,
      selectedSkillKeys,
      selectedCollectionIds,
      selectedMcpKeys,
    ],
  );
  const { rows, sourceOptions, loading } = useUnifiedTableData({
    retainedDisabledKeys,
    includeCollections: true,
    includeMcp: true,
    // The picker is the surface where "checked" means "active in this
    // session", which is what a linked connector is.
    includeProviderConnectors: true,
    // Breaks duplicate-collapse ties, so a plugin the saved configuration
    // refers to is never the copy hidden — which would leave a key selected
    // with no row to uncheck it from. Deliberately the raw plugin selection
    // rather than the combined `selectedKeys` memo below, which is derived
    // from `rows` and would make this circular.
    collapseDuplicates: true,
    selectedKeys: selectedPluginKeys,
  });

  // Annotate plugin rows with unsupported toggle state when the picker's
  // provider scope cannot resolve them. Rows that were already selected stay
  // checked + interactive (so users can opt out) but cannot be re-checked.
  const providerScopedRows = useMemo<UnifiedTableRow[]>(() => {
    if (effectiveScope === 'mixed' && lockedSelectionKeys.size === 0) {
      return rows;
    }

    return rows.map((row) => {
      if (row.installedItemDisabled) return row;
      // Required/inherited selections are locked on regardless of provider
      // scope so the user cannot remove configuration owned by the assistant.
      if (lockedSelectionKeys.has(row.key)) {
        return {
          ...row,
          toggleMode: 'locked',
          toggleReason: 'Required for this assistant and cannot be removed.',
        } satisfies UnifiedTableRow;
      }
      if (effectiveScope === 'mixed') return row;
      // A connector linked on the other provider is not active here. It stays
      // unselectable either way, but `locked` renders it CHECKED, and checked
      // on this surface means "active in this session".
      if (row.sourceId === PROVIDER_CONNECTOR_SOURCE_ID) {
        if (row.toggleMode !== 'locked') return row;
        // Connectors authenticate through a Claude or Codex account; a local
        // Cursor chat has neither, so a linked connector is never live there.
        if (effectiveScope === 'cursor') {
          return {
            ...row,
            toggleMode: 'disabled',
            toggleReason:
              'Linked on a provider account, so it is not available in Cursor chats.',
          } satisfies UnifiedTableRow;
        }
        // Branch on `codex`, defaulting everything else to the Claude check:
        // `ollama` sessions reuse the Claude resolver path, the same aliasing
        // `getUnsupportedReason` applies. Written the other way round, an
        // Ollama chat fell into the Codex branch and showed a connector linked
        // only on Codex as checked — a claim that it is active in a session
        // that never reaches Codex at all.
        const live =
          effectiveScope === 'codex'
            ? row.providerSupport?.codex === 'native'
            : row.providerSupport?.claude === 'native';
        if (live) return row;
        return {
          ...row,
          toggleMode: 'disabled',
          toggleReason: `Linked on your other provider account, so it is not available in this ${effectiveScope === 'codex' ? 'Codex' : 'Claude'} project.`,
        } satisfies UnifiedTableRow;
      }
      // Skill and Collection rows are selectable on every scope: a Cursor
      // chat loads skills from its private Cursor root, and a Collection
      // expands into skills, plugins, and MCP servers a session loads.
      if (row.kind !== 'plugin') return row;
      const reason = getUnsupportedReason(row.providerSupport, effectiveScope);
      if (!reason) return row;
      return {
        ...row,
        toggleMode: 'unsupported',
        toggleReason: reason,
      } satisfies UnifiedTableRow;
    });
  }, [rows, effectiveScope, lockedSelectionKeys]);

  const unavailableProjection = useMemo(() => {
    if (unavailable.length === 0)
      return { rows: providerScopedRows, removableKeys: new Set<string>() };
    const selectedByKind = {
      skill: selectedSkillKeys,
      plugin: selectedPluginKeys,
      mcp: selectedMcpKeys,
    };
    return withUnavailableRows(providerScopedRows, unavailable, {
      rowKey: (selection) => selection.key,
      isSelected: (selection) =>
        selectedByKind[selection.kind].has(selection.key),
      synthesize: (row): UnifiedTableRow => ({
        ...row,
        rowOrigin: 'unavailable',
        description: '',
        source: '',
        sourceSubtitle: '',
        sourceIcon: 'none',
        lastUpdated: '',
        viewDisabled: true,
      }),
    });
  }, [
    providerScopedRows,
    unavailable,
    selectedSkillKeys,
    selectedPluginKeys,
    selectedMcpKeys,
  ]);
  const scopedRows = unavailableProjection.rows;

  // Every locked row, not only connectors — the name says rows because the
  // filter is deliberately broad. Rows locked by an assistant requirement are
  // already in `selectedKeys` via `lockedSelectionKeys`, so including them
  // again is a no-op; narrowing the filter to connectors would just be a second
  // rule to keep in sync.
  //
  // Rows the table renders as locked must also be in `selectedKeys`, because
  // the selection counts and the Selected/Not selected filter read only that
  // set. A linked connector is rendered `locked` (checked) but is never routed
  // into a selection set — so without this it showed a ticked box while the
  // count said it was not selected, hid under "Selected", and appeared ticked
  // under "Not selected". Every other locked row comes from `lockedSelectionKeys`,
  // which is already in this set; these were the first to break that.
  const lockedRowKeys = useMemo(
    () =>
      new Set(
        scopedRows
          .filter((row) => row.toggleMode === 'locked')
          .map((row) => row.key),
      ),
    [scopedRows],
  );

  // Combined selected keys for the table
  const selectedKeys = useMemo(
    () =>
      new Set([
        ...Array.from(lockedRowKeys),
        ...Array.from(selectedCollectionIds),
        ...Array.from(lockedCollectionIds),
        ...Array.from(selectedSkillKeys),
        ...Array.from(lockedSkillKeys),
        ...Array.from(selectedPluginKeys),
        ...Array.from(lockedPluginKeys),
        ...Array.from(selectedMcpKeys),
        ...Array.from(lockedMcpKeys),
      ]),
    [
      lockedRowKeys,
      selectedCollectionIds,
      lockedCollectionIds,
      selectedSkillKeys,
      lockedSkillKeys,
      selectedPluginKeys,
      lockedPluginKeys,
      selectedMcpKeys,
      lockedMcpKeys,
    ],
  );

  const buildSelectionsWithLocks = useCallback(
    (
      collections: Set<string>,
      skills: Set<string>,
      plugins: Set<string>,
      mcpKeys: Set<string>,
    ): ChatTabPluginSelections =>
      buildSelections(
        unionSets(collections, lockedCollectionIds),
        unionSets(skills, lockedSkillKeys),
        unionSets(plugins, lockedPluginKeys),
        unionSets(mcpKeys, lockedMcpKeys),
      ),
    [lockedCollectionIds, lockedSkillKeys, lockedPluginKeys, lockedMcpKeys],
  );

  const sanitizedSelections = useMemo(() => {
    if (effectiveScope === 'mixed') {
      return buildSelectionsWithLocks(
        selectedCollectionIds,
        selectedSkillKeys,
        selectedPluginKeys,
        selectedMcpKeys,
      );
    }

    const rowsByKey = new Map(scopedRows.map((row) => [row.key, row]));
    const supportedOnly = (keys: Set<string>): Set<string> => {
      const allowed = new Set<string>();
      for (const key of Array.from(keys)) {
        if (
          rowsByKey.get(key)?.toggleMode === 'unsupported' &&
          !(effectiveScope === 'cursor' && persistedKeys.has(key))
        )
          continue;
        allowed.add(key);
      }
      return allowed;
    };

    return buildSelectionsWithLocks(
      supportedOnly(selectedCollectionIds),
      supportedOnly(selectedSkillKeys),
      supportedOnly(selectedPluginKeys),
      selectedMcpKeys,
    );
  }, [
    effectiveScope,
    persistedKeys,
    scopedRows,
    selectedCollectionIds,
    selectedSkillKeys,
    selectedPluginKeys,
    selectedMcpKeys,
    buildSelectionsWithLocks,
  ]);

  useEffect(() => {
    onSanitizedChange?.(sanitizedSelections);
  }, [onSanitizedChange, sanitizedSelections]);

  const browserRows = useMemo(
    () =>
      scopedRows.map((scopedRow) => {
        const row = withInheritedDefaultBadge(
          scopedRow,
          inheritedLayerByKey.get(scopedRow.key),
        );
        if (row.kind === 'mcp') return withMcpSurfaceBadge(row);
        if (
          row.kind !== 'plugin' ||
          row.rowOrigin !== 'catalog' ||
          !('facets' in row.original)
        )
          return row;
        const plugin: PluginInfo = row.original;
        // Ollama uses the Claude resolver; Cursor and Copilot read one facet
        // through the Cursor projection and load only some of its member
        // kinds, so their preview is narrowed first.
        const details:
          | Pick<PluginDetails, 'skills' | 'commands' | 'mcpServers'>
          | null
          | undefined =
          effectiveScope === 'codex'
            ? (plugin.facets.codex?.details ??
              plugin.facets.codexCompatibility?.details)
            : effectiveScope === 'claude' || effectiveScope === 'ollama'
              ? plugin.facets.claude?.details
              : effectiveScope === 'cursor' || effectiveScope === 'copilot'
                ? cursorPreviewDetails(plugin)
                : plugin.details;
        const members = details
          ? [
              ...details.skills.map((skill) => ({
                name: skill.name,
                description: skill.description,
                kind: 'Skill',
              })),
              ...details.commands.map((command) => ({
                name: command.name,
                description: command.description,
                kind: 'Command',
              })),
              ...details.mcpServers.map((server) => ({
                name: server.name,
                description: 'Tools provided by this server',
                kind: 'MCP server',
              })),
            ]
          : [];
        return { ...row, members };
      }),
    [scopedRows, effectiveScope, inheritedLayerByKey],
  );

  function handleToggle(key: string): void {
    const row = scopedRows.find((r) => r.key === key);
    if (!row) return;
    // `disabled` too: an unlinked connector row must not be smuggled into a
    // persisted selection by a caller that rebuilds the row list.
    if (row.toggleMode === 'locked' || row.toggleMode === 'disabled') return;

    if (row.kind === 'collection') {
      if (row.toggleMode === 'unsupported' && !selectedCollectionIds.has(key))
        return;
      const next = new Set(selectedCollectionIds);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      setSelectedCollectionIds(next);
      onChange(
        buildSelectionsWithLocks(
          next,
          selectedSkillKeys,
          selectedPluginKeys,
          selectedMcpKeys,
        ),
      );
    } else if (row.kind === 'skill') {
      // Same rule as plugins below: an unsupported, unchecked skill row
      // cannot be checked, but a persisted selection can still be removed.
      if (row.toggleMode === 'unsupported' && !selectedSkillKeys.has(key))
        return;
      const next = new Set(selectedSkillKeys);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      setSelectedSkillKeys(next);
      onChange(
        buildSelectionsWithLocks(
          selectedCollectionIds,
          next,
          selectedPluginKeys,
          selectedMcpKeys,
        ),
      );
    } else if (row.kind === 'plugin') {
      // Provider-scope sanitization: never auto-add unsupported plugins. If
      // a row is unsupported and currently unchecked, the toggle is treated
      // as a no-op. (UnifiedTable already disables the checkbox in that
      // state, but we belt-and-suspenders here so callers that rebuild the
      // row list cannot smuggle an unsupported row through.)
      const isUnsupported = row.toggleMode === 'unsupported';
      const alreadyChecked = selectedPluginKeys.has(key);
      if (isUnsupported && !alreadyChecked) {
        return;
      }
      const next = new Set(selectedPluginKeys);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      setSelectedPluginKeys(next);
      onChange(
        buildSelectionsWithLocks(
          selectedCollectionIds,
          selectedSkillKeys,
          next,
          selectedMcpKeys,
        ),
      );
    } else if (row.kind === 'mcp') {
      const next = new Set(selectedMcpKeys);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      setSelectedMcpKeys(next);
      onChange(
        buildSelectionsWithLocks(
          selectedCollectionIds,
          selectedSkillKeys,
          selectedPluginKeys,
          next,
        ),
      );
    }
  }

  const { removableKeys } = unavailableProjection;
  const tableRows =
    removableKeys.size === 0
      ? browserRows
      : browserRows.map((row) =>
          removableKeys.has(row.key) && selectedKeys.has(row.key)
            ? {
                ...row,
                rowAction: (
                  <UnavailableRemoveAction
                    name={row.name}
                    onRemove={(): void => handleToggle(row.key)}
                  />
                ),
              }
            : row,
        );

  return (
    <>
      {/* Unified table */}
      <div
        className={`flex flex-1 flex-col min-h-0${inset ? ' px-6 py-3' : ''}`}
      >
        <UnifiedTable
          rows={tableRows}
          sourceOptions={sourceOptions}
          selectedKeys={selectedKeys}
          onToggle={handleToggle}
          onView={detailView.openRowDetails}
          showCollectionKind={true}
          loading={loading}
          providerIconScope={providerIconScope}
          selectionCopy={selectionCopy}
          toolbarTrailing={
            <span
              data-testid="plugin-selector-scope"
              title={`Provider scope: ${PROVIDER_SCOPE_LABELS[effectiveScope]}`}
              className="inline-flex shrink-0 items-center whitespace-nowrap rounded-full border px-2.5 py-1 text-xs fg-secondary"
            >
              <span className="sr-only">Provider scope: </span>
              {PROVIDER_SCOPE_LABELS[effectiveScope]}
            </span>
          }
        />
      </div>

      {viewingCollectionId && (
        <CollectionModal
          collectionId={viewingCollectionId}
          onClose={() => setViewingCollectionId(null)}
          onSaved={async () => {
            await refreshCollections();
            if (viewingCollectionId != null) {
              const next = new Set(selectedCollectionIds);
              next.delete(viewingCollectionId);
              setSelectedCollectionIds(next);
              onChange(
                buildSelections(
                  next,
                  selectedSkillKeys,
                  selectedPluginKeys,
                  selectedMcpKeys,
                ),
              );
            }
            setViewingCollectionId(null);
          }}
        />
      )}

      <UnifiedTableDetailOverlays details={detailView} />
    </>
  );
}

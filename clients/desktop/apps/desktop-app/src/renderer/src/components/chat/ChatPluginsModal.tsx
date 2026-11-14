import { DeferredPluginsControl } from '@canopy/ui-shared';
import { DialogModal, ErrorBanner } from '@canopy/ui-shared/components';
import { type JSX, useCallback, useEffect, useRef, useState } from 'react';
import type {
  AgentProviderType,
  ChatTabPluginSelections,
} from '@canopy/desktop-shared/types';
import {
  PluginSelector,
  type PluginSelectorInheritedDefaults,
  type PluginSelectorProviderScope,
} from '../shared/PluginSelector';
import { RecommendedPluginsSettingsPanel } from '../worktree/RecommendedPluginsSettingsPanel';
import { mergeChatPluginSelections } from '@/lib/chatPluginSelections';
import { normalizePluginSelections } from '@canopy/execution-engine/lib/plugin-selections-normalization';
import { subtractPluginSelections } from '@canopy/desktop-shared/lib/effective-plugin-selections';
import { Button } from '@canopy/ui-shared/components';

interface ChatPluginsModalProps {
  initial: ChatTabPluginSelections;
  /**
   * `projectDefaults` is set when a recommendation applied in the modal
   * replaced the project defaults the chat inherits; split the saved set
   * against it instead of `inheritedDefaults.project`.
   */
  onSave: (
    selections: ChatTabPluginSelections,
    deferredToolsAllowed: boolean,
    projectDefaults?: ChatTabPluginSelections,
  ) => void | Promise<void>;
  onClose: () => void;
  /** Workspace context for the canopy.json recommendation panel. When all of
   * projectId, worktreeId are present (and projectId is not the standalone
   * sentinel), the modal includes the "Recommended from canopy.json" panel
   * keyed to the current branch's worktree. */
  projectId?: string;
  worktreeId?: string;
  repoId?: string;
  /**
   * Effective provider type for the chat tab. Used by the picker to gate
   * provider-incompatible plugins (e.g. Codex-only plugins are disabled in a
   * Claude-scoped picker). `undefined` is treated as `'mixed'`.
   */
  effectiveProviderType?: AgentProviderType;
  /**
   * Skills forced on for this surface that the user cannot remove. Forwarded to
   * the {@link PluginSelector} so matching rows render checked + disabled. Used
   * by the embedded pipeline-editor chat drawer for its required skill.
   */
  lockedSkillRefs?: { sourceId: string; skillName: string }[];
  /** Plugin selections inherited from the selected Agent model. */
  lockedSelections?: ChatTabPluginSelections;
  /**
   * Default layers this chat inherits. Matching rows get a "Project default"
   * or "Global default" badge and stay toggleable.
   */
  inheritedDefaults?: PluginSelectorInheritedDefaults;
  /** Show the per-chat deferred-tools permission on supported chat surfaces. */
  showDeferredToolsToggle?: boolean;
  /** Missing values remain allowed for backward compatibility. */
  deferredToolsAllowed?: boolean;
  /** Document of a popped-out composer; defaults to the main window. */
  ownerDocument?: Document;
}

function mapEffectiveProviderToScope(
  provider: AgentProviderType | undefined,
): PluginSelectorProviderScope {
  if (provider === 'codex') return 'codex';
  if (provider === 'ollama') return 'ollama';
  if (provider === 'claude') return 'claude';
  if (provider === 'copilot') return 'copilot';
  if (provider === 'opencode') return 'opencode';
  if (provider === 'cursor') return 'cursor';
  return 'mixed';
}

function selectionsFingerprint(selections: ChatTabPluginSelections): string {
  const normalized = normalizePluginSelections(selections);
  return JSON.stringify({
    collectionIds: [...normalized.collectionIds].sort(),
    skillRefs: [...normalized.skillRefs].sort((left, right) =>
      `${left.sourceId}/${left.skillName}`.localeCompare(
        `${right.sourceId}/${right.skillName}`,
      ),
    ),
    pluginRefs: [...normalized.pluginRefs].sort((left, right) =>
      `${left.marketplaceId}/${left.pluginName}`.localeCompare(
        `${right.marketplaceId}/${right.pluginName}`,
      ),
    ),
    mcpServerRefs: [...(normalized.mcpServerRefs ?? [])].sort((left, right) =>
      `${left.serverId}/${left.configId}`.localeCompare(
        `${right.serverId}/${right.configId}`,
      ),
    ),
  });
}

/**
 * The picker rebuilds selections from its checkboxes, which carry no MCP
 * sign-in routes. Keep the routes the chat already accepted, including those
 * of unchecked plugins: a route stays until it is changed in MCP settings.
 */
function withAcceptedAuthRoutes(
  saved: ChatTabPluginSelections,
  initial: ChatTabPluginSelections,
): ChatTabPluginSelections {
  if (saved.mcpHttpAuthPreferences || !initial.mcpHttpAuthPreferences?.length)
    return saved;
  return { ...saved, mcpHttpAuthPreferences: initial.mcpHttpAuthPreferences };
}

function selectionsEqual(
  left: ChatTabPluginSelections,
  right: ChatTabPluginSelections,
): boolean {
  return selectionsFingerprint(left) === selectionsFingerprint(right);
}

export function ChatPluginsModal({
  initial,
  onSave,
  onClose,
  projectId,
  worktreeId,
  repoId,
  effectiveProviderType,
  lockedSkillRefs,
  lockedSelections,
  inheritedDefaults,
  showDeferredToolsToggle = false,
  deferredToolsAllowed = true,
  ownerDocument,
}: ChatPluginsModalProps): JSX.Element {
  const pickerInitial = lockedSelections
    ? mergeChatPluginSelections(
        normalizePluginSelections(initial),
        normalizePluginSelections(lockedSelections),
      )
    : initial;
  const [selections, setSelections] =
    useState<ChatTabPluginSelections>(pickerInitial);
  const [sanitizedSelections, setSanitizedSelections] =
    useState<ChatTabPluginSelections | null>(null);
  const [allowDeferredTools, setAllowDeferredTools] =
    useState(deferredToolsAllowed);
  const [appliedProjectDefaults, setAppliedProjectDefaults] =
    useState<ChatTabPluginSelections | null>(null);
  const pickerInheritedDefaults =
    inheritedDefaults && appliedProjectDefaults
      ? { ...inheritedDefaults, project: appliedProjectDefaults }
      : inheritedDefaults;
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const providerScope = mapEffectiveProviderToScope(effectiveProviderType);
  const initialKey = `${providerScope}\u0000${selectionsFingerprint(pickerInitial)}`;
  const previousInitialKeyRef = useRef(initialKey);
  const handleSelectionsChange = useCallback(
    (next: ChatTabPluginSelections): void => {
      setSanitizedSelections(null);
      setSelections(next);
    },
    [],
  );
  const handleSanitizedChange = useCallback(
    (next: ChatTabPluginSelections): void => {
      setSanitizedSelections((current) =>
        current && selectionsEqual(current, next) ? current : next,
      );
    },
    [],
  );

  useEffect(() => {
    if (previousInitialKeyRef.current === initialKey) return;
    previousInitialKeyRef.current = initialKey;
    setSanitizedSelections(null);
    setSelections(pickerInitial);
  }, [initialKey, pickerInitial]);

  useEffect(() => {
    setAllowDeferredTools(deferredToolsAllowed);
  }, [deferredToolsAllowed]);

  const showRecommended = Boolean(projectId && worktreeId);

  // DialogModal portals into `ownerDocument` (a popped-out composer's
  // window), so a transformed host, such as the Home composer shell, cannot
  // trap the overlay in its stacking context under later page content. It
  // listens for Escape there too, and stays open while a save runs.
  return (
    <DialogModal
      onClose={onClose}
      title="Plugins"
      maxWidth="2xl"
      inset="flush"
      scrollableBody={false}
      closeOnBackdrop={!saving}
      closeButtonDisabled={saving}
      ownerDocument={ownerDocument}
      footer={
        <>
          {showDeferredToolsToggle && (
            <div className="mr-auto">
              <DeferredPluginsControl
                allowed={allowDeferredTools}
                disabled={saving}
                onChange={setAllowDeferredTools}
              />
            </div>
          )}
          <Button
            variant="secondary"
            size="compact"
            onClick={onClose}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            size="compact"
            onClick={() => {
              if (
                sanitizedSelections ||
                allowDeferredTools !== deferredToolsAllowed
              ) {
                setSaving(true);
                setSaveError(null);
                const saved = withAcceptedAuthRoutes(
                  sanitizedSelections ?? selections,
                  initial,
                );
                void Promise.resolve(
                  appliedProjectDefaults
                    ? onSave(saved, allowDeferredTools, appliedProjectDefaults)
                    : onSave(saved, allowDeferredTools),
                )
                  .catch(() => {
                    setSaveError(
                      'Couldn’t update tools. Your current session and selections were kept.',
                    );
                  })
                  .finally(() => setSaving(false));
              }
            }}
            disabled={
              saving ||
              (!sanitizedSelections &&
                allowDeferredTools === deferredToolsAllowed)
            }
          >
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </>
      }
    >
      {/* The card records; `PluginSelector`'s table blocks its capability
          rows. */}
      {showRecommended && projectId && (
        <div className="max-h-[40vh] shrink-0 overflow-y-auto px-6 pt-3">
          <RecommendedPluginsSettingsPanel
            projectId={projectId}
            worktreeId={worktreeId}
            repoId={repoId}
            hideWhenEmpty
            onAppliedSelections={(newDefaults) => {
              setSanitizedSelections(null);
              if (!inheritedDefaults) {
                setSelections((current) =>
                  mergeChatPluginSelections(current, newDefaults),
                );
                return;
              }
              // The chat inherits project defaults, so a new default shows
              // as inherited and checked instead of joining the chat's own
              // selection. Defaults the chat turned off stay off.
              const previousDefaults =
                appliedProjectDefaults ?? inheritedDefaults.project;
              const added = previousDefaults
                ? subtractPluginSelections(newDefaults, previousDefaults)
                : normalizePluginSelections(newDefaults);
              setSelections((current) =>
                mergeChatPluginSelections(current, added),
              );
              setAppliedProjectDefaults(normalizePluginSelections(newDefaults));
            }}
          />
        </div>
      )}

      {/* min-h-0 + flex keep PluginSelector height-constrained so its
        internal table scrolls instead of overflowing the 80vh dialog */}
      <div
        data-testid="plugin-picker-region"
        className={`flex min-h-0 flex-1 flex-col${saving ? ' pointer-events-none opacity-60' : ''}`}
      >
        <PluginSelector
          selections={selections}
          onChange={handleSelectionsChange}
          providerScope={providerScope}
          onSanitizedChange={handleSanitizedChange}
          lockedSkillRefs={lockedSkillRefs}
          lockedSelections={lockedSelections}
          inheritedDefaults={pickerInheritedDefaults}
        />
      </div>

      {saveError && (
        <div className="shrink-0 px-6 pb-3">
          <ErrorBanner
            errorSource="chat-plugins-modal-save"
            error={saveError}
            className=""
          />
        </div>
      )}
    </DialogModal>
  );
}

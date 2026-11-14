import { Count } from '@canopy/ui-shared/components/Badge';
import { SharedByYou } from '../plugins/SharedByYou';
import { useCloudOrigin } from '@/lib/cloud-origin';
import {
  Stack,
  Heading,
  SegmentedControl,
  type SegmentedControlOption,
  Surface,
} from '@canopy/ui-shared/components';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';
import { unwrapShareOperationResult } from '@/lib/sharing/share-operation-result';
import {
  type JSX,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { DetailBackButton } from '../shared/DetailBackButton';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import { parseGitHubRepo } from '../../lib/format';
import { runCancellableModalLoad } from './entityEditModalUtils';
import { readSkillContentForDisplay } from './skillContentUtils';
import { parseSkillSource, serializeSkillSource } from '@/lib/skillFrontmatter';
import { TryItLaunch, TryItPrimaryCta } from '../plugins/TryItPrimaryCta';
import { tryItMenuItem } from '../plugins/tryItMenuItem';
import { sharedSkillDetailHeader } from '../plugins/sharedResourceDetailHeaders';
import { buildTryItPrompt } from '@canopy/protocol/try-it';
import {
  CUSTOM_SKILL_SOURCE_ID,
  lookupInstalledSharedSkill,
} from '@/lib/sharedSkillImport';
import { SKILLS_CHANGED_EVENT, notifySkillsChanged } from '@/lib/skillsChanged';
import { resolveSharedResourceErrorMessage } from '@/lib/sharedResourceErrors';
import { brandText } from '@/lib/brand';
import { copyTextToClipboard } from '@/lib/clipboard';
import { postShareToast } from '@/lib/share-toast';
import {
  isSkillEditorSaveEnabled,
  resolveSupportingFilePaths,
  skillEditorSnapshot,
} from '@/lib/skill-edit-safety';
import {
  getCustomSkillNameValidationError,
  getSkillFilePathValidationError,
} from '@canopy/desktop-shared/skill-name';
import type {
  SkillRiskInfo,
  AvailableSkill,
  FetchAvailableSkillsResponse,
  InstalledSkillInfo,
  DesktopSharedSkillDetail,
  SharedSkillDetail,
  SharedSkillSummary,
  SkillContentResponse,
  SkillEditableFile,
} from '@canopy/desktop-shared/types/skills';
import {
  ChoiceList,
  ChoiceListRow,
  DialogFormField,
  FieldError,
  FormField,
  SkillFilePreview,
  SkillFileTabBar,
  SkillFileTree,
  Badge,
  TextArea,
  TextInput,
} from '@canopy/ui-shared/components';
import {
  skillFileLabel,
  type MarketplaceShareAction,
  type SkillUpdateAction,
} from '@canopy/ui-shared/lib';
import { DialogModal } from '../shared';
import {
  UnsavedChangesDialog,
  type UnsavedChangesSaveResult,
} from '@canopy/ui-app/workflows';
import { useWorkflowEditGuard } from '../workflows/edit/useWorkflowEditGuard';
import {
  MarkdownFrontmatterContent,
  SKILL_MAIN_FILE,
  SkillEditWithAIButton,
  InstalledShareUpdateButton,
  SkillReadDetail,
  installedSkillDetailHeader,
  type InstalledShareProvenanceOptions,
  type SkillEditWithAIState,
  type SkillReadDetailViewState,
} from '@canopy/ui-app';
import {
  MarketplaceDetailPageShell,
  MarketplaceUnshareAction,
  useMarketplaceUnshare,
  useResourceContext,
  useMarketplaceCopyLinkMenuItem,
  type UseMarketplaceUnshareOptions,
} from '@canopy/ui-app/capability';
import {
  sharedByYouAudienceCount,
  marketplaceShareLink,
  marketplaceLinkAccess,
  type SharedByYouCopyLinkPort,
} from '@canopy/ui-app/sharing';
import { marketplaceUnshareMenuLabel } from '@canopy/ui-shared/lib/marketplace-unshare';
import {
  DetailActionBar,
  DetailMoreMenu,
  DetailActionSlotsProvider,
  DetailPageActions,
  MarketplaceShareButton,
  Button,
  RiskBadge,
  UninstallConfirmDialog,
  useDetailActionSlots,
  type DetailMoreMenuItem,
  type DetailPageActionsProps,
} from '@canopy/ui-shared/components';
import { ErrorBanner } from '../shared';
import {
  CenteredLoadingSpinner,
  DelayedLoadingPlaceholder,
  Notice,
  NoticeButton,
  Skeleton,
} from '@canopy/ui-shared/components';
import { Tooltip } from '@canopy/ui-shared';
import {
  TrashIcon as AppCatalogTrashIcon,
  ChevronRightMediumIcon as AppCatalogChevronRightMediumIcon,
  CloseIcon as AppCatalogCloseIcon,
  PlusIcon as AppCatalogPlusIcon,
  DocumentPencilIcon as AppCatalogDocumentPencilIcon,
  ArrowUpRightIcon,
} from '@canopy/ui-shared/icons/AppIcons';

// ---------------------------------------------------------------------------
// AddSkillsModal
// ---------------------------------------------------------------------------

type ModalStep =
  | { step: 'source' }
  | { step: 'loading'; source: string }
  | {
      step: 'select';
      source: string;
      response: FetchAvailableSkillsResponse;
    }
  | { step: 'installing'; source: string; skillNames: string[] };

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function runAddSkillsModalStep(
  operation: () => Promise<void>,
  options: {
    isCancelled: () => boolean;
    setError: (error: string) => void;
    resetToSource: () => void;
  },
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    if (options.isCancelled()) return;
    options.setError(getErrorMessage(error));
    options.resetToSource();
  }
}

/**
 * GitHub skills-install dialog. Exported so the Plugins discovery page's
 * "Add custom…" dropdown can open the same dialog the Skills surface uses
 * (API-2153) instead of forking it.
 */
export function AddSkillsModal({
  isOpen,
  onClose,
  onInstalled,
  onAddMarketplace,
}: {
  isOpen: boolean;
  onClose: () => void;
  onInstalled: () => Promise<void>;
  onAddMarketplace?: (repo: string) => void;
}): JSX.Element | null {
  const [modalStep, setModalStep] = useState<ModalStep>({ step: 'source' });
  const [sourceInput, setSourceInput] = useState('');
  const [error, setError] = useState('');
  const [selectedNames, setSelectedNames] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!isOpen) {
      setModalStep({ step: 'source' });
      setSourceInput('');
      setError('');
      setSelectedNames(new Set());
    }
  }, [isOpen]);

  // Fetch available skills when entering loading step
  useEffect(() => {
    if (modalStep.step !== 'loading') return;
    let cancelled = false;

    void runAddSkillsModalStep(
      async (): Promise<void> => {
        const result = await window.skills.fetchAvailable(modalStep.source);
        if (cancelled) return;

        if (result.success && result.data) {
          if (result.data.skills.length === 0) {
            setError('No installable skills found in this repository.');
            setModalStep({ step: 'source' });
          } else {
            setSelectedNames(new Set(result.data.skills.map((s) => s.name)));
            setModalStep({
              step: 'select',
              source: modalStep.source,
              response: result.data,
            });
          }
        } else {
          setError(result.error || 'Failed to fetch skills.');
          setModalStep({ step: 'source' });
        }
      },
      {
        isCancelled: () => cancelled,
        setError,
        resetToSource: () => setModalStep({ step: 'source' }),
      },
    );

    return (): void => {
      cancelled = true;
    };
  }, [modalStep]);

  // Store callbacks in refs to avoid re-triggering the install effect
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const onInstalledRef = useRef(onInstalled);
  onInstalledRef.current = onInstalled;

  // Install skills when entering installing step
  useEffect(() => {
    if (modalStep.step !== 'installing') return;
    let cancelled = false;

    void runAddSkillsModalStep(
      async (): Promise<void> => {
        const result = await window.skills.installSkills(
          modalStep.source,
          modalStep.skillNames,
        );
        if (cancelled) return;

        if (result.success) {
          await onInstalledRef.current();
          onCloseRef.current();
        } else {
          setError(result.error || 'Failed to install skills.');
          setModalStep({ step: 'source' });
        }
      },
      {
        isCancelled: () => cancelled,
        setError,
        resetToSource: () => setModalStep({ step: 'source' }),
      },
    );

    return (): void => {
      cancelled = true;
    };
  }, [modalStep]);

  if (!isOpen) return null;

  const handleFindSkills = (): void => {
    setError('');
    const repo = parseGitHubRepo(sourceInput);
    if (!repo) {
      setError(
        'Invalid format. Use owner/repo or a GitHub URL (e.g. https://github.com/owner/repo).',
      );
      return;
    }
    setModalStep({ step: 'loading', source: repo });
  };

  const handleInstall = (): void => {
    if (modalStep.step !== 'select' || selectedNames.size === 0) return;
    setError('');
    setModalStep({
      step: 'installing',
      source: modalStep.source,
      skillNames: Array.from(selectedNames),
    });
  };

  const toggleSkill = (name: string): void => {
    setSelectedNames((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const toggleAll = (skills: AvailableSkill[]): void => {
    if (selectedNames.size === skills.length) {
      setSelectedNames(new Set());
    } else {
      setSelectedNames(new Set(skills.map((s) => s.name)));
    }
  };

  const parsedRepo = parseGitHubRepo(sourceInput);
  const isSourceValid = parsedRepo !== null;

  return (
    <DialogModal
      onClose={onClose}
      title={modalStep.step === 'select' ? 'Select skills' : 'Add skills'}
      titleId="add-skills-modal-title"
      headerBorder={false}
    >
      <Stack gap="group">
        {/* Error */}
        <ErrorBanner
          errorSource="add-skills-modal"
          error={error}
          className=""
        />

        {/* Source input step */}
        {modalStep.step === 'source' && (
          <>
            <DialogFormField
              label="GitHub repository"
              htmlFor="add-skills-source-input"
            >
              <TextInput
                id="add-skills-source-input"
                value={sourceInput}
                onChange={(e) => setSourceInput(e.target.value)}
                onKeyDown={(e) => {
                  if (
                    e.key === 'Enter' &&
                    isSourceValid &&
                    modalStep.step === 'source'
                  )
                    handleFindSkills();
                }}
                placeholder="owner/repo or https://github.com/owner/repo"
                autoFocus
              />
            </DialogFormField>
            <Button
              className="self-start"
              variant="primary"
              size="compact"
              onClick={handleFindSkills}
              disabled={!isSourceValid}
            >
              Find skills
            </Button>
          </>
        )}

        {/* Loading step */}
        {modalStep.step === 'loading' && (
          <div className="py-8">
            <DelayedLoadingPlaceholder
              slowNote={`Still fetching skills from ${modalStep.source}…`}
            >
              {/* Repository contents have not arrived; the result shape is unknown. */}
              <CenteredLoadingSpinner />
            </DelayedLoadingPlaceholder>
          </div>
        )}

        {/* Select step */}
        {modalStep.step === 'select' && (
          <>
            {modalStep.response.hasMarketplace && (
              <Notice
                intent="attention"
                title="This repository contains a plugin marketplace."
                actions={
                  onAddMarketplace ? (
                    <NoticeButton
                      variant="primary"
                      onClick={() => {
                        onAddMarketplace(modalStep.source);
                        onClose();
                      }}
                    >
                      Add marketplace
                    </NoticeButton>
                  ) : undefined
                }
              >
                Install it as a marketplace instead of installing skills
                directly.
              </Notice>
            )}

            <div className="flex items-center justify-between">
              <p className="text-s fg-secondary">
                {modalStep.response.skills.length} skill
                {modalStep.response.skills.length !== 1 ? 's' : ''} found in{' '}
                <span className="fg-primary font-medium">
                  {modalStep.source}
                </span>
              </p>
              <span className="text-xs">
                <Button
                  variant="link"
                  onClick={() => toggleAll(modalStep.response.skills)}
                >
                  {selectedNames.size === modalStep.response.skills.length
                    ? 'Deselect all'
                    : 'Select all'}
                </Button>
              </span>
            </div>

            {/* A long list scrolls inside the box instead of the dialog. */}
            <div className="flex max-h-64 min-h-0 flex-col">
              <ChoiceList aria-label="Skills">
                {modalStep.response.skills.map((skill) => {
                  const risk: SkillRiskInfo | undefined =
                    modalStep.response.riskInfo[skill.name];
                  return (
                    <ChoiceListRow
                      key={skill.name}
                      selected={selectedNames.has(skill.name)}
                      onClick={() => toggleSkill(skill.name)}
                      trailing={
                        risk ? <RiskBadge level={risk.level} /> : undefined
                      }
                    >
                      <span className="block truncate font-medium">
                        {skill.name}
                      </span>
                      {skill.description && (
                        <span className="mt-0.5 line-clamp-2 block text-xs fg-secondary">
                          {skill.description}
                        </span>
                      )}
                    </ChoiceListRow>
                  );
                })}
              </ChoiceList>
            </div>

            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="compact"
                onClick={() => {
                  setError('');
                  setModalStep({ step: 'source' });
                }}
              >
                Back
              </Button>
              <Button
                variant="primary"
                size="compact"
                onClick={handleInstall}
                disabled={selectedNames.size === 0}
              >
                Install {selectedNames.size} skill
                {selectedNames.size !== 1 ? 's' : ''}
              </Button>
            </div>
          </>
        )}

        {/* Installing step */}
        {modalStep.step === 'installing' && (
          <div className="py-8">
            <DelayedLoadingPlaceholder
              slowNote={`Still installing ${modalStep.skillNames.length} skill${modalStep.skillNames.length !== 1 ? 's' : ''}…`}
            >
              {/* Completion closes this dialog, so no next content can be measured. */}
              <CenteredLoadingSpinner />
            </DelayedLoadingPlaceholder>
          </div>
        )}
      </Stack>
    </DialogModal>
  );
}

// ---------------------------------------------------------------------------
// SkillDetailModal
// ---------------------------------------------------------------------------

/**
 * Installed-skill viewer. Exported so the Plugins discovery detail wrapper can
 * open the same viewer the Skills section uses (API-2153, design section 4).
 */
export function SkillDetailModal({
  skill,
  onClose,
  onEdit,
  editWithAI,
  notice,
  shareAction,
  onRemove,
  removeKind,
  removePending,
  updateAction,
  loadErrorPrefix,
  contentRevision = 0,
  installedSkill,
  shareProvenance,
  displayName,
  onNavigateBack,
  relatedContent,
  noEnterAnimation = false,
  presentation = 'modal',
}: {
  skill: { sourceId: string; name: string; filePath?: string } | null;
  /**
   * The installed record, for the page header's source and dates
   * (CAN-4264). The page shows the header without them until it resolves.
   */
  installedSkill?: InstalledSkillInfo;
  /**
   * A receipted shared install's live names, update state and source link
   * (CAN-5018); without it the header shows the receipt's static facts.
   */
  shareProvenance?: InstalledShareProvenanceOptions;
  onClose: () => void;
  onEdit?: () => void;
  /** "Edit with AI" (CAN-1259); omit to hide it. */
  editWithAI?: SkillEditWithAIState;
  /**
   * A page-level notice for an action's failure: the header's one notice on
   * a page, above the content in a dialog.
   */
  notice?: ReactNode;
  /**
   * Same share flow as the list row, or the Marketplace's reason it cannot
   * be shared; omit when the host offers no Share.
   */
  shareAction?: MarketplaceShareAction;
  /** Same delete/remove confirmation as the list row; omit when ineligible. */
  onRemove?: () => void;
  removeKind?: 'delete' | 'remove';
  removePending?: boolean;
  /** Check for and apply updates (CAN-4264); omit when not updatable. */
  updateAction?: SkillUpdateAction;
  /** Explains a committed mutation when its subsequent content read fails. */
  loadErrorPrefix?: string;
  /** Reload the content and file viewer while retaining an in-flight Try it. */
  contentRevision?: number;
  /** Renders a back chip that restores the previous detail (CAN-2382). */
  /** The list's display name for the page header title. */
  displayName?: string;
  onNavigateBack?: () => void;
  /** Optional related-item sections appended below the skill content. */
  relatedContent?: ReactNode;
  noEnterAnimation?: boolean;
  /** Keep management in a dialog while discovery can host the same viewer inline. */
  presentation?: 'modal' | 'page';
}): JSX.Element | null {
  const [content, setContent] = useState<SkillContentResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [files, setFiles] = useState<string[]>([]);
  const [filesTruncated, setFilesTruncated] = useState(false);
  const [viewState, setViewState] = useState<SkillReadDetailViewState>({
    treeOpen: false,
    openTabs: [],
    activeFile: SKILL_MAIN_FILE,
  });
  const selectedSkillSourceId = skill?.sourceId;
  const selectedSkillName = skill?.name;

  useEffect(() => {
    setFiles([]);
    setFilesTruncated(false);
    setViewState({
      treeOpen: false,
      openTabs: [],
      activeFile: SKILL_MAIN_FILE,
    });
    if (
      selectedSkillSourceId === undefined ||
      selectedSkillName === undefined
    ) {
      setContent(null);
      setError('');
      return;
    }

    let cancelled = false;
    setContent(null);
    setLoading(true);
    setError('');

    void runCancellableModalLoad(
      async (): Promise<void> => {
        const [result, filesResult] = await Promise.all([
          readSkillContentForDisplay({
            sourceId: selectedSkillSourceId,
            name: selectedSkillName,
          }),
          window.skills.listFiles(selectedSkillSourceId, selectedSkillName),
        ]);
        if (cancelled) return;
        setContent(result);
        if (filesResult.success && filesResult.data) {
          setFiles(filesResult.data.files);
          setFilesTruncated(filesResult.data.truncated);
        }
      },
      {
        isCancelled: () => cancelled,
        setError,
        setLoading,
      },
    );

    return (): void => {
      cancelled = true;
    };
  }, [contentRevision, selectedSkillName, selectedSkillSourceId]);

  useCurrentUiStateReporter(
    'plugins.skillDetail',
    skill
      ? {
          open: true,
          sourceId: skill.sourceId,
          skillName: skill.name,
          loading,
          errorVisible: error.length > 0,
          fileCount: files.length,
          filesTruncated,
          treeOpen: viewState.treeOpen,
          openTabs: viewState.openTabs,
          activeFile: viewState.activeFile,
        }
      : { open: false },
  );

  // A dialog shows the skill's actions in its title bar, before close.
  const actionSlots = useDetailActionSlots();

  if (!skill) return null;

  const isMultiFile = files.length > 1;
  const skillDescription = content?.frontmatter.description;
  // A shared copy whose source changed offers its reviewed Update as the
  // primary action, and Try it moves first into ⋯ (CAN-5306).
  const onShareUpdate = shareProvenance?.updateAvailable
    ? shareProvenance.onUpdate
    : undefined;
  const headerTitle = displayName?.trim() || skill.name;
  const detailContent = (
    // An installed skill is always ready: Try it opens a chat with it
    // selected. The prompt waits for the content, which holds its example.
    <TryItLaunch
      capability={{
        kind: 'skill',
        sourceId: skill.sourceId,
        catalogId: skill.name,
        name: skill.name,
      }}
      prompt={buildTryItPrompt({
        kind: 'skill',
        name: skill.name,
        description:
          typeof skillDescription === 'string' ? skillDescription : null,
        frontmatter: content?.frontmatter ?? null,
      })}
      installation={content === null ? 'loading' : 'installed'}
      runtimeSelections={{
        skillRefs: [{ sourceId: skill.sourceId, skillName: skill.name }],
        pluginRefs: [],
      }}
      onInstall={(): void => {}}
    >
      {(tryIt): JSX.Element => (
        <SkillReadDetail
          key={contentRevision}
          skill={skill}
          inset={presentation === 'page' ? 'page' : 'dialog'}
          primaryAction={
            onShareUpdate ? (
              <InstalledShareUpdateButton
                name={headerTitle}
                onUpdate={onShareUpdate}
              />
            ) : (
              tryIt.primary
            )
          }
          {...(onShareUpdate
            ? { leadingMenuItems: [tryItMenuItem(tryIt)] }
            : {})}
          content={content}
          files={files}
          filesTruncated={filesTruncated}
          loading={loading}
          error={
            error && loadErrorPrefix ? `${loadErrorPrefix} ${error}` : error
          }
          initialFilePath={skill.filePath}
          onEdit={onEdit}
          editWithAI={editWithAI}
          shareAction={shareAction}
          onRemove={onRemove}
          removeKind={removeKind}
          removePending={removePending}
          updateAction={updateAction}
          // A page shows the skill under its header (CAN-4264); a dialog keeps
          // its title bar and puts the notice above the content.
          header={
            presentation === 'page'
              ? installedSkillDetailHeader(
                  skill.name,
                  content,
                  installedSkill,
                  'skill-detail-modal-title',
                  displayName,
                  shareProvenance,
                )
              : undefined
          }
          notice={presentation === 'page' ? notice : undefined}
          leadingContent={
            onNavigateBack || (notice && presentation !== 'page') ? (
              <>
                {onNavigateBack && (
                  <DetailBackButton onNavigateBack={onNavigateBack} />
                )}
                {presentation !== 'page' && notice}
              </>
            ) : undefined
          }
          relatedContent={relatedContent}
          onViewStateChange={setViewState}
          readFile={async (path) => {
            const result = await window.skills.readFile(
              skill.sourceId,
              skill.name,
              path,
            );
            if (!result.success || !result.data) {
              throw new Error(result.error || 'Failed to load file.');
            }
            return result.data;
          }}
        />
      )}
    </TryItLaunch>
  );

  if (presentation === 'page') {
    return (
      <section
        className="mx-auto flex min-h-0 w-full max-w-3xl flex-col pt-8"
        data-testid="plugins-entry-detail"
        aria-labelledby="skill-detail-modal-title"
      >
        {/* The header's visible title is the page heading. */}
        {detailContent}
      </section>
    );
  }

  return (
    <DialogModal
      inset="flush"
      onClose={() => onClose()}
      title={skill.name}
      titleId="skill-detail-modal-title"
      maxWidth={isMultiFile ? '4xl' : '2xl'}
      headerBorder={false}
      noEnterAnimation={noEnterAnimation}
      scrollableBody={false}
      topRightActions={<DetailActionBar slots={actionSlots} />}
    >
      <DetailActionSlotsProvider slots={actionSlots}>
        {detailContent}
      </DetailActionSlotsProvider>
    </DialogModal>
  );
}

// ---------------------------------------------------------------------------
// Skill editor (shared by CreateSkillModal and SharedSkillDetailModal)
// ---------------------------------------------------------------------------

interface MetadataRow {
  id: string;
  key: string;
  value: string;
  original?: {
    key: string;
    value: unknown;
  };
}

let nextMetadataRowId = 0;

function createMetadataRow(
  key: string,
  value: string,
  original?: { key: string; value: unknown },
): MetadataRow {
  nextMetadataRowId += 1;
  return { id: `metadata-row-${nextMetadataRowId}`, key, value, original };
}

interface EditorFileRow {
  id: string;
  path: string;
  content: string;
  /**
   * False for binary/oversized files that cannot be edited here; they are
   * kept as-is on save (path is sent without content).
   */
  editable: boolean;
}

let nextEditorFileId = 0;

function createEditorFileRow(
  path: string,
  content: string,
  editable = true,
): EditorFileRow {
  nextEditorFileId += 1;
  return { id: `editor-file-${nextEditorFileId}`, path, content, editable };
}

/**
 * Collapses parsed YAML values to JSON-safe shapes (a YAML timestamp's Date
 * becomes its ISO string via toJSON). Returns undefined for values JSON
 * cannot represent at all.
 */
function toJsonSafeFrontmatterValue(value: unknown): unknown {
  if (value === undefined) return undefined;
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) return undefined;
    const parsed: unknown = JSON.parse(serialized);
    return parsed;
  } catch {
    return undefined;
  }
}

function frontmatterValueToString(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return JSON.stringify(value);
}

interface SkillEditorInitialValues {
  name: string;
  description: string;
  body: string;
  extras: Array<{
    key: string;
    value: string;
    original?: { key: string; value: unknown };
  }>;
  files?: Array<{ path: string; content: string; editable?: boolean }>;
}

/** The fields a skill editor skeleton starts from. */
type SkillEditorSampleValues = Pick<
  SkillEditorInitialValues,
  'name' | 'description' | 'body'
>;

interface UseSkillEditorStateResult {
  name: string;
  description: string;
  body: string;
  metadataRows: MetadataRow[];
  showAdvanced: boolean;
  showPreview: boolean;
  skillName: string;
  trimmedDescription: string;
  nameError: string;
  isNameValid: boolean;
  metadataKeyError: string;
  normalizedExtras: Record<string, string>;
  preservedMetadata: Record<string, unknown>;
  previewContent: { frontmatter: Record<string, unknown>; body: string };
  hasContent: boolean;
  files: EditorFileRow[];
  openFileIds: string[];
  activeFileId: string | null;
  showFileTree: boolean;
  filesError: string;
  /**
   * The field errors shown under their fields: set when the person tries to
   * save, and each one cleared as soon as its field is edited.
   */
  shownErrors: SkillEditorShownErrors;
  /**
   * The field to focus after a failed save, once the form shows it. `seq`
   * changes on every request so a repeated press refocuses the same field.
   */
  focusRequest: SkillEditorFocusRequest | null;
  /**
   * Shows every current field error; true when nothing blocks the save. When
   * something does, it brings the first blocking field into view (leaving a
   * file tab or Preview, opening Advanced) and asks for it to be focused.
   */
  revealErrors: () => boolean;
  setName: (next: string) => void;
  setDescription: (next: string) => void;
  setBody: (next: string) => void;
  setShowAdvanced: (next: boolean) => void;
  setShowPreview: (next: boolean) => void;
  addMetadataRow: () => void;
  updateMetadataRow: (id: string, field: 'key' | 'value', next: string) => void;
  removeMetadataRow: (id: string) => void;
  addFile: () => void;
  updateFilePath: (id: string, next: string) => void;
  updateFileContent: (id: string, next: string) => void;
  removeFile: (id: string) => void;
  openFileTab: (id: string) => void;
  closeFileTab: (id: string) => void;
  selectMainFile: () => void;
  setShowFileTree: (next: boolean) => void;
  reset: (values: SkillEditorInitialValues) => void;
}

type SkillEditorField = 'name' | 'description' | 'body' | 'metadata' | 'files';

type SkillEditorShownErrors = Partial<Record<SkillEditorField, string>>;

interface SkillEditorFocusRequest {
  field: SkillEditorField;
  seq: number;
}

/** Where each field's first control sits in SkillEditorBody. */
const SKILL_EDITOR_FIELD_FOCUS_SELECTORS: Record<SkillEditorField, string> = {
  name: '[data-testid="skill-editor-name-field"] input',
  description: '[data-testid="skill-editor-description-input"]',
  body: '[data-testid="skill-editor-body-field"] textarea',
  metadata: 'input[aria-label="Metadata key"]',
  files: '[data-testid="skill-file-path-input"]',
};

const SKILL_EDITOR_FIELDS: readonly SkillEditorField[] = [
  'name',
  'description',
  'body',
  'metadata',
  'files',
];

function useSkillEditorState(
  initial?: SkillEditorSampleValues,
): UseSkillEditorStateResult {
  const [name, setNameValue] = useState(initial?.name ?? '');
  const [description, setDescriptionValue] = useState(
    initial?.description ?? '',
  );
  const [body, setBodyValue] = useState(initial?.body ?? '');
  const [shownErrors, setShownErrors] = useState<SkillEditorShownErrors>({});
  const [focusRequest, setFocusRequest] =
    useState<SkillEditorFocusRequest | null>(null);
  const [metadataRows, setMetadataRows] = useState<MetadataRow[]>([]);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [files, setFiles] = useState<EditorFileRow[]>([]);
  const [openFileIds, setOpenFileIds] = useState<string[]>([]);
  const [activeFileId, setActiveFileId] = useState<string | null>(null);
  const [showFileTree, setShowFileTree] = useState(false);

  const hideError = (field: SkillEditorField): void => {
    setShownErrors((prev) => {
      if (prev[field] === undefined) return prev;
      const next = { ...prev };
      delete next[field];
      return next;
    });
  };

  const setName = (next: string): void => {
    setNameValue(next);
    hideError('name');
  };

  const setDescription = (next: string): void => {
    setDescriptionValue(next);
    hideError('description');
  };

  const setBody = (next: string): void => {
    setBodyValue(next);
    hideError('body');
  };

  const reset = (values: SkillEditorInitialValues): void => {
    setNameValue(values.name);
    setDescriptionValue(values.description);
    setBodyValue(values.body);
    setShownErrors({});
    const rows = values.extras
      .filter(({ key, value }) => key && value)
      .map(({ key, value, original }) =>
        createMetadataRow(key, value, original),
      );
    setMetadataRows(rows);
    setShowAdvanced(rows.length > 0);
    setShowPreview(false);
    setFiles(
      (values.files ?? []).map((file) =>
        createEditorFileRow(file.path, file.content, file.editable ?? true),
      ),
    );
    setOpenFileIds([]);
    setActiveFileId(null);
    setShowFileTree(false);
  };

  const addFile = (): void => {
    const taken = new Set(files.map((f) => f.path.trim().toLowerCase()));
    let candidate = 'new-file.md';
    let suffix = 2;
    while (taken.has(candidate)) {
      candidate = `new-file-${suffix}.md`;
      suffix += 1;
    }
    const row = createEditorFileRow(candidate, '');
    hideError('files');
    setFiles((prev) => [...prev, row]);
    setOpenFileIds((prev) => [...prev, row.id]);
    setActiveFileId(row.id);
  };

  const updateFilePath = (id: string, next: string): void => {
    hideError('files');
    setFiles((prev) =>
      prev.map((f) => (f.id === id ? { ...f, path: next } : f)),
    );
  };

  const updateFileContent = (id: string, next: string): void => {
    setFiles((prev) =>
      prev.map((f) => (f.id === id ? { ...f, content: next } : f)),
    );
  };

  const removeFile = (id: string): void => {
    hideError('files');
    setFiles((prev) => prev.filter((f) => f.id !== id));
    setOpenFileIds((prev) => prev.filter((openId) => openId !== id));
    setActiveFileId((prev) => (prev === id ? null : prev));
  };

  const openFileTab = (id: string): void => {
    setOpenFileIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
    setActiveFileId(id);
  };

  const closeFileTab = (id: string): void => {
    setOpenFileIds((prev) => prev.filter((openId) => openId !== id));
    setActiveFileId((prev) => (prev === id ? null : prev));
  };

  const selectMainFile = (): void => {
    setActiveFileId(null);
  };

  const addMetadataRow = (): void => {
    hideError('metadata');
    setMetadataRows((prev) => [...prev, createMetadataRow('', '')]);
  };

  const updateMetadataRow = (
    id: string,
    field: 'key' | 'value',
    next: string,
  ): void => {
    hideError('metadata');
    setMetadataRows((prev) =>
      prev.map((row) => (row.id === id ? { ...row, [field]: next } : row)),
    );
  };

  const removeMetadataRow = (id: string): void => {
    hideError('metadata');
    setMetadataRows((prev) => prev.filter((row) => row.id !== id));
  };

  const normalizedExtras = useMemo(() => {
    const out: Record<string, string> = {};
    for (const row of metadataRows) {
      const key = row.key.trim();
      const value = row.value.trim();
      if (!key || /\s/.test(key)) continue;
      if (key === 'name' || key === 'description') continue;
      if (!value) continue;
      out[key] = value;
    }
    return out;
  }, [metadataRows]);

  const preservedMetadata = useMemo(() => {
    const out: Record<string, unknown> = {};
    for (const row of metadataRows) {
      const key = row.key.trim();
      const value = row.value.trim();
      if (!key || /\s/.test(key)) continue;
      if (key === 'name' || key === 'description') continue;
      if (!value) continue;
      const original = row.original;
      out[key] =
        original &&
        row.key === original.key &&
        row.value === frontmatterValueToString(original.value)
          ? original.value
          : value;
    }
    return out;
  }, [metadataRows]);

  const skillName = name;
  const trimmedDescription = description.trim();
  const nameError = getCustomSkillNameValidationError(skillName) ?? '';
  const isNameValid = !nameError;

  const metadataKeyError = useMemo(() => {
    const seen = new Set<string>();
    for (const row of metadataRows) {
      const key = row.key.trim();
      if (!key) continue;
      if (/\s/.test(key)) {
        return `Metadata key "${row.key}" cannot contain whitespace.`;
      }
      if (key === 'name' || key === 'description') {
        return `Metadata key "${key}" is reserved.`;
      }
      if (seen.has(key)) {
        return `Duplicate metadata key "${key}".`;
      }
      seen.add(key);
    }
    return '';
  }, [metadataRows]);

  const previewContent = useMemo(
    () => ({
      frontmatter: {
        name: skillName,
        description: trimmedDescription,
        // The save payload uses preservedMetadata (typed originals for
        // untouched rows); the preview must render the same values or a
        // boolean like user-invocable: false previews as the string 'false'.
        ...preservedMetadata,
      },
      body,
    }),
    [skillName, trimmedDescription, body, preservedMetadata],
  );

  const filesError = useMemo(() => {
    const seen = new Set<string>();
    for (const file of files) {
      const filePath = file.path.trim();
      const pathError = getSkillFilePathValidationError(filePath);
      if (pathError) {
        return `File "${filePath || '(unnamed)'}": ${pathError}`;
      }
      const lower = filePath.toLowerCase();
      if (seen.has(lower)) {
        return `Duplicate file path "${filePath}".`;
      }
      seen.add(lower);
    }
    const lowerPaths = files.map((file) => file.path.trim().toLowerCase());
    for (const file of files) {
      const prefix = `${file.path.trim().toLowerCase()}/`;
      if (lowerPaths.some((other) => other.startsWith(prefix))) {
        return `File "${file.path.trim()}" conflicts with a folder of the same name.`;
      }
    }
    return '';
  }, [files]);

  const hasContent =
    isNameValid &&
    trimmedDescription.length > 0 &&
    body.trim().length > 0 &&
    !metadataKeyError &&
    !filesError;

  const revealErrors = (): boolean => {
    const current: Record<SkillEditorField, string> = {
      name: nameError,
      description: trimmedDescription ? '' : 'Enter a description.',
      body: body.trim() ? '' : 'Enter the skill content.',
      metadata: metadataKeyError,
      files: filesError,
    };
    const next: SkillEditorShownErrors = {};
    for (const field of SKILL_EDITOR_FIELDS) {
      if (current[field]) next[field] = current[field];
    }
    setShownErrors(next);
    const first = SKILL_EDITOR_FIELDS.find((field) => next[field]);
    if (!first) return true;
    // The name, description, content and metadata messages render in the
    // edit form, which a supporting file tab or Preview replaces, and the
    // metadata one only while Advanced is open: bring the form back so the
    // message Save just revealed is on screen.
    if (next.name || next.description || next.body || next.metadata) {
      setActiveFileId(null);
      setShowPreview(false);
    }
    if (next.metadata) setShowAdvanced(true);
    setFocusRequest((prev) => ({ field: first, seq: (prev?.seq ?? 0) + 1 }));
    return false;
  };

  return {
    name,
    description,
    body,
    metadataRows,
    showAdvanced,
    showPreview,
    skillName,
    trimmedDescription,
    nameError,
    isNameValid,
    metadataKeyError,
    normalizedExtras,
    preservedMetadata,
    previewContent,
    hasContent,
    files,
    openFileIds,
    activeFileId,
    showFileTree,
    filesError,
    shownErrors,
    focusRequest,
    revealErrors,
    setName,
    setDescription,
    setBody,
    setShowAdvanced,
    setShowPreview,
    addMetadataRow,
    updateMetadataRow,
    removeMetadataRow,
    addFile,
    updateFilePath,
    updateFileContent,
    removeFile,
    openFileTab,
    closeFileTab,
    selectMainFile,
    setShowFileTree,
    reset,
  };
}

interface SkillEditorBodyProps {
  state: UseSkillEditorStateResult;
  /** Auto-focus the name input on first mount (create flow). */
  nameAutoFocus: boolean;
  /** Header copy shown above the edit/preview toggle. */
  headerHint: JSX.Element | string;
  /**
   * Show the multi-file authoring surface (file tabs, tree, add/delete).
   * Off for the shared-skill editor, which is single-file by contract.
   */
  enableFiles?: boolean;
  /** In a flush dialog the fields sit on its 24px inset, not the page's 20px. */
  dialog?: boolean;
  /**
   * Escape typed in a text field stays in the field instead of reaching the
   * host page's Escape (Back), so it cannot discard the edits being typed.
   */
  textEntryEscapeBoundary?: boolean;
}

function SkillEditorBody({
  state,
  nameAutoFocus,
  headerHint,
  enableFiles = false,
  textEntryEscapeBoundary = false,
  dialog = false,
}: SkillEditorBodyProps): JSX.Element {
  const escapeBoundary = textEntryEscapeBoundary ? 'true' : undefined;
  const rootRef = useRef<HTMLDivElement>(null);
  const { focusRequest } = state;
  useEffect(() => {
    if (!focusRequest) return;
    rootRef.current
      ?.querySelector<HTMLElement>(
        SKILL_EDITOR_FIELD_FOCUS_SELECTORS[focusRequest.field],
      )
      ?.focus();
  }, [focusRequest]);
  const activeFile = enableFiles
    ? (state.files.find((f) => f.id === state.activeFileId) ?? null)
    : null;

  const filePane = activeFile ? (
    <Stack gap="item">
      <div className="flex items-end gap-2">
        <div className="min-w-0 flex-1">
          <FormField label="File path">
            {(control) => (
              <TextInput
                {...control}
                data-canopy-escape-boundary={escapeBoundary}
                mono
                value={activeFile.path}
                onChange={(e) =>
                  state.updateFilePath(activeFile.id, e.target.value)
                }
                placeholder="references/notes.md"
                spellCheck={false}
                disabled={!activeFile.editable}
                data-testid="skill-file-path-input"
              />
            )}
          </FormField>
        </div>
        <Tooltip label="Delete file">
          <Button
            variant="ghost-destructive"
            size="compact"
            iconOnly
            onClick={() => state.removeFile(activeFile.id)}
            aria-label="Delete file"
            data-testid="skill-file-delete"
            className="mb-0.5"
          >
            <AppCatalogTrashIcon size="sm" />
          </Button>
        </Tooltip>
      </div>
      {activeFile.editable ? (
        state.showPreview ? (
          <SkillFilePreview
            filePath={activeFile.path.trim() || 'file.txt'}
            state={{
              loading: false,
              error: '',
              data: {
                content: activeFile.content,
                truncated: false,
                binary: false,
              },
            }}
          />
        ) : (
          <TextArea
            data-canopy-escape-boundary={escapeBoundary}
            mono
            value={activeFile.content}
            onChange={(e) =>
              state.updateFileContent(activeFile.id, e.target.value)
            }
            rows={18}
            placeholder="File contents…"
            spellCheck={false}
            aria-label={`Contents of ${activeFile.path.trim() || 'the file'}`}
            data-testid="skill-file-content-input"
          />
        )
      ) : (
        <Surface variant="group">
          <p className="px-3 py-2 text-xs fg-secondary">
            This file cannot be edited here. It is kept unchanged when the skill
            is saved.
          </p>
        </Surface>
      )}
    </Stack>
  ) : null;

  const mainPane = state.showPreview ? (
    <MarkdownFrontmatterContent
      loading={false}
      error=""
      content={state.previewContent}
      emptyText="Nothing to preview yet."
    />
  ) : (
    <Stack gap="group">
      <FormField
        label="Name"
        id="skill-name-input"
        description="Lowercase letters, numbers, and hyphens only."
        error={state.shownErrors.name}
        dataTestId="skill-editor-name-field"
      >
        {(control) => (
          <TextInput
            {...control}
            data-canopy-escape-boundary={escapeBoundary}
            mono
            value={state.name}
            onChange={(e) => state.setName(e.target.value)}
            placeholder="my-skill-name"
            spellCheck={false}
            autoFocus={nameAutoFocus}
          />
        )}
      </FormField>

      <FormField
        label="Description"
        error={state.shownErrors.description}
        dataTestId="skill-editor-description-field"
      >
        {(control) => (
          <TextArea
            {...control}
            data-canopy-escape-boundary={escapeBoundary}
            value={state.description}
            onChange={(e) => state.setDescription(e.target.value)}
            data-testid="skill-editor-description-input"
            placeholder="One-line summary of when this skill should be used."
            rows={2}
          />
        )}
      </FormField>

      <Stack gap="inline">
        <Button
          className="self-start"
          variant="ghost"
          size="compact"
          onClick={() => state.setShowAdvanced(!state.showAdvanced)}
        >
          <AppCatalogChevronRightMediumIcon
            size="sm"
            className={`transition-transform ${state.showAdvanced ? 'rotate-90' : ''}`}
          />
          <span className="inline-flex items-center gap-2.5">
            Advanced metadata
            {state.metadataRows.length > 0 && (
              <Count value={state.metadataRows.length} />
            )}
          </span>
        </Button>

        {state.showAdvanced && (
          <Surface gap="inline" variant="group" padding="compact" className="">
            <div className="flex flex-col gap-2">
              <p className="text-xs fg-secondary">
                Extra YAML frontmatter keys. <code>name</code> and{' '}
                <code>description</code> are reserved.
              </p>
              {state.metadataRows.length === 0 && (
                <p className="text-xs fg-secondary italic">
                  No additional fields.
                </p>
              )}
              {state.metadataRows.map((row) => (
                <div key={row.id} className="flex items-center gap-2">
                  <div className="w-1/3 shrink-0">
                    <TextInput
                      data-canopy-escape-boundary={escapeBoundary}
                      mono
                      value={row.key}
                      onChange={(e) =>
                        state.updateMetadataRow(row.id, 'key', e.target.value)
                      }
                      placeholder="key"
                      spellCheck={false}
                      aria-label="Metadata key"
                      aria-invalid={
                        state.shownErrors.metadata ? true : undefined
                      }
                      aria-describedby={
                        state.shownErrors.metadata
                          ? 'skill-metadata-error'
                          : undefined
                      }
                    />
                  </div>
                  <div className="min-w-0 flex-1">
                    <TextInput
                      data-canopy-escape-boundary={escapeBoundary}
                      value={row.value}
                      onChange={(e) =>
                        state.updateMetadataRow(row.id, 'value', e.target.value)
                      }
                      placeholder="value"
                      aria-label="Metadata value"
                    />
                  </div>
                  <Tooltip label="Remove field">
                    <Button
                      variant="ghost-destructive"
                      size="compact"
                      iconOnly
                      onClick={() => state.removeMetadataRow(row.id)}
                      aria-label="Remove field"
                    >
                      <AppCatalogCloseIcon size="sm" />
                    </Button>
                  </Tooltip>
                </div>
              ))}
              {state.shownErrors.metadata && (
                <FieldError id="skill-metadata-error">
                  {state.shownErrors.metadata}
                </FieldError>
              )}
              <Button
                className="self-start"
                variant="ghost"
                size="compact"
                onClick={state.addMetadataRow}
              >
                <AppCatalogPlusIcon size="sm" />
                Add field
              </Button>
            </div>
          </Surface>
        )}
      </Stack>

      <FormField
        label="Skill content"
        error={state.shownErrors.body}
        dataTestId="skill-editor-body-field"
      >
        {(control) => (
          <TextArea
            {...control}
            data-canopy-escape-boundary={escapeBoundary}
            mono
            value={state.body}
            onChange={(e) => state.setBody(e.target.value)}
            placeholder={`# My Skill\n\nDescribe how the skill should be used, including examples and constraints.`}
            rows={18}
            spellCheck={false}
          />
        )}
      </FormField>
    </Stack>
  );

  const treePaths = [
    SKILL_MAIN_FILE,
    ...state.files.map((f) => f.path.trim()).filter(Boolean),
  ];

  return (
    <div className={dialog ? 'px-6' : 'px-5'} ref={rootRef}>
      <div className="flex items-center justify-between pb-3">
        <p className="text-xs fg-secondary">{headerHint}</p>
        <SegmentedControl<'edit' | 'preview'>
          label="Skill editor view"
          value={state.showPreview ? 'preview' : 'edit'}
          width="content"
          shape="capsule"
          options={SKILL_EDITOR_VIEW_OPTIONS}
          onChange={(next) => state.setShowPreview(next === 'preview')}
        />
      </div>

      {enableFiles && (
        <>
          <SkillFileTabBar
            tabs={state.openFileIds.flatMap((id) => {
              const file = state.files.find((f) => f.id === id);
              if (!file) return [];
              const trimmed = file.path.trim();
              return [
                {
                  key: id,
                  label: skillFileLabel(trimmed) || '(unnamed)',
                  title: trimmed || '(unnamed)',
                },
              ];
            })}
            activeKey={state.activeFileId}
            onSelectMain={state.selectMainFile}
            onSelectTab={state.openFileTab}
            onCloseTab={state.closeFileTab}
            treeToggle={{
              open: state.showFileTree,
              onToggle: () => state.setShowFileTree(!state.showFileTree),
            }}
            trailing={
              <Tooltip label="Add file">
                <Button
                  variant="ghost"
                  size="compact"
                  iconOnly
                  onClick={state.addFile}
                  aria-label="Add file"
                  data-testid="skill-editor-add-file"
                >
                  <AppCatalogPlusIcon size="sm" />
                </Button>
              </Tooltip>
            }
          />
          {state.shownErrors.files && (
            <div className="pb-2">
              <FieldError id="skill-files-error">
                {state.shownErrors.files}
              </FieldError>
            </div>
          )}
        </>
      )}

      <div className="flex gap-3">
        {enableFiles && state.showFileTree && (
          <Surface
            variant="outline"
            className="w-48 shrink-0 self-start overflow-hidden"
          >
            <div className="max-h-96 overflow-y-auto">
              <SkillFileTree
                files={treePaths}
                activePath={activeFile ? activeFile.path.trim() : null}
                onSelectFile={(selected) => {
                  if (selected === SKILL_MAIN_FILE) {
                    state.selectMainFile();
                    return;
                  }
                  const target = state.files.find(
                    (f) => f.path.trim() === selected,
                  );
                  if (target) state.openFileTab(target.id);
                }}
              />
            </div>
          </Surface>
        )}
        <div
          // Blocks the rendered SKILL.md and file previews; the edit form is
          // recorded with its input values masked. Keyed by mode so the block
          // class mounts with the preview: the recorder ignores a class added
          // to an already-recorded element.
          key={state.showPreview ? 'preview' : 'edit'}
          className={
            state.showPreview
              ? `${POSTHOG_REPLAY_BLOCK_CLASS} min-w-0 flex-1`
              : 'min-w-0 flex-1'
          }
          data-testid="skill-editor-pane"
        >
          {activeFile ? filePane : mainPane}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Custom skill editor: the create dialog and the installed skill's edit page
// ---------------------------------------------------------------------------

export interface CustomSkillEditorProps {
  /**
   * The custom skill to edit, or null to author a new one. The editor loads
   * the skill (SKILL.md plus supporting files) whenever this changes.
   */
  editingName: string | null;
  /**
   * `modal` is the authoring dialog. `page` is the installed skill's
   * Marketplace edit page (CAN-3485), laid out like the skill's detail page.
   */
  presentation: 'modal' | 'page';
  /** Dialog dismissal (X, backdrop, Escape); the dialog's Cancel too. */
  onClose: () => void;
  /** The page's Cancel and Back. Returns to the skill's details. */
  onCancel?: () => void;
  /**
   * Runs after a successful save with the saved (possibly renamed) name. The
   * dialog closes itself afterwards; the page leaves navigation to its host.
   * `isEditorOpen` reports whether this editor is still mounted, since the
   * user can leave the page while the save runs.
   */
  onSaved: (
    savedName: string,
    isEditorOpen: () => boolean,
  ) => Promise<void> | void;
  /**
   * "Edit with AI" on the edit page (CAN-1259), before Cancel. It waits for
   * Save or Cancel while the form has unsaved changes, which opening the chat
   * would discard.
   */
  editWithAI?: { onSelect: () => void; pending: boolean; error: string };
}

/** Why the edit page's "Edit with AI" waits (CAN-1259). */
const EDIT_WITH_AI_UNSAVED_REASON = 'Save or cancel your changes first.';

const SKILL_EDITOR_VIEW_OPTIONS: readonly SegmentedControlOption<
  'edit' | 'preview'
>[] = [
  { value: 'edit', label: 'Edit', dataTestId: 'skill-editor-mode-edit' },
  {
    value: 'preview',
    label: 'Preview',
    dataTestId: 'skill-editor-mode-preview',
  },
];

/**
 * The edit page's unsaved-changes guard: the one Workflows editors use, so
 * the sidebar, shortcuts, history and closing the window ask the same way
 * before the page's edits are lost. The dialog only opens while the page is
 * mounted, since the authoring dialog already blocks navigation.
 */
function SkillEditPageUnsavedGuard({
  editingName,
  name,
  isDirty,
  save,
}: {
  /** The saved skill's name; null for a new one, whose name may change. */
  readonly editingName: string | null;
  readonly name: string;
  readonly isDirty: boolean;
  readonly save: () => Promise<UnsavedChangesSaveResult>;
}): JSX.Element | null {
  const { prompt } = useWorkflowEditGuard({
    isDirty,
    save,
    // Stable while the name is typed, so a pending prompt survives it.
    targetKey: editingName === null ? 'skill:new' : `skill:${editingName}`,
  });
  return prompt ? <UnsavedChangesDialog name={name} {...prompt} /> : null;
}

const SAMPLE_SKILL_EDITOR_VALUES: SkillEditorSampleValues = {
  name: 'release-notes',
  description: 'Drafts release notes from the pull requests merged this week.',
  body: 'Collect the merged pull requests since the last tag.\n\nGroup them by area and write one line for each.',
};

/** A shared skill's SKILL.md, plain, for the read view's skeleton. */
const SAMPLE_SHARED_SKILL_CONTENT: {
  frontmatter: Record<string, unknown>;
  body: string;
} = {
  frontmatter: {},
  body: SAMPLE_SKILL_EDITOR_VALUES.body,
};

const rejectSampleFileRead = (): Promise<never> =>
  Promise.reject(new Error('Sample skills have no files.'));

interface SkillEditorBodySkeletonProps {
  label: string;
  testId: string;
  headerHint: JSX.Element | string;
  enableFiles?: boolean;
  dialog?: boolean;
}

/**
 * A skill that has not loaded: `SkillEditorBody` itself, rendered from plain
 * sample fields inside the measured `Skeleton`, so the bars sit where the
 * fields will. Wrap it in `DelayedLoadingPlaceholder` so a fast read never
 * flashes it.
 */
function SkillEditorBodySkeleton({
  label,
  testId,
  headerHint,
  enableFiles = false,
  dialog = false,
}: SkillEditorBodySkeletonProps): JSX.Element {
  const sample = useSkillEditorState(SAMPLE_SKILL_EDITOR_VALUES);
  return (
    <Skeleton loading label={label} testId={testId}>
      <SkillEditorBody
        state={sample}
        nameAutoFocus={false}
        headerHint={headerHint}
        enableFiles={enableFiles}
        dialog={dialog}
      />
    </Skeleton>
  );
}

/**
 * Custom skill authoring: name, description, advanced metadata, SKILL.md
 * content, supporting files, preview, validation, and save. One
 * implementation backs both the create dialog and the edit page.
 */
export function CustomSkillEditor({
  editingName,
  presentation,
  onClose,
  onCancel,
  onSaved,
  editWithAI,
}: CustomSkillEditorProps): JSX.Element {
  const editor = useSkillEditorState();
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [supportingFilesReady, setSupportingFilesReady] = useState(true);
  /** Fingerprint of the fields as loaded; `null` until they load. */
  const [loadedSnapshot, setLoadedSnapshot] = useState<string | null>(null);

  const isEdit = editingName !== null;
  const editorRef = useRef(editor);
  editorRef.current = editor;
  const mountedRef = useRef(true);
  useEffect((): (() => void) => {
    mountedRef.current = true;
    return (): void => {
      mountedRef.current = false;
    };
  }, []);

  // Reset the form whenever the editing target changes.
  useEffect(() => {
    setError('');
    if (editingName === null) {
      setSupportingFilesReady(true);
      editorRef.current.reset({
        name: '',
        description: '',
        body: '',
        extras: [],
      });
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setSupportingFilesReady(false);
    setLoadedSnapshot(null);

    void (async (): Promise<void> => {
      try {
        const [result, filesResult] = await Promise.all([
          window.skills.readContent('custom:app', editingName),
          window.skills.listFiles('custom:app', editingName),
        ]);
        if (cancelled) return;
        if (result.success && result.data) {
          const supportingPaths = resolveSupportingFilePaths(filesResult);
          if (!supportingPaths.success) {
            setError(supportingPaths.error);
            return;
          }
          const fm = result.data.frontmatter;
          const fmName = typeof fm.name === 'string' ? fm.name : editingName;
          const fmDescription =
            typeof fm.description === 'string' ? fm.description : '';
          const extras: Array<{
            key: string;
            value: string;
            original: { key: string; value: unknown };
          }> = [];
          for (const [k, v] of Object.entries(fm)) {
            if (k === 'name' || k === 'description') continue;
            // js-yaml's default schema can yield non-JSON values (e.g. Date
            // for YAML timestamps); preservedMetadata is a JSON-safe contract,
            // so normalize before capturing and derive the display string from
            // the same normalized value.
            const jsonSafeValue = toJsonSafeFrontmatterValue(v);
            if (jsonSafeValue === undefined) continue;
            const stringValue = frontmatterValueToString(jsonSafeValue);
            if (!stringValue) continue;
            extras.push({
              key: k,
              value: stringValue,
              original: { key: k, value: jsonSafeValue },
            });
          }

          // Load supporting files (everything except SKILL.md) so the
          // editor round-trips the full skill directory. Binary/oversized
          // files load as non-editable placeholders that are kept as-is.
          const extraPaths = supportingPaths.paths;
          const fileReads = await Promise.all(
            extraPaths.map((filePath) =>
              window.skills.readFile('custom:app', editingName, filePath),
            ),
          );
          if (cancelled) return;
          const files: Array<{
            path: string;
            content: string;
            editable?: boolean;
          }> = extraPaths.map((filePath, index) => {
            const read = fileReads[index];
            if (read.success && read.data) {
              return read.data.binary || read.data.truncated
                ? { path: filePath, content: '', editable: false }
                : { path: filePath, content: read.data.content };
            }
            return { path: filePath, content: '', editable: false };
          });

          editorRef.current.reset({
            name: fmName,
            description: fmDescription,
            body: result.data.body,
            extras,
            files,
          });
          // Mirrors how `reset` turns these values into editor rows.
          setLoadedSnapshot(
            skillEditorSnapshot({
              name: fmName,
              description: fmDescription,
              body: result.data.body,
              metadata: extras.filter(({ key, value }) => key && value),
              files: files.map((file) => ({
                path: file.path,
                content: file.content,
                editable: file.editable ?? true,
              })),
            }),
          );
          setSupportingFilesReady(true);
        } else {
          setError(result.error || 'Failed to load skill.');
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return (): void => {
      cancelled = true;
    };
  }, [editingName]);

  const hasUnsavedChanges =
    loadedSnapshot !== null &&
    skillEditorSnapshot({
      name: editor.name,
      description: editor.description,
      body: editor.body,
      metadata: editor.metadataRows,
      files: editor.files,
    }) !== loadedSnapshot;

  const canSave = isSkillEditorSaveEnabled({
    saving,
    loading,
    supportingFilesReady,
    hasContent: editor.hasContent,
  });

  const save = async (): Promise<UnsavedChangesSaveResult> => {
    if (!canSave) {
      if (!editor.hasContent) editor.revealErrors();
      // Said in place, since the prompt that asked has closed.
      const message = editor.hasContent
        ? 'This skill is still loading. Try again in a moment.'
        : "This skill can't be saved yet. Check its name, description, instructions and files.";
      setError(message);
      return { ok: false, message };
    }
    setSaving(true);
    setError('');
    try {
      const files: SkillEditableFile[] = editor.files.map((file) =>
        file.editable
          ? { path: file.path.trim(), content: file.content }
          : { path: file.path.trim() },
      );
      const result = await window.skills.saveCustomSkill({
        name: editor.skillName,
        description: editor.trimmedDescription,
        body: editor.body,
        files,
        ...(Object.keys(editor.preservedMetadata).length > 0
          ? { preservedMetadata: editor.preservedMetadata }
          : {}),
        ...(editingName ? { originalName: editingName } : {}),
      });
      if (result.success) {
        await onSaved(
          result.data?.name ?? editor.skillName,
          () => mountedRef.current,
        );
        if (presentation === 'modal') onClose();
        return { ok: true };
      }
      const message = result.error || 'Failed to save skill.';
      setError(message);
      return { ok: false, message };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      return { ok: false, message };
    } finally {
      setSaving(false);
    }
  };
  const handleSave = async (): Promise<void> => {
    // A field that blocks the save says so under itself, not in a banner.
    if (!editor.revealErrors()) return;
    await save();
  };
  // Save stays pressable while a field is invalid, so pressing it can say
  // which field needs attention.
  const saveDisabled = saving || loading || !supportingFilesReady;

  const title = isEdit ? `Edit skill: ${editingName}` : 'Create skill';
  const saveLabel = saving
    ? 'Saving…'
    : isEdit
      ? 'Save changes'
      : 'Create skill';
  const headerHint = (
    <>
      Custom skills are saved locally and shown as{' '}
      <span className="inline-flex items-center gap-1.5 align-middle">
        <Badge>custom</Badge>
        <span className="fg-primary font-medium">{brandText.appName}</span>
      </span>{' '}
      in the skills list.
    </>
  );
  const fields = loading ? (
    <DelayedLoadingPlaceholder slowNote="Still loading skill…">
      <SkillEditorBodySkeleton
        label="Loading skill"
        testId="skill-editor-loading"
        headerHint={headerHint}
        enableFiles
        dialog={presentation === 'modal'}
      />
    </DelayedLoadingPlaceholder>
  ) : (
    <SkillEditorBody
      state={editor}
      nameAutoFocus={!isEdit}
      enableFiles
      textEntryEscapeBoundary={presentation === 'page'}
      dialog={presentation === 'modal'}
      headerHint={headerHint}
    />
  );

  if (presentation === 'page') {
    const cancel = onCancel ?? onClose;
    return (
      <section
        className="mx-auto flex min-h-0 w-full max-w-3xl flex-col pt-8 pb-5"
        data-testid="skill-editor-page"
        aria-labelledby="skill-editor-page-title"
      >
        <Heading
          level={1}
          variant="page"
          id="skill-editor-page-title"
          className="sr-only"
        >
          {title}
        </Heading>
        <SkillEditPageUnsavedGuard
          editingName={editingName}
          name={editingName ?? (editor.skillName || 'New skill')}
          isDirty={hasUnsavedChanges}
          save={save}
        />
        <div className="flex flex-col px-5 gap-2">
          <div className="flex flex-col gap-0">
            <DetailBackButton onNavigateBack={cancel} />
            <div
              className="flex justify-end gap-2"
              data-testid="skill-editor-page-actions"
            >
              {editWithAI && (
                <SkillEditWithAIButton
                  state={
                    hasUnsavedChanges
                      ? {
                          available: false,
                          reason: EDIT_WITH_AI_UNSAVED_REASON,
                        }
                      : {
                          available: true,
                          onSelect: editWithAI.onSelect,
                          pending: editWithAI.pending || loading || saving,
                        }
                  }
                  dataTestId="skill-editor-edit-with-ai"
                />
              )}
              <Button
                size="compact"
                onClick={cancel}
                disabled={saving}
                data-testid="skill-editor-cancel"
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                size="compact"
                onClick={() => void handleSave()}
                disabled={saveDisabled}
                data-testid="skill-editor-save"
              >
                {saveLabel}
              </Button>
            </div>
          </div>
          <ErrorBanner
            errorSource="custom-skill-edit-with-ai"
            error={error || (editWithAI?.error ?? '')}
          />
        </div>
        {fields}
      </section>
    );
  }

  return (
    <DialogModal
      inset="flush"
      onClose={onClose}
      title={title}
      titleId="create-skill-modal-title"
      maxWidth="3xl"
      headerBorder={false}
    >
      <div className="flex flex-col flex-1 overflow-hidden">
        <div className="flex-1 overflow-y-auto pb-3">
          <div className="px-6">
            <ErrorBanner errorSource="custom-skill-edit" error={error} />
          </div>
          {fields}
        </div>

        <Surface variant="section" boundary="top">
          <div className="flex items-center justify-end gap-2 px-6 py-3">
            <Button
              size="compact"
              onClick={onClose}
              disabled={saving}
              data-testid="skill-editor-cancel"
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              size="compact"
              onClick={() => void handleSave()}
              disabled={saveDisabled}
              data-testid="skill-editor-save"
            >
              {saveLabel}
            </Button>
          </div>
        </Surface>
      </div>
    </DialogModal>
  );
}

interface CreateSkillModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSaved: (savedName: string) => Promise<void>;
}

/**
 * Custom skill authoring dialog. Exported for the same reason as
 * {@link AddSkillsModal}: the Plugins discovery page's "Add custom…" dropdown
 * opens this dialog directly rather than forking it (API-2153). Editing an
 * existing skill opens {@link CustomSkillEditor} as a page instead (CAN-3485).
 */
export function CreateSkillModal({
  isOpen,
  onClose,
  onSaved,
}: CreateSkillModalProps): JSX.Element | null {
  if (!isOpen) return null;
  return (
    <CustomSkillEditor
      editingName={null}
      presentation="modal"
      onClose={onClose}
      onSaved={onSaved}
    />
  );
}

// ---------------------------------------------------------------------------
// SharedSkillDetailModal
// ---------------------------------------------------------------------------

/** The ⋯ menu's member-link copy writes and notifies like Shared by you. */
const SHARED_SKILL_COPY_LINK_PORT: SharedByYouCopyLinkPort = {
  write: copyTextToClipboard,
  notify: postShareToast,
};

export function SharedSkillDetailModal({
  mode,
  summary,
  onClose,
  onUpdated,
  onSwitchToEdit,
  presentation = 'modal',
  onNavigateBack,
  onAdd,
  onOpenInstalled,
  shareAction,
  renderUnshare,
  unshareOptions,
  renderSharedByYou,
}: {
  mode: 'view' | 'edit';
  summary: SharedSkillSummary;
  onClose: () => void;
  onUpdated: (detail: SharedSkillDetail) => void;
  onSwitchToEdit: () => void;
  presentation?: 'modal' | 'page';
  onNavigateBack?: () => void;
  /**
   * Opens the shared install review (CAN-3710), which installs the skill and
   * lands on it. This page never writes the skill itself.
   */
  onAdd?: () => void;
  /** Opens the installed local copy by its custom skill name. */
  onOpenInstalled?: (skillName: string) => void;
  /**
   * Marketplace Share, first in the top-right actions; a team share
   * explains who can share it.
   */
  shareAction?: MarketplaceShareAction;
  /**
   * The owner's Unshare, rendered first among the secondaries once the
   * detail loads. The host gates it on the loaded detail's own verdict, so
   * a stale list summary never decides it.
   */
  renderUnshare?: (detail: SharedSkillDetail) => ReactNode;
  /**
   * The owner's Unshare for the loaded detail, or `null` when its own
   * verdict withholds it. A page lists it last in the header ⋯ menu; a
   * dialog shows it as a bar button.
   */
  unshareOptions?: (
    detail: SharedSkillDetail,
  ) => UseMarketplaceUnshareOptions | null;
  /**
   * The owner's "Shared by you" section for the loaded detail (CAN-4842),
   * with a re-read for after a public link is removed. Where it renders the
   * public-link row it owns removing the link, so the legacy Remove public
   * link controls step aside.
   */
  renderSharedByYou?: (
    detail: SharedSkillDetail,
    refresh: () => Promise<void>,
    refreshAfterPublish: () => Promise<void>,
  ) => ReactNode;
}): JSX.Element {
  const [detail, setDetail] = useState<DesktopSharedSkillDetail | null>(null);
  const { personalOrganizationId } = useResourceContext();
  const contextGeneration = useWorkspaceContextStore(
    (store) => store.appliedGeneration,
  );
  const canAdd = onAdd !== undefined && mode === 'view';
  // The installed copy of this share, when the arrival check finds one. A
  // receipted copy that differs from the share has an update (CAN-5307).
  const [installed, setInstalled] = useState<{
    skillName: string;
    updateAvailable: boolean;
  } | null>(null);
  const [checkingInstalled, setCheckingInstalled] = useState(canAdd);
  // Why the installed copy could not be verified. While set, neither Install
  // nor Update is offered: either could duplicate or overwrite a copy.
  const [installCheckError, setInstallCheckError] = useState('');
  // Rechecks after any skill install, update, or uninstall, and on retry.
  const [installCheckCount, setInstallCheckCount] = useState(0);
  const [confirmingUninstall, setConfirmingUninstall] = useState(false);
  const [parsed, setParsed] = useState<{
    frontmatter: Record<string, unknown>;
    body: string;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [sourceReadCount, setSourceReadCount] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const editor = useSkillEditorState();
  const editorRef = useRef(editor);
  editorRef.current = editor;

  const isEdit = mode === 'edit' && summary.canUpdate;
  // Shared by you lists the owner's audiences, so the header leaves them out
  // (CAN-5224). The row's facts stand in while the detail loads, avoiding a
  // flash; the loaded detail decides, and a failed load renders no card.
  const audienceFacts = detail ?? (loading ? summary : null);
  const audienceListedBelow =
    renderSharedByYou !== undefined &&
    !isEdit &&
    audienceFacts !== null &&
    sharedByYouAudienceCount(audienceFacts, personalOrganizationId) > 0;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    // A share that fails to load must not leave the previous one in place for
    // the installed check to read.
    setDetail(null);
    void (async (): Promise<void> => {
      try {
        const nextDetail = await window.skills.getShared(summary.id);
        if (cancelled) return;
        setDetail(nextDetail);
        const parsedSource = parseSkillSource(nextDetail.rawSkill);
        setParsed(parsedSource);
        const fm = parsedSource.frontmatter;
        const fmName = typeof fm.name === 'string' ? fm.name : summary.name;
        const fmDescription =
          typeof fm.description === 'string'
            ? fm.description
            : summary.description;
        const extras: Array<{ key: string; value: string }> = [];
        for (const [k, v] of Object.entries(fm)) {
          if (k === 'name' || k === 'description') continue;
          const stringValue = frontmatterValueToString(v);
          if (!stringValue) continue;
          extras.push({ key: k, value: stringValue });
        }
        editorRef.current.reset({
          name: fmName,
          description: fmDescription,
          body: parsedSource.body,
          extras,
        });
      } catch (err: unknown) {
        if (!cancelled) {
          setError(resolveSharedResourceErrorMessage(err));
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
          setSourceReadCount((count) => count + 1);
        }
      }
    })();
    return (): void => {
      cancelled = true;
    };
  }, [
    summary.id,
    summary.name,
    summary.description,
    summary.contentHash,
    summary.updatedAt,
    contextGeneration,
    installCheckCount,
  ]);

  // Arrival check, against the loaded share: a skill added earlier opens on
  // its outcome instead of offering Add again. Keyed on what decides the
  // answer, so refreshing the public-link state does not repeat it.
  const detailRef = useRef(detail);
  detailRef.current = detail;
  const installCheckKey = detail
    ? [
        detail.id,
        detail.contentHash,
        detail.distributionMode ?? '',
        detail.package?.digest ?? '',
      ].join('\n')
    : null;
  useEffect(() => {
    if (!canAdd) return undefined;
    const recheck = (): void => setInstallCheckCount((count) => count + 1);
    window.addEventListener(SKILLS_CHANGED_EVENT, recheck);
    return (): void => {
      window.removeEventListener(SKILLS_CHANGED_EVENT, recheck);
    };
  }, [canAdd]);
  useEffect(() => {
    if (!canAdd) return undefined;
    if (loading) {
      setInstalled(null);
      setInstallCheckError('');
      setCheckingInstalled(true);
      return undefined;
    }
    const loaded = detailRef.current;
    // A failed source read cannot establish that installing is safe.
    if (loaded === null) {
      setInstalled(null);
      setInstallCheckError('The shared skill could not be checked. Try again.');
      setCheckingInstalled(false);
      return undefined;
    }
    let cancelled = false;
    setCheckingInstalled(true);
    // Source and receipt ids are reloaded together after events/context changes.
    lookupInstalledSharedSkill(loaded)
      .then((found) => {
        if (cancelled) return;
        setInstalled(
          found.status === 'installed'
            ? {
                skillName: found.skillName,
                updateAvailable: found.updateAvailable,
              }
            : null,
        );
        setInstallCheckError(
          found.status === 'missing-copy'
            ? 'Your installed copy of this skill is missing. Restore it, then try again.'
            : found.status === 'unverified'
              ? 'Your installed copy of this skill could not be checked. Try again.'
              : '',
        );
      })
      .catch(() => {
        if (cancelled) return;
        setInstalled(null);
        setInstallCheckError(
          'Your installed copy of this skill could not be checked. Try again.',
        );
      })
      .finally(() => {
        if (!cancelled) setCheckingInstalled(false);
      });
    return (): void => {
      cancelled = true;
    };
  }, [canAdd, installCheckKey, loading, contextGeneration, sourceReadCount]);

  const handleUninstallInstalled = async (): Promise<string | null> => {
    if (!installed) return null;
    const result = await window.skills.removeSkill(
      CUSTOM_SKILL_SOURCE_ID,
      installed.skillName,
    );
    if (!result.success)
      return result.error ?? 'Failed to uninstall the skill.';
    await notifySkillsChanged();
    return null;
  };

  const refreshDetail = async (): Promise<void> => {
    try {
      const nextDetail = await window.skills.getShared(summary.id);
      setDetail(nextDetail);
      onUpdated(nextDetail);
    } catch {
      // Refresh is non-fatal — the mutation already succeeded; the row stays
      // stale until the modal is reopened.
    }
  };

  const handleSharedByYouPublicLinkRemoved = async (): Promise<void> => {
    if (!detail) return;
    // Removal already succeeded. Keep its access facts even if the re-read
    // fails, so both Copy link controls describe the remaining audience.
    const nextDetail = { ...detail, publicShare: null };
    setDetail(nextDetail);
    onUpdated(nextDetail);
    await refreshDetail();
  };

  const cloudOrigin = useCloudOrigin();
  const canonicalLink = detail
    ? marketplaceShareLink(cloudOrigin, 'skill', detail.id)
    : null;
  const linkAccess = detail
    ? marketplaceLinkAccess(detail, personalOrganizationId)
    : null;
  const copyScopedLinkItem = useMarketplaceCopyLinkMenuItem(
    !isEdit &&
      !loading &&
      detail?.id === summary.id &&
      canonicalLink &&
      linkAccess
      ? { link: canonicalLink, access: linkAccess }
      : null,
    SHARED_SKILL_COPY_LINK_PORT,
  );

  const handleSave = async (): Promise<void> => {
    if (!isEdit || !detail || saving) return;
    // A field that blocks the save says so under itself.
    if (!editor.revealErrors()) return;
    setSaving(true);
    setError('');
    try {
      const rawSkill = serializeSkillSource({
        name: editor.skillName,
        description: editor.trimmedDescription,
        body: editor.body,
        ...(Object.keys(editor.normalizedExtras).length > 0
          ? { extraMetadata: editor.normalizedExtras }
          : {}),
      });
      const updated = unwrapShareOperationResult(
        await window.skills.updateShared({
          skillId: detail.id,
          rawSkill,
          expectedContentHash: detail.contentHash,
        }),
      );
      setDetail(updated);
      const parsedSource = parseSkillSource(updated.rawSkill);
      setParsed(parsedSource);
      onUpdated(updated);
      onClose();
    } catch (err: unknown) {
      setError(
        `Failed to update shared skill. ${resolveSharedResourceErrorMessage(err)}`,
      );
    } finally {
      setSaving(false);
    }
  };

  const showInstalled = onAdd !== undefined && installed !== null;
  const showUpdate = showInstalled && installed.updateAvailable;
  const showInstallCheckError =
    onAdd !== undefined && !checkingInstalled && installCheckError !== '';
  const showAdd =
    onAdd !== undefined &&
    !showInstalled &&
    !checkingInstalled &&
    installCheckError === '';
  const installedStatus = showInstalled ? (
    <>
      Installed on this device as “
      <span className={POSTHOG_REPLAY_BLOCK_CLASS}>{installed.skillName}</span>”
      {showUpdate ? '. An update is available.' : ''}
    </>
  ) : null;
  const uninstallButton = !isEdit && showInstalled && (
    <Button
      variant="secondary"
      size="sm"
      data-testid="shared-skill-detail-uninstall"
      onClick={() => setConfirmingUninstall(true)}
    >
      Uninstall
    </Button>
  );
  const uninstallDialog = confirmingUninstall && installed && (
    <UninstallConfirmDialog
      title="Uninstall this skill?"
      message={
        <>
          “
          <span className={POSTHOG_REPLAY_BLOCK_CLASS}>
            {installed.skillName}
          </span>
          ” is removed from this device. You can install the shared skill again
          later.
        </>
      }
      dataTestId="shared-skill-detail-uninstall-dialog"
      confirmTestId="shared-skill-detail-uninstall-confirm"
      onConfirm={handleUninstallInstalled}
      onCancel={() => setConfirmingUninstall(false)}
      onUninstalled={() => setConfirmingUninstall(false)}
    />
  );
  // A stale copy updates through the same review that installs; this page
  // never writes the skill itself. Without that review, nothing is offered.
  const updateOrRetryPrimary = showUpdate ? (
    <Button
      variant="primary"
      size="sm"
      data-testid="shared-skill-detail-update"
      onClick={onAdd}
    >
      Update
    </Button>
  ) : showInstallCheckError ? (
    <Button
      variant="primary"
      size="sm"
      data-testid="shared-skill-detail-retry"
      onClick={() => setInstallCheckCount((count) => count + 1)}
    >
      Try again
    </Button>
  ) : null;

  const page = presentation === 'page';
  const loadedUnshare =
    !loading && detail ? (unshareOptions?.(detail) ?? null) : null;
  const editButton = summary.canUpdate && (
    <Button size="compact" onClick={onSwitchToEdit}>
      <AppCatalogDocumentPencilIcon size="sm" />
      Edit
    </Button>
  );
  // A page shows only a Share it can use; a blocked one reads as clutter.
  const visibleShareAction =
    page && shareAction?.status !== 'shareable' ? undefined : shareAction;

  // The standard action bar: [status] [Edit] [Share] [Add or Open skill].
  // A page keeps Edit, Share and the primary visible and moves the rest into
  // the header's ⋯ menu (CAN-4261).
  const pageActions: DetailPageActionsProps | undefined = !isEdit
    ? {
        secondary: page ? (
          editButton
        ) : (
          <>
            {copyScopedLinkItem && (
              <DetailMoreMenu
                name={summary.name}
                items={[copyScopedLinkItem]}
                triggerTestId="plugins-entry-detail-more"
                menuTestId="plugins-entry-detail-menu"
              />
            )}
            {!loading && detail && renderUnshare?.(detail)}
            {!loading && loadedUnshare && (
              <MarketplaceUnshareAction {...loadedUnshare} />
            )}
            {showInstalled && onOpenInstalled && (
              <Button
                size="compact"
                data-testid="shared-skill-detail-open"
                onClick={() => onOpenInstalled(installed.skillName)}
              >
                Open skill
              </Button>
            )}
            {uninstallButton}
            {showInstalled && (
              <span
                data-testid="shared-skill-detail-installed-status"
                className="min-w-0 break-words text-xs fg-secondary"
              >
                {installedStatus}
                {showUpdate ? '' : '.'}
              </span>
            )}
            {showInstallCheckError && (
              <span
                data-testid="shared-skill-detail-install-check-error"
                className="min-w-0 break-words text-xs fg-secondary"
              >
                {installCheckError}
              </span>
            )}
            {editButton}
          </>
        ),
        share: visibleShareAction ? (
          <MarketplaceShareButton
            action={visibleShareAction}
            name={summary.name}
            placement="detail"
            dataTestId="plugins-entry-detail-share"
          />
        ) : undefined,
        primary: updateOrRetryPrimary ?? (
          <TryItPrimaryCta
            capability={{
              kind: 'skill',
              sourceId: 'cloud-shared',
              catalogId: summary.id,
              name: summary.name,
            }}
            prompt={buildTryItPrompt({
              kind: 'skill',
              name: summary.name,
              description: summary.description,
              frontmatter: parsed?.frontmatter,
            })}
            installation={
              loading || checkingInstalled
                ? 'loading'
                : installed
                  ? 'installed'
                  : 'not-installed'
            }
            runtimeSelections={
              installed
                ? {
                    skillRefs: [
                      {
                        sourceId: CUSTOM_SKILL_SOURCE_ID,
                        skillName: installed.skillName,
                      },
                    ],
                    pluginRefs: [],
                  }
                : undefined
            }
            onInstall={() => onAdd?.()}
            installDisabled={!onAdd}
            guestInstallAction={
              showAdd ? (
                <Button
                  size="compact"
                  data-testid="shared-skill-detail-add"
                  onClick={onAdd}
                >
                  Install
                </Button>
              ) : undefined
            }
          />
        ),
      }
    : undefined;
  const topRightActions = pageActions ? (
    <DetailActionBar {...pageActions} />
  ) : undefined;

  const detailContent = (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex-1 overflow-y-auto pb-3">
        <div className={page ? 'px-5' : 'px-6'}>
          <ErrorBanner errorSource="shared-skill-detail-modal" error={error} />
        </div>
        {!loading && detail?.savedFrom && (
          <p
            data-testid="shared-skill-detail-saved-from"
            className={
              page
                ? 'px-5 pb-3 text-xs fg-secondary'
                : 'px-6 pb-3 text-xs fg-secondary'
            }
          >
            {detail.savedFrom.name
              ? `Saved from ${detail.savedFrom.name}`
              : 'Saved copy'}
            {detail.savedFrom.createdByName
              ? ` by ${detail.savedFrom.createdByName}`
              : ''}
          </p>
        )}
        {loading ? (
          <DelayedLoadingPlaceholder slowNote="Still loading shared skill…">
            {isEdit ? (
              <SkillEditorBodySkeleton
                label="Loading shared skill"
                testId="shared-skill-detail-loading"
                headerHint={`Edits are saved to ${brandText.appName} Cloud.`}
                dialog={!page}
              />
            ) : (
              <Skeleton
                loading
                label="Loading shared skill"
                testId="shared-skill-detail-loading"
              >
                <SkillReadDetail
                  skill={{ sourceId: 'cloud-shared', name: summary.name }}
                  inset={page ? 'page' : 'dialog'}
                  {...(page
                    ? {
                        hostHeader: {
                          title: summary.name,
                          description: summary.description,
                        },
                      }
                    : {})}
                  content={SAMPLE_SHARED_SKILL_CONTENT}
                  files={[]}
                  loading={false}
                  error=""
                  readFile={rejectSampleFileRead}
                />
              </Skeleton>
            )}
          </DelayedLoadingPlaceholder>
        ) : isEdit ? (
          <SkillEditorBody
            state={editor}
            nameAutoFocus={false}
            headerHint={`Edits are saved to ${brandText.appName} Cloud.`}
            dialog={!page}
          />
        ) : (
          <SkillReadDetail
            skill={{ sourceId: 'cloud-shared', name: summary.name }}
            inset={page ? 'page' : 'dialog'}
            {...(page
              ? {
                  // The page header shows the name and description; the
                  // body drops its frontmatter card and repeated title.
                  hostHeader: {
                    title: summary.name,
                    description: summary.description,
                  },
                }
              : {})}
            content={parsed}
            files={[]}
            loading={false}
            error=""
            readFile={() =>
              Promise.reject(
                new Error(
                  'Open the installed copy to browse its supporting files.',
                ),
              )
            }
          />
        )}
        {(renderSharedByYou || !page) && !loading && detail && !isEdit && (
          <div
            className={
              page ? 'px-5 pt-6 empty:hidden' : 'px-6 pt-6 empty:hidden'
            }
          >
            {renderSharedByYou ? (
              renderSharedByYou(
                detail,
                handleSharedByYouPublicLinkRemoved,
                refreshDetail,
              )
            ) : (
              <SharedByYou
                kind="skill"
                shareId={detail.id}
                name={detail.name}
                facts={detail}
                onRefresh={refreshDetail}
                onUnshared={(audience): void => {
                  if (audience.id === 'public')
                    void handleSharedByYouPublicLinkRemoved();
                  else onClose();
                }}
              />
            )}
          </div>
        )}
      </div>
      {/* View mode has no footer: a Close would duplicate the X. */}
      {presentation === 'modal' && isEdit && (
        <Surface variant="section" boundary="top">
          <div className="flex items-center justify-end gap-2 px-6 py-3">
            <Button size="compact" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button
              variant="primary"
              size="compact"
              onClick={() => void handleSave()}
              disabled={loading || saving}
            >
              {saving ? 'Saving…' : 'Save changes'}
            </Button>
          </div>
        </Surface>
      )}
    </div>
  );

  if (page) {
    // The shared detail header (CAN-4261): title, description and meta,
    // `[⋯] [Edit] [Share] [Primary]`, the rarer actions in ⋯ with the
    // owner's Unshare last.
    const moreItems: DetailMoreMenuItem[] = [];
    if (!isEdit && showInstalled && onOpenInstalled)
      moreItems.push({
        id: 'open-installed',
        label: 'Open installed skill',
        icon: <ArrowUpRightIcon size="sm" aria-hidden />,
        testId: 'shared-skill-detail-open',
        onSelect: () => onOpenInstalled(installed.skillName),
      });
    if (!isEdit && showInstalled)
      moreItems.push({
        id: 'uninstall-installed',
        label: 'Uninstall',
        icon: <AppCatalogTrashIcon size="sm" aria-hidden />,
        testId: 'shared-skill-detail-uninstall',
        destructive: true,
        onSelect: () => setConfirmingUninstall(true),
      });
    // Copy link leads the link actions; it never publishes or changes access.
    if (copyScopedLinkItem) moreItems.push(copyScopedLinkItem);
    // Provenance reads the freshest facts: the loaded detail, else the row.
    const provenance = sharedSkillDetailHeader(
      detail ?? summary,
      personalOrganizationId,
      { audienceListedBelow },
    );
    const header = {
      ...provenance,
      description: summary.description,
      meta: [
        ...(provenance.meta ?? []),
        showInstalled ? (
          <span
            key="installed"
            data-testid="shared-skill-detail-installed-status"
          >
            {installedStatus}
          </span>
        ) : null,
        showInstallCheckError ? (
          <span
            key="install-check-error"
            data-testid="shared-skill-detail-install-check-error"
          >
            {installCheckError}
          </span>
        ) : null,
        // The installed copy is one click away, not only in the ⋯ menu.
        !isEdit && showInstalled && onOpenInstalled ? (
          <Button
            key="open-installed"
            variant="link"
            data-testid="shared-skill-detail-open-installed"
            onClick={() => onOpenInstalled(installed.skillName)}
          >
            Open
          </Button>
        ) : null,
        !loading && detail?.publicShare && !audienceListedBelow
          ? 'Public link'
          : null,
      ],
    };
    const shell = (items: readonly DetailMoreMenuItem[]): JSX.Element => (
      <MarketplaceDetailPageShell
        title={summary.name}
        onNavigateBack={onNavigateBack}
        header={header}
        moreItems={items}
      >
        {pageActions && <DetailPageActions {...pageActions} />}
        {detailContent}
        {uninstallDialog}
      </MarketplaceDetailPageShell>
    );
    return loadedUnshare ? (
      <SharedSkillUnshareShell
        options={loadedUnshare}
        items={moreItems}
        audienceCount={
          detail ? sharedByYouAudienceCount(detail, personalOrganizationId) : 0
        }
      >
        {shell}
      </SharedSkillUnshareShell>
    ) : (
      shell(moreItems)
    );
  }

  return (
    <DialogModal
      inset="flush"
      onClose={saving ? (): void => {} : onClose}
      title={isEdit ? `Edit shared skill: ${summary.name}` : summary.name}
      titleId="shared-skill-detail-modal-title"
      maxWidth={isEdit ? '3xl' : '2xl'}
      headerBorder={false}
      closeOnBackdrop={!saving}
      topRightActions={topRightActions}
      scrollableBody={isEdit}
    >
      {detailContent}
      {uninstallDialog}
    </DialogModal>
  );
}

/** Adds the owner's Unshare, last, to a shared skill page's ⋯ menu. */
function SharedSkillUnshareShell({
  options,
  items,
  audienceCount,
  children,
}: {
  options: UseMarketplaceUnshareOptions;
  items: readonly DetailMoreMenuItem[];
  /** Shared by you rows; two read the item "Unshare all" (CAN-4842). */
  audienceCount: number;
  children: (items: readonly DetailMoreMenuItem[]) => JSX.Element;
}): JSX.Element {
  const unshare = useMarketplaceUnshare(options);
  return (
    <>
      {children([
        ...items,
        { ...unshare.item, label: marketplaceUnshareMenuLabel(audienceCount) },
      ])}
      {unshare.dialog}
    </>
  );
}

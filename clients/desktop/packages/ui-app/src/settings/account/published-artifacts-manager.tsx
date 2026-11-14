'use client';

import { Badge } from '@canopy/ui-shared/components/Badge';
import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import { Plus } from '@canopy/ui-shared/icons/AppIcons';
import {
  Button,
  DialogModal,
  EmptyState,
  ErrorBanner,
  SearchField,
  TabBar,
} from '@canopy/ui-shared/components';
import {
  MAX_FEATURED_ARTIFACTS,
  PROFILE_ARTIFACT_PATH_KINDS,
  type ProfileArtifactPathKind,
  type PublishableArtifactItem,
  type PublishedProfileArtifactItem,
} from '@canopy/protocol/settings/account-publishing';
import type { PublicProfileArtifactDetail } from '@canopy/protocol/profile';
import { SettingsConfirmDialog, SettingsLink } from '../host';
import { SETTINGS_LOAD_ERROR_COPY } from '../errors';
import {
  WORKFLOW_ITEM_LABEL,
  WORKFLOW_ITEM_LABEL_PLURAL,
} from '@canopy/ui-shared/lib/workflow-labels';
import { formatDate } from '@canopy/ui-shared/lib';
import { CopyTextButton } from './CopyTextButton';
import { usePublicProfileEditor } from './use-public-profile-editor';
import { SETTINGS_GROUP_CLASS } from '@canopy/ui-shared/components/settings/SettingsCard';
import { Surface } from '@canopy/ui-shared/components';

const KIND_LABELS: Record<ProfileArtifactPathKind, string> = {
  skills: 'Skill',
  runs: 'Run',
  plans: 'Plan',
  pipelines: WORKFLOW_ITEM_LABEL,
};

const KIND_TAB_LABELS: Record<ProfileArtifactPathKind, string> = {
  skills: 'Skills',
  runs: 'Runs',
  plans: 'Plans',
  pipelines: WORKFLOW_ITEM_LABEL_PLURAL,
};

/** Human-readable payload the confirm dialog shows verbatim before publishing. */
function previewBody(detail: PublicProfileArtifactDetail): string {
  if (detail.kind === 'run') {
    const r = detail.rollup;
    return [
      detail.summary,
      '',
      `Tokens: ${r.inputTokens + r.outputTokens}`,
      `Turns: ${r.turnCount}`,
      `Tools used: ${r.toolUseCount}`,
      `Provider: ${r.provider}`,
    ]
      .filter(Boolean)
      .join('\n');
  }
  if (detail.kind === 'plan') {
    return detail.content;
  }
  return [detail.description, '', detail.rawPipeline]
    .filter(Boolean)
    .join('\n');
}

interface PendingPublish {
  kind: ProfileArtifactPathKind;
  id: string;
  title: string;
  /** Preview payload for run/plan/pipeline; null for skills (no preview). */
  detail: PublicProfileArtifactDetail | null;
}

/**
 * "Featured work" manager (GitHub pinned-items pattern): the page lists only
 * the artifacts currently on the profile — a small, user-curated set — and new
 * items are added through a search picker dialog that queries the server per
 * kind. Users can have thousands of sources; nothing here ever loads them all.
 */
export function PublishedArtifactsManager(): JSX.Element {
  const editor = usePublicProfileEditor();
  const [published, setPublished] = useState<
    PublishedProfileArtifactItem[] | null
  >(null);
  const [loadError, setLoadError] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pending, setPending] = useState<PendingPublish | null>(null);
  // A skill whose share link the user has asked to revoke (awaiting confirm).
  const [pendingRevoke, setPendingRevoke] =
    useState<PublishedProfileArtifactItem | null>(null);

  const atLimit = (published?.length ?? 0) >= MAX_FEATURED_ARTIFACTS;

  const refresh = useCallback(async (): Promise<void> => {
    const result = await editor.listPublished();
    if (result) {
      setPublished(result.items);
      setLoadError(false);
    } else {
      setLoadError(true);
    }
  }, [editor]);

  useEffect(() => {
    const id = window.setTimeout(() => void refresh(), 0);
    return (): void => window.clearTimeout(id);
  }, [refresh]);

  const beginPublish = async (
    kind: ProfileArtifactPathKind,
    item: { id: string; title: string },
  ): Promise<void> => {
    // Skills have no preview endpoint (the share row is the snapshot); publish
    // directly through a generic confirm. Others fetch the exact pinned payload.
    if (kind === 'skills') {
      setPending({ kind, id: item.id, title: item.title, detail: null });
      return;
    }
    const detail = await editor.previewArtifact(kind, item.id);
    setPending({ kind, id: item.id, title: item.title, detail });
  };

  const confirmPublish = async (): Promise<void> => {
    if (!pending) {
      return;
    }
    const ok = await editor.publishArtifact(pending.kind, pending.id);
    setPending(null);
    if (ok) {
      await refresh();
    }
  };

  const unpublish = async (
    item: PublishedProfileArtifactItem,
  ): Promise<void> => {
    const ok = await editor.unpublishArtifact(item.kind, item.id);
    if (ok) {
      await refresh();
    }
  };

  const confirmRevokeShare = async (): Promise<void> => {
    if (!pendingRevoke) {
      return;
    }
    const ok = await editor.revokeSkillShare(pendingRevoke.id);
    setPendingRevoke(null);
    if (ok) {
      await refresh();
    }
  };

  return (
    <div
      className="flex flex-col gap-4"
      data-testid="published-artifacts-manager"
    >
      {/* The enclosing settings card owns the "Featured work" heading, so this
          row holds only the add control. */}
      <div className="flex justify-end">
        <div className="flex flex-col items-end gap-1">
          <Button
            size="compact"
            onClick={() => setPickerOpen(true)}
            disabled={atLimit}
            data-testid="featured-work-add"
          >
            <Plus size={14} aria-hidden="true" />
            Add work
          </Button>
          {published && (
            <span
              className={`text-xs ${atLimit ? 'fg-warning' : 'fg-secondary'}`}
              data-testid="featured-work-count"
            >
              {published.length}/{MAX_FEATURED_ARTIFACTS}
              {atLimit && ' · remove one to add more'}
            </span>
          )}
        </div>
      </div>

      <ErrorBanner
        errorSource="published-artifacts-manager-load"
        className=""
        error={loadError ? SETTINGS_LOAD_ERROR_COPY : null}
        onRetry={() => void refresh()}
      />

      <ErrorBanner
        errorSource="published-artifacts-manager-editor"
        className=""
        error={editor.error?.copy}
        details={editor.error?.details}
      />

      {published && published.length === 0 && !loadError && (
        <EmptyState
          testId="featured-work-empty"
          title="Nothing featured yet"
          subtitle="Showcase your best work — add a skill, run, plan, or workflow to your profile."
        />
      )}

      {published && published.length > 0 && (
        <ul className={SETTINGS_GROUP_CLASS}>
          {published.map((item) => (
            <li
              key={`${item.kind}-${item.id}`}
              className="flex flex-wrap items-center justify-between gap-3"
              data-testid={`featured-row-${item.kind}-${item.id}`}
            >
              <div className="min-w-0 flex flex-col gap-1">
                <div>
                  <div className="flex items-center gap-2">
                    <Badge>{KIND_LABELS[item.kind]}</Badge>
                    <p className="truncate text-s font-medium fg-primary">
                      {item.title}
                    </p>
                  </div>

                  <p className="mt-0.5 text-xs fg-secondary">
                    Featured {formatDate(item.publishedAt)}
                    {item.publishedStale && (
                      <span className="ml-2 fg-warning">
                        Source changed since — update the snapshot
                      </span>
                    )}
                  </p>
                </div>

                {item.kind === 'skills' && item.sharePath && (
                  <div className="flex flex-wrap items-center gap-2">
                    {/* A share page is outside settings: hosts without the
                        web router open it in the browser. */}
                    <SettingsLink
                      href={item.sharePath}
                      className="text-xs fg-accent hover:underline"
                    >
                      {item.sharePath}
                    </SettingsLink>
                    <CopyTextButton
                      value={item.sharePath}
                      label="Copy link"
                      copiedLabel="Copied"
                    />
                  </div>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {item.publishedStale && (
                  <Button
                    size="compact"
                    onClick={() => void beginPublish(item.kind, item)}
                    disabled={editor.busy}
                    data-testid={`featured-update-${item.id}`}
                  >
                    Update
                  </Button>
                )}
                {item.kind === 'skills' && item.sharePath && (
                  <Button
                    size="compact"
                    variant="ghost-destructive"
                    onClick={() => setPendingRevoke(item)}
                    disabled={editor.busy}
                    data-testid={`featured-revoke-${item.id}`}
                  >
                    Revoke link
                  </Button>
                )}
                <Button
                  size="compact"
                  onClick={() => void unpublish(item)}
                  disabled={editor.busy}
                  data-testid={`featured-remove-${item.id}`}
                >
                  Remove
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {pickerOpen && (
        <AddWorkDialog
          published={published ?? []}
          search={editor.searchArtifacts}
          busy={editor.busy}
          atLimit={atLimit}
          onPick={(kind, item) => void beginPublish(kind, item)}
          onClose={() => setPickerOpen(false)}
        />
      )}

      {pending && (
        <SettingsConfirmDialog
          title={`Feature “${pending.title}”?`}
          confirmLabel="Add to profile"
          busyLabel="Adding…"
          busy={editor.busy}
          onCancel={() => setPending(null)}
          onConfirm={() => void confirmPublish()}
          dataTestId="publish-artifact-confirm"
          message={
            <div className="flex flex-col gap-2">
              {pending.kind === 'skills' ? (
                <p>
                  This creates a public share link and lists the skill on your
                  profile. Anyone with the link can view its current contents.
                </p>
              ) : (
                <>
                  <p>This is exactly what will be public:</p>
                  <Surface
                    variant="group"
                    size="small"
                    className="overflow-hidden"
                  >
                    <pre className="max-h-64 overflow-auto p-3 text-xs fg-primary">
                      {pending.detail ? previewBody(pending.detail) : '…'}
                    </pre>
                  </Surface>
                </>
              )}
            </div>
          }
        />
      )}

      {pendingRevoke && (
        <SettingsConfirmDialog
          title={`Revoke the share link for “${pendingRevoke.title}”?`}
          confirmLabel="Revoke share link"
          busyLabel="Revoking…"
          busy={editor.busy}
          destructive
          onCancel={() => setPendingRevoke(null)}
          onConfirm={() => void confirmRevokeShare()}
          dataTestId="revoke-share-confirm"
          message={
            <p>
              This permanently breaks every existing {pendingRevoke.sharePath}{' '}
              link and removes the skill from your profile. Anyone you shared
              the link with will no longer be able to open it. You can publish
              it again later to create a new link.
            </p>
          }
        />
      )}
    </div>
  );
}

interface AddWorkDialogProps {
  published: PublishedProfileArtifactItem[];
  search: ReturnType<typeof usePublicProfileEditor>['searchArtifacts'];
  busy: boolean;
  /** At the featured-work cap: rows stay browsable but Add is disabled. */
  atLimit: boolean;
  onPick: (
    kind: ProfileArtifactPathKind,
    item: { id: string; title: string },
  ) => void;
  onClose: () => void;
}

/**
 * Search picker for featuring work: kind tabs + a debounced server-side title
 * search (newest results when the query is empty). Scales to users with
 * thousands of sources because only the top matches are ever fetched.
 */
function AddWorkDialog({
  published,
  search,
  busy,
  atLimit,
  onPick,
  onClose,
}: AddWorkDialogProps): JSX.Element {
  const [kind, setKind] = useState<ProfileArtifactPathKind>('skills');
  const [query, setQuery] = useState('');
  // Results carry the (kind, query) they answer; "searching" is derived from a
  // key mismatch so the effect never sets state synchronously.
  const [settled, setSettled] = useState<{
    key: string;
    items: PublishableArtifactItem[];
  } | null>(null);
  // Monotonic request id so a slow earlier search can't clobber newer results.
  const requestSeq = useRef(0);

  const searchKey = `${kind} ${query}`;
  const searching = settled === null || settled.key !== searchKey;
  const results = searching ? null : (settled?.items ?? null);

  const publishedIds = new Set(
    published.filter((p) => p.kind === kind).map((p) => p.id),
  );

  useEffect(() => {
    const seq = ++requestSeq.current;
    const key = `${kind} ${query}`;
    const id = window.setTimeout(() => {
      void search(kind, query).then((response) => {
        if (seq !== requestSeq.current) {
          return;
        }
        setSettled({ key, items: response ? response.items : [] });
      });
    }, 300);
    return (): void => window.clearTimeout(id);
  }, [kind, query, search]);

  return (
    <DialogModal
      onClose={onClose}
      title="Add work to your profile"
      maxWidth="lg"
      dataTestId="add-work-dialog"
    >
      {atLimit && (
        <Surface variant="group" size="small">
          <p className="px-3 py-2 text-s fg-warning" role="status">
            You&apos;ve reached the {MAX_FEATURED_ARTIFACTS}-item limit. Remove
            something from your profile to feature more.
          </p>
        </Surface>
      )}
      <TabBar
        items={PROFILE_ARTIFACT_PATH_KINDS.map((tabKind) => ({
          id: tabKind,
          label: KIND_TAB_LABELS[tabKind],
          dataTestId: `add-work-tab-${tabKind}`,
        }))}
        value={kind}
        onChange={(next): void => setKind(next)}
        label="Work type"
        density="compact"
      />

      <SearchField
        value={query}
        onValueChange={setQuery}
        aria-label={`Search your ${KIND_TAB_LABELS[kind].toLowerCase()}`}
        placeholder={`Search your ${KIND_TAB_LABELS[kind].toLowerCase()}…`}
        data-testid="add-work-search"
      />

      <div className="max-h-80 overflow-y-auto">
        {searching && results === null && (
          <p className="px-1 py-4 text-s fg-secondary">Searching…</p>
        )}
        {results && results.length === 0 && !searching && (
          <p className="px-1 py-4 text-s fg-secondary">
            {query
              ? `No ${KIND_TAB_LABELS[kind].toLowerCase()} match “${query}”.`
              : `You don't have any ${KIND_TAB_LABELS[kind].toLowerCase()} yet.`}
          </p>
        )}
        {results && results.length > 0 && (
          <ul className="divide-y">
            {results.map((item) => {
              const alreadyFeatured =
                item.published || publishedIds.has(item.id);
              return (
                <li
                  key={item.id}
                  className="flex items-center justify-between gap-3 px-1 py-2.5"
                  data-testid={`add-work-row-${item.id}`}
                >
                  <div className="min-w-0">
                    <p className="truncate text-s font-medium fg-primary">
                      {item.title}
                    </p>
                    <p className="text-xs fg-secondary">
                      Updated {formatDate(item.updatedAt)}
                    </p>
                  </div>
                  {alreadyFeatured ? (
                    <span className="shrink-0 text-xs fg-secondary">
                      On profile
                    </span>
                  ) : (
                    <Button
                      size="compact"
                      onClick={() => onPick(kind, item)}
                      disabled={busy || atLimit}
                      data-testid={`add-work-pick-${item.id}`}
                    >
                      Add
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </DialogModal>
  );
}

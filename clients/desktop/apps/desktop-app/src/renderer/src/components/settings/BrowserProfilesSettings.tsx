import { BrowserProfileDataSettings } from './BrowserProfileDataSettings';
import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import {
  BrowserProfileBadge,
  BrowserProfilePermissions,
  Button,
  ColorSwatchPicker,
  ConfirmDialog,
  EmptyStateRow,
  Notice,
  NoticeButton,
  SettingsButtonRow,
} from '@canopy/ui-shared';
import type {
  BrowserProfileRecord,
  BrowserProfilePatch,
  BrowserProfileDeletePreview,
} from '@canopy/protocol/browser-profiles';
import type { SidebarItem } from '@canopy/desktop-shared/types';
import { useProjectsStore } from '@/stores/projectsStore';
import {
  reportClientAppError,
  resolveClientAppError,
} from '@canopy/desktop-instrumentation/client';
import { toAppError } from '@canopy/protocol/app-errors';
import { DesktopErrorBanner } from '@/components/shared/DesktopErrorBanner';
import {
  inlineFailure,
  inlineFailureText,
  type InlineFailure,
} from '@/lib/inline-app-error';
import {
  SettingsGroup,
  SettingsLoading,
  SettingsRow,
  SettingsSection,
  SettingsTextField,
} from './SettingsLayout';
import {
  collidingProfileNames,
  profileNameQualifier,
} from '@/lib/browserProfileNames';

/**
 * Readable trailing label for a profile row.
 *
 * Every Task profile is stored with the display name `Task`, so the list needs
 * a second fact to tell two of them apart. Prefer the names the user already
 * knows: the workspace and branch this profile belongs to. Fall back to a
 * short monospaced id only when the owning task is not in the sidebar (an
 * archived worktree, a cowork entry this view cannot resolve); an id is a
 * technical identifier of last resort here, never the primary label.
 *
 * The whole task must resolve for the friendly label to be used. A workspace
 * name on its own is not a label — every archived worktree under one workspace
 * would render the same words, which is exactly the collision this trailing
 * column exists to break. A partial answer falls through to the id.
 *
 * A named profile needs nothing: its name is already unique to the user, and a
 * second column repeating "Named profile" on every row would only compete with
 * it. The detail panel still states the kind for the selected profile.
 */
function taskScopeLabel(
  profile: BrowserProfileRecord,
  projects: SidebarItem[],
): { text: string; mono: boolean } {
  if (profile.kind !== 'task' || profile.owner.kind !== 'task')
    return { text: '', mono: false };
  const scope = profile.owner.taskScope;
  if (scope.kind === 'worktree') {
    const project = projects.find((item) => item.id === scope.projectId);
    const worktree =
      project && project.type !== 'cowork'
        ? project.worktrees.find((entry) => entry.id === scope.worktreeId)
        : undefined;
    if (project && worktree)
      return { text: `${project.name} · ${worktree.branchName}`, mono: false };
  }
  return { text: profile.profileId.slice(0, 6), mono: true };
}

/**
 * The trailing label for one row: the task's scope, or — for the named profile
 * whose name another profile is also using — the short id that tells them
 * apart. Nothing enforces unique names, so two rows can otherwise be identical
 * and there is no way to pick the intended one.
 */
function rowLabel(
  profile: BrowserProfileRecord,
  projects: SidebarItem[],
  colliding: ReadonlySet<string>,
): { text: string; mono: boolean } {
  const qualifier = profileNameQualifier(profile, colliding);
  return qualifier
    ? { text: qualifier, mono: true }
    : taskScopeLabel(profile, projects);
}

export function BrowserProfilesSettings(): JSX.Element {
  const projects = useProjectsStore((state) => state.projects);
  const [cleanup, setCleanup] = useState<
    Awaited<
      ReturnType<typeof window.api.browser.profiles.cleanupStatus>
    >['jobs']
  >([]);
  const refreshCleanup = useCallback(async (): Promise<void> => {
    setCleanup((await window.api.browser.profiles.cleanupStatus()).jobs);
  }, []);
  const [profiles, setProfiles] = useState<BrowserProfileRecord[]>([]);
  const [nextOffset, setNextOffset] = useState<number>();
  const [selectedId, setSelectedId] = useState<string>();
  const selectionEpoch = useRef(0);
  const selectedIdRef = useRef<string | undefined>(undefined);
  const [name, setName] = useState('');
  const [rename, setRename] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  // A failed load offers Try again; any other failed action keeps the list
  // refresh beside it, since a stale profile is the usual cause.
  const [error, setError] = useState<
    (InlineFailure & { readonly failedLoad: boolean }) | null
  >(null);
  const [notice, setNotice] = useState('');
  const [preview, setPreview] = useState<
    BrowserProfileDeletePreview & {
      selectionEpoch: number;
      displayName: string;
    }
  >();
  // The delete button is disabled while the preview loads, so the
  // confirmation names it as the place focus returns to when it closes.
  const deleteTrigger = useRef<HTMLButtonElement>(null);
  const select = (profileId?: string): void => {
    if (selectedIdRef.current !== profileId) selectionEpoch.current++;
    selectedIdRef.current = profileId;
    setSelectedId(profileId);
    setPreview(undefined);
  };
  useEffect(
    () => (): void => {
      selectionEpoch.current++;
    },
    [],
  );
  const selected = profiles.find((profile) => profile.profileId === selectedId);
  const colliding = collidingProfileNames(profiles);
  const activePreview =
    preview &&
    preview.profileId === selected?.profileId &&
    preview.metadataRevision === selected.metadataRevision &&
    preview.selectionEpoch === selectionEpoch.current
      ? preview
      : undefined;
  const dismissDeletePrompt = (): void => {
    setPreview(undefined);
  };
  const refreshSelected = useCallback(async (): Promise<void> => {
    if (selectedId) {
      const updated = await window.api.browser.profiles.get({
        profileId: selectedId,
      });
      setProfiles((current) =>
        current.map((profile) =>
          profile.profileId === updated.profileId ? updated : profile,
        ),
      );
    }
    await refreshCleanup();
  }, [selectedId, refreshCleanup]);
  useEffect(() => {
    void refreshCleanup().catch((cause: unknown) => {
      reportClientAppError(cause);
    });
  }, [refreshCleanup]);

  const load = useCallback(async (offset = 0): Promise<void> => {
    setLoading(true);
    try {
      const page = await window.api.browser.profiles.list({ offset });
      setProfiles((current) =>
        Array.from(
          new Map(
            (offset ? [...current, ...page.profiles] : page.profiles).map(
              (profile) => [profile.profileId, profile],
            ),
          ).values(),
        ),
      );
      setNextOffset(page.nextOffset);
    } finally {
      setLoading(false);
    }
  }, []);
  const loadFirstPage = useCallback((): void => {
    setError(null);
    void load().catch((cause: unknown) => {
      const appError = toAppError(resolveClientAppError(cause));
      if (appError)
        setError({
          ...inlineFailure(appError, "Couldn't load browser profiles."),
          failedLoad: true,
        });
    });
  }, [load]);
  useEffect(() => {
    loadFirstPage();
  }, [loadFirstPage]);
  useEffect(() => {
    setRename(selected?.displayName ?? '');
    setPreview(undefined);
  }, [selected?.profileId, selected?.displayName]);
  const run = async (
    operation: () => Promise<void>,
    failureSentence: string,
  ): Promise<void> => {
    setBusy(true);
    setError(null);
    setNotice('');
    try {
      await operation();
    } catch (cause) {
      const appError = toAppError(resolveClientAppError(cause));
      if (appError)
        setError({
          ...inlineFailure(appError, failureSentence),
          failedLoad: false,
        });
    } finally {
      setBusy(false);
    }
  };
  const update = (patch: BrowserProfilePatch): void => {
    if (!selected) return;
    void run(async () => {
      const updated = await window.api.browser.profiles.update({
        operationId: crypto.randomUUID(),
        profileId: selected.profileId,
        expectedMetadataRevision: selected.metadataRevision,
        patch,
      });
      setProfiles((current) =>
        current.map((profile) =>
          profile.profileId === updated.profileId ? updated : profile,
        ),
      );
    }, "Couldn't update this profile.");
  };
  // The list, the selected profile's settings, and its browser data are
  // sections of the page; the page's spacing separates them.
  return (
    <>
      <SettingsSection
        title="Profiles"
        description="Keep logins separate, or reuse a named profile across tasks."
        ariaLabel="Browser profiles"
        dataTestId="browser-profiles-settings"
      >
        <DesktopErrorBanner
          className=""
          error={error?.error}
          {...(error?.details === undefined ? {} : { details: error.details })}
          {...(error?.failedLoad
            ? { onRetry: loadFirstPage }
            : {
                secondaryAction: (
                  <NoticeButton onClick={loadFirstPage}>
                    Refresh profiles
                  </NoticeButton>
                ),
              })}
          testId="browser-profiles-error"
        />
        {notice && <Notice intent="neutral">{notice}</Notice>}
        {cleanup.length > 0 && (
          <Notice
            intent="attention"
            data-testid="browser-profile-cleanup-jobs"
            title={`${cleanup.length} retired ${cleanup.length === 1 ? 'store' : 'stores'} pending cleanup`}
            detail={summarizeCleanup(cleanup)}
            actions={
              <NoticeButton
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await window.api.browser.profiles.retryCleanup();
                    await refreshCleanup();
                  }, "Couldn't clean up the retired browser data.")
                }
              >
                Try again
              </NoticeButton>
            }
          >
            Browser data from deleted or reset profiles is still on disk.
          </Notice>
        )}
        <SettingsGroup>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void run(async () => {
                const profile = await window.api.browser.profiles.create({
                  operationId: crypto.randomUUID(),
                  input: { displayName: name },
                });
                setProfiles((current) => [...current, profile]);
                select(profile.profileId);
                setName('');
              }, "Couldn't create the profile.");
            }}
          >
            <SettingsRow
              label="New profile"
              htmlFor="browser-profile-new-name"
              control={
                <>
                  <SettingsTextField
                    id="browser-profile-new-name"
                    width="md"
                    aria-label="New profile name"
                    data-testid="browser-profile-new-name"
                    maxLength={100}
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder="Personal or Work"
                  />
                  <Button
                    size="compact"
                    type="submit"
                    variant="primary"
                    data-testid="browser-profile-create"
                    disabled={busy || !name.trim()}
                  >
                    Create profile
                  </Button>
                </>
              }
            />
          </form>
          {profiles.map((profile) => (
            // Picking a profile opens its settings below; the chosen row
            // carries the checkmark.
            <SettingsButtonRow
              key={profile.profileId}
              trailing="select"
              selected={selectedId === profile.profileId}
              data-testid={`browser-profile-row-${profile.profileId}`}
              onClick={() => select(profile.profileId)}
              label={
                <BrowserProfileBadge
                  name={profile.displayName}
                  color={profile.color}
                  className="max-w-full"
                />
              }
              meta={<ScopeLabel {...rowLabel(profile, projects, colliding)} />}
            />
          ))}
          {/* First load only: loading more keeps the listed profiles and
              holds the button until the next page arrives. */}
          {loading && profiles.length === 0 && (
            <SettingsLoading rows={2} dataTestId="browser-profiles-loading" />
          )}
          {!loading && error === null && profiles.length === 0 && (
            <EmptyStateRow title="No profiles yet. Opening a browser creates its Task profile." />
          )}
          {nextOffset !== undefined && (
            <div>
              <Button
                size="compact"
                variant="secondary"
                disabled={loading}
                onClick={() =>
                  void run(
                    () => load(nextOffset),
                    "Couldn't load more profiles.",
                  )
                }
              >
                Load more profiles
              </Button>
            </div>
          )}
        </SettingsGroup>
      </SettingsSection>
      {selected && (
        // Automation scopes the profile's settings and its browser data
        // together; `contents` keeps both sections direct items of the page.
        <div className="contents" data-testid="browser-profile-details">
          <SettingsSection
            title={selected.displayName}
            headingId="browser-profile-details-heading"
            description={
              selected.kind === 'task'
                ? 'Task profile. It belongs to one worktree or work entry.'
                : 'Named profile. Reuse it across tasks.'
            }
          >
            <SettingsGroup>
              {selected.kind === 'named' && (
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    update({ displayName: rename });
                  }}
                >
                  <SettingsRow
                    label="Name"
                    htmlFor="browser-profile-rename"
                    control={
                      <>
                        <SettingsTextField
                          id="browser-profile-rename"
                          width="md"
                          aria-label="Profile name"
                          value={rename}
                          maxLength={100}
                          onChange={(event) => setRename(event.target.value)}
                        />
                        <Button
                          size="compact"
                          type="submit"
                          variant="secondary"
                          disabled={busy || !rename.trim()}
                        >
                          Rename
                        </Button>
                      </>
                    }
                  />
                </form>
              )}
              {selected.kind === 'named' && (
                <SettingsRow
                  label="Color"
                  control={
                    <ColorSwatchPicker
                      value={selected.color}
                      disabled={busy}
                      testId="browser-profile-color-swatches"
                      onChange={(color) => update({ color })}
                    />
                  }
                />
              )}
              {/* The shared permissions control lays out both agent
                  permissions itself, so together they are one row here. */}
              <BrowserProfilePermissions
                task={selected.kind === 'task'}
                allowEnable={selected.agentPermissions.allowEnable}
                allowClear={selected.agentPermissions.allowClear}
                disabled={busy}
                onEnableChange={(allowEnable) => update({ allowEnable })}
                onClearChange={(allowClear) => update({ allowClear })}
              />
              {selected.kind === 'named' && (
                <SettingsRow
                  label="Delete profile"
                  description="Removes this profile and its browser data."
                  control={
                    <Button
                      size="compact"
                      ref={deleteTrigger}
                      variant="destructive"
                      data-testid="browser-profile-delete"
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          const epoch = selectionEpoch.current;
                          const result =
                            await window.api.browser.profiles.previewDelete({
                              profileId: selected.profileId,
                              expectedMetadataRevision:
                                selected.metadataRevision,
                            });
                          if (
                            epoch === selectionEpoch.current &&
                            selectedIdRef.current === selected.profileId &&
                            result.profileId === selected.profileId
                          )
                            setPreview({
                              ...result,
                              selectionEpoch: epoch,
                              displayName: selected.displayName,
                            });
                        }, "Couldn't check what deleting this profile removes.")
                      }
                    >
                      Delete profile
                    </Button>
                  }
                />
              )}
              {activePreview && (
                <ConfirmDialog
                  dataTestId="browser-profile-delete-preview"
                  confirmTestId="browser-profile-confirm-delete"
                  cancelTestId="browser-profile-cancel-delete"
                  title={`Delete “${activePreview.displayName}” and its browser data?`}
                  message={`Open pages will close and unsaved changes will be lost.${
                    activePreview.tabs.length > 0
                      ? ` ${activePreview.tabs.length} saved ${activePreview.tabs.length === 1 ? 'tab becomes' : 'tabs become'} unavailable.`
                      : ''
                  }${
                    activePreview.defaults.length > 0
                      ? ` ${activePreview.defaults.length} task ${activePreview.defaults.length === 1 ? 'default needs' : 'defaults need'} another profile.`
                      : ''
                  }`}
                  confirmLabel="Delete profile"
                  destructive
                  busy={busy}
                  errorMessage={inlineFailureText(error)}
                  {...(error?.details === undefined
                    ? {}
                    : { errorDetails: error.details })}
                  restoreFocusRef={deleteTrigger}
                  onCancel={dismissDeletePrompt}
                  onConfirm={() =>
                    void run(async () => {
                      if (
                        activePreview.selectionEpoch !==
                          selectionEpoch.current ||
                        activePreview.profileId !== selectedIdRef.current
                      )
                        return;
                      const result = await window.api.browser.profiles.delete({
                        operationId: crypto.randomUUID(),
                        token: activePreview.token,
                      });
                      select(undefined);
                      setPreview(undefined);
                      await load();
                      await refreshCleanup();
                      setNotice(
                        result.cleanupPending
                          ? 'Profile deleted. Storage cleanup is still running.'
                          : 'Profile deleted.',
                      );
                    }, "Couldn't delete the profile.")
                  }
                />
              )}
            </SettingsGroup>
          </SettingsSection>
          <BrowserProfileDataSettings
            key={`${selected.profileId}:${selected.storageGeneration}`}
            profile={selected}
            api={window.api.browser.profiles}
            onChanged={refreshSelected}
          />
        </div>
      )}
    </>
  );
}

/** Trailing identity for a profile row: a name, or a monospaced id fallback. */
function ScopeLabel({
  text,
  mono,
}: {
  text: string;
  mono: boolean;
}): JSX.Element | null {
  if (!text) return null;
  return (
    <span
      className={`max-w-48 shrink-0 truncate text-s fg-tertiary ${mono ? 'font-mono' : ''}`}
    >
      {text}
    </span>
  );
}

/**
 * One readable line for the pending retired-storage jobs.
 *
 * A failure carries a diagnostic message, and it is the only thing that tells
 * the user why Retry might not work either — a locked file, a missing
 * directory. Counting the failures without saying what went wrong leaves them
 * pressing the same button. One message is enough: the failures in a batch are
 * near-always the same cause, and the notice is a summary line, not a log.
 */
function summarizeCleanup(
  jobs: Awaited<
    ReturnType<typeof window.api.browser.profiles.cleanupStatus>
  >['jobs'],
): string {
  const waiting = jobs.filter((job) => job.status === 'pending_restart').length;
  const failures = jobs.filter((job) => job.status === 'failed');
  const parts: string[] = [];
  if (waiting) parts.push(`${waiting} waiting for an app restart`);
  if (failures.length) parts.push(`${failures.length} needing attention`);
  if (!parts.length) return 'Cleanup is queued.';
  const reason = failures.find((job) => job.message)?.message;
  return reason ? `${parts.join(', ')}. ${reason}` : parts.join(', ');
}

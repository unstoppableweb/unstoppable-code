import { Stack, Divider, Heading } from '@canopy/ui-shared/components';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type JSX,
  type RefObject,
} from 'react';
import {
  BrowserProfileBadge,
  Button,
  ChevronDownIcon,
  CloseButton,
  Notice,
  Popover,
  SettingsIcon,
  Tooltip,
} from '@canopy/ui-shared';
import { FormField, SettingsSelect } from '@canopy/ui-shared/components';
import type {
  BrowserProfileRecord,
  BrowserTaskSlot,
  BrowserProfileSelection,
} from '@canopy/protocol/browser-profiles';
import type { BrowserSessionSnapshot } from '@canopy/desktop-shared/types';
import { useBrowserStore } from '@/stores/browserStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { requestBrowserPanel } from '@/lib/browserPanelActivation';
import {
  browserProfileDisplayName,
  collidingProfileNames,
  profileNameQualifier,
} from '@/lib/browserProfileNames';

/** Shown when a profile switch is cancelled before it applies. */
export const PROFILE_SWITCH_CANCELLED =
  'Profile switch cancelled. The original page is still open.';

/** Why another control opened the picker: shown once it opens. */
export interface BrowserProfilePickerReason {
  readonly notice?: string;
  readonly error?: string;
}

interface BrowserProfilePickerProps {
  snapshot: BrowserSessionSnapshot;
  /**
   * Opened by another control (the early-access address bar's menu) instead
   * of its own chip: no chip renders, the popover anchors to `anchorRef`, and
   * `open` / `onOpenChange` own its visibility.
   */
  control?: {
    readonly open: boolean;
    readonly onOpenChange: (open: boolean) => void;
    readonly anchorRef: RefObject<HTMLElement | null>;
    /** Why it opened (a profile switch that needs attention), if anything. */
    readonly reason?: BrowserProfilePickerReason;
  };
}

export function BrowserProfilePicker({
  snapshot,
  control,
}: BrowserProfilePickerProps): JSX.Element {
  const [ownOpen, setOwnOpen] = useState(false);
  const anchorRef = control?.anchorRef;
  const onOpenChange = control?.onOpenChange;
  const open = control ? control.open : ownOpen;
  const setOpen = useCallback(
    (next: boolean): void => {
      if (onOpenChange) onOpenChange(next);
      else setOwnOpen(next);
    },
    [onOpenChange],
  );
  const [profiles, setProfiles] = useState<BrowserProfileRecord[]>([]);
  const [slot, setSlot] = useState<BrowserTaskSlot>();
  const [selected, select] = useState('task');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [nextOffset, setNextOffset] = useState<number>();
  const button = useRef<HTMLButtonElement>(null);
  const selectionRef = useRef<HTMLButtonElement>(null);
  // Escape and an outside press close the popover, except while an
  // operation is in flight: closing mid-switch would hide the progress and
  // error the user still needs to see. Meanwhile an outside press is ignored
  // rather than swallowed (`closeOnOutsidePress`), so the page's leave/stay
  // prompt stays answerable.
  const handleOpenChange = (next: boolean): void => {
    if (!next && busy) return;
    setOpen(next);
  };
  const scope = {
    projectId: snapshot.projectId,
    worktreeId: snapshot.worktreeId,
  };
  const selection: BrowserProfileSelection =
    selected === 'task'
      ? { kind: 'task' }
      : { kind: 'named', profileId: selected };
  /** The profile this tab is using right now, as a dropdown value. */
  const currentValue =
    snapshot.profile?.selection.kind === 'named'
      ? snapshot.profile.resolvedProfileId
      : 'task';
  const run = async (operation: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setError('');
    try {
      await operation();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  const load = (): void => {
    setNotice('');
    select(currentValue);
    void run(async () => {
      const [page, context] = await Promise.all([
        window.api.browser.profiles.list(scope),
        window.api.browser.profiles.context(scope),
      ]);
      setProfiles(page.profiles);
      setNextOffset(page.nextOffset);
      setSlot(context);
    });
  };
  const show = (): void => {
    setOpen(true);
    load();
  };
  // Opened from outside: load the profiles each time it opens.
  const controlledOpen = control?.open === true;
  const openReason = control?.reason;
  useEffect(() => {
    if (!controlledOpen) return;
    load();
    // After `load` clears the notice and error, so the reason survives it.
    if (openReason?.notice) setNotice(openReason.notice);
    if (openReason?.error) setError(openReason.error);
    // `load` reads the latest snapshot; re-running on its identity would
    // reload on every render while open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controlledOpen]);
  const close = (): void => {
    setOpen(false);
    (anchorRef?.current ?? button.current)?.focus();
  };
  const switchTo = (mode: 'replace' | 'new-tab'): void => {
    if (!snapshot.profile) {
      setError('Wait for this browser to finish opening.');
      return;
    }
    const expectedRuntimeGeneration = snapshot.profile.runtimeGeneration;
    void run(async () => {
      const result = await window.api.browser.switchProfile({
        operationId: crypto.randomUUID(),
        browserId: snapshot.id,
        expectedRuntimeGeneration,
        selection,
        mode,
      });
      const store = useBrowserStore.getState();
      if (mode === 'new-tab' && result.status === 'complete') {
        store.registerBrowserSnapshot(result.browser);
        const activated = await requestBrowserPanel(
          snapshot.projectId,
          snapshot.worktreeId,
          result.browser.id,
        );
        if (!activated) {
          await window.api.browser.destroy({ browserId: result.browser.id });
          store.dropBrowserSession(
            snapshot.projectId,
            snapshot.worktreeId,
            result.browser.id,
          );
          throw new Error(
            'The new browser panel could not be placed. The original tab is unchanged.',
          );
        }
      } else store.applySnapshot(result.browser);
      if (result.message) setNotice(result.message);
      else if (result.status === 'cancelled')
        setNotice(PROFILE_SWITCH_CANCELLED);
      else close();
    });
  };
  const defaultSelection = slot?.defaultSelection;
  /**
   * Both action groups are hidden when they would be a no-op.
   *
   * Picking the profile a tab already uses and pressing Replace reloads the
   * page for nothing, and pressing "use for new tabs" when it is already the
   * default writes an unchanged record. Offering either is offering a control
   * that cannot do anything.
   *
   * `defaultValue` stays `undefined` until the task slot loads, so the footer
   * action waits for a real answer rather than flashing on an assumption.
   */
  const switchChangesProfile = selected !== currentValue;
  const defaultValue = defaultSelection
    ? defaultSelection.kind === 'named'
      ? defaultSelection.profileId
      : 'task'
    : undefined;
  const defaultChangesProfile =
    defaultValue !== undefined && selected !== defaultValue;
  const currentName = browserProfileDisplayName(snapshot);
  const colliding = collidingProfileNames(profiles);
  const defaultName =
    defaultSelection?.kind === 'named'
      ? (profiles.find(
          (profile) => profile.profileId === defaultSelection.profileId,
        )?.displayName ?? 'Unavailable profile')
      : 'Task';
  return (
    <>
      {control ? null : (
        <>
          {/* Suppressed while the popover is open: the pointer is still over the
          trigger after the click, so the tooltip would otherwise paint on top
          of the menu it just opened. */}
          <Tooltip label={`Browser profile: ${currentName}`} suppressed={open}>
            <Button
              ref={button}
              variant="ghost"
              size="sm"
              aria-label={`Browser profile: ${currentName}`}
              aria-expanded={open}
              aria-haspopup="dialog"
              data-testid="browser-profile-picker"
              onClick={show}
              className="min-w-0"
            >
              <BrowserProfileBadge
                name={currentName}
                color={snapshot.profileInfo?.color}
                className="max-w-28"
                titleSuppressed
              />
              <ChevronDownIcon aria-hidden="true" className="shrink-0" />
            </Button>
          </Tooltip>
        </>
      )}
      <Popover
        open={open}
        onOpenChange={handleOpenChange}
        closeOnOutsidePress={!busy}
        anchorRef={anchorRef ?? button}
        initialFocusRef={selectionRef}
        width="lg"
        aria-label="Choose browser profile"
        data-testid="browser-profile-menu"
      >
        <Stack gap="group">
          <div className="flex items-start justify-between gap-2">
            <Stack gap="tight" className="min-w-0">
              <Heading level={3} variant="title">
                Browser profile
              </Heading>
              {switchChangesProfile && (
                <p className="text-xs fg-secondary">
                  Replacing reloads this tab in the selected profile. Unsaved
                  changes may be lost, and other tabs keep their profiles.
                </p>
              )}
            </Stack>
            <CloseButton onClick={close} />
          </div>
          <div className="flex flex-col gap-1.5">
            <FormField label="Use profile">
              {(fieldControl) => (
                <SettingsSelect
                  {...fieldControl}
                  ref={selectionRef}
                  width="fill"
                  data-testid="browser-profile-selection"
                  value={selected}
                  onValueChange={select}
                  disabled={busy}
                  options={[
                    { value: 'task', label: 'Task (this task only)' },
                    ...(selected !== 'task' &&
                    !profiles.some((profile) => profile.profileId === selected)
                      ? [{ value: selected, label: 'Unavailable profile' }]
                      : []),
                    ...profiles
                      .filter((profile) => profile.kind === 'named')
                      .map((profile) => {
                        const qualifier = profileNameQualifier(
                          profile,
                          colliding,
                        );
                        return {
                          value: profile.profileId,
                          label: qualifier
                            ? `${profile.displayName} · ${qualifier}`
                            : profile.displayName,
                        };
                      }),
                  ]}
                />
              )}
            </FormField>
            {nextOffset !== undefined && (
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                className="-ml-2.5 self-start"
                onClick={() =>
                  void run(async () => {
                    const page = await window.api.browser.profiles.list({
                      ...scope,
                      offset: nextOffset,
                    });
                    setProfiles((current) => [...current, ...page.profiles]);
                    setNextOffset(page.nextOffset);
                  })
                }
              >
                Load more profiles
              </Button>
            )}
          </div>
          {switchChangesProfile && (
            <div className="flex flex-wrap gap-2">
              <Button
                variant="primary"
                size="md"
                data-testid="browser-profile-replace"
                disabled={busy}
                onClick={() => switchTo('replace')}
              >
                Replace this tab
              </Button>
              <Button
                variant="outline"
                size="md"
                data-testid="browser-profile-new-tab"
                disabled={busy}
                onClick={() => switchTo('new-tab')}
              >
                Open new tab
              </Button>
            </div>
          )}
          {/* Stacked rather than a justify-between row: at this width the
                button wraps, and a wrapped `justify-between` child lands
                inset by its own padding instead of on the popover's edge. */}
          <div>
            <Divider />
            <div className="flex flex-col items-start gap-0.5 pt-3">
              <p className="min-w-0 text-xs fg-secondary">
                New-tab default:{' '}
                <span className="fg-primary">{defaultName}</span>
              </p>
              {defaultChangesProfile && (
                <Button
                  variant="ghost"
                  size="sm"
                  data-testid="browser-profile-set-default"
                  disabled={busy || !slot}
                  className="-ml-2.5"
                  onClick={() =>
                    slot &&
                    void run(async () => {
                      setSlot(
                        await window.api.browser.profiles.setDefault({
                          ...scope,
                          operationId: crypto.randomUUID(),
                          incarnationId: slot.incarnationId,
                          expectedMetadataRevision: slot.metadataRevision,
                          selection,
                        }),
                      );
                      setNotice(
                        'Default updated for new tabs in this task. Existing tabs keep their profiles.',
                      );
                    })
                  }
                >
                  Use selected for new tabs
                </Button>
              )}
            </div>
          </div>
          {/* Everything above acts on this tab; this leaves for the page
                that owns profiles themselves (create, rename, permissions,
                stored data), so it sits below its own rule. */}
          <div>
            <Divider />
            <div className="pt-2">
              <Button
                variant="ghost"
                size="sm"
                data-testid="browser-profile-open-settings"
                className="-ml-2.5"
                onClick={() => {
                  setOpen(false);
                  useNavigationStore.getState().openSettings('browser');
                }}
              >
                <SettingsIcon className="shrink-0" />
                Settings
              </Button>
            </div>
          </div>
          {busy && (
            <Notice intent="neutral" title="Applying profile">
              Respond to any page dialog to continue.
            </Notice>
          )}
          {error && (
            <Notice errorSource="browser-profile-picker" intent="destructive">
              {error}
            </Notice>
          )}
          {notice && <Notice intent="neutral">{notice}</Notice>}
        </Stack>
      </Popover>
    </>
  );
}

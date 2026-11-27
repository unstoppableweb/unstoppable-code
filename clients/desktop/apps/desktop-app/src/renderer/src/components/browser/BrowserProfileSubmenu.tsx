import { useEffect, useState, type JSX } from 'react';
import type {
  BrowserProfileRecord,
  BrowserProfileSelection,
} from '@canopy/protocol/browser-profiles';
import type { BrowserSessionSnapshot } from '@canopy/desktop-shared/types';
import {
  MenuDivider,
  MenuItem,
  MenuItemIcon,
  NestedMenuFlyout,
} from '@canopy/ui-shared/components';
import {
  CheckIcon,
  GlobeIcon,
  SettingsIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import {
  browserProfileDisplayName,
  collidingProfileNames,
  profileNameQualifier,
} from '@/lib/browserProfileNames';
import { useBrowserStore } from '@/stores/browserStore';
import {
  PROFILE_SWITCH_CANCELLED,
  type BrowserProfilePickerReason,
} from './BrowserProfilePicker';
import { useNavigationStore } from '@/stores/navigationStore';

interface BrowserProfileSubmenuProps {
  readonly snapshot: BrowserSessionSnapshot;
  /** Closes the menu the submenu opens from. */
  readonly onDone: () => void;
  /**
   * Opens the full profile picker, for a switch that needs the user's
   * attention (it was cancelled, came back with a message, or failed), with
   * the reason to show there.
   */
  readonly onNeedsPicker: (reason?: BrowserProfilePickerReason) => void;
}

/** Most profile pages the submenu reads, so a bad offset cannot loop. */
const MAX_PROFILE_PAGES = 50;

/**
 * The browser menu's "Browser profile" row: hovering it lists the profiles
 * to switch this tab to (the current one checked), then Browser settings,
 * where profiles are created and managed.
 */
export function BrowserProfileSubmenu({
  snapshot,
  onDone,
  onNeedsPicker,
}: BrowserProfileSubmenuProps): JSX.Element {
  const [profiles, setProfiles] = useState<BrowserProfileRecord[]>([]);
  const { projectId, worktreeId } = snapshot;
  useEffect(() => {
    let cancelled = false;
    // Every page: the submenu is the only way to a profile from this bar, so
    // profiles past the first page must be listed too.
    const loadAll = async (): Promise<void> => {
      const all: BrowserProfileRecord[] = [];
      let offset: number | undefined;
      for (let pages = 0; pages < MAX_PROFILE_PAGES; pages += 1) {
        const page = await window.api.browser.profiles.list(
          offset === undefined
            ? { projectId, worktreeId }
            : { projectId, worktreeId, offset },
        );
        if (cancelled) return;
        all.push(...page.profiles);
        setProfiles([...all]);
        if (page.nextOffset === undefined || page.nextOffset === offset) return;
        offset = page.nextOffset;
      }
    };
    loadAll().catch(() => {
      // The profiles loaded so far, the task profile and Browser settings
      // still show.
    });
    return (): void => {
      cancelled = true;
    };
  }, [projectId, worktreeId]);

  const current =
    snapshot.profile?.selection.kind === 'named'
      ? snapshot.profile.resolvedProfileId
      : 'task';
  const colliding = collidingProfileNames(profiles);

  const switchTo = (value: string): void => {
    onDone();
    if (value === current) return;
    if (!snapshot.profile) {
      onNeedsPicker();
      return;
    }
    const selection: BrowserProfileSelection =
      value === 'task' ? { kind: 'task' } : { kind: 'named', profileId: value };
    void window.api.browser
      .switchProfile({
        operationId: crypto.randomUUID(),
        browserId: snapshot.id,
        expectedRuntimeGeneration: snapshot.profile.runtimeGeneration,
        selection,
        mode: 'replace',
      })
      .then((result) => {
        useBrowserStore.getState().applySnapshot(result.browser);
        if (result.message) onNeedsPicker({ notice: result.message });
        else if (result.status === 'cancelled')
          onNeedsPicker({ notice: PROFILE_SWITCH_CANCELLED });
      })
      .catch((cause: unknown) =>
        onNeedsPicker({
          error: cause instanceof Error ? cause.message : String(cause),
        }),
      );
  };

  const row = (value: string, label: string): JSX.Element => (
    <MenuItem
      key={value}
      role="menuitemradio"
      aria-checked={value === current}
      data-testid={`browser-profile-option-${value}`}
      onClick={(): void => switchTo(value)}
    >
      {/* The check leads the row, in the icon column Browser settings uses,
          so the names line up with it. */}
      <MenuItemIcon tone="secondary">
        {value === current ? <CheckIcon /> : null}
      </MenuItemIcon>
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </MenuItem>
  );

  return (
    <NestedMenuFlyout
      label={`Browser profile: ${browserProfileDisplayName(snapshot)}`}
      leading={<GlobeIcon />}
      triggerTestId="browser-more-profile"
      menuTestId="browser-profile-submenu"
    >
      {row('task', 'Task')}
      {profiles
        .filter((profile) => profile.kind === 'named')
        .map((profile) => {
          const qualifier = profileNameQualifier(profile, colliding);
          return row(
            profile.profileId,
            qualifier
              ? `${profile.displayName} · ${qualifier}`
              : profile.displayName,
          );
        })}
      <MenuDivider />
      <MenuItem
        data-testid="browser-profile-settings"
        onClick={(): void => {
          onDone();
          useNavigationStore.getState().openSettings('browser');
        }}
      >
        <MenuItemIcon>
          <SettingsIcon />
        </MenuItemIcon>
        <span className="min-w-0 flex-1 truncate">Browser settings</span>
      </MenuItem>
    </NestedMenuFlyout>
  );
}

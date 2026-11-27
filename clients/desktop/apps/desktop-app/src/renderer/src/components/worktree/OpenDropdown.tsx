import { ControlButton, MorphLabel } from '@canopy/ui-shared/components';
import { OpenAppSplitSurface } from '@canopy/ui-shared/components';
import {
  type JSX,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import {
  ActionMenuRowStyle,
  MenuDivider,
  MenuItem,
  MenuItemIcon,
  MenuLabel,
  Menu,
  PickerOptionCheck,
  Tooltip,
} from '@canopy/ui-shared';
import {
  ChevronDownMediumIcon,
  CopyIcon,
  SettingsIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import type { DetectedApp } from '@canopy/desktop-shared/types';
import { copyTextToClipboard } from '@/lib/clipboard';
import { pt } from '@/lib/platform-text';
import { uiText } from '@/lib/ui-text';
import { useNavigationStore } from '@/stores/navigationStore';
import { selectPreferredOpenApp } from './openInAppSelection';
import { Divider } from '@canopy/ui-shared/components';

interface OpenDropdownProps {
  projectId: string;
  worktreeId: string;
}

export function OpenDropdown({
  projectId,
  worktreeId,
}: OpenDropdownProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const [apps, setApps] = useState<DetectedApp[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [lastAppId, setLastAppId] = useState('');
  const [disabledApps, setDisabledApps] = useState<string[]>([]);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const openSettings = useNavigationStore((s) => s.openSettings);

  // Load apps and preferences on mount
  useEffect(() => {
    void window.api
      .detectApps()
      .then((detected) => {
        setApps(detected);
      })
      .catch(() => {
        setApps([]);
      })
      .finally(() => {
        setLoaded(true);
      });
    void window.api.loadPreferences().then((prefs) => {
      setLastAppId(prefs.lastOpenApp);
      setDisabledApps(prefs.disabledOpenApps);
    });
  }, []);

  // Refresh preferences each time dropdown opens
  const refreshPreferences = useCallback((): void => {
    void window.api.loadPreferences().then((prefs) => {
      setDisabledApps(prefs.disabledOpenApps);
      setLastAppId(prefs.lastOpenApp);
    });
  }, []);

  const handleOpenApp = useCallback(
    (appId: string): void => {
      setOpen(false);
      setLastAppId(appId);
      void window.api.openInApp({ projectId, worktreeId, appId });
      void window.api.savePreferences({ lastOpenApp: appId });
    },
    [projectId, worktreeId],
  );

  const handleCopyPath = useCallback((): void => {
    setOpen(false);
    void window.api
      .getWorktreePath({ projectId, worktreeId })
      .then((path) => copyTextToClipboard(path));
  }, [projectId, worktreeId]);

  const handleOpenSettings = useCallback((): void => {
    setOpen(false);
    openSettings('applications');
  }, [openSettings]);

  const visibleApps = apps.filter((a) => !disabledApps.includes(a.id));
  // The split button's icon segment: the last-used app, falling back to the
  // first visible app so the control keeps its shape before any use.
  const splitApp = selectPreferredOpenApp(apps, {
    lastOpenApp: lastAppId,
    disabledOpenApps: disabledApps,
  });

  return (
    <div className="relative flex items-center">
      {/* Split control on the house secondary surface — the same shell the
          shared Button secondary and action chips compose through
          SECONDARY_SURFACE_CLASS: [app icon] | divider | [chevron menu]. The
          shell sits on the wrapper and the hover overlay on each segment so
          only the hovered half lights up. */}
      <OpenAppSplitSurface>
        {splitApp && splitApp.icon && (
          <>
            {/* Icon-only below 560px, so the app name has to live in a
                tooltip. Uses the shared Tooltip (not the native `title`) so
                it matches the rest of the chrome and appears promptly. */}
            <Tooltip
              label={`Open in ${splitApp.name}`}
              className="items-stretch"
            >
              <ControlButton
                type="button"
                data-testid="worktree-open-app"
                onClick={() => handleOpenApp(splitApp.id)}
                presentation="worktree-open-app"
                aria-label={`Open in ${splitApp.name}`}
              >
                {/* Compact mode: below a 560px status region the label drops and
                  the control is just [app icon] | [chevron]. */}
                <MorphLabel at="prbar-560" gap="end">
                  Open in
                </MorphLabel>
                <img
                  src={splitApp.icon}
                  alt=""
                  className="h-4 w-4"
                  draggable={false}
                />
              </ControlButton>
            </Tooltip>
            <span className="flex h-4 self-center">
              <Divider orientation="vertical" aria-hidden />
            </span>
          </>
        )}
        <Tooltip label="Open in…" className="items-stretch" suppressed={open}>
          <ControlButton
            ref={triggerRef}
            type="button"
            data-testid="worktree-open-trigger"
            onClick={() => {
              refreshPreferences();
              setOpen((prev) => !prev);
            }}
            aria-haspopup="menu"
            aria-expanded={open}
            aria-controls={open ? menuId : undefined}
            aria-label="Open in…"
            presentation="worktree-open-menu"
            appearance={Boolean(splitApp?.icon)}
          >
            {(!splitApp || !splitApp.icon) && 'Open in'}
            <ChevronDownMediumIcon size={16} className="shrink-0 fg-primary" />
          </ControlButton>
        </Tooltip>
      </OpenAppSplitSurface>

      <Menu
        id={menuId}
        open={open}
        onOpenChange={setOpen}
        anchorRef={triggerRef}
        placement="bottom-right"
        aria-label="Open project"
        data-testid="worktree-open-menu"
        data-canopy-browser-native-overlay="true"
        className="w-34 max-w-[calc(100vw-16px)]"
      >
        {/* The action-menu rows: small text, tertiary glyphs. App icons are
            product marks and keep their own colors. */}
        <ActionMenuRowStyle>
          {!loaded ? (
            <MenuLabel>{pt(uiText.applications.detecting)}</MenuLabel>
          ) : visibleApps.length === 0 ? (
            <MenuLabel>{pt(uiText.applications.empty)}</MenuLabel>
          ) : (
            visibleApps.map((appItem) => (
              <MenuItem
                key={appItem.id}
                data-testid={`worktree-open-app-${appItem.id}`}
                className="min-w-0"
                onClick={() => handleOpenApp(appItem.id)}
              >
                <MenuItemIcon>
                  {appItem.icon ? (
                    <img
                      src={appItem.icon}
                      alt=""
                      className="h-4 w-4"
                      draggable={false}
                    />
                  ) : null}
                </MenuItemIcon>
                <span className="min-w-0 flex-1 truncate whitespace-nowrap">
                  {appItem.name}
                </span>
                <PickerOptionCheck selected={appItem.id === splitApp?.id} />
              </MenuItem>
            ))
          )}
          <MenuDivider />
          <MenuItem
            data-testid="worktree-open-copy-path"
            className="min-w-0"
            onClick={handleCopyPath}
          >
            <MenuItemIcon>
              <CopyIcon />
            </MenuItemIcon>
            <span className="min-w-0 flex-1 truncate whitespace-nowrap">
              Copy path
            </span>
          </MenuItem>
          <MenuItem
            data-testid="worktree-open-settings"
            className="min-w-0"
            onClick={handleOpenSettings}
          >
            <MenuItemIcon>
              <SettingsIcon />
            </MenuItemIcon>
            <span className="min-w-0 flex-1 truncate whitespace-nowrap">
              Settings
            </span>
          </MenuItem>
        </ActionMenuRowStyle>
      </Menu>
    </div>
  );
}

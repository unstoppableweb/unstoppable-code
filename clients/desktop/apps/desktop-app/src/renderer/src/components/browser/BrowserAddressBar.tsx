import { Dot } from '@canopy/ui-shared/primitives/Badge';
import { useCallback, useId, useRef, useState, type JSX } from 'react';
import { isMcpOAuthBrowserScope } from '@canopy/execution-engine/types/browser';
import type { BrowserSessionSnapshot } from '@canopy/desktop-shared/types';
import { CHAT_UNIT_LABEL } from '@canopy/protocol';
import {
  Surface,
  ActionMenuRowStyle,
  DropdownMenuDivider,
  DropdownMenuItem,
  DropdownMenuItemIcon,
  DropdownMenuItemTrailing,
  FloatingMenu,
  HeaderActionButton,
  NestedMenuFlyout,
  TextInput,
  FieldError,
} from '@canopy/ui-shared/components';
import {
  BackIcon,
  CameraIcon,
  CheckIcon,
  CodeBracketsIcon,
  ExternalIcon,
  ForwardIcon,
  MoonIcon,
  MoreHorizontalIcon,
  PickIcon,
  RecordIcon,
  RefreshIcon,
  StopIcon,
  SunIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import { browserAddressSummary } from '@/lib/browserUrl';
import {
  BrowserProfilePicker,
  type BrowserProfilePickerReason,
} from './BrowserProfilePicker';
import { BrowserDownloadsButton } from './BrowserDownloadsButton';
import { BrowserProfileSubmenu } from './BrowserProfileSubmenu';
import { useBrowserBarActions } from './useBrowserBarActions';

interface BrowserAddressBarProps {
  browserId: string;
  snapshot: BrowserSessionSnapshot;
  inspectorOpen: boolean;
  errorCount: number;
  onToggleInspector: () => void;
}

/**
 * Early access: the browser's one-row address bar. History and reload, the
 * address (only the host until it is focused), Pick for the chat, and a
 * More menu with every other tool. A running recording keeps a Stop control
 * in the row, and page errors put a dot on More, so neither state hides in
 * the menu.
 */
export function BrowserAddressBar({
  browserId,
  snapshot,
  inspectorOpen,
  errorCount,
  onToggleInspector,
}: BrowserAddressBarProps): JSX.Element {
  const actions = useBrowserBarActions(browserId, snapshot);
  const errorId = useId();
  const [focused, setFocused] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [profileReason, setProfileReason] =
    useState<BrowserProfilePickerReason>();
  const onProfileOpenChange = useCallback((open: boolean): void => {
    if (!open) setProfileReason(undefined);
    setProfileOpen(open);
  }, []);
  const moreRef = useRef<HTMLButtonElement | null>(null);
  const fullTools = !isMcpOAuthBrowserScope(
    snapshot.projectId,
    snapshot.worktreeId,
  );

  // At rest the field shows only where the page is (the host); focusing it
  // shows the full address to edit. An edit in progress or an error keeps
  // the full draft in view.
  const editing =
    focused || actions.urlError !== null || actions.urlDraft !== snapshot.url;
  const summary = browserAddressSummary(snapshot.url);
  const pickLabel = snapshot.pickMode
    ? 'Stop picking'
    : `Pick element for ${CHAT_UNIT_LABEL}`;
  const closeMenu = (): void => setMenuOpen(false);

  return (
    <Surface variant="section" boundary="bottom" className="shrink-0">
      <div
        data-testid="browser-bar"
        data-variant="address-bar"
        className="flex shrink-0 flex-col"
      >
        {/* The panel's title row keeps its controls 4px from the card's
          edges; this row does too, so Back sits under the first tab and the
          last control under the panel's ✕. As a pane toolbar its controls
          take the tab row's nested corner radius (panels.css). */}
        <div className="canopy-panel-toolbar flex h-11 min-w-0 items-center gap-1 px-1">
          <HeaderActionButton
            stateStyle="toolbar"
            iconOnly
            tone="neutral"
            aria-label="Back"
            data-testid="browser-back"
            disabled={!snapshot.canGoBack}
            onClick={actions.back}
          >
            <BackIcon size={16} aria-hidden="true" />
          </HeaderActionButton>
          <HeaderActionButton
            stateStyle="toolbar"
            iconOnly
            tone="neutral"
            aria-label="Forward"
            data-testid="browser-forward"
            disabled={!snapshot.canGoForward}
            onClick={actions.forward}
          >
            <ForwardIcon size={16} aria-hidden="true" />
          </HeaderActionButton>
          {actions.isLoading ? (
            <HeaderActionButton
              stateStyle="toolbar"
              iconOnly
              tone="neutral"
              aria-label="Stop loading"
              data-testid="browser-stop"
              onClick={actions.stop}
            >
              <StopIcon size={16} aria-hidden="true" />
            </HeaderActionButton>
          ) : (
            <HeaderActionButton
              stateStyle="toolbar"
              iconOnly
              tone="neutral"
              aria-label="Reload"
              data-testid="browser-refresh"
              onClick={actions.refresh}
            >
              <RefreshIcon size={16} aria-hidden="true" />
            </HeaderActionButton>
          )}

          <div className="flex min-w-0 flex-1 px-1">
            <TextInput
              ref={actions.urlInputRef}
              density="compact"
              align={editing ? 'start' : 'center'}
              data-testid="browser-url-input"
              value={editing ? actions.urlDraft : summary}
              spellCheck={false}
              placeholder={actions.urlPlaceholder}
              onFocus={(event): void => {
                setFocused(true);
                // The field swaps the host for the full address on focus;
                // select it once that value is in place.
                const input = event.currentTarget;
                requestAnimationFrame(() => input.select());
              }}
              onBlur={(): void => setFocused(false)}
              onChange={(event): void =>
                actions.setUrlDraft(event.target.value)
              }
              onKeyDown={actions.handleKeyDown}
              aria-label="Browser URL"
              aria-invalid={actions.urlError !== null}
              aria-describedby={actions.urlError !== null ? errorId : undefined}
              className="min-w-0"
            />
          </div>

          {fullTools && snapshot.recording ? (
            <HeaderActionButton
              stateStyle="toolbar"
              iconOnly
              tone="destructive"
              aria-label="Stop recording"
              data-testid="browser-stop-recording"
              onClick={actions.toggleRecording}
            >
              <RecordIcon size={16} aria-hidden="true" />
            </HeaderActionButton>
          ) : null}
          {fullTools ? (
            <HeaderActionButton
              stateStyle="toolbar"
              iconOnly
              tone="neutral"
              aria-label={pickLabel}
              aria-pressed={snapshot.pickMode}
              data-testid="browser-pick"
              onClick={actions.togglePick}
            >
              <PickIcon size={16} aria-hidden="true" />
            </HeaderActionButton>
          ) : null}
          {fullTools ? <BrowserDownloadsButton browserId={browserId} /> : null}

          <span className="relative inline-flex">
            <HeaderActionButton
              stateStyle="toolbar"
              ref={moreRef}
              iconOnly
              tone="neutral"
              aria-label="More browser actions"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              data-testid="browser-more"
              onClick={(): void => setMenuOpen((current) => !current)}
            >
              <MoreHorizontalIcon size={16} aria-hidden="true" />
            </HeaderActionButton>
            {fullTools && errorCount > 0 && !inspectorOpen ? (
              // Page errors: the sidebar's 6px status dot, on the control
              // that leads to them.
              <Dot
                tone="danger"
                data-testid="browser-more-error-dot"
                className="pointer-events-none absolute right-1 top-1"
              />
            ) : null}
          </span>
          <FloatingMenu
            open={menuOpen}
            onOpenChange={setMenuOpen}
            anchorRef={moreRef}
            placement="bottom-right"
            aria-label="More browser actions"
            data-testid="browser-more-menu"
            // As wide as its rows need, like the other action menus.
            className="w-max min-w-45 max-w-[calc(100vw-16px)]"
          >
            <ActionMenuRowStyle>
              {fullTools ? (
                <BrowserProfileSubmenu
                  snapshot={snapshot}
                  onDone={closeMenu}
                  onNeedsPicker={(reason): void => {
                    setProfileReason(reason);
                    setProfileOpen(true);
                  }}
                />
              ) : null}
              <DropdownMenuItem
                data-testid="browser-more-open-external"
                disabled={!actions.canOpenExternally}
                onClick={(): void => {
                  closeMenu();
                  actions.openExternally();
                }}
              >
                <DropdownMenuItemIcon>
                  <ExternalIcon />
                </DropdownMenuItemIcon>
                <span className="min-w-0 flex-1 truncate">
                  Open in external browser
                </span>
              </DropdownMenuItem>
              <DropdownMenuDivider />
              <NestedMenuFlyout
                label="Appearance"
                leading={
                  snapshot.themeMode === 'dark' ? (
                    <MoonIcon size={16} />
                  ) : (
                    <SunIcon size={16} />
                  )
                }
                triggerTestId="browser-more-appearance"
                menuTestId="browser-appearance-submenu"
              >
                {(
                  [
                    ['system', 'System'],
                    ['light', 'Light'],
                    ['dark', 'Dark'],
                  ] as const
                ).map(([mode, label]) => (
                  <DropdownMenuItem
                    key={mode}
                    role="menuitemradio"
                    aria-checked={snapshot.themeMode === mode}
                    data-testid={`browser-theme-${mode}`}
                    onClick={(): void => {
                      closeMenu();
                      actions.setTheme(mode);
                    }}
                  >
                    {/* The check leads, in the icon column, like the profile
                    submenu's rows. */}
                    <DropdownMenuItemIcon tone="secondary">
                      {snapshot.themeMode === mode ? (
                        <CheckIcon size={16} />
                      ) : null}
                    </DropdownMenuItemIcon>
                    <span className="min-w-0 flex-1 truncate">{label}</span>
                  </DropdownMenuItem>
                ))}
              </NestedMenuFlyout>
              {fullTools ? (
                <>
                  <DropdownMenuDivider />
                  <DropdownMenuItem
                    data-testid="browser-more-record"
                    onClick={(): void => {
                      closeMenu();
                      actions.toggleRecording();
                    }}
                  >
                    <DropdownMenuItemIcon
                      tone={snapshot.recording ? 'destructive' : undefined}
                    >
                      <RecordIcon />
                    </DropdownMenuItemIcon>
                    <span className="min-w-0 flex-1 truncate">
                      {snapshot.recording ? 'Stop recording' : 'Record actions'}
                    </span>
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    data-testid="browser-more-screenshot"
                    onClick={(): void => {
                      closeMenu();
                      actions.screenshot();
                    }}
                  >
                    <DropdownMenuItemIcon>
                      <CameraIcon />
                    </DropdownMenuItemIcon>
                    <span className="min-w-0 flex-1 truncate">
                      Take screenshot
                    </span>
                  </DropdownMenuItem>
                  <DropdownMenuDivider />
                  <DropdownMenuItem
                    data-testid="browser-more-details"
                    onClick={(): void => {
                      closeMenu();
                      onToggleInspector();
                    }}
                  >
                    <DropdownMenuItemIcon>
                      <CodeBracketsIcon />
                    </DropdownMenuItemIcon>
                    <span className="min-w-0 flex-1 truncate">
                      {inspectorOpen
                        ? 'Hide console and network'
                        : 'Console and network'}
                    </span>
                    {errorCount > 0 ? (
                      <div className="pl-3 empty:hidden">
                        <DropdownMenuItemTrailing tone="destructive">
                          {errorCount > 99 ? '99+' : errorCount}{' '}
                          {errorCount === 1 ? 'error' : 'errors'}
                        </DropdownMenuItemTrailing>
                      </div>
                    ) : null}
                  </DropdownMenuItem>
                </>
              ) : null}
            </ActionMenuRowStyle>
          </FloatingMenu>
          {fullTools ? (
            <BrowserProfilePicker
              snapshot={snapshot}
              control={{
                open: profileOpen,
                onOpenChange: onProfileOpenChange,
                anchorRef: moreRef,
                reason: profileReason,
              }}
            />
          ) : null}
        </div>
        {actions.urlError !== null && (
          <div className="px-3 pb-1.5">
            <FieldError id={errorId}>{actions.urlError}</FieldError>
          </div>
        )}
      </div>
    </Surface>
  );
}

import type { JSX } from 'react';
import { Button, DownloadIcon } from '@canopy/ui-shared';
import { Folder, RefreshCw } from 'lucide-react';
import { BrandLogo } from '@/components/BrandLogo';
import {
  GIT_LINUX_INSTALL_URL,
  LinuxGitInstallInstructions,
} from './LinuxGitInstallInstructions';
import { brandText } from '@/lib/brand';
import type { WindowsGitGateState } from '@/hooks/useWindowsGitRequirement';
import { MonitorDownIcon as AppCatalogMonitorDownIcon } from '@canopy/ui-shared/icons/AppIcons';
import {
  Divider,
  ErrorBanner,
  Heading,
  ProgressBar,
} from '@canopy/ui-shared/components';

/** Git homepage linked from the description copy. */
const GIT_HOMEPAGE_URL = 'https://git-scm.com/';
/** Git-for-Windows install page opened by the `Manual` action. */
const GIT_WINDOWS_INSTALL_URL = 'https://git-scm.com/install/windows';

export interface WindowsGitRequiredScreenProps {
  state: WindowsGitGateState;
  /** Force a fresh detection pass. */
  onRecheck: () => void;
  /** Open a native picker for an installed Git executable. */
  onBrowse: () => void;
  /** Kick off the winget-driven install. */
  onAutoInstall: () => void;
  /** Dismiss the gate once Git is available. */
  onContinue: () => void;
  onCancelInstall?: () => void;
  /** Brand name woven into the description. Defaults to the active brand. */
  brandName?: string;
}

function openExternal(url: string): void {
  void window.api.browser.openExternal({ url });
}

/**
 * Horizontal rule that optionally frames a centered section header. Used to
 * separate the missing-Git actions into labeled groups.
 */
interface SectionDividerProps {
  label?: string;
}

function SectionDivider({ label }: SectionDividerProps): JSX.Element {
  if (!label) {
    return <Divider aria-hidden />;
  }
  return (
    <div className="flex items-center gap-3">
      <Divider className="flex-1" aria-hidden />
      <span className="text-xs font-medium fg-secondary">{label}</span>
      <Divider className="flex-1" aria-hidden />
    </div>
  );
}

interface ScreenShellProps {
  children: JSX.Element;
}

function ScreenShell({ children }: ScreenShellProps): JSX.Element {
  return (
    // The window's whole content in place of the shell, not a layer over it.
    <div
      className="flex h-screen w-full items-center justify-center overflow-hidden bg-base fg-primary"
      data-testid={
        window.platform === 'darwin'
          ? 'mac-git-required-screen'
          : window.platform === 'linux'
            ? 'linux-git-required-screen'
            : 'windows-git-required-screen'
      }
    >
      <div className="flex w-full max-w-md flex-col items-center gap-5 px-8 text-center">
        <BrandLogo size={64} className="select-none fg-accent" />
        {children}
      </div>
    </div>
  );
}

/**
 * Missing-Git view (also reused for the recoverable `error` state). Offers
 * Auto (when winget is available), Manual, Browse, and Recheck.
 */
interface MissingGitViewProps {
  wingetAvailable: boolean;
  brandName: string;
  errorText: string | null;
  onRecheck: () => void;
  onBrowse: () => void;
  onAutoInstall: () => void;
}

function MissingGitView({
  wingetAvailable,
  brandName,
  errorText,
  onRecheck,
  onBrowse,
  onAutoInstall,
}: MissingGitViewProps): JSX.Element {
  const linux = window.platform === 'linux';
  return (
    <>
      <Heading level={1} variant="page" data-testid="git-gate-title">
        Git installation is required
      </Heading>
      {linux ? (
        <>
          <p className="text-s fg-secondary">
            No usable Git installation was found. Install Git to use {brandName}
            .
          </p>
        </>
      ) : (
        <p className="text-s fg-secondary">
          No{' '}
          <a
            href={GIT_HOMEPAGE_URL}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e): void => {
              e.preventDefault();
              openExternal(GIT_HOMEPAGE_URL);
            }}
            className="underline transition-colors hover:fg-primary"
            data-testid="git-gate-git-link"
          >
            Git
          </a>{' '}
          installation was detected and it must be installed in order to use{' '}
          {brandName}.
        </p>
      )}
      {errorText && (
        <p className="text-s fg-warning" data-testid="git-gate-error">
          {errorText}
        </p>
      )}
      <div className="flex w-full flex-col gap-4 text-left">
        <SectionDivider label="Install Git" />
        <div className="flex flex-col gap-2">
          {!linux && (
            <Button
              variant="primary"
              onClick={onAutoInstall}
              disabled={!wingetAvailable}
              data-testid="git-gate-auto"
            >
              <AppCatalogMonitorDownIcon aria-hidden size="sm" />
              Install
            </Button>
          )}
          {linux ? (
            <LinuxGitInstallInstructions
              brandName={brandName}
              recheckLabel="Recheck"
              onOpenInstructions={(): void =>
                openExternal(GIT_LINUX_INSTALL_URL)
              }
            />
          ) : (
            <Button
              variant="secondary"
              onClick={(): void => openExternal(GIT_WINDOWS_INSTALL_URL)}
              data-testid="git-gate-manual"
            >
              <DownloadIcon size="sm" />
              Manual
            </Button>
          )}
          {!linux && !wingetAvailable && (
            <p
              className="text-xs fg-secondary"
              data-testid="git-gate-winget-hint"
            >
              Automatic installation requires winget.
            </p>
          )}
        </div>

        <SectionDivider label="Existing installation" />
        <div className="flex flex-col gap-2">
          <Button
            variant="secondary"
            onClick={onBrowse}
            data-testid="git-gate-browse"
          >
            <Folder className="h-4 w-4" />
            Browse
          </Button>
        </div>

        <SectionDivider />
        <div className="flex flex-col gap-2">
          <Button
            variant="secondary"
            onClick={onRecheck}
            data-testid="git-gate-recheck"
          >
            <RefreshCw className="h-4 w-4" />
            Recheck
          </Button>
        </div>
      </div>
    </>
  );
}

/** Auto-install view: indeterminate progress bar + latest phase message. */
interface InstallingViewProps {
  message: string;
}

function InstallingView({ message }: InstallingViewProps): JSX.Element {
  return (
    <>
      <Heading level={1} variant="page" data-testid="git-gate-title">
        Installing Git
      </Heading>
      {/* Indeterminate: winget output is not reliably percentage-able, so
          the bar exposes no value. */}
      <ProgressBar
        value={0}
        indeterminate
        label="Installing Git"
        hideLabel
        dataTestId="git-gate-progress"
      />
      <p
        className="text-s fg-secondary"
        data-testid="git-gate-progress-message"
      >
        {message}
      </p>
      <div className="flex w-full flex-col gap-4 text-left">
        <SectionDivider label="Install Git" />
        <div className="flex flex-col gap-2">
          <Button variant="primary" disabled data-testid="git-gate-auto">
            <AppCatalogMonitorDownIcon aria-hidden size="sm" />
            Install
          </Button>
          <Button variant="secondary" disabled data-testid="git-gate-manual">
            <DownloadIcon size="sm" />
            Manual
          </Button>
        </div>

        <SectionDivider label="Existing installation" />
        <div className="flex flex-col gap-2">
          <Button variant="secondary" disabled data-testid="git-gate-browse">
            <Folder className="h-4 w-4" />
            Browse
          </Button>
        </div>

        <SectionDivider />
        <div className="flex flex-col gap-2">
          <Button variant="secondary" disabled data-testid="git-gate-recheck">
            <RefreshCw className="h-4 w-4" />
            Recheck
          </Button>
        </div>
      </div>
    </>
  );
}

/** Detected path and Continue; Linux can recheck before entering the app. */
interface DetectedViewProps {
  path: string | null;
  onContinue: () => void;
  onRecheck?: () => void;
}

function DetectedView({
  path,
  onContinue,
  onRecheck,
}: DetectedViewProps): JSX.Element {
  return (
    <>
      <Heading level={1} variant="page" data-testid="git-gate-title">
        Git is ready
      </Heading>
      <p
        className="text-s fg-secondary"
        data-testid="git-gate-detected-message"
      >
        {path ? `Git was detected at ${path}.` : 'Git was detected.'}
      </p>
      <Button
        variant="primary"
        onClick={onContinue}
        data-testid="git-gate-continue"
      >
        Continue
      </Button>
      {onRecheck && (
        <Button
          variant="secondary"
          className="w-full"
          onClick={onRecheck}
          data-testid="git-gate-recheck"
        >
          Recheck
        </Button>
      )}
    </>
  );
}

/**
 * Blocking, full-screen desktop Git requirement gate (not a modal). Rendered by
 * App.tsx after the hydration gate and before the onboarding overlay / main
 * shell whenever Git is required but not yet usable on a supported desktop build.
 */
export function WindowsGitRequiredScreen({
  state,
  onRecheck,
  onBrowse,
  onAutoInstall,
  onContinue,
  onCancelInstall,
  brandName = brandText.appName,
}: WindowsGitRequiredScreenProps): JSX.Element {
  if (
    window.platform === 'darwin' &&
    (state.kind === 'required' ||
      state.kind === 'error' ||
      state.kind === 'installing')
  ) {
    const waiting = state.kind === 'installing';
    return (
      <ScreenShell>
        <>
          <Heading level={1} variant="page" data-testid="git-gate-title">
            {waiting
              ? 'Waiting for install to finish'
              : 'Git installation is required'}
          </Heading>
          <p
            className="text-s fg-secondary"
            data-testid="git-gate-install-explanation"
          >
            {waiting
              ? state.progress.message
              : `No usable Git installation was found. Install Apple's Command Line Tools to use ${brandName}. macOS will open a dialog where you can choose Install and accept the license.`}
          </p>
          {state.kind === 'error' && (
            <ErrorBanner
              errorSource="git-gate-error"
              className="w-full"
              error={state.message}
              testId="git-gate-error"
            />
          )}
          <div className="flex w-full flex-col gap-3">
            {waiting ? (
              <>
                <p
                  role="status"
                  className="text-s fg-secondary"
                  data-testid="git-gate-progress-message"
                >
                  Checking for Git in the background…
                </p>
                <Button
                  variant="secondary"
                  onClick={onCancelInstall}
                  data-testid="git-gate-cancel"
                >
                  Cancel
                </Button>
                <p className="text-xs fg-secondary">
                  Cancel stops these checks. Close Apple's installer separately
                  if needed.
                </p>
              </>
            ) : (
              <>
                <Button
                  variant="primary"
                  onClick={onAutoInstall}
                  data-testid="git-gate-auto"
                >
                  Install Command Line Tools
                </Button>
                <Button
                  variant="secondary"
                  onClick={onBrowse}
                  data-testid="git-gate-browse"
                >
                  Browse for Git
                </Button>
                <Button
                  variant="secondary"
                  onClick={onRecheck}
                  data-testid="git-gate-recheck"
                >
                  Recheck
                </Button>
              </>
            )}
          </div>
        </>
      </ScreenShell>
    );
  }
  switch (state.kind) {
    case 'installing':
      return (
        <ScreenShell>
          <InstallingView message={state.progress.message} />
        </ScreenShell>
      );
    case 'detected':
      return (
        <ScreenShell>
          <DetectedView
            path={state.status.path}
            onContinue={onContinue}
            {...(window.platform === 'linux' ? { onRecheck } : {})}
          />
        </ScreenShell>
      );
    case 'error':
      return (
        <ScreenShell>
          <MissingGitView
            wingetAvailable={state.status?.wingetAvailable ?? false}
            brandName={brandName}
            errorText={state.message}
            onRecheck={onRecheck}
            onBrowse={onBrowse}
            onAutoInstall={onAutoInstall}
          />
        </ScreenShell>
      );
    case 'required':
      return (
        <ScreenShell>
          <MissingGitView
            wingetAvailable={state.status.wingetAvailable}
            brandName={brandName}
            errorText={
              window.platform === 'linux' ? (state.status.error ?? null) : null
            }
            onRecheck={onRecheck}
            onBrowse={onBrowse}
            onAutoInstall={onAutoInstall}
          />
        </ScreenShell>
      );
    // `checking` / `not-required` are handled by App.tsx and never reach this
    // component, but render a neutral branded frame defensively.
    default:
      return (
        <ScreenShell>
          <Heading
            level={1}
            variant="page"
            className="sr-only"
            data-testid="git-gate-title"
          >
            Checking Git
          </Heading>
        </ScreenShell>
      );
  }
}

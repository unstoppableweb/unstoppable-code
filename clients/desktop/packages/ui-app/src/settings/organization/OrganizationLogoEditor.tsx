'use client';

import { ControlButton } from '@canopy/ui-shared/components';
import { useRef, type ChangeEvent, type JSX } from 'react';
import {
  Button,
  DISPLAY_AVATAR_SIZE_PX,
  MediaEditOverlay,
  type DisplayAvatarSize,
  ErrorBanner,
} from '@canopy/ui-shared/components';
import { Camera, ImagePlus } from '@canopy/ui-shared/icons/AppIcons';
import { ALLOWED_AVATAR_MIME_TYPES } from '@canopy/protocol/settings/account';
import { OrganizationLogo } from './OrganizationLogo';
import type { SettingsFailure } from '../errors';

const LOGO_INPUT_ACCEPT = ALLOWED_AVATAR_MIME_TYPES.join(',');

interface OrganizationLogoEditorProps {
  name: string;
  logoUrl: string | null;
  /** A shared avatar step; defaults to the 72px profile size. */
  size?: DisplayAvatarSize;
  busy: boolean;
  error: SettingsFailure | null;
  onPick: (file: File) => void;
  /**
   * Remove handler. When omitted, the "Remove logo" affordance is hidden — used
   * by the compact header editor, where removal lives only on the full settings
   * page. When provided, the affordance renders whenever a logo is set.
   */
  onRemove?: () => void;
}

/**
 * Rounded-square logo with a hover/focus "change logo" overlay that opens a
 * file picker, a dashed empty-state button when unset, and (when `onRemove` is
 * provided) a "Remove logo" affordance when a logo is set. The square analog of
 * `AvatarEditor`; presentational — the parent owns the upload state and feeds
 * `busy`/`error` back in.
 */
export function OrganizationLogoEditor({
  name,
  logoUrl,
  size = '2xl',
  busy,
  error,
  onPick,
  onRemove,
}: OrganizationLogoEditorProps): JSX.Element {
  const px = DISPLAY_AVATAR_SIZE_PX[size];
  const inputRef = useRef<HTMLInputElement>(null);

  const handleChange = (event: ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0];
    // Reset so re-picking the same file re-triggers `onChange`.
    event.target.value = '';
    if (file) {
      onPick(file);
    }
  };

  return (
    <div className="flex flex-col items-center gap-1">
      {logoUrl ? (
        <ControlButton
          data-settings-control="media"
          data-testid="org-logo-edit"
          onClick={() => inputRef.current?.click()}
          disabled={busy}
          aria-busy={busy || undefined}
          aria-label="Change organization logo"
          presentation="organization-logo-replace"
          style={{ width: px, height: px }}
        >
          <OrganizationLogo name={name} logoUrl={logoUrl} size={size} />
          <MediaEditOverlay>
            {busy ? (
              <span className="text-xs font-medium">…</span>
            ) : (
              <Camera size={Math.max(16, Math.round(px / 4))} />
            )}
          </MediaEditOverlay>
        </ControlButton>
      ) : (
        <ControlButton
          data-settings-control="media"
          data-testid="org-logo-edit"
          onClick={() => inputRef.current?.click()}
          disabled={busy}
          aria-busy={busy || undefined}
          aria-label="Add organization logo"
          style={{ width: px, height: px }}
          presentation="organization-logo-add"
        >
          {busy ? (
            <span className="text-xs font-medium">…</span>
          ) : (
            <ImagePlus size={Math.max(16, Math.round(px / 3))} />
          )}
        </ControlButton>
      )}
      <input
        ref={inputRef}
        type="file"
        accept={LOGO_INPUT_ACCEPT}
        className="sr-only"
        data-testid="org-logo-input"
        onChange={handleChange}
      />
      {logoUrl && onRemove && (
        <Button
          variant="secondary"
          size="compact"
          data-testid="org-logo-remove"
          onClick={onRemove}
          disabled={busy}
        >
          Remove logo
        </Button>
      )}
      {error && (
        <div className="w-full max-w-48">
          <ErrorBanner
            errorSource="organization-logo-editor"
            className=""
            error={error.copy}
            {...(error.details !== undefined ? { details: error.details } : {})}
          />
        </div>
      )}
    </div>
  );
}

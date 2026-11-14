'use client';

import {
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
  type JSX,
  type ReactNode,
} from 'react';
import {
  Button,
  DISPLAY_AVATAR_SIZE_PX,
  TextInput,
  Heading,
  type DisplayAvatarSize,
  ErrorBanner,
} from '@canopy/ui-shared/components';
import { Camera, Pencil } from '@canopy/ui-shared/icons/AppIcons';
import {
  ALLOWED_AVATAR_MIME_TYPES,
  PROFILE_NAME_MAX_LENGTH,
  PROFILE_NAME_MIN_LENGTH,
} from '@canopy/protocol/settings/account';
import { useSettingsPrivacy } from '../../host';
import { withPrivacyClass } from '../../account/privacy-class';
import { MemberAvatar } from '../MemberAvatar';
import type { SettingsFailure } from '../../errors';
import { useProfileEditor, type ProfileEditTarget } from './use-profile-editor';

const AVATAR_INPUT_ACCEPT = ALLOWED_AVATAR_MIME_TYPES.join(',');

interface AvatarEditorProps {
  name: string;
  image: string | null;
  /** A shared avatar step; defaults to the 72px profile size. */
  size?: DisplayAvatarSize;
  busy: boolean;
  error: SettingsFailure | null;
  onPick: (file: File) => void;
  onRemove: () => void;
}

/**
 * Avatar with a hover/focus "change photo" overlay that opens a file picker,
 * plus a "Remove photo" affordance when a custom image is set. Presentational:
 * the parent owns the upload state and feeds `busy`/`error` back in.
 */
export function AvatarEditor({
  name,
  image,
  size = '2xl',
  busy,
  error,
  onPick,
  onRemove,
}: AvatarEditorProps): JSX.Element {
  const px = DISPLAY_AVATAR_SIZE_PX[size];
  const inputRef = useRef<HTMLInputElement>(null);
  const { blockClassName } = useSettingsPrivacy();

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
      <button
        type="button"
        data-settings-control="media"
        data-testid="profile-avatar-edit"
        onClick={() => inputRef.current?.click()}
        disabled={busy}
        aria-label="Change profile photo"
        className={withPrivacyClass(
          'group relative rounded-full disabled:cursor-not-allowed',
          blockClassName,
        )}
        style={{ width: px, height: px }}
      >
        <MemberAvatar name={name} image={image} size={size} />
        <span
          aria-hidden="true"
          className="absolute inset-0 flex items-center justify-center rounded-full bg-black/40 text-white opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
        >
          {busy ? (
            <span className="text-xs font-medium">…</span>
          ) : (
            <Camera size={Math.max(16, Math.round(px / 4))} />
          )}
        </span>
      </button>
      <input
        ref={inputRef}
        type="file"
        accept={AVATAR_INPUT_ACCEPT}
        className="sr-only"
        data-testid="profile-avatar-input"
        onChange={handleChange}
      />
      {image && (
        <Button
          size="compact"
          variant="secondary"
          data-testid="profile-avatar-remove"
          onClick={onRemove}
          disabled={busy}
        >
          Remove photo
        </Button>
      )}
      {error && (
        <div className="w-full max-w-48">
          <ErrorBanner
            errorSource="avatar-editor"
            className=""
            error={error.copy}
            {...(error.details !== undefined ? { details: error.details } : {})}
          />
        </div>
      )}
    </div>
  );
}

interface NameEditorProps {
  name: string;
  busy: boolean;
  error: SettingsFailure | null;
  onSave: (name: string) => void;
  onOpen: () => void;
  /** Rendered next to the name in read mode (e.g. a role badge). */
  aux?: ReactNode;
}

/**
 * Inline-editable display name: an `<h1>` with a pencil affordance that swaps
 * to a text input + Save/Cancel. The parent persists via the shared editor and
 * feeds `busy`/`error` back in.
 */
export function NameEditor({
  name,
  busy,
  error,
  onSave,
  onOpen,
  aux,
}: NameEditorProps): JSX.Element {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const { blockClassName } = useSettingsPrivacy();

  const open = (): void => {
    setDraft(name);
    onOpen();
    setEditing(true);
  };

  const cancel = (): void => {
    setEditing(false);
    setDraft(name);
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const trimmed = draft.trim();
    if (
      trimmed.length < PROFILE_NAME_MIN_LENGTH ||
      trimmed.length > PROFILE_NAME_MAX_LENGTH ||
      busy
    ) {
      return;
    }
    onSave(trimmed);
    setEditing(false);
  };

  if (!editing) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <Heading level={1} variant="page" truncate data-testid="profile-name">
          <span className={blockClassName === '' ? undefined : blockClassName}>
            {name}
          </span>
        </Heading>
        {aux}
        <Button
          size="compact"
          iconOnly
          variant="ghost"
          data-testid="profile-name-edit"
          onClick={open}
          aria-label="Edit display name"
        >
          <Pencil size={14} />
        </Button>
        {error && (
          <div className="w-full">
            <ErrorBanner
              errorSource="name-editor"
              className=""
              error={error.copy}
              {...(error.details !== undefined
                ? { details: error.details }
                : {})}
            />
          </div>
        )}
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-wrap items-center gap-2">
      <div className={withPrivacyClass('min-w-0 flex-1', blockClassName)}>
        <TextInput
          density="compact"
          type="text"
          required
          autoFocus
          value={draft}
          maxLength={PROFILE_NAME_MAX_LENGTH}
          onChange={(event) => setDraft(event.target.value)}
          disabled={busy}
          data-testid="profile-name-input"
          aria-label="Display name"
        />
      </div>
      <Button
        type="submit"
        size="compact"
        disabled={busy || draft.trim().length < PROFILE_NAME_MIN_LENGTH}
        data-testid="profile-name-save"
      >
        {busy ? 'Saving…' : 'Save'}
      </Button>
      <Button
        size="compact"
        onClick={cancel}
        disabled={busy}
        data-testid="profile-name-cancel"
      >
        Cancel
      </Button>
      {error && (
        <div className="w-full">
          <ErrorBanner
            errorSource="name-editor"
            className=""
            error={error.copy}
            {...(error.details !== undefined ? { details: error.details } : {})}
          />
        </div>
      )}
    </form>
  );
}

interface ProfileIdentityEditorProps {
  initialName: string;
  initialImage: string | null;
  /** Rendered next to the name (e.g. the org role badge). */
  roleBadge?: ReactNode;
  /** The remaining (read-only) meta column content. */
  children?: ReactNode;
  avatarSize?: DisplayAvatarSize;
  /**
   * Which identity these edits write to. Defaults to the signed-in user's own
   * global profile (`{ mode: 'self' }`); pass an `org-member` target to edit
   * another member's org-scoped override instead.
   */
  target?: ProfileEditTarget;
}

/**
 * The owner-editable identity block of a member profile header: an editable
 * avatar plus an inline-editable display name, with the read-only meta column
 * (email / member-since / bio / links) passed through as `children`. Holds the
 * locally-optimistic `name`/`image` so edits reflect immediately without a
 * reload; full site-wide propagation lands on the next navigation.
 */
export function ProfileIdentityEditor({
  initialName,
  initialImage,
  roleBadge,
  children,
  avatarSize = '2xl',
  target,
}: ProfileIdentityEditorProps): JSX.Element {
  const [name, setName] = useState(initialName);
  const [image, setImage] = useState<string | null>(initialImage);
  const editor = useProfileEditor(target);

  const handlePick = (file: File): void => {
    void editor.uploadAvatar(file).then((url) => {
      if (url) {
        setImage(url);
      }
    });
  };

  const handleRemove = (): void => {
    void editor.removeAvatar().then((ok) => {
      if (ok) {
        setImage(null);
      }
    });
  };

  const handleSaveName = (next: string): void => {
    void editor.updateName(next).then((saved) => {
      if (saved) {
        setName(saved);
      }
    });
  };

  return (
    <>
      <AvatarEditor
        name={name}
        image={image}
        size={avatarSize}
        busy={editor.busy}
        error={editor.error}
        onPick={handlePick}
        onRemove={handleRemove}
      />
      <div className="flex min-w-0 flex-col gap-1">
        <NameEditor
          name={name}
          busy={editor.busy}
          error={editor.error}
          onOpen={editor.clearError}
          onSave={handleSaveName}
          aux={roleBadge}
        />
        {children}
      </div>
    </>
  );
}

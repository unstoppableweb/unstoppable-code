'use client';

import {
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
  type JSX,
} from 'react';
import {
  Button,
  SettingsRowsRow,
  TextInput,
  ErrorBanner,
} from '@canopy/ui-shared/components';
import {
  SETTINGS_CARD_ROW_CLASS,
  SettingsCard,
} from '@canopy/ui-shared/components/settings/SettingsCard';
import { capitalizeFirstLetter } from '@canopy/ui-shared/lib';
import {
  ALLOWED_AVATAR_MIME_TYPES,
  PROFILE_NAME_MAX_LENGTH,
  PROFILE_NAME_MIN_LENGTH,
} from '@canopy/protocol/settings/account';
import { useSettingsPrivacy } from '../host';
import { MemberAvatar } from '../organization/MemberAvatar';
import { useProfileEditor } from '../organization/profile/use-profile-editor';
import { withPrivacyClass } from './privacy-class';

const AVATAR_INPUT_ACCEPT = ALLOWED_AVATAR_MIME_TYPES.join(',');
const ROW_LABEL_CLASS = 'text-s font-medium fg-primary';
const ROW_DESCRIPTION_CLASS = 'text-xs text-pretty fg-secondary';

export interface AccountPanelProps {
  /** Signed-in user's current display name (server session). */
  initialName: string;
  /** Signed-in user's current avatar URL, or `null` for initials. */
  initialImage: string | null;
  /** Signed-in user's global role (e.g. `ADMIN`), shown on the profile rows. */
  role: string;
  /** Signed-in user's sign-in email, shown read-only. */
  email: string;
}

/**
 * "Account" page content: one Profile section whose rows hold the owner's
 * photo, name, sign-in email and role. The public profile and billing
 * surfaces have their own pages, so this panel needs no data fetch. Kept
 * separate from `SecurityPanel` so each account page owns its content.
 */
export function AccountPanel({
  initialName,
  initialImage,
  role,
  email,
}: AccountPanelProps): JSX.Element {
  return (
    <SettingsCard title="Profile" testId="account-profile-section">
      <ProfileSection initialName={initialName} initialImage={initialImage} />
      <AccountBasicsSection email={email} />
      <div className={SETTINGS_CARD_ROW_CLASS}>
        <div className={ROW_LABEL_CLASS}>Role</div>
        <span className="text-s fg-secondary" data-testid="account-role">
          {capitalizeFirstLetter(role.toLowerCase())}
        </span>
      </div>
    </SettingsCard>
  );
}

/**
 * The read-only Email row: the address the user signs in with. Sign-in
 * methods, password and two-factor are managed on Security.
 */
export function AccountBasicsSection({
  email,
}: {
  email: string;
}): JSX.Element {
  const { blockClassName } = useSettingsPrivacy();
  return (
    <div
      className={SETTINGS_CARD_ROW_CLASS}
      data-testid="account-basics-section"
    >
      <div className="min-w-0">
        <div className={ROW_LABEL_CLASS}>Email</div>
        <p
          className={withPrivacyClass(
            `${ROW_DESCRIPTION_CLASS} truncate`,
            blockClassName,
          )}
          data-testid="account-email"
        >
          {email}
        </p>
      </div>
    </div>
  );
}

interface ProfileSectionProps {
  initialName: string;
  initialImage: string | null;
}

/**
 * The owner-editable Photo and Name rows, sharing the upload/commit/PATCH
 * transport ({@link useProfileEditor}) with the member profile header. Edits
 * update the rows at once and propagate site-wide on the next navigation.
 */
export function ProfileSection({
  initialName,
  initialImage,
}: ProfileSectionProps): JSX.Element {
  const [name, setName] = useState(initialName);
  const [draft, setDraft] = useState(initialName);
  const [image, setImage] = useState<string | null>(initialImage);
  const editor = useProfileEditor();
  const { blockClassName } = useSettingsPrivacy();
  const inputRef = useRef<HTMLInputElement>(null);

  const handlePick = (event: ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0];
    // Reset so re-picking the same file re-triggers `onChange`.
    event.target.value = '';
    if (!file) return;
    void editor.uploadAvatar(file).then((url) => {
      if (url) setImage(url);
    });
  };

  const handleRemove = (): void => {
    void editor.removeAvatar().then((ok) => {
      if (ok) setImage(null);
    });
  };

  const saveName = (): void => {
    const trimmed = draft.trim();
    if (
      trimmed.length < PROFILE_NAME_MIN_LENGTH ||
      trimmed.length > PROFILE_NAME_MAX_LENGTH
    ) {
      setDraft(name);
      return;
    }
    if (trimmed === name || editor.busy) return;
    void editor.updateName(trimmed).then((saved) => {
      if (saved) {
        setName(saved);
        setDraft(saved);
      }
    });
  };

  const handleNameSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    saveName();
  };

  return (
    <>
      <div className={SETTINGS_CARD_ROW_CLASS}>
        <div className="min-w-0">
          <div className={ROW_LABEL_CLASS}>Photo</div>
          <p className={ROW_DESCRIPTION_CLASS}>
            PNG, JPEG or GIF, shown wherever your name appears.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <MemberAvatar name={name} image={image} size="lg" />
          <Button
            size="compact"
            variant="secondary"
            onClick={() => inputRef.current?.click()}
            disabled={editor.busy}
            data-testid="profile-avatar-edit"
          >
            Change
          </Button>
          {image ? (
            <Button
              size="compact"
              variant="secondary"
              onClick={handleRemove}
              disabled={editor.busy}
              data-testid="profile-avatar-remove"
            >
              Remove
            </Button>
          ) : null}
          <input
            ref={inputRef}
            type="file"
            accept={AVATAR_INPUT_ACCEPT}
            className="sr-only"
            data-testid="profile-avatar-input"
            onChange={handlePick}
          />
        </div>
      </div>
      <form className={SETTINGS_CARD_ROW_CLASS} onSubmit={handleNameSubmit}>
        <div className="min-w-0 flex-1">
          <SettingsRowsRow
            label="Name"
            htmlFor="profile-name-input"
            description="How you appear on your profile and in organizations."
            control={
              <div
                className={withPrivacyClass('w-52 shrink-0', blockClassName)}
              >
                <TextInput
                  id="profile-name-input"
                  density="settings"
                  required
                  maxLength={PROFILE_NAME_MAX_LENGTH}
                  value={draft}
                  disabled={editor.busy}
                  onChange={(event) => setDraft(event.target.value)}
                  onFocus={editor.clearError}
                  onBlur={saveName}
                  data-testid="profile-name-input"
                />
              </div>
            }
          />
        </div>
      </form>
      {editor.error ? (
        <div className="pb-3">
          <ErrorBanner
            errorSource="profile-section-editor"
            className=""
            error={editor.error.copy}
            {...(editor.error.details !== undefined
              ? { details: editor.error.details }
              : {})}
          />
        </div>
      ) : null}
    </>
  );
}

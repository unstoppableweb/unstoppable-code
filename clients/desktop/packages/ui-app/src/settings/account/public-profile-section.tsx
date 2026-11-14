'use client';
import {
  Fieldset,
  Stack,
  Button,
  buttonClassName,
  FormField,
  type FormFieldControlProps,
  ErrorBanner,
  SettingsSelect,
  TextArea,
  TextInput,
  ToggleSwitch,
  Tooltip,
  Heading,
  FieldError,
} from '@canopy/ui-shared/components';

import { useEffect, useMemo, useState, type JSX } from 'react';
import {
  Check,
  ExternalLink,
  Globe,
  Pencil,
} from '@canopy/ui-shared/icons/AppIcons';
import {
  PROFILE_PUBLIC_PATH,
  type PublicProfileSettings,
  type UsernameUnavailableReason,
} from '@canopy/protocol/settings/account';
import {
  PROFILE_SOCIAL_PLATFORMS,
  PUBLIC_PROFILE_BIO_MAX_LENGTH,
  PUBLIC_PROFILE_MAX_LINKS,
  validatePublicUsername,
  type ProfileSocialPlatform,
  type SocialLink,
} from '@canopy/protocol/profile';
import { SettingsCard } from '@canopy/ui-shared/components/settings/SettingsCard';
import { usePublicProfileEditor } from './use-public-profile-editor';
import { PublishedArtifactsManager } from './published-artifacts-manager';
import { platformMeta } from '@canopy/ui-shared/icons';
import { SettingsLink, useSettingsPrivacy } from '../host';
import { withPrivacyClass } from './privacy-class';
import {
  AvatarEditor,
  NameEditor,
} from '../organization/profile/ProfileIdentityEditor';
import { useProfileEditor } from '../organization/profile/use-profile-editor';
import { Surface } from '@canopy/ui-shared/components';

const USERNAME_HINT: Record<UsernameUnavailableReason, string> = {
  invalid: 'Use 3–40 lowercase letters, numbers, or hyphens.',
  reserved: 'That username is reserved.',
  taken: 'That username is already taken.',
};

interface PublicProfileSectionProps {
  initialSettings: PublicProfileSettings | null;
  /** Signed-in user's display name, shown on the profile header card. */
  displayName: string;
  /** Signed-in user's avatar URL, or null for an initial placeholder. */
  avatarUrl: string | null;
}

/** Editable draft of the profile form fields, diffed against saved settings. */
interface ProfileDraft {
  bio: string;
  links: SocialLink[];
  showCost: boolean;
  showHeatmap: boolean;
}

function draftFromSettings(
  settings: PublicProfileSettings | null,
): ProfileDraft {
  return {
    bio: settings?.bio ?? '',
    links: settings?.links ?? [],
    showCost: settings?.showCost ?? true,
    showHeatmap: settings?.showHeatmap ?? true,
  };
}

function linksEqual(a: SocialLink[], b: SocialLink[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (link, i) => link.platform === b[i].platform && link.url === b[i].url,
    )
  );
}

/**
 * /account public-profile tab. Two states, keyed on whether a username has been
 * claimed:
 *
 * - **Empty state** (no username): an explainer of what a public profile is plus
 *   a single "claim a username" CTA. Claiming publishes the profile in one call
 *   (`{ username, enabled: true }`) so the CTA actually turns the profile on.
 * - **Editor state** (username claimed): a "Basic info" header card (avatar,
 *   name, handle, publish switch, view/rename), a single-save "Shared content"
 *   form (bio, links, stat visibility), and the Featured work manager.
 *
 * The per-user opt-in is the only gate — no feature flag. Initial settings are
 * server-fetched and threaded in as props.
 */
export function PublicProfileSection({
  initialSettings,
  displayName,
  avatarUrl,
}: PublicProfileSectionProps): JSX.Element {
  const editor = usePublicProfileEditor();
  // Name + avatar are the global identity (shared with the Account tab and the
  // top nav), edited through the same {@link useProfileEditor} transport. Local
  // optimistic state reflects edits immediately; site-wide on next navigation.
  const identityEditor = useProfileEditor();
  const { blockClassName } = useSettingsPrivacy();
  const [name, setName] = useState(displayName);
  const [image, setImage] = useState<string | null>(avatarUrl);
  const [settings, setSettings] = useState<PublicProfileSettings | null>(
    initialSettings,
  );

  const handlePickAvatar = (file: File): void => {
    void identityEditor.uploadAvatar(file).then((url) => {
      if (url) {
        setImage(url);
      }
    });
  };
  const handleRemoveAvatar = (): void => {
    void identityEditor.removeAvatar().then((ok) => {
      if (ok) {
        setImage(null);
      }
    });
  };
  const handleSaveName = (next: string): void => {
    void identityEditor.updateName(next).then((saved) => {
      if (saved) {
        setName(saved);
      }
    });
  };
  // In the editor state the username claim is collapsed by default (the empty
  // state already handled the initial claim); this reveals it to rename.
  const [showUsernameEdit, setShowUsernameEdit] = useState(false);
  const [draft, setDraft] = useState<ProfileDraft>(() =>
    draftFromSettings(initialSettings),
  );
  const [saved, setSaved] = useState(false);

  const enabled = settings?.enabled ?? false;
  const claimedUsername = settings?.username ?? null;

  const baseline = draftFromSettings(settings);
  const dirty =
    draft.bio !== baseline.bio ||
    !linksEqual(draft.links, baseline.links) ||
    draft.showCost !== baseline.showCost ||
    draft.showHeatmap !== baseline.showHeatmap;

  const apply = async (
    patch: Parameters<typeof editor.save>[0],
  ): Promise<PublicProfileSettings | null> => {
    const next = await editor.save(patch);
    if (next) {
      setSettings(next);
    }
    return next;
  };

  const saveDraft = async (): Promise<void> => {
    setSaved(false);
    const next = await apply({
      bio: draft.bio || null,
      links: draft.links,
      showCost: draft.showCost,
      showHeatmap: draft.showHeatmap,
    });
    if (next) {
      setDraft(draftFromSettings(next));
      setSaved(true);
    }
  };

  // Empty state: nothing claimed yet. Explain the feature and offer the claim
  // CTA, which publishes the profile on success.
  if (!claimedUsername) {
    return (
      <div
        className="flex flex-col gap-6"
        data-testid="account-public-profile-section"
      >
        <Surface
          as="section"
          variant="raised"
          data-testid="public-profile-empty-state"
        >
          <div className="flex flex-col items-center gap-6 p-8 text-center">
            <Stack gap="item" align="center" className="w-full">
              <Stack gap="inline" align="center" className="w-full">
                <Stack gap="group" align="center">
                  {/* Deliberately NOT `SETTINGS_CARD_ICON_CLASS`. This is a full-width
              centred hero, not a card heading row: it keeps the larger 48px
              disc it has always had, and omits `mt-0.5`/`shrink-0`, which are
              written for a horizontal `items-start` row and would push the
              glyph off centre here. */}
                  <span className="flex h-12 w-12 items-center justify-center rounded-full bg-accent-subtle fg-accent-strong">
                    <Globe size={22} aria-hidden="true" />
                  </span>
                  <Heading level={2} variant="section">
                    Set up your public profile
                  </Heading>
                </Stack>
                <p className="max-w-md text-s fg-secondary">
                  Your public profile is a shareable page that showcases your
                  impact, activity, and published work. Claim a username to
                  publish it and share your work with anyone.
                </p>
              </Stack>
              <ErrorBanner
                errorSource="public-profile-section-editor"
                className="w-full max-w-md"
                error={editor.error?.copy}
                details={editor.error?.details}
              />
            </Stack>
            <div className="w-full max-w-md text-left">
              <UsernameField
                currentUsername={null}
                busy={editor.busy}
                check={editor.checkUsername}
                ctaLabel="Claim username"
                onClaim={(username) => void apply({ username, enabled: true })}
              />
            </div>
          </div>
        </Surface>
      </div>
    );
  }

  return (
    <div
      className="flex flex-col gap-6"
      data-testid="account-public-profile-section"
    >
      {/* The capsule link above the card, right-aligned. Hidden with the rest
          of the editor while unpublished — the public page is unreachable in
          that state. */}
      {enabled && (
        <div className="-mb-3 flex justify-end">
          <SettingsLink
            href={PROFILE_PUBLIC_PATH(claimedUsername)}
            className={buttonClassName({ size: 'compact' })}
            data-testid="public-profile-view-link"
          >
            <ExternalLink size={14} aria-hidden="true" />
            View public profile
          </SettingsLink>
        </div>
      )}

      {/* Profile header card: identity summary + publish switch, the standard
          social edit-profile header. The handle edits inline via the pencil.
          Titled "Basic info" rather than "Public profile" — the page header above
          already says Public profile, so repeating it here says nothing. */}
      <SettingsCard
        title="Basic info"
        subtitle="Your name, picture, and handle as they appear to anyone who visits your profile."
        testId="public-profile-header-card"
      >
        <Stack gap="item">
          <Stack gap="group">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="flex min-w-0 flex-1 items-center gap-4">
                <AvatarEditor
                  name={name}
                  image={image}
                  busy={identityEditor.busy}
                  error={identityEditor.error}
                  onPick={handlePickAvatar}
                  onRemove={handleRemoveAvatar}
                />
                <div
                  className={`flex min-w-0 flex-1 flex-col ${showUsernameEdit ? 'gap-1' : ''}`}
                >
                  <NameEditor
                    name={name}
                    busy={identityEditor.busy}
                    error={identityEditor.error}
                    onOpen={identityEditor.clearError}
                    onSave={handleSaveName}
                  />
                  {showUsernameEdit ? (
                    <div className="max-w-sm">
                      <UsernameField
                        currentUsername={claimedUsername}
                        busy={editor.busy}
                        check={editor.checkUsername}
                        hideLabel
                        onClaim={(username) => {
                          void apply({ username });
                          setShowUsernameEdit(false);
                        }}
                        onCancel={() => setShowUsernameEdit(false)}
                      />
                    </div>
                  ) : (
                    <p className="flex items-center gap-1.5 text-s fg-secondary">
                      <span
                        className={withPrivacyClass('truncate', blockClassName)}
                      >
                        @{claimedUsername}
                      </span>
                      <Tooltip label="Change username">
                        <Button
                          size="compact"
                          variant="ghost"
                          iconOnly
                          onClick={() => setShowUsernameEdit(true)}
                          aria-label="Change username"
                          data-testid="public-profile-change-username"
                        >
                          <Pencil size={14} aria-hidden="true" />
                        </Button>
                      </Tooltip>
                    </p>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-3">
                <span
                  className={`text-s font-medium ${enabled ? 'fg-success' : 'fg-secondary'}`}
                >
                  {enabled ? 'Published' : 'Hidden'}
                </span>
                <ToggleSwitch
                  checked={enabled}
                  disabled={editor.busy}
                  label="Publish profile"
                  onChange={(next) => void apply({ enabled: next })}
                  dataTestId="public-profile-enabled-toggle"
                />
              </div>
            </div>

            {!enabled && (
              <p className="text-s fg-secondary">
                Your profile is hidden — nobody can see it. Turn it back on to
                edit and share it.
              </p>
            )}
          </Stack>
          <ErrorBanner
            errorSource="public-profile-section-editor"
            className=""
            error={editor.error?.copy}
            details={editor.error?.details}
          />
        </Stack>
      </SettingsCard>

      {enabled && (
        <>
          {/* Single-save edit form: bio, links, stat visibility. "Shared
              content" names what the card holds; "Edit profile" restated the
              tab. */}
          <SettingsCard
            title="Shared content"
            subtitle="Your bio, links, and other content visitors can see."
            testId="public-profile-edit-card"
          >
            <div className="flex flex-col gap-6">
              <div className="flex flex-col gap-1.5">
                <FormField id="public-profile-bio" label="Bio">
                  {(control) => (
                    <TextArea
                      {...control}
                      value={draft.bio}
                      onChange={(e) =>
                        setDraft((prev) => ({
                          ...prev,
                          bio: e.target.value.slice(
                            0,
                            PUBLIC_PROFILE_BIO_MAX_LENGTH,
                          ),
                        }))
                      }
                      rows={3}
                      placeholder="Tell people what you build."
                      data-testid="public-profile-bio-input"
                    />
                  )}
                </FormField>
                <span className="self-end text-xs fg-secondary">
                  {draft.bio.length}/{PUBLIC_PROFILE_BIO_MAX_LENGTH}
                </span>
              </div>

              <SocialLinksField
                links={draft.links}
                onChange={(links) => setDraft((prev) => ({ ...prev, links }))}
              />

              <Fieldset
                gap="inline"
                legend={
                  <span className="text-xs font-medium fg-secondary">
                    Stats on your profile
                  </span>
                }
              >
                <Stack gap="item">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-s fg-primary">
                      Cost & subscription savings
                    </span>
                    <ToggleSwitch
                      checked={draft.showCost}
                      label="Show cost & subscription savings"
                      onChange={(next) =>
                        setDraft((prev) => ({ ...prev, showCost: next }))
                      }
                      dataTestId="public-profile-show-cost"
                    />
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-s fg-primary">Activity heatmap</span>
                    <ToggleSwitch
                      checked={draft.showHeatmap}
                      label="Show activity heatmap"
                      onChange={(next) =>
                        setDraft((prev) => ({ ...prev, showHeatmap: next }))
                      }
                      dataTestId="public-profile-show-heatmap"
                    />
                  </div>
                </Stack>
              </Fieldset>

              <div className="flex items-center justify-end gap-3 border-t pt-4">
                {saved && !dirty && (
                  <span
                    className="flex items-center gap-1 text-s fg-success"
                    role="status"
                  >
                    <Check size={14} aria-hidden="true" />
                    Saved
                  </span>
                )}
                <Button
                  size="compact"
                  onClick={() => void saveDraft()}
                  disabled={!dirty || editor.busy}
                  data-testid="public-profile-save"
                >
                  {editor.busy ? 'Saving…' : 'Save changes'}
                </Button>
              </div>
            </div>
          </SettingsCard>

          {/* Featured work: published-only listing + search picker (scales to
          thousands of sources — see PublishedArtifactsManager). */}
          <SettingsCard
            title="Featured work"
            subtitle="Skills, runs, plans, and workflows you choose to showcase. Each is a point-in-time snapshot."
            testId="public-profile-featured-card"
          >
            <PublishedArtifactsManager />
          </SettingsCard>
        </>
      )}
    </div>
  );
}

interface UsernameFieldProps {
  currentUsername: string | null;
  busy: boolean;
  check: ReturnType<typeof usePublicProfileEditor>['checkUsername'];
  onClaim: (username: string) => void;
  /** Overrides the claim/change button label (e.g. the empty-state CTA). */
  ctaLabel?: string;
  /** Visually hide the "Username" label (inline header editing). */
  hideLabel?: boolean;
  /** When set, render a Cancel action (and honor Escape) for inline editing. */
  onCancel?: () => void;
}

type RemoteResult = {
  username: string;
  status: 'available' | UsernameUnavailableReason;
};

function UsernameField({
  currentUsername,
  busy,
  check,
  onClaim,
  ctaLabel,
  hideLabel,
  onCancel,
}: UsernameFieldProps): JSX.Element {
  const [value, setValue] = useState(currentUsername ?? '');
  // Only the async network result lives in state (set inside the debounce
  // callback); everything else is derived during render so the effect never
  // calls setState synchronously.
  const [remote, setRemote] = useState<RemoteResult | null>(null);

  const clientValidation = useMemo(
    () => validatePublicUsername(value),
    [value],
  );
  const isCurrent = value === currentUsername;
  const isCandidate = !isCurrent && value.length > 0 && clientValidation.ok;

  useEffect(() => {
    if (!isCandidate) {
      return;
    }
    const id = window.setTimeout(() => {
      void check(value).then((result) => {
        if (!result) {
          return;
        }
        setRemote({
          username: value,
          status: result.available ? 'available' : (result.reason ?? 'invalid'),
        });
      });
    }, 400);
    return (): void => window.clearTimeout(id);
  }, [value, isCandidate, check]);

  const availability:
    | 'unknown'
    | 'checking'
    | 'available'
    | UsernameUnavailableReason =
    isCurrent || value.length === 0
      ? 'unknown'
      : !clientValidation.ok
        ? clientValidation.error === 'reserved'
          ? 'reserved'
          : 'invalid'
        : remote && remote.username === value
          ? remote.status
          : 'checking';

  const canClaim =
    !busy && !isCurrent && availability === 'available' && clientValidation.ok;

  // `control` is FormField's wiring when the label shows; a hidden label
  // names the field with `aria-label` instead.
  const renderRow = (control: FormFieldControlProps | null): JSX.Element => (
    <div className="flex flex-wrap items-start gap-2">
      {/* Input and its availability message share a column so the message
            aligns under the text box. */}
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        {/* The "@" is a fixed prefix inside the field edge. */}
        <TextInput
          {...control}
          id="public-profile-username"
          aria-label={control ? undefined : 'Username'}
          density="settings"
          leading="@"
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value.toLowerCase())}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && onCancel) {
              onCancel();
            }
          }}
          maxLength={40}
          autoComplete="off"
          spellCheck={false}
          data-testid="public-profile-username-input"
        />
        {availability === 'checking' && (
          <p className="text-xs fg-secondary">Checking availability…</p>
        )}
        {availability === 'available' && (
          <p className="flex items-center gap-1 text-xs fg-success">
            <Check size={13} aria-hidden="true" />
            Available
          </p>
        )}
        {availability !== 'checking' &&
          availability !== 'available' &&
          availability !== 'unknown' && (
            <FieldError id="public-profile-username-error">
              {USERNAME_HINT[availability]}
            </FieldError>
          )}
      </div>
      <Button
        size="compact"
        onClick={() => onClaim(value)}
        disabled={!canClaim}
        data-testid="public-profile-username-claim"
      >
        {ctaLabel ?? (currentUsername ? 'Change' : 'Claim')}
      </Button>
      {onCancel && (
        <Button
          size="compact"
          onClick={onCancel}
          data-testid="public-profile-username-cancel"
        >
          Cancel
        </Button>
      )}
    </div>
  );

  return hideLabel ? (
    renderRow(null)
  ) : (
    <FormField id="public-profile-username" label="Username">
      {(control) => renderRow(control)}
    </FormField>
  );
}

interface SocialLinksFieldProps {
  links: SocialLink[];
  onChange: (links: SocialLink[]) => void;
}

/** Controlled links editor: add/remove update the parent form draft directly. */
function SocialLinksField({
  links,
  onChange,
}: SocialLinksFieldProps): JSX.Element {
  const usedPlatforms = new Set(links.map((l) => l.platform));
  const availablePlatforms = PROFILE_SOCIAL_PLATFORMS.filter(
    (p) => !usedPlatforms.has(p),
  );
  const [platform, setPlatform] = useState<ProfileSocialPlatform | ''>('');
  const [url, setUrl] = useState('');

  const addLink = (): void => {
    if (!platform || !url || links.length >= PUBLIC_PROFILE_MAX_LINKS) {
      return;
    }
    onChange([...links, { platform, url }]);
    setUrl('');
    setPlatform('');
  };

  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs font-medium fg-secondary">Links</span>
      {links.length > 0 && (
        <ul className="flex flex-col gap-1">
          {links.map((link) => {
            const meta = platformMeta(link.platform);
            const Icon = meta.icon;
            return (
              <li
                key={link.platform}
                className="flex items-center justify-between gap-2 text-s fg-primary"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <Icon size={15} aria-hidden="true" />
                  <span className="sr-only">{meta.label}</span>
                  <span className="truncate">{link.url}</span>
                </span>
                <Button
                  size="compact"
                  onClick={() =>
                    onChange(links.filter((l) => l.platform !== link.platform))
                  }
                >
                  Remove
                </Button>
              </li>
            );
          })}
        </ul>
      )}
      {links.length < PUBLIC_PROFILE_MAX_LINKS &&
        availablePlatforms.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <SettingsSelect
              value={platform || null}
              placeholder="Platform…"
              onValueChange={(next) => {
                setPlatform(
                  PROFILE_SOCIAL_PLATFORMS.find((p) => p === next) ?? '',
                );
              }}
              aria-label="Link platform"
              options={availablePlatforms.map((p) => ({
                value: p,
                label: platformMeta(p).label,
              }))}
            />
            <TextInput
              type="url"
              density="settings"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://…"
              className="min-w-0 flex-1"
              aria-label="Link URL"
            />
            <Button
              size="compact"
              onClick={addLink}
              disabled={!platform || !url}
            >
              Add
            </Button>
          </div>
        )}
    </div>
  );
}

import {
  Fragment,
  type JSX,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import type {
  PreferencesData,
  ProfileRoleId,
} from '@canopy/desktop-shared/types';
import {
  Button,
  ChoiceList,
  ChoiceListRow,
  DialogFormField,
  DialogModal,
  TextInput,
  ErrorBanner,
} from '@canopy/ui-shared/components';
import { expandLegacyProfileRoles } from '@canopy/protocol/plugin-catalog';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import { ROLE_OPTIONS } from '@/lib/onboarding/profile-options';
import { SettingsDescriptionLoading, SettingsRow } from './SettingsLayout';

const ROLE_DETAIL_MAX_LENGTH = 256;

/** Older profiles have only `profileRole`; current profiles save the full list. */
function rolesFromPreferences(preferences: PreferencesData): ProfileRoleId[] {
  return expandLegacyProfileRoles(
    preferences.profileRoles?.length
      ? preferences.profileRoles
      : preferences.profileRole
        ? [preferences.profileRole]
        : [],
  );
}

/** Match the checklist's primary-role rule: first selected in option order. */
function primaryRole(roles: readonly ProfileRoleId[]): ProfileRoleId | null {
  return ROLE_OPTIONS.find((option) => roles.includes(option.id))?.id ?? null;
}

/**
 * Settings shows the complete checklist selection. Changes are staged in a
 * modal so dismissing it cannot accidentally replace the saved role list.
 */
export function ProfileRoleSection(): JSX.Element {
  const [roles, setRoles] = useState<ProfileRoleId[]>([]);
  const [detail, setDetail] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draftRoles, setDraftRoles] = useState<ProfileRoleId[]>([]);
  const [draftDetail, setDraftDetail] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const editButtonRef = useRef<HTMLButtonElement>(null);
  // The initial read and cross-window broadcasts can arrive after a local
  // save. During that save, its drafted selection remains authoritative.
  const inFlightSavesRef = useRef(0);
  const syncedRef = useRef(false);

  const applyPreferences = useCallback((preferences: PreferencesData): void => {
    setRoles(rolesFromPreferences(preferences));
    setDetail(preferences.profileRoleDetail ?? '');
    setLoaded(true);
    setLoadError(false);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void window.api
      .loadPreferences()
      .then((preferences) => {
        if (cancelled || syncedRef.current || inFlightSavesRef.current > 0)
          return;
        applyPreferences(preferences);
      })
      .catch(() => {
        if (!cancelled && !syncedRef.current) setLoadError(true);
      });
    return (): void => {
      cancelled = true;
    };
  }, [applyPreferences]);

  useEffect(() => {
    if (typeof window.api.onPreferencesSynced !== 'function') return undefined;
    return window.api.onPreferencesSynced((preferences) => {
      syncedRef.current = true;
      if (inFlightSavesRef.current > 0) return;
      applyPreferences(preferences);
      // Do not rewrite an open draft; Save and Cancel retain their ordinary
      // meaning even if onboarding is replayed in another window.
    });
  }, [applyPreferences]);

  const openEditor = (): void => {
    if (!loaded) return;
    setDraftRoles([...roles]);
    setDraftDetail(detail);
    setSaveError(false);
    setEditing(true);
  };

  const closeEditor = (): void => {
    if (!saving) setEditing(false);
  };

  const toggleRole = (role: ProfileRoleId): void => {
    setDraftRoles((current) =>
      current.includes(role)
        ? current.filter((entry) => entry !== role)
        : [...current, role],
    );
    setSaveError(false);
  };

  const saveRoles = async (): Promise<void> => {
    if (saving) return;
    const nextRoles = [...draftRoles];
    const nextDetail = nextRoles.length > 0 ? draftDetail : '';
    const primary = primaryRole(nextRoles);

    setSaving(true);
    setSaveError(false);
    inFlightSavesRef.current += 1;
    try {
      if (nextRoles.length === 0) {
        await window.api.savePreferences({
          profileRole: undefined,
          profileRoles: [],
          profileRoleDetail: '',
        });
      } else {
        await window.api.savePreferences({
          profileRole: primary ?? undefined,
          profileRoles: nextRoles,
          profileRoleDetail: nextDetail,
        });
      }
      setRoles(nextRoles);
      setDetail(nextDetail.trim());
      setEditing(false);
    } catch {
      setSaveError(true);
    } finally {
      inFlightSavesRef.current -= 1;
      setSaving(false);
    }
  };

  useCurrentUiStateReporter('settings.profileRole', {
    loaded,
    role: primaryRole(roles),
  });

  return (
    <SettingsRow
      label="Role"
      labelId="settings-profile-role-heading"
      dataTestId="settings-profile-role"
      description={
        loadError ? (
          <ErrorBanner
            errorSource="profile-roles-load"
            className=""
            error="Could not load your roles."
          />
        ) : !loaded ? (
          <SettingsDescriptionLoading dataTestId="settings-profile-role-loading" />
        ) : roles.length > 0 ? (
          <>
            <span data-testid="settings-profile-role-tiles">
              {roles.map((role, index) => (
                <Fragment key={role}>
                  {index > 0 ? ', ' : null}
                  <span data-testid={`settings-profile-role-tile-${role}`}>
                    {ROLE_OPTIONS.find((option) => option.id === role)?.label}
                  </span>
                </Fragment>
              ))}
            </span>
            {detail ? (
              <span
                className="block"
                data-testid="settings-profile-role-detail"
              >
                {detail}
              </span>
            ) : null}
          </>
        ) : (
          'What kind of work do you do?'
        )
      }
      control={
        loaded && !loadError ? (
          <Button
            ref={editButtonRef}
            size="compact"
            onClick={openEditor}
            data-testid="settings-profile-role-edit"
          >
            Edit
          </Button>
        ) : null
      }
    >
      {editing ? (
        <DialogModal
          inset="flush"
          onClose={closeEditor}
          title="What kind of work do you do?"
          subtitle="Select all that apply."
          maxWidth="sm"
          dataTestId="settings-profile-role-modal"
          trapFocus
          restoreFocusRef={editButtonRef}
          closeOnBackdrop={!saving}
          footer={
            <>
              <Button
                size="compact"
                variant="secondary"
                onClick={closeEditor}
                disabled={saving}
                data-testid="settings-profile-role-cancel"
              >
                Cancel
              </Button>
              <Button
                size="compact"
                variant="primary"
                onClick={(): void => {
                  void saveRoles();
                }}
                disabled={saving}
                data-testid="settings-profile-role-save"
              >
                {saving ? 'Saving…' : 'Save'}
              </Button>
            </>
          }
        >
          {/* The shared choice list: selection is the neutral mark. */}
          <div className="p-6">
            <ChoiceList
              aria-label="Roles"
              data-testid="settings-profile-role-options"
            >
              {ROLE_OPTIONS.map((option) => (
                <ChoiceListRow
                  key={option.id}
                  selected={draftRoles.includes(option.id)}
                  onClick={(): void => toggleRole(option.id)}
                  disabled={saving}
                  data-testid={`settings-profile-role-option-${option.id}`}
                >
                  {option.label}
                </ChoiceListRow>
              ))}
            </ChoiceList>
          </div>
          <div className="px-6 pb-6">
            <DialogFormField
              label="Tell us more about what you do (optional)"
              htmlFor="settings-profile-role-detail-input"
            >
              <TextInput
                id="settings-profile-role-detail-input"
                density="settings"
                value={draftDetail}
                onChange={(event): void => setDraftDetail(event.target.value)}
                maxLength={ROLE_DETAIL_MAX_LENGTH}
                data-testid="settings-profile-role-detail-input"
                placeholder="Role, responsibilities, or goals"
                disabled={saving}
              />
            </DialogFormField>
          </div>
          {saveError ? (
            <div className="px-6 pb-6">
              <ErrorBanner
                errorSource="profile-roles-save"
                className=""
                error="Could not save your roles. Please try again."
              />
            </div>
          ) : null}
        </DialogModal>
      ) : null}
    </SettingsRow>
  );
}

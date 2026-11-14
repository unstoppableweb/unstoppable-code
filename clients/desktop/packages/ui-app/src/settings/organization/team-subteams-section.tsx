'use client';

import { useMemo, useState, type FormEvent, type JSX } from 'react';
import { Pencil, Trash2, Users } from '@canopy/ui-shared/icons/AppIcons';
import {
  Button,
  ChoiceList,
  ChoiceListRow,
  DialogFormField,
  DialogModal,
  ErrorBanner,
  TextInput,
  EmptyStateRow,
} from '@canopy/ui-shared/components';
import type {
  OrganizationDetail,
  OrganizationSubTeam,
} from '@canopy/protocol/settings';
import { canManageSubTeams } from '@canopy/protocol/settings/organization-permissions';
import { useSettingsClient, useSettingsPrivacy } from '../host';
import { useSettingsErrorCopy, type KnownSettingsError } from '../errors';
import { ORGANIZATION_LAPSED_ERROR } from './organization-known-errors';
import { joinClassNames } from './join-class-names';
import {
  createSubTeam,
  deleteSubTeam,
  renameSubTeam,
  setSubTeamMembership,
} from './team-api';
import { SETTINGS_GROUP_CLASS } from '@canopy/ui-shared/components/settings/SettingsCard';
import type { SettingsFailure } from '../errors';

/** Failures of creating or renaming a team that have their own copy. */
const TEAM_NAME_KNOWN_ERRORS: readonly KnownSettingsError[] = [
  {
    // Team names are unique within an organization.
    status: 409,
    copy: 'A team with that name already exists. Choose another name.',
  },
  ORGANIZATION_LAPSED_ERROR,
];

const TEAMS_ERROR_SCOPE = 'settings.organization.teams';

interface TeamSubTeamsSectionProps {
  detail: OrganizationDetail;
  onDetailChange: (detail: OrganizationDetail) => void;
  /**
   * The org has lost `teams` (CAN-2311).
   *
   * This tab stays LIVE while lapsed — unlike most gated surfaces — because
   * sub-team member REMOVAL is a deliberate server-side exemption, so an admin
   * can still revoke a departing or compromised member's access. Only the
   * genuinely gated controls (create / rename / delete) are suppressed here, so
   * the tab does not present buttons whose every save would 403.
   */
  orgLapsed?: boolean;
  /**
   * Whether the new-team form is open. The page shell owns this because its
   * "New team" action sits in the page header.
   */
  creating: boolean;
  onCreatingChange: (creating: boolean) => void;
}

/**
 * Sub-teams list with member counts. Owners/admins can create, rename, delete,
 * and edit membership (a multi-select of org members, enforcing the
 * subset-of-org-membership invariant server-side).
 */
export function TeamSubTeamsSection({
  detail,
  onDetailChange,
  orgLapsed = false,
  creating,
  onCreatingChange,
}: TeamSubTeamsSectionProps): JSX.Element {
  const client = useSettingsClient();
  const errorCopy = useSettingsErrorCopy(TEAMS_ERROR_SCOPE);
  const [error, setError] = useState<SettingsFailure | null>(null);
  const [newName, setNewName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [editingMembership, setEditingMembership] =
    useState<OrganizationSubTeam | null>(null);
  const [renaming, setRenaming] = useState<OrganizationSubTeam | null>(null);
  const [busyTeamId, setBusyTeamId] = useState<string | null>(null);

  const manage = canManageSubTeams(detail.viewerRole);
  // Membership editing stays available while lapsed (removal is exempt);
  // creating, renaming, and deleting a sub-team are gated server-side, so their
  // controls are hidden rather than left to 403 on save.
  const manageStructure = manage && !orgLapsed;

  // The form opens from the page header; closing it clears what it held so
  // the next open starts empty.
  const closeCreateForm = (): void => {
    setNewName('');
    setError(null);
    onCreatingChange(false);
  };

  const handleCreate = async (
    event: FormEvent<HTMLFormElement>,
  ): Promise<void> => {
    event.preventDefault();
    const trimmed = newName.trim();
    if (!trimmed) {
      return;
    }
    try {
      setSubmitting(true);
      setError(null);
      const updated = await createSubTeam(client, detail.id, trimmed);
      onDetailChange(updated);
      closeCreateForm();
    } catch (err) {
      setError(
        errorCopy.actionFailure(err, {
          action: 'create the team',
          known: TEAM_NAME_KNOWN_ERRORS,
        }),
      );
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (team: OrganizationSubTeam): Promise<void> => {
    try {
      setBusyTeamId(team.id);
      setError(null);
      const updated = await deleteSubTeam(client, detail.id, team.id);
      onDetailChange(updated);
    } catch (err) {
      setError(
        errorCopy.actionFailure(err, {
          action: 'delete the team',
          known: [ORGANIZATION_LAPSED_ERROR],
        }),
      );
    } finally {
      setBusyTeamId(null);
    }
  };

  return (
    // The panel is the list itself: the page header above carries the name,
    // description, and New team.
    <section
      className="flex flex-col gap-4"
      data-testid="team-subteams-section"
    >
      <ErrorBanner
        errorSource="team-sub-teams-section"
        className=""
        error={error?.copy}
        details={error?.details}
      />

      {creating && (
        <form onSubmit={handleCreate} className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <TextInput
              density="settings"
              type="text"
              autoFocus
              required
              maxLength={120}
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Team name"
              aria-label="Team name"
              data-testid="team-subteam-name-input"
            />
          </div>
          <Button
            type="submit"
            variant="secondary"
            size="compact"
            disabled={submitting || !newName.trim()}
          >
            {submitting ? 'Creating…' : 'Create'}
          </Button>
          <Button variant="secondary" size="compact" onClick={closeCreateForm}>
            Cancel
          </Button>
        </form>
      )}

      <div>
        {detail.subTeams.length === 0 ? (
          <div className={SETTINGS_GROUP_CLASS}>
            <EmptyStateRow title="No teams yet." />
          </div>
        ) : (
          <ul className={SETTINGS_GROUP_CLASS}>
            {detail.subTeams.map((team) => (
              <li
                key={team.id}
                data-testid="team-subteam-row"
                className="flex flex-wrap items-center justify-between gap-3"
              >
                <div className="min-w-0">
                  <p className="truncate text-s font-medium fg-primary">
                    {team.name}
                  </p>
                  <p className="text-xs fg-secondary">
                    {team.memberCount}{' '}
                    {team.memberCount === 1 ? 'member' : 'members'}
                  </p>
                </div>
                {manage && (
                  <div className="flex items-center gap-2">
                    <Button
                      variant="secondary"
                      size="compact"
                      onClick={() => setEditingMembership(team)}
                      data-testid="team-subteam-members"
                    >
                      <Users size={13} />
                      Members
                    </Button>
                    {/* Rename and delete are gated server-side; membership
                        editing above is not, because removal is a deliberate
                        wind-down exemption. */}
                    {manageStructure && (
                      <>
                        <Button
                          variant="ghost"
                          size="compact"
                          iconOnly
                          onClick={() => setRenaming(team)}
                          aria-label={`Rename ${team.name}`}
                        >
                          <Pencil size={13} />
                        </Button>
                        <Button
                          variant="ghost"
                          size="compact"
                          iconOnly
                          onClick={() => void handleDelete(team)}
                          disabled={busyTeamId === team.id}
                          aria-label={`Delete ${team.name}`}
                          data-testid="team-subteam-delete"
                        >
                          <Trash2 size={13} />
                        </Button>
                      </>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {renaming && (
        <RenameSubTeamDialog
          orgId={detail.id}
          subTeam={renaming}
          onClose={() => setRenaming(null)}
          onRenamed={(updated) => {
            setRenaming(null);
            onDetailChange(updated);
          }}
        />
      )}

      {editingMembership && (
        <SubTeamMembershipDialog
          orgLapsed={orgLapsed}
          detail={detail}
          subTeam={editingMembership}
          onClose={() => setEditingMembership(null)}
          onSaved={(updated) => {
            setEditingMembership(null);
            onDetailChange(updated);
          }}
        />
      )}
    </section>
  );
}

interface RenameSubTeamDialogProps {
  orgId: string;
  subTeam: OrganizationSubTeam;
  onClose: () => void;
  onRenamed: (detail: OrganizationDetail) => void;
}

function RenameSubTeamDialog({
  orgId,
  subTeam,
  onClose,
  onRenamed,
}: RenameSubTeamDialogProps): JSX.Element {
  const client = useSettingsClient();
  const errorCopy = useSettingsErrorCopy(TEAMS_ERROR_SCOPE);
  const [name, setName] = useState(subTeam.name);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<SettingsFailure | null>(null);

  const handleSubmit = async (
    event: FormEvent<HTMLFormElement>,
  ): Promise<void> => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || trimmed === subTeam.name) {
      onClose();
      return;
    }
    try {
      setSubmitting(true);
      setError(null);
      const updated = await renameSubTeam(client, orgId, subTeam.id, trimmed);
      onRenamed(updated);
    } catch (err) {
      setError(
        errorCopy.actionFailure(err, {
          action: 'rename the team',
          known: TEAM_NAME_KNOWN_ERRORS,
        }),
      );
      setSubmitting(false);
    }
  };

  return (
    <DialogModal
      onClose={onClose}
      title="Rename team"
      maxWidth="md"
      dataTestId="rename-subteam-dialog"
    >
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <ErrorBanner
          errorSource="rename-sub-team-dialog"
          error={error?.copy}
          details={error?.details}
        />
        <DialogFormField label="Name" htmlFor="rename-subteam-name">
          <TextInput
            id="rename-subteam-name"
            density="settings"
            type="text"
            autoFocus
            required
            maxLength={120}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </DialogFormField>
        <div className="flex items-center justify-end gap-2">
          <Button variant="secondary" size="compact" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="primary"
            size="compact"
            disabled={submitting || !name.trim()}
          >
            {submitting ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </form>
    </DialogModal>
  );
}

interface SubTeamMembershipDialogProps {
  detail: OrganizationDetail;
  subTeam: OrganizationSubTeam;
  onClose: () => void;
  onSaved: (detail: OrganizationDetail) => void;
  /**
   * The org has lost `teams` (CAN-2311), so only REMOVALS are expressible.
   *
   * The server gate is direction-aware — it applies only when the update adds a
   * member — precisely so a lapsed org can still revoke a departing or
   * compromised member's sub-team access. But the save replaces the whole set
   * inside one transaction, so ticking a new member alongside a legitimate
   * removal makes the gate throw and rolls the ENTIRE replacement back, taking
   * the exempt removal with it. Disabling the unticked boxes keeps the
   * still-permitted operation from being defeated by an adjacent one.
   */
  orgLapsed?: boolean;
}

function SubTeamMembershipDialog({
  detail,
  subTeam,
  onClose,
  onSaved,
  orgLapsed = false,
}: SubTeamMembershipDialogProps): JSX.Element {
  const client = useSettingsClient();
  const errorCopy = useSettingsErrorCopy(TEAMS_ERROR_SCOPE);
  const { blockClassName } = useSettingsPrivacy();
  const initialSelected = useMemo(() => {
    const set = new Set<string>();
    for (const member of detail.members) {
      if (member.subTeamIds.includes(subTeam.id)) {
        set.add(member.id);
      }
    }
    return set;
  }, [detail.members, subTeam.id]);

  const [selected, setSelected] = useState<Set<string>>(initialSelected);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<SettingsFailure | null>(null);

  const toggle = (memberId: string): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(memberId)) {
        next.delete(memberId);
      } else {
        next.add(memberId);
      }
      return next;
    });
  };

  const handleSave = async (): Promise<void> => {
    try {
      setSubmitting(true);
      setError(null);
      const updated = await setSubTeamMembership(
        client,
        detail.id,
        subTeam.id,
        Array.from(selected),
      );
      onSaved(updated);
    } catch (err) {
      setError(
        errorCopy.actionFailure(err, { action: "update the team's members" }),
      );
      setSubmitting(false);
    }
  };

  return (
    <DialogModal
      onClose={onClose}
      title={`Members of ${subTeam.name}`}
      subtitle="Select which members belong to this team."
      maxWidth="md"
      dataTestId="subteam-membership-dialog"
    >
      <div className="flex flex-col gap-4">
        <ErrorBanner
          errorSource="sub-team-membership-dialog"
          error={error?.copy}
          details={error?.details}
        />
        {/* The whole list scrolls in its capped box. */}
        <div className="max-h-72 overflow-y-auto rounded-lg">
          <ChoiceList aria-label="Members">
            {detail.members.map((member) => (
              <ChoiceListRow
                key={member.id}
                selected={selected.has(member.id)}
                onClick={() => toggle(member.id)}
                // While lapsed only removals are permitted, so a member who
                // is not currently on the sub-team cannot be added.
                disabled={orgLapsed && !initialSelected.has(member.id)}
                data-testid="subteam-member-checkbox"
              >
                <span
                  className={joinClassNames('block min-w-0', blockClassName)}
                >
                  <span className="block truncate font-medium fg-primary">
                    {member.name}
                  </span>
                  <span className="block truncate text-xs fg-secondary">
                    {member.email}
                  </span>
                </span>
              </ChoiceListRow>
            ))}
          </ChoiceList>
        </div>
        <div className="flex items-center justify-end gap-2">
          <Button variant="secondary" size="compact" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="compact"
            onClick={() => void handleSave()}
            disabled={submitting}
            data-testid="subteam-membership-save"
          >
            {submitting ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </div>
    </DialogModal>
  );
}

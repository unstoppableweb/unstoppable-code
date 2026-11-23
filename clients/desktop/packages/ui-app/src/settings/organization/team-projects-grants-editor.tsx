'use client';

import type { Dispatch, SetStateAction, JSX } from 'react';
import {
  Button,
  ChoiceField,
  FormField,
  Notice,
  SettingsSelect,
} from '@canopy/ui-shared/components';
import {
  ORG_PROJECT_LIMITS,
  type OrgProjectGrant,
  type OrgProjectGrantPrincipal,
} from '@canopy/protocol/org-projects';
import type {
  OrganizationDetail,
  OrganizationMember,
} from '@canopy/protocol/settings/organization';
import { useSettingsPrivacy } from '../host';

/** Class tokens joined without stray whitespace when one is empty. */
function joinClasses(...classes: string[]): string {
  return classes.filter(Boolean).join(' ');
}

/** Select value for the everyone grant; member ids are UUIDs, so it cannot collide. */
const ORGANIZATION_OPTION = 'organization';

export function principalKey(principal: OrgProjectGrantPrincipal): string {
  switch (principal.type) {
    case 'user':
      return `user:${principal.userId}`;
    case 'team':
      return `team:${principal.teamId}`;
    case 'organization':
      return 'organization';
  }
}

function principalName(
  principal: OrgProjectGrantPrincipal,
  detail: OrganizationDetail,
): string {
  switch (principal.type) {
    case 'user':
      return (
        detail.members.find((member) => member.id === principal.userId)?.name ||
        detail.members.find((member) => member.id === principal.userId)
          ?.email ||
        principal.userId
      );
    case 'team':
      return (
        detail.subTeams.find((team) => team.id === principal.teamId)?.name ??
        principal.teamId
      );
    case 'organization':
      return `Everyone in ${detail.name}`;
  }
}

function grantedMembers(
  grants: OrgProjectGrant[],
  members: OrganizationMember[],
): OrganizationMember[] {
  return members.filter((member) =>
    grants.some(({ principal }) => {
      switch (principal.type) {
        case 'user':
          return principal.userId === member.id;
        case 'team':
          return member.subTeamIds.includes(principal.teamId);
        case 'organization':
          return true;
      }
    }),
  );
}

interface TeamProjectsGrantsEditorProps {
  detail: OrganizationDetail;
  grants: OrgProjectGrant[];
  setGrants: Dispatch<SetStateAction<OrgProjectGrant[]>>;
  originalGrants?: OrgProjectGrant[];
  disabled: boolean;
  growthDisabled: boolean;
}

export function TeamProjectsGrantsEditor({
  detail,
  grants,
  setGrants,
  originalGrants = [],
  disabled,
  growthDisabled,
}: TeamProjectsGrantsEditorProps): JSX.Element {
  const { blockClassName } = useSettingsPrivacy();
  const currentMembers = grantedMembers(grants, detail.members);
  const memberIds = new Set(currentMembers.map((member) => member.id));
  const losingAccess = grantedMembers(originalGrants, detail.members).filter(
    (member) => !memberIds.has(member.id),
  );
  const losingNames = losingAccess
    .map((member) => member.name || member.email)
    .join(', ');
  const keys = new Set(grants.map((grant) => principalKey(grant.principal)));
  const addDisabled =
    disabled ||
    growthDisabled ||
    grants.length >= ORG_PROJECT_LIMITS.grantsPerProject;
  const add = (principal: OrgProjectGrantPrincipal): void => {
    if (addDisabled || keys.has(principalKey(principal))) return;
    setGrants((current) => [...current, { principal, defaultListed: false }]);
  };
  return (
    <div
      data-testid="team-projects-grants-editor"
      className="flex flex-col gap-3 text-s"
    >
      <ul className="divide-y">
        {grants.map((grant) => {
          const key = principalKey(grant.principal);
          const label = principalName(grant.principal, detail);
          const principal = grant.principal;
          const member =
            principal.type === 'user'
              ? detail.members.find((entry) => entry.id === principal.userId)
              : undefined;
          const everyone = principal.type === 'organization';
          return (
            <li
              key={key}
              data-testid={
                everyone ? 'team-projects-grant-organization' : undefined
              }
              className="flex flex-wrap items-center gap-3 py-3"
            >
              <div className="min-w-0 flex-1">
                <p className={blockClassName || undefined}>{label}</p>
                {member && (
                  <p className={joinClasses('fg-secondary', blockClassName)}>
                    {member.email}
                  </p>
                )}
                {everyone && (
                  <p className="fg-secondary">Includes people who join later</p>
                )}
              </div>
              {/* The everyone grant is never listed by default: members add it themselves. */}
              {!everyone && (
                <ChoiceField
                  label="Listed by default"
                  checked={grant.defaultListed}
                  disabled={disabled}
                  onChange={(event): void =>
                    setGrants((current) =>
                      current.map((entry) =>
                        principalKey(entry.principal) === key
                          ? {
                              ...entry,
                              defaultListed: event.target.checked,
                            }
                          : entry,
                      ),
                    )
                  }
                />
              )}
              <Button
                size="compact"
                variant="secondary"
                disabled={disabled}
                aria-label={`Remove ${label}`}
                onClick={(): void =>
                  setGrants((current) =>
                    current.filter(
                      (entry) => principalKey(entry.principal) !== key,
                    ),
                  )
                }
              >
                Remove
              </Button>
            </li>
          );
        })}
      </ul>
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField label="Add member">
          {(control) => (
            <SettingsSelect
              {...control}
              aria-label="Add member"
              width="fill"
              replayPrivacy={{ blockClassName }}
              value={null}
              placeholder="Choose a member"
              disabled={addDisabled}
              onValueChange={(value): void => {
                if (value === ORGANIZATION_OPTION)
                  add({ type: 'organization' });
                else if (value) add({ type: 'user', userId: value });
              }}
              options={[
                ...(keys.has(principalKey({ type: 'organization' }))
                  ? []
                  : [
                      {
                        value: ORGANIZATION_OPTION,
                        label: principalName({ type: 'organization' }, detail),
                      },
                    ]),
                ...detail.members
                  .filter((member) => !keys.has(`user:${member.id}`))
                  .map((member) => ({
                    value: member.id,
                    label: member.name || member.email,
                  })),
              ]}
            />
          )}
        </FormField>
        <FormField label="Add team">
          {(control) => (
            <SettingsSelect
              {...control}
              aria-label="Add team"
              width="fill"
              replayPrivacy={{ blockClassName }}
              value={null}
              placeholder="Choose a team"
              disabled={addDisabled}
              onValueChange={(value): void => {
                if (value) add({ type: 'team', teamId: value });
              }}
              options={detail.subTeams
                .filter((team) => !keys.has(`team:${team.id}`))
                .map((team) => ({ value: team.id, label: team.name }))}
            />
          )}
        </FormField>
      </div>
      {grants.length >= ORG_PROJECT_LIMITS.grantsPerProject && (
        <Notice>Each project can have up to 500 grants.</Notice>
      )}
      <p aria-live="polite">
        {currentMembers.length}{' '}
        {currentMembers.length === 1 ? 'member' : 'members'} will see this
        project
      </p>
      {losingAccess.length > 0 && (
        <Notice intent="attention">
          Members losing access:{' '}
          {blockClassName === '' ? (
            losingNames
          ) : (
            <span className={blockClassName}>{losingNames}</span>
          )}
        </Notice>
      )}
    </div>
  );
}

'use client';

import { Badge } from '@canopy/ui-shared/primitives/Badge';
import type { JSX, ReactNode } from 'react';
import type { MemberProfileHeader } from '@canopy/protocol/team';
import type { OrganizationRole } from '@canopy/protocol/settings';
import { useSettingsPrivacy } from '../../host';
import { joinClassNames } from '../join-class-names';
import { MemberAvatar } from '../MemberAvatar';
import { ROLE_LABEL } from '../team-role-label';
import { ProfileIdentityEditor } from './ProfileIdentityEditor';
import type { ProfileEditTarget } from './use-profile-editor';
import { TextLink, Heading } from '@canopy/ui-shared/components';
import { Surface } from '@canopy/ui-shared/components';

interface ProfileHeaderProps {
  member: MemberProfileHeader;
  /**
   * When non-null, the avatar and display name render edit affordances writing
   * to this target: `{ mode: 'self' }` edits the viewer's own global identity,
   * `{ mode: 'org-member', … }` edits this member's org-scoped override. `null`
   * (the default) renders a read-only header.
   */
  editContext?: ProfileEditTarget | null;
}

function formatMemberSince(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return 'Unknown';
  }
  return date.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

/**
 * The GitHub-profile-style header for a member: large avatar, display name,
 * role chip, and "Member since {date}". When `editContext` is non-null, the
 * avatar and name become editable via {@link ProfileIdentityEditor} against
 * that target (self vs org-member override); the meta column below is identical
 * in both modes. The optional `bio`/`links` fields stay read-only forward-compat
 * hooks.
 */
export function ProfileHeader({
  member,
  editContext = null,
}: ProfileHeaderProps): JSX.Element {
  const { blockClassName } = useSettingsPrivacy();
  const role: OrganizationRole = member.role;
  const links = member.links ?? [];

  const meta: ReactNode = (
    <>
      <p
        className={joinClassNames(
          'truncate text-s fg-secondary',
          blockClassName,
        )}
      >
        {member.email}
      </p>
      <p className="text-xs fg-secondary">
        Member since{' '}
        <time dateTime={member.memberSinceIso}>
          {formatMemberSince(member.memberSinceIso)}
        </time>
      </p>
      {member.bio && <p className="pt-1 text-s fg-primary">{member.bio}</p>}
      {links.length > 0 && (
        <ul className="pt-1 flex flex-wrap gap-3 text-s">
          {links.map((link) => (
            <li key={`${link.label}:${link.url}`}>
              <TextLink href={link.url} target="_blank" rel="noreferrer">
                {link.label}
              </TextLink>
            </li>
          ))}
        </ul>
      )}
    </>
  );

  return (
    <Surface
      as="header"
      variant="raised"
      padding="roomy"
      data-testid="profile-header"
      data-editable={editContext ? 'true' : 'false'}
      data-edit-mode={editContext?.mode ?? 'none'}
    >
      <div className="flex flex-col items-start gap-4 sm:flex-row sm:items-center">
        {editContext ? (
          <ProfileIdentityEditor
            initialName={member.name}
            initialImage={member.image}
            roleBadge={<Badge>{ROLE_LABEL[role]}</Badge>}
            target={editContext}
          >
            {meta}
          </ProfileIdentityEditor>
        ) : (
          <>
            <MemberAvatar name={member.name} image={member.image} size="2xl" />
            <div className="flex min-w-0 flex-col gap-1">
              <div className="flex flex-wrap items-center gap-2">
                <Heading level={1} variant="page" truncate>
                  <span
                    className={
                      blockClassName === '' ? undefined : blockClassName
                    }
                  >
                    {member.name}
                  </span>
                </Heading>
                <Badge>{ROLE_LABEL[role]}</Badge>
              </div>
              {meta}
            </div>
          </>
        )}
      </div>
    </Surface>
  );
}

'use client';

import {
  SETTINGS_CARD_CLASS,
  SETTINGS_CARD_GROUP_CLASS,
  SETTINGS_CARD_SUBTITLE_CLASS,
  SETTINGS_CARD_ROW_CLASS,
} from '@canopy/ui-shared/components/settings/SettingsCard';
import { useEffect, useState, type JSX } from 'react';
import {
  DelayedLoadingPlaceholder,
  ErrorBanner,
  Skeleton,
  ToggleSwitch,
  Tooltip,
  Heading,
} from '@canopy/ui-shared/components';
import type { OrganizationRole } from '@canopy/protocol/settings/organization';
import { canEditMemorySettings } from '@canopy/protocol/settings/organization-permissions';
import { useSettingsClient, useSettingsPrivacy } from '../host';
import { useSettingsErrorCopy, useSettingsLoadFailure } from '../errors';
import { joinClassNames } from './settings/join-class-names';
import {
  fetchMemoryParticipation,
  updateMemberMemoryParticipation,
  type MemoryParticipationMember,
} from './team-api';
import type { SettingsFailure } from '../errors';

const MEMORY_SETTINGS_ERROR_SCOPE = 'settings.organization.memory';

interface TeamMemorySettingsSectionProps {
  orgId: string;
  /** Org display name, named in the quiet-participation tooltip. */
  orgName: string;
  viewerRole: OrganizationRole;
  memoryEnabled: boolean;
}

export function TeamMemorySettingsSection(
  props: TeamMemorySettingsSectionProps,
): JSX.Element | null {
  if (!props.memoryEnabled || !canEditMemorySettings(props.viewerRole)) {
    return null;
  }
  return <MemorySettingsCard orgId={props.orgId} orgName={props.orgName} />;
}

function MemorySettingsCard({
  orgId,
  orgName,
}: {
  orgId: string;
  orgName: string;
}): JSX.Element {
  const client = useSettingsClient();
  const { blockClassName } = useSettingsPrivacy();
  const [members, setMembers] = useState<MemoryParticipationMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingMemberId, setSavingMemberId] = useState<string | null>(null);
  const errorCopy = useSettingsErrorCopy(MEMORY_SETTINGS_ERROR_SCOPE);
  const loadErrorCopy = useSettingsLoadFailure(MEMORY_SETTINGS_ERROR_SCOPE);
  // A failed load offers Retry; a failed toggle does not.
  const [loadError, setLoadError] = useState<SettingsFailure | null>(null);
  const [error, setError] = useState<SettingsFailure | null>(null);
  // Bumped by Retry to run the load again.
  const [loadAttempt, setLoadAttempt] = useState(0);

  const retryLoad = (): void => {
    setLoadError(null);
    setLoading(true);
    setLoadAttempt((attempt) => attempt + 1);
  };

  useEffect(() => {
    let active = true;
    const load = async (): Promise<void> => {
      try {
        const result = await fetchMemoryParticipation(client, orgId);
        if (active) {
          setMembers(result.members);
          setLoadError(null);
        }
      } catch (err) {
        if (active) setLoadError(loadErrorCopy(err));
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    };
    void load();
    return (): void => {
      active = false;
    };
  }, [client, orgId, loadErrorCopy, loadAttempt]);

  const handleToggle = async (
    memberId: string,
    enabled: boolean,
  ): Promise<void> => {
    const previousEnabled = members.find(
      (member) => member.userId === memberId,
    )?.memoryEnabled;
    if (previousEnabled === undefined) {
      return;
    }
    setMembers((current) =>
      current.map((member) =>
        member.userId === memberId
          ? { ...member, memoryEnabled: enabled }
          : member,
      ),
    );
    setSavingMemberId(memberId);
    setError(null);
    try {
      const result = await updateMemberMemoryParticipation(
        client,
        orgId,
        memberId,
        enabled,
      );
      setMembers((current) =>
        current.map((member) =>
          member.userId === memberId
            ? { ...member, memoryEnabled: result.memoryEnabled }
            : member,
        ),
      );
    } catch (err) {
      setMembers((current) =>
        current.map((member) =>
          member.userId === memberId
            ? { ...member, memoryEnabled: previousEnabled }
            : member,
        ),
      );
      setError(
        errorCopy.actionFailure(err, {
          action: 'update memory participation',
        }),
      );
    } finally {
      setSavingMemberId(null);
    }
  };

  return (
    <section
      className={SETTINGS_CARD_CLASS}
      data-testid="team-memory-settings-section"
    >
      <div className="flex min-w-0 flex-col gap-1">
        <Heading level={2} variant="section">
          Memory participation
        </Heading>
        <p className={SETTINGS_CARD_SUBTITLE_CLASS}>
          Choose whose organization conversations can be used to build shared
          memory.
        </p>
      </div>
      <div className={SETTINGS_CARD_GROUP_CLASS}>
        <p className="mt-2 text-xs fg-secondary">
          Disabling a member expires facts sourced solely from that member.
          Re-enabling them does not restore expired facts.
        </p>

        <ErrorBanner
          errorSource="memory-settings-card-load"
          className="mt-3"
          error={loadError?.copy}
          details={loadError?.details}
          onRetry={retryLoad}
        />
        <ErrorBanner
          errorSource="memory-settings-card"
          className="mt-3"
          error={error?.copy}
          details={error?.details}
        />

        {loading ? (
          <div className="mt-4">
            <DelayedLoadingPlaceholder>
              <MemoryParticipationSkeleton orgName={orgName} />
            </DelayedLoadingPlaceholder>
          </div>
        ) : (
          <ul className="flex flex-col">
            {members.map((member) => (
              <MemoryParticipationRow
                key={member.userId}
                member={member}
                orgName={orgName}
                blockClassName={blockClassName}
                busy={savingMemberId !== null}
                onToggle={(next) => void handleToggle(member.userId, next)}
              />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

const noop = (): void => undefined;

/** Sample members for the loading state: plain, of the loaded shape. */
const SAMPLE_MEMORY_MEMBERS: readonly MemoryParticipationMember[] = [
  {
    userId: 'sample-member-1',
    name: 'Sample member',
    email: 'member@example.com',
    role: 'ADMIN',
    memoryEnabled: true,
    contributingRecently: true,
  },
  {
    userId: 'sample-member-2',
    name: 'Another member',
    email: 'another@example.com',
    role: 'MEMBER',
    memoryEnabled: true,
    contributingRecently: true,
  },
];

/**
 * The member list while it loads: the real rows with sample members inside
 * `Skeleton`, so skullet measures them into bars in place.
 */
function MemoryParticipationSkeleton({
  orgName,
}: {
  orgName: string;
}): JSX.Element {
  return (
    <Skeleton
      loading
      label="Loading memory participation"
      testId="settings-skeleton-form"
      className="w-full"
    >
      <ul className="flex flex-col">
        {SAMPLE_MEMORY_MEMBERS.map((member) => (
          <MemoryParticipationRow
            key={member.userId}
            member={member}
            orgName={orgName}
            blockClassName=""
            busy={false}
            onToggle={noop}
          />
        ))}
      </ul>
    </Skeleton>
  );
}

/** One member's row: who they are and whether memory includes them. */
function MemoryParticipationRow({
  member,
  orgName,
  blockClassName,
  busy,
  onToggle,
}: {
  member: MemoryParticipationMember;
  orgName: string;
  blockClassName: string;
  busy: boolean;
  onToggle: (next: boolean) => void;
}): JSX.Element {
  return (
    <li
      className={SETTINGS_CARD_ROW_CLASS}
      data-testid={`memory-participation-row-${member.userId}`}
    >
      <div className={joinClassNames('min-w-0', blockClassName)}>
        <p className="truncate text-s font-medium fg-primary">
          {member.name ?? member.email}
        </p>
        <p className="truncate text-xs fg-secondary">
          {member.email} · {roleLabel(member.role)}
        </p>
        {!member.contributingRecently && (
          <QuietParticipationLabel userId={member.userId} orgName={orgName} />
        )}
      </div>
      <ToggleSwitch
        checked={member.memoryEnabled}
        label={`Include ${member.name ?? member.email} in organization memory`}
        disabled={busy}
        dataTestId={`memory-participation-toggle-${member.userId}`}
        onChange={onToggle}
      />
    </li>
  );
}

/**
 * Neutral, admin-only note that a member's chats have not reached organization
 * memory recently (CAN-3383). It reports this one metric and nothing else: no
 * cause, and no claim about the member's other work.
 */
function QuietParticipationLabel({
  userId,
  orgName,
}: {
  userId: string;
  orgName: string;
}): JSX.Element {
  return (
    <Tooltip
      label={
        <span className="block max-w-60 whitespace-normal">
          {`No chats contributed to ${orgName} memory in 30 days.`}
        </span>
      }
      className="mt-1"
    >
      <button
        type="button"
        data-settings-control="disclosure"
        data-testid={`memory-participation-quiet-${userId}`}
        className="text-left text-xs fg-secondary"
      >
        No recent chat contributions
      </button>
    </Tooltip>
  );
}

function roleLabel(role: OrganizationRole): string {
  switch (role) {
    case 'OWNER':
      return 'Owner';
    case 'ADMIN':
      return 'Admin';
    case 'MEMBER':
      return 'Member';
  }
}

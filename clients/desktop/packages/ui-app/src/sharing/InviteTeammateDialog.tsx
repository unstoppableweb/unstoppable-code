'use client';

import {
  Stack,
  Button,
  DialogFormField,
  DialogModal,
  DisplayAvatar,
  ErrorBanner,
  Notice,
  NoticeButton,
  PickerMenuOption,
  PickerMenuOptionCheck,
  PickerMenuOptionContent,
  PickerMenuOptionLabel,
  PickerMenuOptionTrailing,
  SearchField,
  SettingsSelect,
  StatusPill,
  EmptyStateRow,
} from '@canopy/ui-shared/components';
import type {
  SharedContainerCapability,
  SharedContainerGrantSummary,
  SharedContainerMemberSummary,
} from '@canopy/protocol/shared-containers';
import type { WorkspaceContext } from '@canopy/protocol/workspace-context';
import {
  type JSX,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  ContextChangedNotice,
  contextLabel,
  defaultOrganizationForContext,
  useContextRebind,
} from './defaultOrganizationForContext';
import { InviteTeammateRefusal } from './invite-teammate-refusal';
import { Divider } from '@canopy/ui-shared/components';

export { InviteTeammateRefusal };

export interface InviteTeammateOrganization {
  readonly id: string;
  readonly name: string;
}

export interface InviteTeammateDialogProps {
  readonly chatId: string;
  readonly chatTitle: string;
  readonly organizations: readonly InviteTeammateOrganization[];
  /** Navigation context supplies the initial organization, never authority. */
  readonly context?: WorkspaceContext;
  /** Existing shares stay bound to the organization that owns the container. */
  readonly existingShareOrganizationId?: string;
  /**
   * Preferred organization when the chat has no existing share yet, e.g. the
   * organization that owns the chat's project (CAN-3458). Ignored when it is
   * not in `organizations`.
   */
  readonly defaultOrganizationId?: string;
  readonly searchMembers: (
    organizationId: string,
    query: string,
  ) => Promise<readonly SharedContainerMemberSummary[]>;
  readonly invite: (input: {
    organizationId: string;
    cloudChatId: string;
    recipientUserId: string;
    capabilities: readonly SharedContainerCapability[];
  }) => Promise<{
    containerId: string;
    grant: SharedContainerGrantSummary;
  }>;
  readonly loadRecipients: (
    organizationId: string,
    cloudChatId: string,
  ) => Promise<{
    containerId: string | null;
    recipients: readonly SharedContainerGrantSummary[];
  }>;
  readonly revoke: (input: {
    organizationId: string;
    containerId: string;
    recipientUserId: string;
  }) => Promise<void>;
  readonly onClose: () => void;
  readonly onSharingChanged?: () => void;
}

const CLOUD_CHAT_CAPABILITIES = ['VIEW', 'PROMPT'] as const;

function memberLabel(member: SharedContainerMemberSummary): string {
  return member.name || 'Teammate';
}

type MemberGrantSummary = SharedContainerGrantSummary & {
  readonly recipient: Extract<
    SharedContainerGrantSummary['recipient'],
    { kind: 'member' }
  >;
};

/** Cloud-chat sharing is organization-only, so only member grants render. */
function isMemberGrant(
  grant: SharedContainerGrantSummary,
): grant is MemberGrantSummary {
  return grant.recipient.kind === 'member';
}

export function InviteTeammateDialog({
  chatId,
  chatTitle,
  organizations,
  context,
  existingShareOrganizationId,
  defaultOrganizationId,
  searchMembers,
  invite,
  loadRecipients,
  revoke,
  onClose,
  onSharingChanged,
}: InviteTeammateDialogProps): JSX.Element {
  const initialOrganizationId = (): string =>
    existingShareOrganizationId ??
    (defaultOrganizationId !== undefined &&
    organizations.some(
      (organization) => organization.id === defaultOrganizationId,
    )
      ? defaultOrganizationId
      : defaultOrganizationForContext(context, organizations)) ??
    '';
  const [organizationId, setOrganizationId] = useState(initialOrganizationId);
  const [locallyBoundOrganizationId, setLocallyBoundOrganizationId] = useState<
    string | undefined
  >();
  const boundOrganizationId =
    existingShareOrganizationId ?? locallyBoundOrganizationId;
  const [contextChangedLabel, setContextChangedLabel] = useState<string | null>(
    null,
  );
  const [query, setQuery] = useState('');
  const [members, setMembers] = useState<
    readonly SharedContainerMemberSummary[]
  >([]);
  const [recipients, setRecipients] = useState<readonly MemberGrantSummary[]>(
    [],
  );
  const [containerId, setContainerId] = useState<string | null>(null);
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [membersLoading, setMembersLoading] = useState(false);
  const [recipientsLoading, setRecipientsLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [membersError, setMembersError] = useState<string | null>(null);
  const [recipientsError, setRecipientsError] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const searchSequence = useRef(0);
  const recipientsSequence = useRef(0);

  const selectOrganization = useCallback((nextOrganizationId: string): void => {
    searchSequence.current += 1;
    recipientsSequence.current += 1;
    setOrganizationId(nextOrganizationId);
    setQuery('');
    setMembers([]);
    setRecipients([]);
    setContainerId(null);
    setSelectedUserId(null);
    setMembersLoading(false);
    setRecipientsLoading(false);
    setMembersError(null);
    setRecipientsError(null);
    setMutationError(null);
  }, []);

  useContextRebind(
    context,
    (next) => {
      selectOrganization(
        (defaultOrganizationId !== undefined &&
        organizations.some(
          (organization) => organization.id === defaultOrganizationId,
        )
          ? defaultOrganizationId
          : defaultOrganizationForContext(next, organizations)) ?? '',
      );
      setContextChangedLabel(contextLabel(next, organizations));
    },
    boundOrganizationId !== undefined || submitting,
  );

  const invitedUserIds = useMemo(
    () => new Set(recipients.map((recipient) => recipient.recipient.userId)),
    [recipients],
  );

  const refreshMembers = useCallback(async (): Promise<void> => {
    if (!organizationId) return;
    const sequence = ++searchSequence.current;
    setMembersLoading(true);
    setMembersError(null);
    try {
      const nextMembers = await searchMembers(organizationId, query);
      if (sequence !== searchSequence.current) return;
      setMembers(nextMembers);
    } catch {
      if (sequence !== searchSequence.current) return;
      setMembers([]);
      setMembersError('Could not load teammates.');
    } finally {
      if (sequence === searchSequence.current) setMembersLoading(false);
    }
  }, [organizationId, query, searchMembers]);

  const refreshRecipients = useCallback(async (): Promise<void> => {
    if (!organizationId) return;
    const sequence = ++recipientsSequence.current;
    setRecipientsLoading(true);
    setRecipientsError(null);
    try {
      const result = await loadRecipients(organizationId, chatId);
      if (sequence !== recipientsSequence.current) return;
      setContainerId(result.containerId);
      setRecipients(result.recipients.filter(isMemberGrant));
    } catch {
      if (sequence !== recipientsSequence.current) return;
      setRecipients([]);
      setRecipientsError('Could not load people with access.');
    } finally {
      if (sequence === recipientsSequence.current) {
        setRecipientsLoading(false);
      }
    }
  }, [chatId, loadRecipients, organizationId]);

  useEffect(() => void refreshMembers(), [refreshMembers]);
  useEffect(() => void refreshRecipients(), [refreshRecipients]);

  const submitInvite = useCallback(async (): Promise<void> => {
    if (!organizationId || !selectedUserId) return;
    const requestOrganizationId = organizationId;
    setSubmitting(true);
    setMutationError(null);
    try {
      const result = await invite({
        organizationId: requestOrganizationId,
        cloudChatId: chatId,
        recipientUserId: selectedUserId,
        capabilities: CLOUD_CHAT_CAPABILITIES,
      });
      setLocallyBoundOrganizationId(requestOrganizationId);
      recipientsSequence.current += 1;
      setContainerId(result.containerId);
      setRecipientsLoading(false);
      const grant = result.grant;
      if (isMemberGrant(grant)) {
        setRecipients((current) => [
          ...current.filter(
            (entry) => entry.recipient.userId !== grant.recipient.userId,
          ),
          grant,
        ]);
      }
      setSelectedUserId(null);
      onSharingChanged?.();
    } catch (error) {
      setRecipientsLoading(false);
      setMutationError(
        error instanceof InviteTeammateRefusal
          ? error.message
          : 'Could not invite that teammate. Try again.',
      );
    } finally {
      setSubmitting(false);
    }
  }, [chatId, invite, onSharingChanged, organizationId, selectedUserId]);

  const revokeRecipient = useCallback(
    async (recipientUserId: string): Promise<void> => {
      if (!organizationId || !containerId) return;
      recipientsSequence.current += 1;
      setSubmitting(true);
      setMutationError(null);
      try {
        await revoke({ organizationId, containerId, recipientUserId });
        setRecipientsLoading(false);
        setRecipients((current) =>
          current.filter((entry) => entry.recipient.userId !== recipientUserId),
        );
        onSharingChanged?.();
      } catch {
        setMutationError('Could not remove access. Try again.');
      } finally {
        setSubmitting(false);
      }
    },
    [containerId, onSharingChanged, organizationId, revoke],
  );

  return (
    <DialogModal
      inset="flush"
      title="Share chat"
      subtitle={chatTitle}
      maxWidth="md"
      onClose={onClose}
    >
      <div className="flex flex-col gap-4 px-6 py-4">
        <p className="text-s fg-secondary">
          Teammates you invite can read this chat, send prompts, and stop
          running turns. Their prompts run and bill under your account.
        </p>

        {contextChangedLabel !== null && (
          <ContextChangedNotice
            label={contextChangedLabel}
            data-testid="invite-teammate-context-changed"
          />
        )}

        {(organizations.length > 1 || organizationId === '') && (
          <DialogFormField
            label="Organization"
            htmlFor="invite-teammate-organization"
          >
            <SettingsSelect
              id="invite-teammate-organization"
              data-testid="invite-teammate-organization"
              value={organizationId === '' ? null : organizationId}
              placeholder="Choose an organization"
              disabled={submitting || boundOrganizationId !== undefined}
              onValueChange={(value): void => {
                selectOrganization(value);
              }}
              options={organizations.map((organization) => ({
                value: organization.id,
                label: organization.name,
              }))}
            />
          </DialogFormField>
        )}
        {organizations.length <= 1 && organizationId !== '' && (
          <p
            className="text-s fg-secondary"
            data-testid="invite-teammate-organization-name"
          >
            Organization:{' '}
            <span className="fg-primary">
              {organizations.find(
                (organization) => organization.id === organizationId,
              )?.name ?? organizationId}
            </span>
          </p>
        )}

        <Stack gap="item">
          <SearchField
            value={query}
            placeholder="Search teammates"
            aria-label="Search teammates"
            onValueChange={setQuery}
          />
          {membersLoading && (
            <p className="text-s fg-secondary">Loading teammates…</p>
          )}
          {!membersLoading && membersError && (
            <Notice
              errorSource="invite-teammate-dialog-members"
              intent="destructive"
              actions={
                <NoticeButton
                  data-testid="invite-teammate-search-retry"
                  onClick={(): void => void refreshMembers()}
                >
                  Try again
                </NoticeButton>
              }
            >
              {membersError}
            </Notice>
          )}
          {!membersLoading && !membersError && (
            <div
              className="max-h-40 overflow-y-auto grid grid-cols-1 content-start gap-1"
              role="listbox"
              aria-label="Teammates"
            >
              {members.map((member) => {
                const alreadyShared = invitedUserIds.has(member.userId);
                return (
                  <PickerMenuOption
                    key={member.userId}
                    role="option"
                    aria-selected={selectedUserId === member.userId}
                    selected={selectedUserId === member.userId}
                    data-testid={`invite-teammate-member-${member.userId}`}
                    disabled={alreadyShared || submitting}
                    onClick={(): void => setSelectedUserId(member.userId)}
                  >
                    <DisplayAvatar
                      name={memberLabel(member)}
                      image={member.image}
                    />
                    <PickerMenuOptionContent>
                      <PickerMenuOptionLabel>
                        {memberLabel(member)}
                      </PickerMenuOptionLabel>
                    </PickerMenuOptionContent>
                    <PickerMenuOptionCheck
                      selected={selectedUserId === member.userId}
                    />
                    {alreadyShared && (
                      <PickerMenuOptionTrailing>
                        Shared
                      </PickerMenuOptionTrailing>
                    )}
                  </PickerMenuOption>
                );
              })}
            </div>
          )}
        </Stack>

        <div className="flex flex-col gap-4">
          <Divider />
          <div className="flex flex-col gap-2">
            <p className="text-s font-medium fg-primary">People with access</p>
            {recipientsLoading && (
              <p className="text-s fg-secondary">Loading people…</p>
            )}
            {!recipientsLoading && recipientsError && (
              <Notice
                errorSource="invite-teammate-dialog-recipients"
                intent="destructive"
                actions={
                  <NoticeButton
                    data-testid="invite-teammate-recipients-retry"
                    onClick={(): void => void refreshRecipients()}
                  >
                    Try again
                  </NoticeButton>
                }
              >
                {recipientsError}
              </Notice>
            )}
            {!recipientsLoading &&
              !recipientsError &&
              recipients.length === 0 && (
                <EmptyStateRow title="No one has access yet." />
              )}
            {!recipientsLoading &&
              !recipientsError &&
              recipients.map((grant) => (
                <div
                  key={grant.id}
                  className="flex items-center gap-3 px-3 py-2 text-s"
                >
                  <DisplayAvatar
                    name={memberLabel(grant.recipient)}
                    image={grant.recipient.image}
                  />
                  <span className="min-w-0 flex-1 truncate fg-primary">
                    {memberLabel(grant.recipient)}
                  </span>
                  {grant.dismissedAt !== undefined ? (
                    // Revoke-only record of a share the recipient removed.
                    <StatusPill
                      data-testid={`invite-teammate-removed-by-recipient-${grant.recipient.userId}`}
                    >
                      Removed by recipient
                    </StatusPill>
                  ) : (
                    <StatusPill>Can view and prompt</StatusPill>
                  )}
                  <Button
                    variant="ghost-destructive"
                    size="compact"
                    data-testid={`invite-teammate-revoke-${grant.recipient.userId}`}
                    disabled={submitting}
                    onClick={(): void =>
                      void revokeRecipient(grant.recipient.userId)
                    }
                  >
                    Remove
                  </Button>
                </div>
              ))}
          </div>
        </div>

        <ErrorBanner
          errorSource="invite-teammate-dialog-mutation"
          className=""
          error={mutationError}
        />
      </div>

      <div className="flex justify-end gap-2 border-t px-6 py-3">
        <Button
          type="button"
          variant="secondary"
          size="compact"
          onClick={onClose}
          disabled={submitting}
        >
          Close
        </Button>
        <Button
          type="button"
          variant="primary"
          size="compact"
          data-testid="invite-teammate-submit"
          disabled={!organizationId || !selectedUserId || submitting}
          onClick={(): void => void submitInvite()}
        >
          {submitting ? 'Inviting…' : 'Invite'}
        </Button>
      </div>
    </DialogModal>
  );
}

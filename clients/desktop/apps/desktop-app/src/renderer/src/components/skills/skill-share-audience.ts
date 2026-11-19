import type { ShareAudience } from '@canopy/protocol/sharing';
import type { SharedSkillDetail } from '@canopy/protocol/skills';
import type {
  CreateSharedSkillRequest,
  UpdateSharedSkillRequest,
} from '@canopy/desktop-shared/types/skills';
import { classifyShareFailure } from '@canopy/ui-app/sharing';

/**
 * What a new share asks the cloud about its audience (CAN-7037). "Only me"
 * asks for a private skill, so an identical skill the account already shares
 * by link, with a team or with an organization is refused rather than reused.
 * The other audiences ask nothing, as before.
 */
export function skillShareCreateAudience(
  scope: ShareAudience,
): Pick<CreateSharedSkillRequest, 'expectedAudience'> {
  return scope === 'private' ? { expectedAudience: 'private' } : {};
}

/** Who a shared skill reaches, as the cloud's audience check names it. */
function skillAudience(
  detail: Pick<SharedSkillDetail, 'shareScope' | 'publicShare'>,
): NonNullable<UpdateSharedSkillRequest['expectedAudience']> {
  if (detail.shareScope === 'private')
    return detail.publicShare ? 'public_link' : 'private';
  return detail.shareScope;
}

/**
 * What an "Only me" update of an already-linked skill asks the cloud
 * (CAN-7037): that the skill still reaches whoever it reached when the dialog
 * loaded it. The cloud checks that under the row lock before writing, so a
 * public link published elsewhere since then refuses the update and nothing
 * changes. Loaded private, that is "private"; loaded with the public link the
 * dialog is revoking, or with the team or organization it is moving away from,
 * that audience. Without a loaded skill it asks for "private", which fails
 * closed for anything wider. The other audiences ask nothing, as before.
 */
export function skillShareUpdateAudience(
  scope: ShareAudience,
  loaded: Pick<SharedSkillDetail, 'shareScope' | 'publicShare'> | null,
): Pick<UpdateSharedSkillRequest, 'expectedAudience'> {
  if (scope !== 'private') return {};
  return { expectedAudience: loaded ? skillAudience(loaded) : 'private' };
}

/**
 * Whether an update only takes a linked skill down to "Only me" with its
 * stored text unchanged (CAN-7226). Such an update keeps the package the
 * cloud already holds instead of committing one, so nothing uploads and a
 * skill shared before the secret check can still be taken down. A skill
 * already private narrows nothing, so it still commits and its supporting
 * files reach the cloud; without a loaded copy the update commits too.
 */
export function skillShareKeepsStoredPackage(input: {
  readonly scope: ShareAudience;
  readonly linked: boolean;
  readonly outgoingRawSkill: string;
  readonly stored: Pick<
    SharedSkillDetail,
    'rawSkill' | 'shareScope' | 'publicShare'
  > | null;
}): boolean {
  const { stored } = input;
  return (
    input.linked &&
    input.scope === 'private' &&
    stored !== null &&
    skillAudience(stored) !== 'private' &&
    input.outgoingRawSkill === stored.rawSkill
  );
}

// CAN-7037: the wording is for the security reviewer to confirm.
export const SKILL_SHARE_AUDIENCE_WIDER_MESSAGE =
  "This skill is already in your cloud account and shared by link, with a team or with an organization, so sharing it with only you can't use it. Stop sharing it in the cloud, or change this skill, then share it again.";

/** The message for a share the cloud refused for that reason, or null. */
export function skillShareCreateRefusal(error: unknown): string | null {
  return classifyShareFailure(error)?.serverCode === 'audience_changed'
    ? SKILL_SHARE_AUDIENCE_WIDER_MESSAGE
    : null;
}

import type { DeepLinkResolveShareResponse } from '@canopy/protocol/share-deep-link';
/**
 * Copy for installing a shared resource (CAN-3710), shared by the desktop
 * install review and the web `/share/*` landers so both say the same thing.
 *
 * It lives apart from the sharing barrel so first-screen web code can import
 * it through `@canopy/ui-app/sharing/share-install-copy` without loading the
 * sharing dialogs.
 */
import type { DesktopShareDeepLinkEntity } from '@canopy/protocol/share-deep-link';
import {
  WORKSPACE_TEMPLATE_SHARE_LABEL,
  WORKSPACE_TEMPLATE_SHARE_LABEL_LOWER,
} from '@canopy/protocol/workspace-templates';
import {
  SCHEDULED_WORKFLOW_ITEM_LABEL,
  WORKFLOW_ITEM_LABEL,
} from '@canopy/ui-shared/lib/workflow-labels';
import { MODEL_PRESET_LABEL } from '@canopy/ui-shared/lib/model-preset-labels';

/** Every shared resource that installs; a shared container is accepted, not installed. */
export type ShareInstallEntity = Exclude<
  DesktopShareDeepLinkEntity,
  'shared-container'
>;

/** Where the install's primary action stands. */
export type ShareInstallActionState =
  | 'install'
  | 'installing'
  | 'update'
  | 'updating'
  | 'open'
  // An installed skill over a chat: stages its invocation in that chat's
  // composer without sending (CAN-5219).
  | 'use-in-chat';

/**
 * The noun for each entity as it appears in sentence-case copy. A workspace
 * share is a Blueprint, which the reader receives as a project. Pipelines and
 * automations are both workflows; an automation is named by how it starts
 * (`scheduled workflow`) so the two kinds stay distinguishable.
 */
const ENTITY_NOUN: Readonly<Record<ShareInstallEntity, string>> = {
  skill: 'skill',
  plugin: 'plugin',
  pipeline: WORKFLOW_ITEM_LABEL.toLowerCase(),
  automation: SCHEDULED_WORKFLOW_ITEM_LABEL.toLowerCase(),
  agent: MODEL_PRESET_LABEL.toLowerCase(),
  collection: 'collection',
  workspace: 'project',
};

const DEFAULT_DESCRIPTION: Readonly<Record<ShareInstallEntity, string>> = {
  skill: 'A skill your agents can use when it fits the task.',
  plugin: 'A plugin that adds tools and skills to your agents.',
  pipeline: 'A workflow you can run on a project when you need it.',
  automation: 'A workflow that runs a task for you on a schedule.',
  agent: 'A model preset you can select in chat.',
  collection: 'A set of skills and plugins that install together.',
  workspace: 'A project template with its setup ready to use.',
};

/**
 * The primary action's label. `Install` is a plain verb with no noun on every
 * entity, Blueprints included; the installed state names the outcome
 * (`Open project`), as `docs/ux-writing.md` requires.
 */
export function shareInstallActionLabel(
  entity: ShareInstallEntity,
  state: ShareInstallActionState,
): string {
  switch (state) {
    case 'install':
      return 'Install';
    case 'installing':
      return 'Installing…';
    case 'update':
      return 'Update';
    case 'updating':
      return 'Updating…';
    case 'open':
      return `Open ${ENTITY_NOUN[entity]}`;
    case 'use-in-chat':
      return 'Use in this chat';
  }
}

/** The entity's noun in sentence-case copy (`project` for a Blueprint). */
export function shareInstallEntityNoun(entity: ShareInstallEntity): string {
  return ENTITY_NOUN[entity];
}

/**
 * The shared item's type, as the install review's subtitle shows it. A
 * workspace share arrives as a project template and installs as a project.
 */
export function shareInstallTypeLabel(entity: ShareInstallEntity): string {
  if (entity === 'workspace') return WORKSPACE_TEMPLATE_SHARE_LABEL;
  const noun = ENTITY_NOUN[entity];
  return `${noun.charAt(0).toUpperCase()}${noun.slice(1)}`;
}

/** The loading title before the item's own name is known (`Shared skill`). */
export function shareInstallPlaceholderTitle(
  entity: ShareInstallEntity,
): string {
  return `Shared ${
    entity === 'workspace'
      ? WORKSPACE_TEMPLATE_SHARE_LABEL_LOWER
      : ENTITY_NOUN[entity]
  }`;
}

/** One friendly line for a shared item published without a description. */
export function shareInstallDefaultDescription(
  entity: ShareInstallEntity,
): string {
  return DEFAULT_DESCRIPTION[entity];
}

/**
 * One segment of a share's attribution, in display order. Hosts render each
 * part themselves so a person's name can carry their replay protection.
 */
export type ShareAttributionPart =
  | { readonly kind: 'sharer'; readonly name: string }
  | { readonly kind: 'owner'; readonly name: string }
  | {
      readonly kind: 'audience';
      readonly label: string;
      readonly name?: string;
    };

/** The separator between attribution parts (`Shared by Ada · Platform`). */
export const SHARE_ATTRIBUTION_SEPARATOR = ' · ';

/** The copy before the sharer's name; hosts render the name separately. */
export const SHARE_ATTRIBUTION_SHARER_PREFIX = 'Shared by ';

/**
 * Who shared it, who owns it, and who can see it, dropping any part that is
 * missing or blank.
 */
export function shareAttributionParts({
  sharerName,
  ownerName,
  audienceLabel,
  audienceName,
  preserveOwnerWhitespace = false,
}: {
  readonly sharerName?: string | null;
  readonly ownerName?: string | null;
  readonly audienceLabel?: string | null;
  readonly audienceName?: string | null;
  /** The existing web attribution preserves its owner text verbatim. */
  readonly preserveOwnerWhitespace?: boolean;
}): readonly ShareAttributionPart[] {
  const parts: ShareAttributionPart[] = [];
  const sharer = sharerName?.trim();
  if (sharer) parts.push({ kind: 'sharer', name: sharer });
  const owner = preserveOwnerWhitespace ? ownerName : ownerName?.trim();
  if (owner) parts.push({ kind: 'owner', name: owner });
  const audience = audienceLabel?.trim();
  const name = audienceName?.trim();
  if (audience) {
    parts.push({
      kind: 'audience',
      label: audience,
      ...(name ? { name } : {}),
    });
  }
  return parts;
}

/** One part's text (`Shared by Ada`, `Acme`, `Team: Platform`). */
function shareAttributionPartText(part: ShareAttributionPart): string {
  switch (part.kind) {
    case 'sharer':
      return `${SHARE_ATTRIBUTION_SHARER_PREFIX}${part.name}`;
    case 'owner':
      return part.name;
    case 'audience':
      return part.name ? `${part.label}: ${part.name}` : part.label;
  }
}

/** The parts joined as plain text, or `''` when there are none. */
export function shareAttributionText(
  parts: readonly ShareAttributionPart[],
): string {
  return parts.map(shareAttributionPartText).join(SHARE_ATTRIBUTION_SEPARATOR);
}

/**
 * Where an installed skill copy is available, as the install path decides it.
 * `organization` without a name is a scoped install whose owning
 * organization's name is unavailable; `unknown` is an install whose scope
 * itself cannot be established.
 */
export type SkillInstallScope =
  | { readonly kind: 'all-contexts' }
  | { readonly kind: 'organization'; readonly name: string | null }
  | { readonly kind: 'personal' }
  | { readonly kind: 'unknown' };

const SKILL_INSTALL_UPDATE_NOTE =
  "Later edits to the shared skill won't automatically update this copy.";

/** What installing a shared skill does, said before the reader installs it. */
export function shareInstallSkillEffect(scope: SkillInstallScope): string {
  return joinShareInstallCopyParts(shareInstallSkillEffectParts(scope));
}

/**
 * One segment of install-review copy. A `name` part is identifying text the
 * host renders with its replay protection.
 */
export interface ShareInstallCopyPart {
  readonly kind: 'copy' | 'name';
  readonly text: string;
}

function joinShareInstallCopyParts(
  parts: readonly ShareInstallCopyPart[],
): string {
  return parts.map((part) => part.text).join('');
}

/** Keep context names separate so hosts can protect identifying text in replay. */
export function shareInstallSkillEffectParts(
  scope: SkillInstallScope,
): readonly ShareInstallCopyPart[] {
  switch (scope.kind) {
    case 'all-contexts':
      return [
        {
          kind: 'copy',
          text: `Adds a copy to this device, available in every context. ${SKILL_INSTALL_UPDATE_NOTE}`,
        },
      ];
    case 'personal':
      return [
        {
          kind: 'copy',
          text: `Adds a copy to this device for your Personal context. ${SKILL_INSTALL_UPDATE_NOTE}`,
        },
      ];
    case 'organization': {
      const name = scope.name?.trim();
      return name
        ? [
            { kind: 'copy', text: 'Adds a copy to this device for the ' },
            { kind: 'name', text: name },
            { kind: 'copy', text: ` context. ${SKILL_INSTALL_UPDATE_NOTE}` },
          ]
        : [
            {
              kind: 'copy',
              text: `Adds a copy to this device for the owning organization's context. ${SKILL_INSTALL_UPDATE_NOTE}`,
            },
          ];
    }
    case 'unknown':
      return [
        {
          kind: 'copy',
          text: `Adds a copy to this device. ${SKILL_INSTALL_UPDATE_NOTE}`,
        },
      ];
  }
}

// CAN-5219: an installed plugin offered over the chat the reader came from.
// "Turn on" because the chat's plugin picker controls activation, not
// addition; the chat title is quoted because it is user-authored, and it is a
// separate `name` part so hosts can mask it in replay.

/**
 * Longest chat title quoted in a label, in code points. Sized so the label
 * fits the install review's action row beside its ⋯ menu.
 */
export const SHARE_INSTALL_CHAT_TITLE_MAX_LENGTH = 30;

/** The trimmed title, cut to the limit with an ellipsis. Counts code points. */
export function truncateShareInstallChatTitle(title: string): string {
  const points = Array.from(title.trim());
  if (points.length <= SHARE_INSTALL_CHAT_TITLE_MAX_LENGTH) {
    return points.join('');
  }
  const cut = points.slice(0, SHARE_INSTALL_CHAT_TITLE_MAX_LENGTH - 1).join('');
  return `${cut.trimEnd()}…`;
}

/** Label for turning an installed plugin on in a chat; `''` means untitled. */
export function shareInstallTurnOnInChatLabelParts(
  chatTitle: string,
): readonly ShareInstallCopyPart[] {
  const name = truncateShareInstallChatTitle(chatTitle);
  return name
    ? [
        { kind: 'copy', text: 'Turn on in “' },
        { kind: 'name', text: name },
        { kind: 'copy', text: '”' },
      ]
    : [{ kind: 'copy', text: 'Turn on in this chat' }];
}

/** {@link shareInstallTurnOnInChatLabelParts} joined as plain text. */
export function shareInstallTurnOnInChatLabel(chatTitle: string): string {
  return joinShareInstallCopyParts(
    shareInstallTurnOnInChatLabelParts(chatTitle),
  );
}

export const SHARE_INSTALL_TURNING_ON_LABEL = 'Turning on…';

/** Why turning a plugin on in the originating chat did not happen. */
export type ShareInstallTurnOnInChatFailure = 'stale' | 'busy' | 'failed';

export function shareInstallTurnOnInChatFailureCopy(
  reason: ShareInstallTurnOnInChatFailure,
): string {
  switch (reason) {
    case 'stale':
      return "That chat is no longer open. Turn the plugin on from the chat's plugins.";
    case 'busy':
      // Matches the desktop chat plugin editor's busy sentence.
      return 'Wait for this chat to finish before changing plugins.';
    case 'failed':
      return "Couldn't turn the plugin on in that chat. Turn it on from the chat's plugins.";
  }
}

/**
 * A marketplace that ships with the app rather than one the reader adds
 * (`builtin:app`, `codex-builtin:<id>`).
 */
function isBuiltInMarketplaceOrigin(origin: string): boolean {
  return origin === 'builtin:app' || origin.startsWith('codex-builtin:');
}

const PLUGIN_INSTALL_CONTEXT_NOTE = 'Available in every context.';

/**
 * The marketplace as the plugin's copy names it. Any non-built-in origin is
 * shown verbatim, matching the Source row on the shared plugin's detail.
 * Callers pass a non-empty origin.
 */
function pluginMarketplaceParts(
  marketplaceOrigin: string,
): readonly ShareInstallCopyPart[] {
  return isBuiltInMarketplaceOrigin(marketplaceOrigin)
    ? [{ kind: 'copy', text: 'the built-in marketplace' }]
    : [{ kind: 'name', text: marketplaceOrigin }];
}

/**
 * What installing a shared plugin does, said before the reader installs it
 * (CAN-5017). Marketplaces and plugin installs are device-wide.
 */
export function shareInstallPluginEffectParts(
  marketplaceOrigin: string,
): readonly ShareInstallCopyPart[] {
  if (isBuiltInMarketplaceOrigin(marketplaceOrigin)) {
    return [
      {
        kind: 'copy',
        text: `Installs this plugin from the built-in marketplace. ${PLUGIN_INSTALL_CONTEXT_NOTE}`,
      },
    ];
  }
  return [
    { kind: 'copy', text: 'Adds the ' },
    { kind: 'name', text: marketplaceOrigin },
    {
      kind: 'copy',
      text: ` marketplace to this device if it isn't there yet, then installs this plugin from it. ${PLUGIN_INSTALL_CONTEXT_NOTE}`,
    },
  ];
}

/** {@link shareInstallPluginEffectParts} as plain text. */
export function shareInstallPluginEffect(marketplaceOrigin: string): string {
  return joinShareInstallCopyParts(
    shareInstallPluginEffectParts(marketplaceOrigin),
  );
}

/** The review's status after Install installed the shared plugin. */
export function shareInstallPluginInstalledStatusParts(
  marketplaceOrigin: string,
): readonly ShareInstallCopyPart[] {
  return [
    { kind: 'copy', text: 'Installed from ' },
    ...pluginMarketplaceParts(marketplaceOrigin),
    { kind: 'copy', text: '.' },
  ];
}

/** {@link shareInstallPluginInstalledStatusParts} as plain text. */
export function shareInstallPluginInstalledStatus(
  marketplaceOrigin: string,
): string {
  return joinShareInstallCopyParts(
    shareInstallPluginInstalledStatusParts(marketplaceOrigin),
  );
}

/**
 * The review's status when the shared plugin was already installed: found
 * when the review opened, or found by Install with nothing left to install.
 */
export function shareInstallPluginAlreadyAvailableStatusParts(
  marketplaceOrigin: string,
  { installAttempted }: { readonly installAttempted: boolean },
): readonly ShareInstallCopyPart[] {
  return [
    { kind: 'copy', text: 'Already available from ' },
    ...pluginMarketplaceParts(marketplaceOrigin),
    {
      kind: 'copy',
      text: installAttempted ? '. Nothing new was installed.' : '.',
    },
  ];
}

/** {@link shareInstallPluginAlreadyAvailableStatusParts} as plain text. */
export function shareInstallPluginAlreadyAvailableStatus(
  marketplaceOrigin: string,
  options: { readonly installAttempted: boolean },
): string {
  return joinShareInstallCopyParts(
    shareInstallPluginAlreadyAvailableStatusParts(marketplaceOrigin, options),
  );
}

/**
 * Why a shared item could not be opened (CAN-5222). It derives from the portable
 * resolve response contract shared with the desktop host. A failed read never proves why: an unauthorized read may answer a
 * uniform 404, and a 403 covers more than organization membership.
 */
export type ShareLandingFailureReason = Extract<
  DeepLinkResolveShareResponse,
  { ok: false }
>['reason'];

/** The product names a landing failure may mention, from the host's brand. */
export interface ShareLandingBrandNames {
  /** The app's name, e.g. `Canopy`. */
  readonly appName: string;
  /** The hosted service's name, as the host shows it. */
  readonly serverName: string;
}

/**
 * The failure as one line for the reader. It never claims the share was
 * revoked or names an organization: neither follows from a failed read.
 */
export function shareLandingErrorCopy(
  reason: ShareLandingFailureReason,
  entity: ShareInstallEntity,
  brand: ShareLandingBrandNames,
): string {
  const noun = ENTITY_NOUN[entity];
  switch (reason) {
    case 'not-found':
      return "This share isn't available. It may no longer exist, or you may not have access.";
    case 'sign-in-required':
      return `Sign in to open this ${noun}.`;
    case 'not-a-member':
      return `This account doesn't have access to this ${noun}. Try signing in with another account.`;
    case 'client-upgrade-required':
      // Never offer a YAML-only fallback here: the share is packaged, and
      // installing the definition alone would be an incomplete install
      // presented as a success.
      return `This shared workflow includes dependencies that this version of ${brand.appName} cannot install. Update to the latest version to continue.`;
    case 'share-changed':
      return 'This share changed. Return to the share page to review the updated version.';
    case 'cloud-unreachable':
      return `Couldn't reach ${brand.serverName}. Check your connection and try again.`;
  }
}

/**
 * The one action that may recover a landing failure. The host wires each to
 * its own sign-in, account, retry and update surfaces.
 */
export type ShareLandingRecoveryAction =
  | 'sign-in'
  | 'switch-account'
  | 'retry'
  | 'check-for-updates';

/**
 * The failure's recovery action, or `null` when nothing the reader can do
 * here would help: an unavailable share, or one that changed after review.
 */
export function shareLandingRecoveryAction(
  reason: ShareLandingFailureReason,
): ShareLandingRecoveryAction | null {
  switch (reason) {
    case 'sign-in-required':
      return 'sign-in';
    case 'not-a-member':
      return 'switch-account';
    case 'cloud-unreachable':
      return 'retry';
    case 'client-upgrade-required':
      return 'check-for-updates';
    case 'not-found':
    case 'share-changed':
      return null;
  }
}

/** The recovery action's button label. */
export function shareLandingRecoveryActionLabel(
  action: ShareLandingRecoveryAction,
): string {
  switch (action) {
    case 'sign-in':
      return 'Sign in';
    case 'switch-account':
      return 'Switch account';
    case 'retry':
      return 'Try again';
    case 'check-for-updates':
      return 'Check for updates';
  }
}

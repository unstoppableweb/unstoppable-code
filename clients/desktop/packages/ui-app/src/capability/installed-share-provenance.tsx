'use client';

import type { JSX, MouseEvent, ReactNode } from 'react';
import type {
  SharedSkillInstallOrigin,
  SharedSkillSummary,
} from '@canopy/protocol';
import {
  Badge,
  Button,
  ExecutionActionButton,
  TextLink,
} from '@canopy/ui-shared/components';
import { RefreshIcon } from '@canopy/ui-shared/icons/AppIcons';
import { INSTALLED_SHARE_UPDATE_AVAILABLE_LABEL } from '@canopy/ui-shared/lib';
import { REPLAY_BLOCK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import { SHARE_ATTRIBUTION_SHARER_PREFIX } from '../sharing/share-install-copy';
import { normalizeShareContentHash } from './share-content-hash';

/** An installed shared skill never follows its source (CAN-5018). */
export const INSTALLED_SHARE_COPY_LABEL = 'One-time copy';
export { INSTALLED_SHARE_UPDATE_AVAILABLE_LABEL };
export const VIEW_SHARED_SKILL_LABEL = 'View shared skill';
/** Opens the reviewed in-place replacement of a shared copy (CAN-5306). */
const INSTALLED_SHARE_UPDATE_LABEL = 'Update';

/**
 * Where the installed page's `View shared skill` goes: a host route the
 * browser can follow, or a host navigation action. `onNavigate` lets a
 * client router take an ordinary click while the anchor keeps its href.
 */
export type InstalledShareSource =
  | {
      readonly kind: 'link';
      readonly href: string;
      readonly onNavigate?: () => void;
    }
  | { readonly kind: 'action'; readonly onSelect: () => void };

/** Display names for an installed share. Never grants access. */
export interface InstalledShareDisplayNames {
  /** Organization name, including the organization owning a team share. */
  readonly ownerName?: string;
  readonly teamName?: string;
  readonly sharedByName?: string;
}

export interface InstalledShareProvenanceOptions {
  /**
   * Current names from a successful authenticated read. They replace the
   * receipt's names entirely, so a removed team or sharer stays removed.
   */
  readonly names?: InstalledShareDisplayNames;
  /** Only when a live read established that the source's hash changed. */
  readonly updateAvailable?: boolean;
  /**
   * Opens the host's reviewed replacement (CAN-5306). Only with
   * `updateAvailable` and a review the host can open for this copy's scope;
   * opening it never writes.
   */
  readonly onUpdate?: () => void;
  readonly source?: InstalledShareSource;
}

export interface InstalledShareProvenance {
  /** From, Team, Shared by and One-time copy, in order. */
  readonly facts: readonly ReactNode[];
  /** Whether the status fact carries the `Update available` badge. */
  readonly updateAvailable: boolean;
  /** Placed after the header's status and date. */
  readonly sourceLink: ReactNode | null;
}

/**
 * Whether the source's SKILL.md hash differs from the one recorded at
 * install. Both are SHA-256 hex of the raw source, so case is not
 * significant. A missing or malformed hash is no evidence either way.
 */
export function shareSourceHashChanged(
  installedHash: string | undefined,
  sourceHash: string | undefined,
): boolean {
  const installed = normalizeShareContentHash(installedHash);
  const source = normalizeShareContentHash(sourceHash);
  if (!installed || !source) return false;
  return installed !== source;
}

/**
 * Whether a receipted shared copy has an update: the source's hash differs
 * from the receipt's. The installed detail badge and the Customize row both
 * use this rule (CAN-5309); scope gates only the Update action, never this.
 */
export function installedShareUpdateAvailable(
  origin: Pick<SharedSkillInstallOrigin, 'contentHash'>,
  sourceContentHash: string | undefined,
): boolean {
  return shareSourceHashChanged(origin.contentHash, sourceContentHash);
}

function present(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * A shared skill's display names as the install receipt records them: the
 * owning organization (a team's organization for a team share), the team,
 * and the sharer. A personal owner is never named as an organization.
 */
export function sharedSkillDisplayNames(
  detail: Pick<SharedSkillSummary, 'owner' | 'createdBy'>,
): InstalledShareDisplayNames {
  const { owner } = detail;
  const ownerName = present(
    owner.type === 'team'
      ? owner.organization.name
      : owner.type === 'organization'
        ? owner.name
        : undefined,
  );
  const teamName = present(owner.type === 'team' ? owner.name : undefined);
  const sharedByName = present(detail.createdBy?.name);
  return {
    ...(ownerName ? { ownerName } : {}),
    ...(teamName ? { teamName } : {}),
    ...(sharedByName ? { sharedByName } : {}),
  };
}

function SourceLink({ source }: { source: InstalledShareSource }): JSX.Element {
  if (source.kind === 'action') {
    return (
      <Button
        variant="link"
        data-testid="installed-share-source-link"
        onClick={source.onSelect}
      >
        {VIEW_SHARED_SKILL_LABEL}
      </Button>
    );
  }
  const { onNavigate } = source;
  return (
    <TextLink
      href={source.href}
      data-testid="installed-share-source-link"
      onClick={
        onNavigate
          ? (event: MouseEvent<HTMLAnchorElement>): void => {
              // Modified clicks keep the browser's new-tab behavior.
              if (
                event.defaultPrevented ||
                event.button !== 0 ||
                event.metaKey ||
                event.ctrlKey ||
                event.shiftKey ||
                event.altKey
              )
                return;
              event.preventDefault();
              onNavigate();
            }
          : undefined
      }
    >
      {VIEW_SHARED_SKILL_LABEL}
    </TextLink>
  );
}

/**
 * A shared copy's one status and date fact (CAN-5306):
 * `Update available · Installed {date}`, or either part alone. The badge is
 * informational; the header's Update button is the action. `null` when there
 * is neither.
 */
export function installedShareStatusFact(
  updateAvailable: boolean,
  installedDate: string | undefined,
): JSX.Element | null {
  if (!updateAvailable && !installedDate) return null;
  return (
    <span
      key="status"
      className="inline-flex items-center gap-1.5"
      data-testid="installed-share-status"
    >
      {updateAvailable ? (
        <Badge
          tone="info"
          icon={RefreshIcon}
          data-testid="installed-share-update-available"
        >
          {INSTALLED_SHARE_UPDATE_AVAILABLE_LABEL}
        </Badge>
      ) : null}
      {updateAvailable && installedDate ? (
        <span aria-hidden="true">·</span>
      ) : null}
      {installedDate ? `Installed ${installedDate}` : null}
    </span>
  );
}

/**
 * The installed page's primary action for a shared copy whose source changed
 * (CAN-5306): opens the host's reviewed replacement. The skill's name is in
 * the accessible name only, so the visible label stays one word.
 */
export function InstalledShareUpdateButton({
  name,
  onUpdate,
  disabled = false,
}: {
  name: string;
  onUpdate: () => void;
  /** Only for a host's own in-flight replacement; a review is not one. */
  disabled?: boolean;
}): JSX.Element {
  const subject = name.trim();
  return (
    <ExecutionActionButton
      label={INSTALLED_SHARE_UPDATE_LABEL}
      ariaLabel={
        subject
          ? `${INSTALLED_SHARE_UPDATE_LABEL} ${subject}`
          : INSTALLED_SHARE_UPDATE_LABEL
      }
      icon={<RefreshIcon aria-hidden="true" />}
      variant="primary"
      placement="detail"
      disabled={disabled}
      onClick={onUpdate}
      dataTestId="installed-share-update"
      stopKeyDownPropagation={false}
    />
  );
}

/**
 * Where a receipted shared install came from and how it relates to its
 * source (CAN-5018), on every host: `From {organization}`, `Team: {team}`,
 * `Shared by {person}` and `One-time copy`. Unknown names are left out.
 * Names are session-replay blocked. A live `Update available` joins the
 * header's date in `installedShareStatusFact`.
 */
export function installedShareProvenance(
  origin: SharedSkillInstallOrigin,
  options: InstalledShareProvenanceOptions = {},
): InstalledShareProvenance {
  const names = options.names ?? origin;
  const ownerName = present(names.ownerName);
  const teamName = present(names.teamName);
  const sharedByName = present(names.sharedByName);
  const name = (text: string): JSX.Element => (
    <span className={REPLAY_BLOCK_CLASS}>{text}</span>
  );
  const facts: ReactNode[] = [];
  if (ownerName)
    facts.push(
      <span key="owner" data-testid="installed-share-owner">
        From {name(ownerName)}
      </span>,
    );
  if (teamName)
    facts.push(
      <span key="team" data-testid="installed-share-team">
        Team: {name(teamName)}
      </span>,
    );
  if (sharedByName)
    facts.push(
      <span key="sharer" data-testid="installed-share-sharer">
        {SHARE_ATTRIBUTION_SHARER_PREFIX}
        {name(sharedByName)}
      </span>,
    );
  facts.push(
    <span key="copy" data-testid="installed-share-copy">
      {INSTALLED_SHARE_COPY_LABEL}
    </span>,
  );
  return {
    facts,
    updateAvailable: options.updateAvailable === true,
    sourceLink: options.source ? (
      <SourceLink key="source" source={options.source} />
    ) : null,
  };
}

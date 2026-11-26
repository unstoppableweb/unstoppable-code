import type { JSX } from 'react';
import type { LedgerActorKind } from '@canopy/protocol/canopy-core';
import {
  AgentAssistantIcon,
  ChatIcon,
  PersonIcon,
  PipelineIcon,
  SummaryIcon,
  type AppIcon,
} from '../../icons/AppIcons';
import { ICON_SIZE_PX } from '../../icons/icon-size';
import { SubagentIcon } from '../../icons/SubagentIcon';
import {
  DISPLAY_AVATAR_GLYPH_SIZE,
  DisplayAvatar,
  type DisplayAvatarSize,
} from '../../primitives/DisplayAvatar';

/** `large` beside a Feed row (32px); `small` in the panel and on replies. */
export type LedgerActorAvatarSize = 'large' | 'small';

/** The shared avatar step for each Ledger avatar size. */
export const LEDGER_DISPLAY_AVATAR_SIZE: Readonly<
  Record<LedgerActorAvatarSize, DisplayAvatarSize>
> = {
  large: 'lg',
  small: 'md',
};

/**
 * One glyph per kind of actor. A delegate has none here: it takes the one
 * subagent glyph (`SubagentIcon`), as its agent card and its chat do.
 */
const ACTOR_GLYPHS: Readonly<
  Record<Exclude<LedgerActorKind, 'managed_delegation'>, AppIcon>
> = {
  user: PersonIcon,
  chat: ChatIcon,
  pipeline_agent: PipelineIcon,
  background: SummaryIcon,
  ledger_sidecar: AgentAssistantIcon,
};

export interface LedgerActorGlyphProps {
  readonly kind: LedgerActorKind;
  /** Glyph size in pixels. */
  readonly size: number;
  readonly className?: string;
}

/**
 * The glyph of an actor's kind: a person, a chat, a pipeline agent, a
 * delegate, a Summary or the Ledger's own agent. By the kind of actor, never
 * its provider. Decorative: the actor's name always shows beside it.
 */
export function LedgerActorGlyph({
  kind,
  size,
  className,
}: LedgerActorGlyphProps): JSX.Element {
  if (kind === 'managed_delegation') {
    return <SubagentIcon size={size} className={className} />;
  }
  const Glyph = ACTOR_GLYPHS[kind];
  return <Glyph size={size} aria-hidden="true" className={className} />;
}

export interface LedgerActorAvatarProps {
  /** What kind of actor it is; a person (`user`) gets initials, You a glyph. */
  readonly kind: LedgerActorKind;
  /**
   * The name the avatar stands for. A person's initials and color come from
   * it, so on a teammate's row pass the teammate's name.
   */
  readonly name: string;
  readonly size: LedgerActorAvatarSize;
  /** True only for the semantic local user actor, never inferred from name. */
  readonly localUser?: boolean;
}

/**
 * Who wrote a reply or is writing an entry, at a glance: a person's initials
 * (the person glyph for You), or an agent's glyph, in the shared avatar. A
 * main entry's avatar is its type instead (`LedgerEntryTypeAvatar`), and its
 * author's glyph sits beside the author's name. Decorative: the name always
 * shows beside it.
 */
export function LedgerActorAvatar({
  kind,
  name,
  size,
  localUser = false,
}: LedgerActorAvatarProps): JSX.Element {
  const avatarSize = LEDGER_DISPLAY_AVATAR_SIZE[size];
  // A teammate shows initials (blocked from replay); You and every agent
  // show their kind's glyph, which replay records.
  const glyph =
    kind === 'user' && !localUser ? undefined : (
      <LedgerActorGlyph
        kind={kind}
        size={ICON_SIZE_PX[DISPLAY_AVATAR_GLYPH_SIZE[avatarSize]]}
      />
    );
  return (
    <DisplayAvatar
      name={name}
      size={avatarSize}
      glyph={glyph}
      testId="ledger-actor-avatar"
      data-actor-kind={kind}
    />
  );
}

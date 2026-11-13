import type { JSX } from 'react';
import {
  DISPLAY_AVATAR_GLYPH_SIZE,
  DISPLAY_AVATAR_SIZE_PX,
  DisplayAvatar,
  type DisplayAvatarSize,
} from '@canopy/ui-shared/components';
import { AgentIcon } from '@canopy/ui-shared/icons/AppIcons';
import {
  SpecimenCell,
  SpecimenGrid,
  SpecimenPanel,
} from './componentsLabParts';

// A stand-in profile photo (the lab has no network).
const PHOTO = `data:image/svg+xml;utf8,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#c9a27e"/><stop offset="1" stop-color="#6b4f3a"/></linearGradient></defs><rect width="64" height="64" fill="url(#g)"/><circle cx="32" cy="26" r="11" fill="#f1d7c1"/><path d="M12 64c2-14 10-20 20-20s18 6 20 20z" fill="#2f3e57"/></svg>',
)}`;

const SIZES: readonly DisplayAvatarSize[] = ['xs', 'sm', 'md', 'lg', 'xl'];

const USES: Readonly<Record<DisplayAvatarSize, string>> = {
  xs: 'menu rows, one initial',
  sm: 'bylines, comments',
  md: 'pickers, replies',
  lg: 'member rows, feeds',
  xl: 'organization tiles',
  '2xl': 'profile headers',
};

export function AvatarsSpecimen(): JSX.Element {
  return (
    <SpecimenPanel>
      <SpecimenGrid min={200}>
        {SIZES.map((size) => (
          <SpecimenCell
            key={size}
            label={`${size}, ${DISPLAY_AVATAR_SIZE_PX[size]}px: ${USES[size]}`}
          >
            <DisplayAvatar name="Ana Ruiz" image={PHOTO} size={size} />
            <DisplayAvatar name="Sam Lee" size={size} />
            <DisplayAvatar name="Platform team" subject="group" size={size} />
            <DisplayAvatar
              name="Claude"
              size={size}
              glyph={<AgentIcon size={DISPLAY_AVATAR_GLYPH_SIZE[size]} />}
            />
          </SpecimenCell>
        ))}
        <SpecimenCell
          label={`2xl, ${DISPLAY_AVATAR_SIZE_PX['2xl']}px: ${USES['2xl']}`}
        >
          <DisplayAvatar name="Ana Ruiz" image={PHOTO} size="2xl" />
          <DisplayAvatar name="Sam Lee" size="2xl" />
        </SpecimenCell>
        <SpecimenCell label="A photo that fails to load falls back to the initials">
          <DisplayAvatar name="Kai Mori" image="data:," size="lg" />
        </SpecimenCell>
      </SpecimenGrid>
    </SpecimenPanel>
  );
}

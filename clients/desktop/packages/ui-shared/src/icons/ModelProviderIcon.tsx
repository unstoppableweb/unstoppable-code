import type { JSX, SVGProps } from 'react';
import {
  AntigravityIcon,
  BuildingIcon,
  TerminalIcon,
  ClaudeIcon,
  CodexIcon,
  CursorIcon,
  DeepSeekIcon,
  GitHubIcon,
  GoogleIcon,
  MiniMaxIcon,
  MoonshotIcon,
  OllamaIcon,
  OpenRouterIcon,
  VercelIcon,
  ZaiIcon,
} from './AppIcons';
import { ClaudeLogo } from './ClaudeLogo';
import { CodexLogo } from './CodexLogo';
import { CursorLogo } from './CursorLogo';
import { LiteLLMLogo } from './LiteLLMLogo';
import { OllamaLogo } from './OllamaLogo';
import { RequestyLogo } from './RequestyLogo';
import { ICON_SIZE_PX, isIconSize, type IconSize } from './icon-size';
import { OPERATIONAL_STATUS_COLORS } from '../lib/operational-status-colors';

export interface ModelProviderIconProps extends SVGProps<SVGSVGElement> {
  provider: string;
  /** Use the compact glyphs instead of the full provider marks. */
  central?: boolean;
  /**
   * A step of the icon scale sizes every mark and glyph, by its pixels as
   * `width` and `height`. A number sizes the compact glyphs only; `width`
   * and `height` then affect the full provider marks.
   */
  size?: IconSize | number;
  /**
   * Renders compact glyphs at exactly `size`, skipping the Lucide 14px /
   * 20px tiers, so they match brand marks in a one-size surface.
   */
  exactSize?: boolean;
  /** Host state ink; full provider marks keep their own artwork. */
  tone?: 'inherit' | 'secondary' | 'unread';
}

/** Canonical provider-to-glyph dispatch shared by every model surface. */
export function ModelProviderIcon({
  provider,
  central = false,
  size,
  exactSize = false,
  tone = 'inherit',
  ...restProps
}: ModelProviderIconProps): JSX.Element | null {
  const toneClassName =
    tone === 'unread'
      ? OPERATIONAL_STATUS_COLORS.unread.foreground
      : tone === 'secondary'
        ? 'fg-secondary'
        : undefined;
  const themedProps = toneClassName
    ? {
        ...restProps,
        className: restProps.className
          ? `${restProps.className} ${toneClassName}`
          : toneClassName,
      }
    : restProps;
  const svgProps = isIconSize(size)
    ? { width: ICON_SIZE_PX[size], height: ICON_SIZE_PX[size], ...themedProps }
    : themedProps;
  const centralProps = {
    ...svgProps,
    ...(size === undefined ? {} : { size }),
    ...(exactSize ? { exactSize } : {}),
  };
  // An organization's own models group under `org-gateway:<id>`; a neutral
  // building stands for the organization rather than a guessed initial.
  if (provider.startsWith('org-gateway:')) {
    return <BuildingIcon size="xl" {...centralProps} />;
  }
  switch (provider) {
    case 'anthropic':
    case 'claude':
      return central ? (
        <ClaudeIcon size="md" {...centralProps} />
      ) : (
        <ClaudeLogo {...svgProps} />
      );
    case 'openai':
    case 'codex':
      return central ? (
        <CodexIcon size="md" {...centralProps} />
      ) : (
        <CodexLogo {...svgProps} />
      );
    case 'google':
      return <GoogleIcon size="md" {...centralProps} />;
    case 'antigravity':
      return <AntigravityIcon size="md" {...centralProps} />;
    case 'opencode':
      return <TerminalIcon {...centralProps} />;
    case 'copilot':
      return <GitHubIcon {...centralProps} />;
    case 'cursor':
      return central ? (
        <CursorIcon size="md" {...centralProps} />
      ) : (
        <CursorLogo {...svgProps} />
      );
    case 'ollama':
      return central ? (
        <OllamaIcon size="md" {...centralProps} />
      ) : (
        <OllamaLogo {...svgProps} />
      );
    case 'deepseek':
      return <DeepSeekIcon size="md" {...centralProps} />;
    case 'moonshot':
    case 'kimi':
      return <MoonshotIcon size="md" {...centralProps} />;
    case 'minimax':
      return <MiniMaxIcon size="md" {...centralProps} />;
    case 'zai':
    case 'z.ai':
      return <ZaiIcon size="md" {...centralProps} />;
    case 'openrouter':
      return <OpenRouterIcon size="md" {...centralProps} />;
    case 'vercel':
      return <VercelIcon size="md" {...centralProps} />;
    // Neither set has these marks, so they are repository logos from each
    // project's own MIT repository.
    case 'requesty':
      return <RequestyLogo {...svgProps} />;
    case 'litellm':
      return <LiteLLMLogo {...svgProps} />;
    default:
      return (
        <svg
          {...svgProps}
          viewBox="0 0 16 16"
          aria-hidden="true"
          data-generic-provider-icon="true"
        >
          <circle cx="8" cy="8" r="7" fill="currentColor" opacity="0.18" />
          <text
            x="8"
            y="11"
            textAnchor="middle"
            fill="currentColor"
            fontSize="8"
            fontWeight="700"
          >
            {provider.slice(0, 1).toUpperCase()}
          </text>
        </svg>
      );
  }
}

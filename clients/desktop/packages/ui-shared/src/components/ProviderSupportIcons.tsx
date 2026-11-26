import type { JSX } from 'react';
import { ClaudeLogo, CodexLogo } from '../icons';
import { Tooltip } from '../primitives/Tooltip';

export type ProviderSupportScope = 'claude' | 'codex' | 'mixed';

export interface UnifiedProviderSupport {
  claude: 'native' | 'none';
  codex: 'native' | 'compat' | 'none';
}

export interface ProviderSupportIconsProps {
  support: UnifiedProviderSupport;
  scope?: ProviderSupportScope;
  size?: number;
  className?: string;
  iconClassName?: string;
  codexCompatDisabled?: boolean;
}

interface RenderedIcon {
  key: 'claude' | 'codex-native' | 'codex-compat';
  tooltip: string;
  icon: JSX.Element;
}

export function ProviderSupportIcons({
  support,
  scope,
  size = 14,
  className,
  iconClassName,
  codexCompatDisabled,
}: ProviderSupportIconsProps): JSX.Element | null {
  const icons: RenderedIcon[] = [];
  const sharedClass = iconClassName ?? 'shrink-0 fg-secondary';
  if (support.claude === 'native') {
    icons.push({
      key: 'claude',
      tooltip:
        scope === 'codex' && support.codex === 'compat'
          ? 'Available for Codex through compatibility mode'
          : 'Claude native plugin',
      icon: (
        <ClaudeLogo
          className={sharedClass}
          width={size}
          height={size}
          aria-label="Claude"
          role="img"
        />
      ),
    });
  }
  if (support.codex === 'native') {
    icons.push({
      key: 'codex-native',
      tooltip:
        scope === 'claude' && support.claude === 'none'
          ? 'Only available for Codex'
          : 'Codex native plugin',
      icon: (
        <CodexLogo
          className={sharedClass}
          width={size}
          height={size}
          aria-label="Codex"
          role="img"
        />
      ),
    });
  } else if (support.codex === 'compat') {
    const disabled = codexCompatDisabled === true;
    icons.push({
      key: 'codex-compat',
      tooltip: disabled
        ? 'Codex compatibility mode is disabled'
        : 'Generated from Claude plugin for Codex compatibility.',
      icon: (
        <CodexLogo
          className={
            iconClassName !== undefined
              ? `${iconClassName}${disabled ? ' opacity-40' : ''}`
              : disabled
                ? 'shrink-0 fg-secondary/40'
                : 'shrink-0 fg-warning'
          }
          width={size}
          height={size}
          aria-label={
            disabled ? 'Codex compatibility disabled' : 'Codex compatibility'
          }
          role="img"
        />
      ),
    });
  }
  if (icons.length === 0) return null;
  return (
    <span
      className={`inline-flex items-center gap-1 ${className ?? ''}`}
      data-testid="provider-support-icons"
    >
      {icons.map((entry) => (
        <Tooltip key={entry.key} label={entry.tooltip}>
          <span
            data-testid={`provider-support-icon-${entry.key}`}
            data-tooltip={entry.tooltip}
          >
            {entry.icon}
          </span>
        </Tooltip>
      ))}
    </span>
  );
}

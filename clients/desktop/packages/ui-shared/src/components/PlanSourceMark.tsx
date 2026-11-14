import type { JSX, ReactNode } from 'react';
import { CheckIcon as AppCatalogCheckIcon } from '../icons/AppIcons';

export type PlanSource =
  | 'cursor'
  | 'copilot'
  | 'antigravity'
  | 'opencode'
  | 'claude'
  | 'codex'
  | 'ollama'
  | 'pipeline'
  | 'imported'
  | 'detected';

export interface PlanSourceMarkProps {
  /** Source identifier. Currently informational — the rendered visual comes
   * from {@link PlanSourceMarkProps.icon}. Kept on the interface so callers
   * can drive analytics or future variant behavior off the same value. */
  source: PlanSource;
  /** Icon glyph for this source. Caller supplies a provider/pipeline glyph
   * so the shared component does not own runtime-specific SVG assets. When
   * omitted, a generic checkmark badge is rendered (used by the portal in
   * environments where the provider logos are not available). */
  icon?: ReactNode;
  /** Icon size in pixels. Defaults to 14. */
  size?: number;
  /** Optional tailwind classes applied to the outer span. */
  className?: string;
}

/**
 * Marker glyph rendered next to the plan title. Pure display: caller
 * provides the source-specific icon. The shared default is a generic
 * checkmark badge.
 */
export function PlanSourceMark({
  source,
  icon,
  size = 14,
  className,
}: PlanSourceMarkProps): JSX.Element {
  if (icon) {
    return (
      <span
        aria-hidden="true"
        data-plan-source={source}
        className={`shrink-0 ${className ?? ''}`}
      >
        {icon}
      </span>
    );
  }
  return (
    <span
      aria-hidden="true"
      data-plan-source={source}
      className={`inline-flex shrink-0 items-center justify-center rounded-sm border border-sky-500/40 bg-sky-500/10 ${className ?? ''}`}
      style={{ width: size, height: size }}
    >
      <AppCatalogCheckIcon size="sm" className="text-sky-400" />
    </span>
  );
}

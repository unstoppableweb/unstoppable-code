import type { JSX } from 'react';
import {
  Button,
  ModelProviderIcon,
  Tooltip,
} from '@canopy/ui-shared/components';
import {
  AI_GATEWAY_PRESETS,
  type AiGatewayPresetId,
} from '@canopy/protocol/model-gateway/presets';

/** Every preset fits inline up to this many; beyond it the rest fold away. */
const MAX_INLINE_PRESETS = 6;
const SHOWN_WHEN_FOLDED = 5;

export interface GatewayPresetMarksProps {
  /** Open setup at this preset's key step. */
  readonly onPick: (presetId: AiGatewayPresetId) => void;
  /** Open the full chooser; reached only when presets fold away. */
  readonly onMore: () => void;
}

/**
 * The well-known gateways as muted marks beside an AI gateway link, so the
 * term reads by example. Each mark is its own control: its name shows in a
 * tooltip on hover and keyboard focus, and picking it skips the chooser.
 */
export function GatewayPresetMarks({
  onPick,
  onMore,
}: GatewayPresetMarksProps): JSX.Element {
  const folded = AI_GATEWAY_PRESETS.length > MAX_INLINE_PRESETS;
  const shown = folded
    ? AI_GATEWAY_PRESETS.slice(0, SHOWN_WHEN_FOLDED)
    : AI_GATEWAY_PRESETS;
  const hidden = AI_GATEWAY_PRESETS.length - shown.length;
  return (
    <div
      className="flex items-center gap-1"
      data-testid="ai-gateway-preset-marks"
    >
      {shown.map((preset) => (
        <Tooltip key={preset.id} label={preset.name}>
          <Button
            variant="ghost-quiet"
            size="compact"
            iconOnly
            aria-label={preset.name}
            data-testid={`ai-gateway-preset-mark-${preset.id}`}
            className="group/mark"
            onClick={() => onPick(preset.id)}
          >
            {/* Muted at rest, so brand-colored logos read as one quiet row;
                full color on hover and keyboard focus. */}
            <ModelProviderIcon
              provider={preset.id}
              size="sm"
              aria-hidden="true"
              className="grayscale group-hover/mark:grayscale-0 group-focus-visible/mark:grayscale-0"
            />
          </Button>
        </Tooltip>
      ))}
      {hidden > 0 ? (
        <Tooltip label="More gateways">
          <Button
            variant="ghost-quiet"
            size="compact"
            iconOnly
            aria-label="More gateways"
            data-testid="ai-gateway-preset-marks-more"
            onClick={onMore}
          >
            <span className="text-xs">{`+${String(hidden)}`}</span>
          </Button>
        </Tooltip>
      ) : null}
    </div>
  );
}

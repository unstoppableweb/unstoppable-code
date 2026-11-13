'use client';

import type { JSX } from 'react';
import { Button, ModelProviderIcon } from '@canopy/ui-shared/components';
import { Network } from '@canopy/ui-shared/icons/AppIcons';
import {
  AI_GATEWAY_PRESETS,
  type AiGatewayPreset,
} from '@canopy/protocol/model-gateway/presets';

export interface AiGatewayPresetPickerProps {
  readonly layout: 'page' | 'dialog';
  /** One click opens that provider's key step. */
  readonly onChoose: (preset: AiGatewayPreset) => void;
  readonly onCustom: () => void;
}

/** The gateway's own brand mark, beside its name. */
export function AiGatewayPresetMark({
  preset,
}: {
  readonly preset: AiGatewayPreset;
}): JSX.Element | null {
  return (
    <ModelProviderIcon
      provider={preset.id}
      size="xl"
      aria-hidden="true"
      className="shrink-0"
    />
  );
}

/**
 * A tile per well-known gateway, then the custom URL form as the quieter
 * way in for any other gateway.
 */
export function AiGatewayPresetPicker({
  layout,
  onChoose,
  onCustom,
}: AiGatewayPresetPickerProps): JSX.Element {
  return (
    <div className="flex flex-col gap-2" data-testid="ai-gateway-preset-picker">
      <ul
        role="list"
        className={
          layout === 'dialog'
            ? 'grid grid-cols-2 gap-2'
            : // Four across truncates names in the settings column.
              'grid gap-2 sm:grid-cols-2'
        }
      >
        {AI_GATEWAY_PRESETS.map((preset) => (
          <li key={preset.id} role="listitem" className="flex">
            <Button
              type="button"
              variant="outline"
              size="lg"
              leadingIcon
              className="w-full"
              data-testid={`ai-gateway-preset-${preset.id}`}
              onClick={() => onChoose(preset)}
            >
              <span className="flex min-w-0 flex-1 items-center gap-2">
                <AiGatewayPresetMark preset={preset} />
                <span className="min-w-0 truncate">{preset.name}</span>
              </span>
            </Button>
          </li>
        ))}
      </ul>
      <div>
        <Button
          type="button"
          variant="ghost"
          size="compact"
          leadingIcon
          data-testid="ai-gateway-custom-url"
          onClick={onCustom}
        >
          <Network size="sm" aria-hidden />
          Use a custom gateway URL
        </Button>
      </div>
    </div>
  );
}

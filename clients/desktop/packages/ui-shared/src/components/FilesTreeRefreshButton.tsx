import type { JSX } from 'react';
import { RefreshIcon as CentralRefreshIcon } from '../icons/AppIcons';
import { Button } from '../primitives/Button';
import { useIconStyle } from './icon-style';
import { RefreshSpinner } from './RefreshSpinner';
import { Tooltip } from '../primitives/Tooltip';

/**
 * Glyph density the Files tab draws the control at. `compact` matches the
 * desktop Files header's 12px glyphs; `comfortable` matches the Portal and
 * cloud Files toolbar's 16px glyphs. Both sit in the same 28px icon button
 * as the toolbar's other icon actions.
 */
export type FilesTreeRefreshButtonDensity = 'compact' | 'comfortable';

export interface FilesTreeRefreshButtonProps {
  readonly onClick: () => void;
  /** Disables the button. */
  readonly disabled?: boolean;
  /** Spins the glyph while a refresh is in flight. */
  readonly spinning?: boolean;
  readonly density?: FilesTreeRefreshButtonDensity;
  /**
   * Wraps the button in the shared hover tooltip. Defaults to true.
   * The desktop Files header has never shown one for this control.
   */
  readonly showTooltip?: boolean;
}

const LABEL = 'Refresh files';

const CENTRAL_ICON_CLASS_NAMES: Record<FilesTreeRefreshButtonDensity, string> =
  {
    compact: 'h-3 w-3',
    comfortable: 'h-4 w-4',
  };

/**
 * The Files tab's refresh control, shared by the desktop Files tree and the
 * Portal and cloud Files tab. The glyph follows the host's icon style:
 * `central` draws the app refresh arrow, `classic` the original spinner.
 */
export function FilesTreeRefreshButton({
  onClick,
  disabled = false,
  spinning = false,
  density = 'comfortable',
  showTooltip = true,
}: FilesTreeRefreshButtonProps): JSX.Element {
  const central = useIconStyle() === 'central';
  const button = (
    <Button
      variant="ghost"
      size="compact"
      iconOnly
      aria-label={LABEL}
      data-testid="files-tree-refresh"
      disabled={disabled}
      onClick={onClick}
    >
      {central ? (
        <CentralRefreshIcon
          className={`${CENTRAL_ICON_CLASS_NAMES[density]} ${spinning ? 'animate-spin' : ''}`}
        />
      ) : (
        <RefreshSpinner spinning={spinning} size="sm" />
      )}
    </Button>
  );
  return showTooltip ? <Tooltip label={LABEL}>{button}</Tooltip> : button;
}

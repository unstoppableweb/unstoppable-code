import type { JSX } from 'react';
import { DownloadIcon } from '../icons/AppIcons';
import { CompositeListRow } from '../primitives/ListRow';
import { Stack } from '../primitives/Stack';
import { Surface } from '../primitives/Surface';

export interface AttachmentDropZoneProps {
  readonly active?: boolean;
  /** Replaces the default copy, which tells the user to drop or pick files. */
  readonly emptyMessage?: string;
  /** Makes the empty zone a button that opens the file picker. */
  readonly onAdd?: () => void;
  readonly testId: string;
}

function AttachmentDropZoneContent({
  active = false,
  emptyMessage,
  iconSize = 'xl',
}: Omit<AttachmentDropZoneProps, 'testId' | 'onAdd'> & {
  readonly iconSize?: 'xl' | number;
}): JSX.Element {
  return active ? (
    <Stack gap="inline" align="center">
      <DownloadIcon size={iconSize} />
      <p className="text-xs font-medium">Drop files to attach</p>
    </Stack>
  ) : (
    <p className="text-xs fg-secondary/60">
      {emptyMessage ?? (
        <>
          <span className="pointer-coarse:hidden">
            Drop files here or click to add them
          </span>
          <span className="pointer-fine:hidden">Tap to add files</span>
        </>
      )}
    </p>
  );
}

/** Attachment presentation shared by local and hosted upload adapters. */
export function AttachmentDropZone({
  active = false,
  emptyMessage,
  onAdd,
  testId,
}: AttachmentDropZoneProps): JSX.Element {
  const pressable = onAdd !== undefined && !active;
  return (
    <div className="flex h-full min-h-28">
      <Surface
        as={pressable ? CompositeListRow : 'div'}
        variant="dashed"
        size="small"
        selected={active}
        interactive={pressable}
        focusRing={pressable}
        onClick={pressable ? onAdd : undefined}
        className="flex flex-1 items-center justify-center text-center"
        data-testid={testId}
      >
        <div className={active ? 'py-8 fg-accent' : 'py-8'}>
          <AttachmentDropZoneContent
            active={active}
            emptyMessage={emptyMessage}
          />
        </div>
      </Surface>
    </div>
  );
}

/** Non-interactive feedback drawn over the destination during a file drag. */
export function AttachmentDropOverlay({
  testId,
}: Pick<AttachmentDropZoneProps, 'testId'>): JSX.Element {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center border-2 border-dashed border-line-accent bg-base/85 text-center fg-accent"
      style={{ borderRadius: 'inherit' }}
      data-testid={testId}
    >
      <AttachmentDropZoneContent active iconSize={24} />
    </div>
  );
}

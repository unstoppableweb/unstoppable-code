import {
  forwardRef,
  type CSSProperties,
  type JSX,
  type ReactNode,
} from 'react';
import { Badge, ListRow, ListRowStatic } from '@canopy/ui-shared/components';
import { REPLAY_BLOCK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';

export type PipelineStepKind = 'action' | 'script' | 'incomplete';

const KIND_LABEL: Readonly<Record<PipelineStepKind, string>> = {
  action: 'Action',
  script: 'Script',
  incomplete: 'Incomplete',
};

export interface PipelineStepRowProps {
  readonly name: string;
  readonly kind: PipelineStepKind;
  /** The action ref, or a script's first line. */
  readonly summary: string;
  /** Makes the row selectable; without it the row is plain text. */
  readonly onSelect?: () => void;
  readonly selected?: boolean;
  /** Controls at the row's end, such as a drag handle and a delete button. */
  readonly actions?: ReactNode;
  readonly style?: CSSProperties;
  readonly 'data-testid'?: string;
}

/**
 * One step in a pipeline job, in the editor and the read-only view. The outer
 * `div` takes the ref and style a sortable list needs.
 */
export const PipelineStepRow = forwardRef<HTMLDivElement, PipelineStepRowProps>(
  function PipelineStepRow(
    {
      name,
      kind,
      summary,
      onSelect,
      selected = false,
      actions,
      style,
      'data-testid': testId,
    },
    ref,
  ): JSX.Element {
    const label = (
      <span className="flex min-w-0 items-center gap-2">
        <span className="truncate" title={name}>
          {name}
        </span>
        <Badge tone={kind === 'incomplete' ? 'warning' : 'neutral'}>
          {KIND_LABEL[kind]}
        </Badge>
      </span>
    );
    // Never recorded: a script's first line, and an action ref, which can
    // name a private repository path or project action (CAN-4224).
    const description = <span className={REPLAY_BLOCK_CLASS}>{summary}</span>;
    return (
      <div ref={ref} style={style} data-testid={testId}>
        {onSelect ? (
          <ListRow
            selected={selected}
            aria-current={selected ? 'true' : undefined}
            onClick={onSelect}
            description={description}
            actions={actions}
            // The editor's controls stay in view, as they did before rows.
            actionsReveal={false}
            // The job frame clips at its 2px padding, so the ring goes inside.
            focusInset
          >
            {label}
          </ListRow>
        ) : (
          <ListRowStatic description={description} actions={actions}>
            {label}
          </ListRowStatic>
        )}
      </div>
    );
  },
);

import { Fragment } from 'react';
import type { JSX } from 'react';
import { ForwardIcon } from '../icons/AppIcons';
import { Button } from '../primitives/Button';

export interface WorkPathPart {
  /** Stable React key. */
  readonly key: string;
  readonly label: string;
  /** Opens what the part names; without it the part is plain text. */
  readonly onOpen?: () => void;
}

export interface WorkPathProps {
  /** Largest first: project, task, then operation or chat. */
  readonly parts: readonly WorkPathPart[];
  readonly className?: string;
  readonly testId?: string;
}

/** Shows where something belongs, from its largest context to its most specific. */
export function WorkPath({
  parts,
  className,
  testId,
}: WorkPathProps): JSX.Element {
  return (
    <span
      data-testid={testId}
      // Clips sideways only: `truncate` would also cut the links' taller touch
      // area. Each part truncates itself.
      className={`inline-flex min-w-0 max-w-full items-center gap-1 overflow-x-clip whitespace-nowrap${
        className ? ` ${className}` : ''
      }`}
    >
      {parts.map((part, index) => (
        <Fragment key={part.key}>
          {index > 0 && (
            <ForwardIcon
              size={12}
              aria-hidden="true"
              className="shrink-0 fg-quaternary"
            />
          )}
          {part.onOpen === undefined ? (
            <span className="min-w-0 truncate" title={part.label}>
              {part.label}
            </span>
          ) : (
            <Button
              type="button"
              variant="link"
              onClick={(event): void => {
                event.stopPropagation();
                part.onOpen?.();
              }}
              // A link has no touch area of its own; grow it to 44px tall.
              className="relative min-w-0 before:absolute before:inset-x-0 before:content-[''] pointer-coarse:before:-inset-y-3.5"
            >
              {/* A block label clips to the shrunk button; an inline one
                  spills over the next part. */}
              <span className="block truncate" title={part.label}>
                {part.label}
              </span>
            </Button>
          )}
        </Fragment>
      ))}
    </span>
  );
}

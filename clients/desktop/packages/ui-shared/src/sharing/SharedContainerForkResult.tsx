import { useEffect, useRef, type JSX } from 'react';
import { Button } from '../components/Button';
import { Notice } from '../components/Notice';
import { REPLAY_MASK_CLASS } from '../lib/replay-privacy';

export interface SharedContainerForkResultProps {
  /** The copy's warnings, one sentence each, as the fork response carries them. */
  warnings: readonly string[];
  onOpenCopy: () => void;
  onDone: () => void;
  /** Holds both actions while the copy is being opened. */
  busy?: boolean;
}

/**
 * A finished copy that came with warnings (CAN-7585). Each warning can name
 * an Agent, pipeline, automation, skill or plugin from the share, so its
 * text stays out of every attribute.
 */
export function SharedContainerForkResult({
  warnings,
  onOpenCopy,
  onDone,
  busy = false,
}: SharedContainerForkResultProps): JSX.Element {
  const openRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    openRef.current?.focus();
  }, []);
  return (
    <div
      className="flex flex-col gap-3"
      data-testid="shared-container-fork-result"
    >
      <Notice intent="attention" title="Your copy is ready">
        Some things from this share weren&apos;t added.
      </Notice>
      <ul className="flex list-disc flex-col gap-1 pl-5 text-s fg-secondary">
        {warnings.map((warning, index) => (
          <li key={index} className={REPLAY_MASK_CLASS}>
            {warning}
          </li>
        ))}
      </ul>
      <div className="flex justify-end gap-2">
        <Button
          variant="secondary"
          size="lg"
          disabled={busy}
          data-testid="shared-container-fork-result-done"
          onClick={onDone}
        >
          Done
        </Button>
        <Button
          ref={openRef}
          variant="primary"
          size="lg"
          disabled={busy}
          data-testid="shared-container-fork-result-open"
          onClick={onOpenCopy}
        >
          Open copy
        </Button>
      </div>
    </div>
  );
}

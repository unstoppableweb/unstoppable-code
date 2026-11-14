import { useState, type JSX } from 'react';
import { Button, ErrorBanner } from '@canopy/ui-shared/components';
import { Surface } from '@canopy/ui-shared/components';

export type LedgerCloseIntentChoice = 'cancel' | 'detach' | 'complete';
export type LedgerCloseIntentKind = 'OPERATION' | 'TASK';

export interface LedgerCloseIntentPromptProps {
  readonly openCount: number;
  readonly kind: LedgerCloseIntentKind;
  /** More may be open than were counted; the copy then says "at least". */
  readonly openCountIsLowerBound?: boolean;
  readonly onChoose: (
    choice: LedgerCloseIntentChoice,
  ) => Promise<
    { readonly ok: true } | { readonly ok: false; readonly message: string }
  > | void;
  readonly testId?: string;
}

export function ledgerCloseIntentCopy(
  openCount: number,
  kind: LedgerCloseIntentKind,
  lowerBound = false,
): string {
  const scope = kind === 'OPERATION' ? 'in this operation' : 'under this task';
  if (lowerBound) {
    return `At least ${openCount === 1 ? '1 task' : `${openCount} tasks`} ${scope} ${openCount === 1 ? 'is' : 'are'} still open.`;
  }
  const tasks = openCount === 1 ? '1 task' : `${openCount} tasks`;
  const verb = openCount === 1 ? 'is' : 'are';
  return `${tasks} ${scope} ${verb} still open.`;
}

export function LedgerCloseIntentPrompt({
  openCount,
  kind,
  openCountIsLowerBound = false,
  onChoose,
  testId = 'ledger-close-intent',
}: LedgerCloseIntentPromptProps): JSX.Element {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const choose = async (choice: LedgerCloseIntentChoice): Promise<void> => {
    setPending(true);
    setError(null);
    try {
      const result = await onChoose(choice);
      if (result !== undefined && !result.ok) setError(result.message);
    } catch {
      setError("Couldn't update this entry. Try again.");
    } finally {
      setPending(false);
    }
  };

  return (
    <Surface
      data-testid={testId}
      variant="group"
      size="small"
      padding="compact"
      gap="inline"
    >
      <p className="text-s fg-primary">
        {ledgerCloseIntentCopy(openCount, kind, openCountIsLowerBound)}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          data-testid={`${testId}-cancel`}
          size="sm"
          variant="secondary"
          disabled={pending}
          onClick={(): void => void choose('cancel')}
        >
          Cancel
        </Button>
        <Button
          type="button"
          data-testid={`${testId}-detach`}
          size="sm"
          variant="secondary"
          disabled={pending}
          onClick={(): void => void choose('detach')}
        >
          Move them out
        </Button>
        <Button
          type="button"
          data-testid={`${testId}-complete`}
          size="sm"
          variant="primary"
          disabled={pending}
          onClick={(): void => void choose('complete')}
        >
          {openCountIsLowerBound ? 'Complete all' : `Complete all ${openCount}`}
        </Button>
      </div>
      <ErrorBanner
        errorSource="ledger-close-intent-prompt"
        className=""
        error={error}
      />
    </Surface>
  );
}

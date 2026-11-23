'use client';

import type { JSX, ReactNode } from 'react';
import type {
  ProviderChoiceModel,
  ProviderChoices,
} from '@canopy/app-state/provider-choice';
import { Heading } from '@canopy/ui-shared/components';
import {
  ProviderChoiceList,
  type ProviderChoiceListProps,
} from './ProviderChoiceList';

export interface ProviderChooserProps<
  TModel extends ProviderChoiceModel,
> extends Pick<
  ProviderChoiceListProps<TModel>,
  | 'presentation'
  | 'renderAction'
  | 'rowChildren'
  | 'renderRow'
  | 'rowError'
  | 'surface'
  | 'ariaLabel'
> {
  /** A `set-up` resolution: its rows in the host's order. */
  readonly choices: Pick<ProviderChoices<TModel>, 'rows' | 'recommended'>;
  readonly title?: ReactNode;
  /** One sentence under the title. */
  readonly intro?: ReactNode;
  /** Under the rows: the host's Skip or Continue, a gateway link. */
  readonly footer?: ReactNode;
  /** A quiet way elsewhere, under the footer. */
  readonly link?: ReactNode;
  readonly dataTestId?: string;
}

/**
 * The provider list as an inline step: an optional title and intro, the rows
 * in one box in the host's order, then the host's footer and a quiet link.
 * Desktop's "Let's get started" and the web first-visit card render it; the
 * modal shell is {@link ChooseProviderDialog}. Rows come from
 * `resolveProviderChoices` with a `set-up` target, and nothing here branches
 * on the host.
 */
export function ProviderChooser<TModel extends ProviderChoiceModel>({
  choices,
  title,
  intro,
  footer,
  link,
  dataTestId,
  ...list
}: ProviderChooserProps<TModel>): JSX.Element {
  return (
    <div
      className="flex min-w-0 flex-col gap-3"
      {...(dataTestId !== undefined ? { 'data-testid': dataTestId } : {})}
    >
      {title !== undefined || intro !== undefined ? (
        <div className="flex min-w-0 flex-col gap-1">
          {title !== undefined && (
            <Heading level={2} variant="section">
              {title}
            </Heading>
          )}
          {intro !== undefined && (
            <p className="text-xs text-pretty fg-secondary">{intro}</p>
          )}
        </div>
      ) : null}
      <ProviderChoiceList
        {...list}
        rows={choices.rows}
        recommended={choices.recommended}
        layout="flat"
        dataTestId="provider-choice-list"
        {...(footer !== undefined ? { footer } : {})}
      />
      {link}
    </div>
  );
}

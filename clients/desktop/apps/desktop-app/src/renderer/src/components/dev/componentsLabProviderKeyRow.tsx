import type { JSX } from 'react';
import type {
  ProviderKeyProvider,
  ProviderKeyStatus,
} from '@canopy/protocol/canopy-core';
import {
  ProviderKeyRow,
  type ProviderKeyRowOutcome,
} from '@canopy/ui-app/providers';
import {
  SpecimenCell,
  SpecimenGrid,
  SpecimenPanel,
} from './componentsLabParts';

function status(
  provider: ProviderKeyProvider,
  fields: Partial<ProviderKeyStatus> & Pick<ProviderKeyStatus, 'status'>,
): ProviderKeyStatus {
  const saved = fields.status !== 'none';
  return {
    provider,
    keyHint: saved ? '7Qm4' : null,
    modelCount: saved ? 3 : 0,
    modelsListed: saved,
    savedAt: saved ? '2026-11-20T12:00:00.000Z' : null,
    revision: saved ? 1 : 0,
    ...fields,
  };
}

// The lab has no server: a key ending in "bad" is refused, any other saves.
const save = (apiKey: string): Promise<ProviderKeyRowOutcome> =>
  Promise.resolve(
    apiKey.endsWith('bad')
      ? {
          ok: false,
          error: "Anthropic didn't accept that key. Check it and try again.",
        }
      : { ok: true },
  );
const remove = (): Promise<ProviderKeyRowOutcome> =>
  Promise.resolve({ ok: true });

const STATES: readonly {
  readonly label: string;
  readonly provider: ProviderKeyProvider;
  readonly status: ProviderKeyStatus | null;
}[] = [
  { label: 'loading', provider: 'anthropic', status: null },
  {
    label: 'no key',
    provider: 'anthropic',
    status: status('anthropic', { status: 'none' }),
  },
  {
    label: 'connected, models listed',
    provider: 'anthropic',
    status: status('anthropic', { status: 'saved' }),
  },
  {
    label: 'connected, one model',
    provider: 'openai',
    status: status('openai', { status: 'saved', modelCount: 1 }),
  },
  {
    label: 'connected, models not listed',
    provider: 'openai',
    status: status('openai', { status: 'saved', modelsListed: false }),
  },
  {
    label: 'connected, no hint',
    provider: 'anthropic',
    status: status('anthropic', { status: 'saved', keyHint: null }),
  },
  {
    label: 'rejected',
    provider: 'openai',
    status: status('openai', { status: 'rejected' }),
  },
];

/** ProviderKeyRow in each stored state; Connect opens its masked editor. */
export function ProviderKeyRowSpecimen(): JSX.Element {
  return (
    <SpecimenPanel
      title="ProviderKeyRow"
      hint='Connect or Save again opens the editor. A key ending in "bad" is refused.'
    >
      <SpecimenGrid min={360}>
        {STATES.map((state) => (
          <SpecimenCell key={state.label} label={state.label} wide>
            <ProviderKeyRow
              provider={state.provider}
              status={state.status}
              onSave={save}
              onRemove={remove}
            />
          </SpecimenCell>
        ))}
      </SpecimenGrid>
    </SpecimenPanel>
  );
}

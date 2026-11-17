import { useContext, type JSX } from 'react';
import { LabBrandDisplayNameContext } from './componentsLabStageContext';
import {
  CREDITS_ROW_DESCRIPTION,
  CREDITS_ROW_EMPTY_DESCRIPTION,
  PROVIDER_ROW_DESCRIPTIONS,
  providerChoiceReason,
  providerSwitchFailedMessage,
  switchProviderDialogTitle,
  usageLimitReasonAfterName,
  Surface,
  ProviderRowLabel,
  ProviderStatusDot,
  RemoteControlMobileAppPromo,
  ResizeRailIndicator,
  ServerMarkdown,
  type MobileAppStoreLink,
  type ProviderStatusDotTone,
} from '@canopy/ui-shared/components';
import { ClaudeLogo, CodexLogo } from '@canopy/ui-shared/icons';
import {
  resolveProviderChoices,
  type AnyProviderSourceFacts,
  type CreditsSourceFacts,
  type ProviderChoiceInput,
  type ProviderChoiceRow,
  type ProviderChoices,
} from '@canopy/app-state/provider-choice';
import {
  ProviderChoiceActionButton,
  ProviderChoiceList,
  providerChoicePrimaryLabel,
  type ProviderChoiceActionContext,
  type ProviderChoicePresentations,
  type ProviderChoiceRowError,
} from '@canopy/ui-app/providers';
import {
  SpecimenCell,
  SpecimenGrid,
  SpecimenPanel,
} from './componentsLabParts';

const DOT_STATES: readonly {
  tone: ProviderStatusDotTone;
  label: string;
  caption: string;
}[] = [
  { tone: 'connected', label: 'Connected', caption: 'connected' },
  { tone: 'failed', label: 'Sign-in failed', caption: 'failed' },
  { tone: 'limited', label: 'At usage limit', caption: 'limited' },
  { tone: 'pending', label: 'Signing in', caption: 'pending' },
  { tone: 'idle', label: 'Stopped', caption: 'idle' },
  { tone: 'signed-out', label: 'Not connected', caption: 'signed-out' },
];

/** ProviderRowLabel and ProviderStatusDot: every tone, no status, long name. */
export function ProviderRowLabelSpecimen(): JSX.Element {
  return (
    <div className="flex flex-col gap-6">
      <SpecimenPanel title="ProviderRowLabel: mark, name and status dot">
        <SpecimenGrid min={220}>
          {DOT_STATES.map(({ tone, label, caption }) => (
            <SpecimenCell key={tone} label={caption}>
              <ProviderRowLabel
                icon={<ClaudeLogo width={16} height={16} aria-hidden="true" />}
                name="Claude"
                status={<ProviderStatusDot tone={tone} label={label} />}
              />
            </SpecimenCell>
          ))}
          <SpecimenCell label="No connection to report: no dot">
            <ProviderRowLabel
              icon={<CodexLogo width={16} height={16} aria-hidden="true" />}
              name="Codex"
            />
          </SpecimenCell>
          <SpecimenCell label="No mark">
            <ProviderRowLabel
              name="OpenCode"
              status={<ProviderStatusDot tone="connected" />}
            />
          </SpecimenCell>
          <SpecimenCell label="Long name shrinks inside its column" wide>
            <div className="w-48">
              <ProviderRowLabel
                icon={<ClaudeLogo width={16} height={16} aria-hidden="true" />}
                name={
                  <span className="min-w-0 truncate">
                    A provider with a very long display name
                  </span>
                }
                status={<ProviderStatusDot tone="limited" label="At limit" />}
              />
            </div>
          </SpecimenCell>
        </SpecimenGrid>
      </SpecimenPanel>
    </div>
  );
}

const BADGE_SRC = (label: string): string =>
  `data:image/svg+xml;utf8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="48" viewBox="0 0 144 48"><rect width="144" height="48" rx="8" fill="#111"/><text x="72" y="29" fill="#fff" font-family="sans-serif" font-size="13" text-anchor="middle">${label}</text></svg>`,
  )}`;

const APPLE: MobileAppStoreLink = {
  store: 'apple-app-store',
  url: 'https://apps.apple.com/app/example',
  badgeSrc: BADGE_SRC('App Store'),
};
const GOOGLE: MobileAppStoreLink = {
  store: 'google-play',
  url: 'https://play.google.com/store/apps/details?id=example',
  badgeSrc: BADGE_SRC('Google Play'),
};

const noop = (): void => undefined;

/** RemoteControlMobileAppPromo: both stores, one store, callback, hidden. */
export function RemoteControlPromoSpecimen(): JSX.Element {
  const brandDisplayName = useContext(LabBrandDisplayNameContext);
  return (
    <SpecimenPanel title="Download offer inside a Remote Control panel">
      <SpecimenCell label="Both stores, badges as links (web)" wide>
        <div className="w-full max-w-xl">
          <RemoteControlMobileAppPromo
            brandDisplayName={brandDisplayName}
            links={[APPLE, GOOGLE]}
            activation={{ kind: 'anchor' }}
            visible
          />
        </div>
      </SpecimenCell>
      <SpecimenCell label="Both stores, badges as buttons (desktop)" wide>
        <div className="w-full max-w-xl">
          <RemoteControlMobileAppPromo
            brandDisplayName={brandDisplayName}
            links={[APPLE, GOOGLE]}
            activation={{ kind: 'callback', onActivate: noop }}
            visible
          />
        </div>
      </SpecimenCell>
      <SpecimenCell label="One store only" wide>
        <div className="w-full max-w-xl">
          <RemoteControlMobileAppPromo
            brandDisplayName={brandDisplayName}
            links={[APPLE]}
            activation={{ kind: 'anchor' }}
            visible
          />
        </div>
      </SpecimenCell>
      <SpecimenCell
        label="Hidden, or with no store links, renders nothing"
        wide
      >
        <RemoteControlMobileAppPromo
          brandDisplayName={brandDisplayName}
          links={[APPLE, GOOGLE]}
          activation={{ kind: 'anchor' }}
          visible={false}
        />
        <RemoteControlMobileAppPromo
          brandDisplayName={brandDisplayName}
          links={[]}
          activation={{ kind: 'anchor' }}
          visible
        />
        <span className="text-2xs fg-tertiary">(nothing before this)</span>
      </SpecimenCell>
    </SpecimenPanel>
  );
}

function RailFrame({
  line,
  active,
}: {
  readonly line: 'vertical' | 'horizontal';
  readonly active: boolean;
}): JSX.Element {
  // The 8px handle the indicator sits in; `group` drives its hover look.
  return (
    <Surface variant="panel">
      <div
        className={`group flex items-stretch justify-center ${
          line === 'vertical' ? 'h-24 w-2' : 'h-2 w-48 flex-col'
        }`}
      >
        <ResizeRailIndicator line={line} active={active} />
      </div>
    </Surface>
  );
}

/** ResizeRailIndicator: rest, hover (live) and dragging, both directions. */
export function ResizeRailSpecimen(): JSX.Element {
  return (
    <SpecimenPanel title="The line inside a resize handle (hover a handle to see the accent)">
      <SpecimenGrid min={200}>
        <SpecimenCell label="Vertical, at rest">
          <RailFrame line="vertical" active={false} />
        </SpecimenCell>
        <SpecimenCell label="Vertical, resizing (accent, thick)">
          <RailFrame line="vertical" active />
        </SpecimenCell>
        <SpecimenCell label="Horizontal, at rest">
          <RailFrame line="horizontal" active={false} />
        </SpecimenCell>
        <SpecimenCell label="Horizontal, resizing (accent, thick)">
          <RailFrame line="horizontal" active />
        </SpecimenCell>
      </SpecimenGrid>
    </SpecimenPanel>
  );
}

const MARKDOWN_SAMPLE = `# Release plan

A paragraph with **bold**, _emphasis_, \`inline code\` and a [link](https://example.com).

- First item
- Second item with a much longer line that wraps when the column is narrow enough to need it
  - A nested item

1. Numbered
2. Steps

> A quoted note.

\`\`\`ts
const message = 'a code block that is wider than its column should scroll sideways rather than wrap';
\`\`\`

| Name | Status |
| --- | --- |
| Build | Passing |
| Deploy | Waiting |
`;

/** ServerMarkdown: a full document, a narrow column and an empty one. */
export function ServerMarkdownSpecimen(): JSX.Element {
  return (
    <SpecimenPanel title="Markdown rendered without a client boundary">
      <SpecimenGrid min={320}>
        <SpecimenCell label="Full document">
          <div className="prose prose-sm w-full max-w-none">
            <ServerMarkdown>{MARKDOWN_SAMPLE}</ServerMarkdown>
          </div>
        </SpecimenCell>
        <SpecimenCell label="Narrow column">
          <div className="prose prose-sm w-48 max-w-none break-words">
            <ServerMarkdown>{MARKDOWN_SAMPLE}</ServerMarkdown>
          </div>
        </SpecimenCell>
        <SpecimenCell label="Empty renders nothing">
          <div className="min-h-4 w-full">
            <ServerMarkdown>{''}</ServerMarkdown>
          </div>
        </SpecimenCell>
      </SpecimenGrid>
    </SpecimenPanel>
  );
}

const CODEX_DEFAULT = { id: 'gpt-6-sol', label: 'GPT-6 Sol' };
/** The chat's model in every recovery scenario. */
const CHAT_MODEL = { id: 'claude-opus-4-7', label: 'Opus 4.7' };
const CONTINUE_CHAT = { kind: 'continue-chat', model: CHAT_MODEL } as const;
const CREDITS_DEFAULT = { id: 'gpt-6-sol', label: 'GPT-6 Sol' };
const RESETS_AT = Date.UTC(2026, 10, 14, 20, 0);

function credits(
  overrides: Partial<CreditsSourceFacts> = {},
): CreditsSourceFacts {
  return {
    source: 'credits',
    balance: 'empty',
    runsTargetModel: true,
    billingEnabled: true,
    viewer: 'signed-in',
    owner: { kind: 'personal' },
    purchaseMode: 'handoff',
    pending: false,
    ...overrides,
  };
}

/** Each scenario resolves its rows through the shared decision, as hosts do. */
const SCENARIOS: readonly {
  readonly label: string;
  readonly input: ProviderChoiceInput;
  /** A failed choice, shown on its row. */
  readonly rowError?: ProviderChoiceRowError;
}[] = [
  {
    label:
      'Usage limit: the gateway has its own route for the model (Stays on)',
    input: {
      current: 'claude',
      condition: 'quota_limit',
      target: CONTINUE_CHAT,
      sources: [
        {
          source: 'claude',
          connection: { kind: 'limited', resetsAt: RESETS_AT },
          connectable: true,
          runsTargetModel: true,
        },
        {
          source: 'codex',
          connection: { kind: 'ready' },
          connectable: true,
          runsTargetModel: false,
          defaultModel: CODEX_DEFAULT,
        },
        {
          source: 'gateway',
          connection: { kind: 'ready' },
          connectable: true,
          runsTargetModel: false,
          defaultModel: { id: 'gw-sonnet-5-5', label: 'Sonnet 5.5' },
          equivalentModel: {
            id: 'gw-anthropic/claude-opus-4.7',
            label: 'Opus 4.7',
          },
        },
        credits({ runsTargetModel: false }),
      ],
    },
  },
  {
    label: 'Signed out of the current provider (Reconnect)',
    input: {
      current: 'claude',
      condition: 'no_billing_source',
      target: CONTINUE_CHAT,
      sources: [
        {
          source: 'claude',
          connection: { kind: 'not-connected' },
          connectable: true,
          runsTargetModel: true,
        },
        {
          source: 'codex',
          connection: { kind: 'ready' },
          connectable: true,
          runsTargetModel: false,
          defaultModel: CODEX_DEFAULT,
        },
        credits({ balance: 'unknown' }),
      ],
    },
  },
  {
    label: 'A failed switch, shown on its row',
    rowError: {
      source: 'codex',
      message: providerSwitchFailedMessage('codex', 'Codex'),
    },
    input: {
      current: 'claude',
      condition: 'quota_limit',
      target: CONTINUE_CHAT,
      sources: [
        {
          source: 'claude',
          connection: { kind: 'limited', resetsAt: null },
          connectable: true,
          runsTargetModel: true,
        },
        {
          source: 'codex',
          connection: { kind: 'ready' },
          connectable: true,
          runsTargetModel: false,
          defaultModel: CODEX_DEFAULT,
        },
        credits({ balance: 'spendable' }),
      ],
    },
  },
  {
    label: 'Usage limit: one other source can continue (Continue with)',
    input: {
      current: 'claude',
      condition: 'quota_limit',
      target: CONTINUE_CHAT,
      sources: [
        {
          source: 'claude',
          connection: { kind: 'limited', resetsAt: RESETS_AT },
          connectable: true,
          runsTargetModel: true,
        },
        {
          source: 'codex',
          connection: { kind: 'ready' },
          connectable: true,
          runsTargetModel: false,
          defaultModel: CODEX_DEFAULT,
        },
        credits({ runsTargetModel: false }),
      ],
    },
  },
  {
    label: 'Usage limit: two sources can continue (Switch provider)',
    input: {
      current: 'codex',
      condition: 'quota_limit',
      target: CONTINUE_CHAT,
      sources: [
        {
          source: 'claude',
          connection: { kind: 'ready' },
          connectable: true,
          runsTargetModel: false,
          defaultModel: { id: 'claude-opus', label: 'Opus' },
        },
        {
          source: 'codex',
          connection: { kind: 'limited', resetsAt: null },
          connectable: true,
          runsTargetModel: true,
        },
        credits({ balance: 'spendable' }),
      ],
    },
  },
  {
    label:
      'Nothing ready, so no primary: connect a provider or buy credits (no credits left)',
    input: {
      current: 'codex',
      condition: 'no_billing_source',
      target: CONTINUE_CHAT,
      sources: [
        {
          source: 'claude',
          connection: { kind: 'not-connected' },
          connectable: true,
          runsTargetModel: false,
        },
        {
          source: 'codex',
          connection: { kind: 'not-connected' },
          connectable: true,
          runsTargetModel: true,
        },
        credits({ defaultModel: CREDITS_DEFAULT }),
      ],
    },
  },
  {
    label: 'A row still checking never counts toward Continue',
    input: {
      current: 'claude',
      condition: 'quota_limit',
      target: CONTINUE_CHAT,
      sources: [
        {
          source: 'claude',
          connection: { kind: 'limited', resetsAt: RESETS_AT },
          connectable: true,
          runsTargetModel: true,
        },
        {
          source: 'codex',
          connection: { kind: 'checking' },
          connectable: true,
          runsTargetModel: false,
          defaultModel: CODEX_DEFAULT,
        },
        credits({ runsTargetModel: false }),
      ],
    },
  },
  {
    label: 'A blocked row, an organization member',
    input: {
      current: 'claude',
      condition: 'quota_limit',
      target: CONTINUE_CHAT,
      sources: [
        {
          source: 'claude',
          connection: { kind: 'limited', resetsAt: RESETS_AT },
          connectable: true,
          runsTargetModel: true,
        },
        {
          source: 'codex',
          connection: { kind: 'ready' },
          connectable: true,
          runsTargetModel: false,
          defaultModel: CODEX_DEFAULT,
          blockedReason:
            'This chat is running on Claude. Start a new chat to use Codex models.',
        },
        credits({
          owner: { kind: 'organization', canFund: false, creditPool: true },
        }),
      ],
    },
  },
  {
    label:
      'Web: subscriptions need the desktop app, a guest buys after sign-in',
    input: {
      current: 'credits',
      condition: 'out_of_credits',
      target: CONTINUE_CHAT,
      sources: [
        ...(['claude', 'codex'] as const).map(
          (source): AnyProviderSourceFacts => ({
            source,
            connection: { kind: 'not-connected' },
            connectable: false,
            runsTargetModel: false,
            unsupported: 'desktop-only',
          }),
        ),
        credits({ viewer: 'guest', purchaseMode: 'inline' }),
      ],
    },
  },
];

function renderAction(
  row: ProviderChoiceRow,
  { recommended }: ProviderChoiceActionContext,
): JSX.Element | null {
  return (
    <ProviderChoiceActionButton
      source={row.source}
      action={row.action}
      recommended={recommended}
      isCurrent={row.isCurrent}
      onClick={noop}
    />
  );
}

/**
 * The dialog's header for a scenario, as one caption: its title and the
 * reason the subtitle gives. The lab's names are plain strings.
 */
function headerCaption(
  input: ProviderChoiceInput,
  choices: ProviderChoices,
  presentation: ProviderChoicePresentations,
  resetsLabel: string,
): string {
  const title = switchProviderDialogTitle({ condition: input.condition });
  const { current } = choices;
  const name =
    current !== null ? presentation[current.source]?.name : undefined;
  const reason =
    input.condition === 'quota_limit' &&
    current?.connection.kind === 'limited' &&
    typeof name === 'string'
      ? `${name} ${usageLimitReasonAfterName(
          current.connection.resetsAt !== null ? resetsLabel : undefined,
        )}`
      : providerChoiceReason(input.condition);
  return reason !== undefined ? `${title}. ${reason}` : title;
}

/** The provider list's row states, as the Switch provider dialog shows them. */
export function ProviderRowsSpecimen(): JSX.Element {
  const brandDisplayName = useContext(LabBrandDisplayNameContext);
  // The desktop's presentation, rebuilt from shared pieces so the lab stays
  // free of the composer's client graph.
  const presentation: ProviderChoicePresentations = {
    claude: {
      name: 'Claude',
      icon: <ClaudeLogo width={16} height={16} aria-hidden="true" />,
      description: PROVIDER_ROW_DESCRIPTIONS.claude,
    },
    codex: {
      name: 'Codex',
      icon: <CodexLogo width={16} height={16} aria-hidden="true" />,
      description: PROVIDER_ROW_DESCRIPTIONS.codex,
    },
    credits: { name: brandDisplayName, description: CREDITS_ROW_DESCRIPTION },
    gateway: {
      name: 'OpenRouter',
      description: PROVIDER_ROW_DESCRIPTIONS.gateway,
    },
  };
  const formatResetsAt = (): string => '3:00 PM';
  return (
    <div className="flex flex-col gap-6">
      <SpecimenPanel title="ProviderChoiceList">
        {SCENARIOS.map(({ label, input, rowError }) => {
          const choices = resolveProviderChoices(input);
          const creditsBalance = input.sources.find(
            (facts) => facts.source === 'credits',
          );
          // An empty balance replaces the credits description, as hosts do.
          const scenarioPresentation: ProviderChoicePresentations = {
            ...presentation,
            credits: {
              name: brandDisplayName,
              description:
                creditsBalance !== undefined &&
                'balance' in creditsBalance &&
                creditsBalance.balance === 'empty'
                  ? CREDITS_ROW_EMPTY_DESCRIPTION
                  : CREDITS_ROW_DESCRIPTION,
            },
          };
          const continueName =
            choices.primary.kind === 'continue-with'
              ? presentation[choices.primary.source]?.name
              : undefined;
          return (
            <SpecimenCell
              key={label}
              label={`${label}: notice button "${providerChoicePrimaryLabel(
                choices.primary,
                typeof continueName === 'string' ? continueName : '',
              )}"`}
              wide
            >
              <div className="flex w-full max-w-lg flex-col gap-2">
                <p className="text-xs fg-secondary">
                  {headerCaption(
                    input,
                    choices,
                    scenarioPresentation,
                    formatResetsAt(),
                  )}
                </p>
                <ProviderChoiceList
                  rows={choices.rows}
                  recommended={choices.recommended}
                  presentation={scenarioPresentation}
                  renderAction={renderAction}
                  formatResetsAt={formatResetsAt}
                  targetModelLabel={CHAT_MODEL.label}
                  {...(rowError !== undefined ? { rowError } : {})}
                />
              </div>
            </SpecimenCell>
          );
        })}
      </SpecimenPanel>
    </div>
  );
}

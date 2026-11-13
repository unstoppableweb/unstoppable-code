import { useEffect, useState, type JSX } from 'react';
import {
  Badge,
  Button,
  LoadingSpinner,
  loadedSmoothMarkdown,
  Markdown,
  PipelineSourceLabel,
  SlashCommandAvailabilityTag,
  SlashCommandAvailableDivider,
  SlashCommandGroupHeading,
  SlashCommandPendingSpinner,
  SkillUpdateNotice,
  SkillUpdateStatus,
  SmoothStreamingProvider,
  SpinnerStyleProvider,
  StandardPresentationProvider,
  StartChatSummary,
  StartingPointChip,
  StatusLabel,
  StoreBadgeLink,
  StuckAgentNotice,
  ThinkingSpinner,
  type SpinnerStyle,
  type SpinnerTone,
  type StatusLabelSize,
  type StatusLabelTone,
  type StuckAgentCheckResult,
  preloadSmoothMarkdown,
} from '@canopy/ui-shared/components';
import type { SkillUpdateAction } from '@canopy/ui-shared/lib';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import {
  APPLE_APP_STORE_BADGE_DATA_URI,
  GOOGLE_PLAY_BADGE_DATA_URI,
} from '@canopy/ui-shared/assets/store-badges';
import {
  SpecimenCell,
  SpecimenGrid,
  SpecimenPanel,
} from './componentsLabParts';

const noop = (): void => undefined;

// ---------------------------------------------------------------- Skills

function ready(
  overrides: Partial<Extract<SkillUpdateAction, { status: 'ready' }>>,
): SkillUpdateAction {
  return {
    status: 'ready',
    updateAvailable: false,
    pending: 'none',
    onCheck: noop,
    onApply: noop,
    ...overrides,
  };
}

const SKILL_UPDATE_CASES: readonly {
  label: string;
  action: SkillUpdateAction | undefined;
}[] = [
  { label: 'update available', action: ready({ updateAvailable: true }) },
  {
    label: 'update available, applying (a check or apply is pending)',
    action: ready({ updateAvailable: true, pending: 'applying' }),
  },
  {
    label: 'blocked, update known (host cannot run updates)',
    action: {
      status: 'blocked',
      updateAvailable: true,
      reason: 'Check for and apply skill updates from the desktop app.',
    },
  },
  {
    label: 'check failed, with detail',
    action: ready({
      error: { kind: 'check-failed', detail: 'github.com took too long.' },
    }),
  },
  {
    label: 'update failed, retry disabled while another operation runs',
    action: ready({
      updateAvailable: true,
      pending: 'checking',
      error: { kind: 'update-failed', detail: 'The source moved.' },
    }),
  },
  {
    label: 'no longer in its source (with Remove)',
    action: ready({ error: { kind: 'missing-source' } }),
  },
  {
    label: 'up to date or not updatable: renders nothing',
    action: undefined,
  },
];

function SkillUpdateSection(): JSX.Element {
  const now = Date.now();
  return (
    <div className="flex flex-col gap-6">
      <SpecimenPanel title="SkillUpdateNotice">
        {SKILL_UPDATE_CASES.map(({ label, action }) => (
          <SpecimenCell key={label} label={label} wide>
            <div className="w-full">
              <SkillUpdateNotice action={action} onRemove={noop} />
              {action === undefined ? (
                <span className="text-2xs fg-tertiary">(nothing)</span>
              ) : null}
            </div>
          </SpecimenCell>
        ))}
        <SpecimenCell
          label="missing source, host cannot remove: no Remove"
          wide
        >
          <div className="w-full">
            <SkillUpdateNotice
              action={ready({ error: { kind: 'missing-source' } })}
            />
          </div>
        </SpecimenCell>
      </SpecimenPanel>
      <SpecimenPanel title="SkillUpdateStatus (the detail header’s meta line)">
        <SpecimenGrid min={240}>
          <SpecimenCell label="checking">
            <span className="text-xs fg-secondary">
              <SkillUpdateStatus action={ready({ pending: 'checking' })} />
            </span>
          </SpecimenCell>
          <SpecimenCell label="up to date, just now">
            <span className="text-xs fg-secondary">
              <SkillUpdateStatus action={ready({ checkedAt: now })} />
            </span>
          </SpecimenCell>
          <SpecimenCell label="up to date, an hour ago">
            <span className="text-xs fg-secondary">
              <SkillUpdateStatus
                action={ready({ checkedAt: now - 60 * 60_000 })}
              />
            </span>
          </SpecimenCell>
          <SpecimenCell label="nothing to say (cached, never checked)">
            <span className="text-xs fg-tertiary">
              <SkillUpdateStatus action={ready({})} />
              (empty)
            </span>
          </SpecimenCell>
        </SpecimenGrid>
      </SpecimenPanel>
    </div>
  );
}

// -------------------------------------------------------- Stuck agent

type CheckOutcome = StuckAgentCheckResult | 'fail';

function StuckAgentSection(): JSX.Element {
  const [outcome, setOutcome] = useState<CheckOutcome>('running');
  const check = (): Promise<StuckAgentCheckResult> =>
    new Promise((resolve, reject) => {
      window.setTimeout(() => {
        if (outcome === 'fail') reject(new Error('offline'));
        else resolve(outcome);
      }, 1200);
    });
  return (
    <SpecimenPanel title="StuckAgentNotice">
      <SpecimenCell
        label="Live: press Check status; the outcome is set below"
        wide
      >
        <div className="w-full">
          <StuckAgentNotice minutes={12} onCheckStatus={check} key={outcome} />
        </div>
      </SpecimenCell>
      <SpecimenCell label="The next check ends as" wide>
        {(
          [
            ['running', 'Still working (action goes away)'],
            ['settled', 'Settled (back to unchecked)'],
            ['fail', 'Fails (detail line)'],
          ] as const
        ).map(([value, label]) => (
          <Button
            key={value}
            size="compact"
            variant={outcome === value ? 'primary' : 'secondary'}
            onClick={(): void => setOutcome(value)}
          >
            {label}
          </Button>
        ))}
      </SpecimenCell>
      <SpecimenCell label="one minute (singular)" wide>
        <div className="w-full">
          <StuckAgentNotice
            minutes={1}
            onCheckStatus={(): Promise<StuckAgentCheckResult> =>
              Promise.resolve('settled')
            }
          />
        </div>
      </SpecimenCell>
    </SpecimenPanel>
  );
}

// ------------------------------------------------ Starting point + chat

function StartingPointSection(): JSX.Element {
  const [selected, setSelected] = useState<string | null>('Web app');
  const toggle = (name: string) => (): void =>
    setSelected((current) => (current === name ? null : name));
  return (
    <SpecimenPanel title="StartingPointChip (press the chosen one again to clear it)">
      <SpecimenCell
        label="Live: a Blueprint picker, hover for the description"
        wide
      >
        {[
          ['Web app', 'A Next.js app with auth and a database wired in.'],
          ['CLI tool', 'A Node CLI with tests and a release workflow.'],
          ['Empty project', ''],
        ].map(([name, description]) => (
          <StartingPointChip
            key={name}
            name={name}
            description={description}
            selected={selected === name}
            onToggle={toggle(name)}
          />
        ))}
      </SpecimenCell>
      <SpecimenGrid min={200}>
        <SpecimenCell label="unselected">
          <StartingPointChip
            name="Web app"
            description="Desc"
            selected={false}
            onToggle={noop}
          />
        </SpecimenCell>
        <SpecimenCell label="selected">
          <StartingPointChip
            name="Web app"
            description="Desc"
            selected
            onToggle={noop}
          />
        </SpecimenCell>
        <SpecimenCell label="disabled">
          <StartingPointChip
            name="Web app"
            description="Desc"
            selected={false}
            disabled
            onToggle={noop}
          />
        </SpecimenCell>
        <SpecimenCell label="selected and disabled">
          <StartingPointChip
            name="Web app"
            description="Desc"
            selected
            disabled
            onToggle={noop}
          />
        </SpecimenCell>
        <SpecimenCell label="long name truncates inside the chip">
          <div className="w-40">
            <StartingPointChip
              name="A starting point with a remarkably long name"
              description="Long names are cut inside the chip."
              selected={false}
              onToggle={noop}
            />
          </div>
        </SpecimenCell>
      </SpecimenGrid>
    </SpecimenPanel>
  );
}

function StartChatSummarySection(): JSX.Element {
  return (
    <SpecimenPanel title="StartChatSummary">
      <SpecimenCell label="steps and an action" wide>
        <div className="w-full">
          <StartChatSummary
            destination="storefront"
            steps={[
              'Create a worktree',
              'Send the prompt',
              'Wait for the reply',
            ]}
            actions={
              <Button size="compact" variant="secondary">
                Open workflow
              </Button>
            }
          />
        </div>
      </SpecimenCell>
      <SpecimenCell label="with a note and no actions" wide>
        <div className="w-full">
          <StartChatSummary
            destination="Orchestrator"
            steps={['Send the prompt']}
            note="This chat runs as a workflow, so it can only be edited there."
          />
        </div>
      </SpecimenCell>
      <SpecimenCell label="long destination and many steps wrap" wide>
        <div className="w-full">
          <StartChatSummary
            destination="a-monorepo-with-a-remarkably-long-project-name/feature-worktree"
            steps={[
              'Create a worktree',
              'Install dependencies',
              'Send the prompt',
              'Wait for the reply',
              'Open a pull request',
              'Request review',
            ]}
            actions={
              <Button size="compact" variant="secondary">
                Open workflow
              </Button>
            }
          />
        </div>
      </SpecimenCell>
    </SpecimenPanel>
  );
}

// ------------------------------------------------- Status label + badges

const LABEL_TONES: readonly StatusLabelTone[] = [
  'destructive',
  'attention',
  'positive',
];
const LABEL_SIZES: readonly StatusLabelSize[] = [
  'inherit',
  '3xs',
  '2xs',
  'xs',
  's',
];

function StatusLabelSection(): JSX.Element {
  return (
    <SpecimenPanel title="StatusLabel (a row’s status, in its state’s ink)">
      <SpecimenGrid min={200}>
        {LABEL_TONES.map((tone) => (
          <SpecimenCell key={tone} label={tone}>
            <StatusLabel tone={tone}>
              {tone === 'positive'
                ? 'Connected'
                : tone === 'attention'
                  ? 'Needs sign-in'
                  : 'Expired'}
            </StatusLabel>
          </SpecimenCell>
        ))}
        {LABEL_SIZES.map((size) => (
          <SpecimenCell key={size} label={`size ${size}`}>
            <StatusLabel size={size}>Disconnected</StatusLabel>
          </SpecimenCell>
        ))}
        <SpecimenCell label="long text truncates in a narrow row">
          <div className="w-32 truncate text-s">
            <StatusLabel title="Authentication expired three days ago">
              Authentication expired three days ago
            </StatusLabel>
          </div>
        </SpecimenCell>
      </SpecimenGrid>
    </SpecimenPanel>
  );
}

function StoreBadgeSection(): JSX.Element {
  const [last, setLast] = useState('nothing pressed yet');
  return (
    <SpecimenPanel title="StoreBadgeLink (the official artwork, never recolored)">
      <SpecimenCell label="callback activation (desktop): Live" wide>
        <StoreBadgeLink
          link={{
            store: 'apple-app-store',
            url: 'https://apps.apple.com/app/example',
            badgeSrc: APPLE_APP_STORE_BADGE_DATA_URI,
          }}
          activation={{
            kind: 'callback',
            onActivate: (store, url): void => setLast(`${store}: ${url}`),
          }}
        />
        <StoreBadgeLink
          link={{
            store: 'google-play',
            url: 'https://play.google.com/store/apps/details?id=example',
            badgeSrc: GOOGLE_PLAY_BADGE_DATA_URI,
          }}
          activation={{
            kind: 'callback',
            onActivate: (store, url): void => setLast(`${store}: ${url}`),
          }}
        />
        <span className="text-2xs fg-tertiary">{last}</span>
      </SpecimenCell>
      <SpecimenCell label="anchor activation (web): a real link" wide>
        <StoreBadgeLink
          link={{
            store: 'apple-app-store',
            url: '#apple',
            badgeSrc: APPLE_APP_STORE_BADGE_DATA_URI,
          }}
          activation={{ kind: 'anchor' }}
        />
        <StoreBadgeLink
          link={{
            store: 'google-play',
            url: '#google',
            badgeSrc: GOOGLE_PLAY_BADGE_DATA_URI,
          }}
          activation={{ kind: 'anchor' }}
        />
      </SpecimenCell>
    </SpecimenPanel>
  );
}

// ------------------------------------------------------------ Slash menu

function SlashCommandSection(): JSX.Element {
  return (
    <SpecimenPanel title="Slash command primitives">
      <SpecimenGrid min={260}>
        <SpecimenCell label="availability tag">
          <SlashCommandAvailabilityTag />
        </SpecimenCell>
        <SpecimenCell label="loading spinner">
          <span className="fg-secondary">
            <SlashCommandPendingSpinner />
          </span>
        </SpecimenCell>
        <SpecimenCell label="group heading, default">
          <div className="w-64 rounded-lg bg-quaternary py-1">
            <SlashCommandGroupHeading label="Commands" />
          </div>
        </SpecimenCell>
        <SpecimenCell label="group heading, compact">
          <div className="w-64 rounded-lg bg-quaternary py-1">
            <SlashCommandGroupHeading label="Recent" compact />
          </div>
        </SpecimenCell>
        <SpecimenCell label="group heading with a divider, and the Available divider">
          <div className="w-64 rounded-lg bg-quaternary py-1 text-s">
            <div className="px-3 py-1">/review</div>
            <SlashCommandGroupHeading label="Skills" divider />
            <div className="px-3 py-1">/summarize</div>
            <SlashCommandAvailableDivider />
            <div className="flex items-center gap-2 px-3 py-1">
              /translate <SlashCommandAvailabilityTag />
            </div>
          </div>
        </SpecimenCell>
        <SpecimenCell label="long heading truncation is the host’s; it wraps here">
          <div className="w-48 rounded-lg bg-quaternary py-1">
            <SlashCommandGroupHeading label="A very long group heading from a plugin" />
          </div>
        </SpecimenCell>
      </SpecimenGrid>
    </SpecimenPanel>
  );
}

// ---------------------------------------------------------- Presentation

const SPINNER_TONES: readonly SpinnerTone[] = [
  'inherit',
  'primary',
  'secondary',
  'tertiary',
  'accent',
  'warning',
  'destructive',
];

function SpinnerStyleSection(): JSX.Element {
  const styles: readonly SpinnerStyle[] = ['dots', 'comet'];
  return (
    <SpecimenPanel title="SpinnerStyleProvider (the host chooses once; every spinner follows)">
      {styles.map((style) => (
        <SpecimenCell
          key={style}
          label={`value="${style}": LoadingSpinner by tone, then ThinkingSpinner`}
          wide
        >
          <SpinnerStyleProvider value={style}>
            {SPINNER_TONES.map((tone) => (
              <span
                key={tone}
                className="inline-flex items-center gap-1 text-xs fg-secondary"
              >
                <LoadingSpinner tone={tone} sizePx={14} decorative />
                {tone}
              </span>
            ))}
            <ThinkingSpinner tone="secondary" />
          </SpinnerStyleProvider>
        </SpecimenCell>
      ))}
    </SpecimenPanel>
  );
}

const STREAM_TEXT =
  'Smooth streaming reveals **whole words** on a steady beat, so a reply never\njumps. Half-typed markup such as `code` stays hidden until it closes.';

function useStreamedText(run: number): { text: string; done: boolean } {
  // The length belongs to a run, so a new run reads as unfinished on its first
  // render, before the effect below resets it.
  const [streamed, setStreamed] = useState({ run, length: 0 });
  const length = streamed.run === run ? streamed.length : 0;
  useEffect(() => {
    setStreamed({ run, length: 0 });
    const id = window.setInterval(() => {
      setStreamed((current) => {
        if (current.length >= STREAM_TEXT.length) {
          window.clearInterval(id);
          return current;
        }
        return { run, length: current.length + 6 };
      });
    }, 120);
    return (): void => window.clearInterval(id);
  }, [run]);
  return {
    text: STREAM_TEXT.slice(0, length),
    done: length >= STREAM_TEXT.length,
  };
}

/**
 * Markdown picks its renderer when it mounts, so wait for the lazy smooth
 * renderer first, and remount on each run so Replay restarts the stream.
 */
function StreamingReply({ run }: { readonly run: number }): JSX.Element {
  const { text, done } = useStreamedText(run);
  const [ready, setReady] = useState(() => loadedSmoothMarkdown() !== null);
  useEffect(() => {
    void preloadSmoothMarkdown().then(() => setReady(true));
  }, []);
  return (
    <div className={`w-full text-s ${POSTHOG_REPLAY_BLOCK_CLASS}`}>
      {ready ? (
        <Markdown key={run} streaming={!done}>
          {text}
        </Markdown>
      ) : null}
    </div>
  );
}

function SmoothStreamingSection(): JSX.Element {
  const [run, setRun] = useState(0);
  return (
    <SpecimenPanel title="SmoothStreamingProvider (a streaming reply, with and without)">
      <SpecimenCell label="Live: replay both streams" wide>
        <Button size="compact" onClick={(): void => setRun((n) => n + 1)}>
          Replay
        </Button>
      </SpecimenCell>
      <SpecimenCell
        label="value={true}: whole words on a beat, new text fades in"
        wide
      >
        <SmoothStreamingProvider value>
          <StreamingReply run={run} />
        </SmoothStreamingProvider>
      </SpecimenCell>
      <SpecimenCell label="value={false}: text appears as it arrives" wide>
        <SmoothStreamingProvider value={false}>
          <StreamingReply run={run} />
        </SmoothStreamingProvider>
      </SpecimenCell>
    </SpecimenPanel>
  );
}

function StandardPresentationSection(): JSX.Element {
  const [run, setRun] = useState(0);
  return (
    <SpecimenPanel title="StandardPresentationProvider (desktop and web chats: comet spinner, smooth streaming, PR hover cards, compact queue)">
      <SpecimenCell label="inside the provider" wide>
        <StandardPresentationProvider>
          <span className="inline-flex items-center gap-2 text-xs fg-secondary">
            <LoadingSpinner tone="secondary" sizePx={14} decorative />
            Working…
          </span>
          <StreamingReply run={run} />
        </StandardPresentationProvider>
      </SpecimenCell>
      <SpecimenCell label="outside it: today’s dot spinner" wide>
        <span className="inline-flex items-center gap-2 text-xs fg-secondary">
          <LoadingSpinner tone="secondary" sizePx={14} decorative />
          Working…
        </span>
        <Badge muted>unchanged defaults</Badge>
        <Button size="compact" onClick={(): void => setRun((n) => n + 1)}>
          Replay stream
        </Button>
      </SpecimenCell>
    </SpecimenPanel>
  );
}

export function StatusPartsSpecimen(): JSX.Element {
  return (
    <div className="flex flex-col gap-6">
      <SkillUpdateSection />
      <StuckAgentSection />
      <StartingPointSection />
      <StartChatSummarySection />
      <SpecimenPanel title="Workflow source metadata">
        <SpecimenGrid min={160}>
          {['Bundled', 'Custom', 'Project', 'Shared', 'Curated', 'Local'].map(
            (label) => (
              <SpecimenCell key={label} label={label}>
                <PipelineSourceLabel>{label}</PipelineSourceLabel>
              </SpecimenCell>
            ),
          )}
          <SpecimenCell label="Shared by you, organization">
            <PipelineSourceLabel audience="organization">
              Custom
            </PipelineSourceLabel>
          </SpecimenCell>
          <SpecimenCell label="Shared by you, public link">
            <PipelineSourceLabel audience="private">Custom</PipelineSourceLabel>
          </SpecimenCell>
          <SpecimenCell label="Long provenance" wide>
            <PipelineSourceLabel>
              Project workflow from the release automation collection
            </PipelineSourceLabel>
          </SpecimenCell>
        </SpecimenGrid>
      </SpecimenPanel>
      <StatusLabelSection />
      <StoreBadgeSection />
      <SlashCommandSection />
      <SpinnerStyleSection />
      <SmoothStreamingSection />
      <StandardPresentationSection />
    </div>
  );
}

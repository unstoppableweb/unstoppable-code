import { useState, type JSX } from 'react';
import {
  Badge,
  Button,
  GuestModelGateContent,
  HomeSection,
  HomeSections,
  InterruptedSessionRow,
  Notice,
  SourceBranchCommitHint,
} from '@canopy/ui-shared/components';
import {
  SpecimenCell,
  SpecimenGrid,
  SpecimenPanel,
} from './componentsLabParts';

const noop = (): void => undefined;

function SelectableRows(): JSX.Element {
  const [selected, setSelected] = useState<ReadonlySet<string>>(
    () => new Set(['a']),
  );
  const toggle = (id: string) => (): void =>
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  return (
    <div className="w-full">
      {[
        {
          id: 'a',
          title: 'Fix the flaky export test',
          meta: 'Claude · interrupted by quit · ready',
        },
        {
          id: 'b',
          title: 'Port the settings page to the shared rows',
          meta: 'Codex · interrupted by crash · ready',
        },
      ].map((row) => (
        <InterruptedSessionRow
          key={row.id}
          title={row.title}
          selection={{
            id: `lab-resume-${row.id}`,
            checked: selected.has(row.id),
            onChange: toggle(row.id),
            testId: `lab-resume-check-${row.id}`,
          }}
          context="canopy / main"
          metadata={row.meta}
          data-testid={`lab-resume-row-${row.id}`}
        />
      ))}
    </div>
  );
}

function SignInLink(label: string, className: string): JSX.Element {
  return (
    <a href="#sign-in" className={className} data-testid="lab-guest-sign-in">
      {label}
    </a>
  );
}

/**
 * Below-composer Home sections, the resume list rows and the guest model
 * gate. Hover a section to reveal its ⋯ menu; Hide section and Show hidden
 * sections are live.
 */
export function HomeAndResumeSpecimen(): JSX.Element {
  return (
    <div className="flex flex-col gap-6">
      <SpecimenPanel title="SourceBranchCommitHint">
        <SpecimenCell label="Verified branch with no commits">
          <SourceBranchCommitHint headUnborn />
        </SpecimenCell>
        <SpecimenCell label="Inline after repository details">
          <span>
            Git repository{' '}
            <SourceBranchCommitHint headUnborn leadingSeparator />
          </span>
        </SpecimenCell>
        <SpecimenCell label="Committed branch: no hint">
          <span>
            Git repository{' '}
            <SourceBranchCommitHint headUnborn={false} leadingSeparator />
          </span>
        </SpecimenCell>
        <SpecimenCell label="Unknown state: no hint">
          <span>
            Git repository <SourceBranchCommitHint leadingSeparator />
          </span>
        </SpecimenCell>
      </SpecimenPanel>

      <SpecimenPanel title="HomeSection, grouped in HomeSections (hide one, then restore)">
        <HomeSections>
          <HomeSection
            sectionId="lab-suggestions"
            title="Suggestions"
            description="Ideas based on this project."
            testId="lab-home-suggestions"
          >
            <p className="px-4 text-s fg-secondary">
              Add tests for the export flow.
            </p>
          </HomeSection>
          <HomeSection
            sectionId="lab-recent"
            title="Recent chats"
            testId="lab-home-recent"
          >
            <p className="px-4 text-s fg-secondary">
              Fix the flaky export test.
            </p>
          </HomeSection>
        </HomeSections>
      </SpecimenPanel>

      <SpecimenPanel title="HomeSection on its own (hides with its own restore control)">
        <HomeSection
          sectionId="lab-solo"
          title="Pull requests"
          description="Open pull requests that need you."
          testId="lab-home-solo"
        >
          <p className="px-4 text-s fg-secondary">
            Nothing needs you right now.
          </p>
        </HomeSection>
      </SpecimenPanel>

      <SpecimenPanel title="InterruptedSessionRow">
        <SpecimenCell
          label="Selectable rows in the resume dialog (live checkboxes)"
          wide
        >
          <SelectableRows />
        </SpecimenCell>
        <SpecimenCell label="Disabled selection, muted text" wide>
          <div className="w-full">
            <InterruptedSessionRow
              title="Waiting for the repository to finish cloning"
              selection={{
                id: 'lab-resume-disabled',
                checked: false,
                disabled: true,
                onChange: noop,
              }}
              disabled
              metadata="Claude · interrupted by quit · not ready"
              data-testid="lab-resume-disabled"
            />
          </div>
        </SpecimenCell>
        <SpecimenCell
          label="Queue layout with a trailing status and an error line"
          wide
        >
          <div className="w-full">
            <InterruptedSessionRow
              layout="queue"
              title="Port the settings page to the shared rows"
              context="canopy / feature-branch"
              metadata="Codex · interrupted by crash"
              secondaryMetadata="Pipeline · 2 of 5 steps paused"
              trailing={<Badge tone="warning">Waiting</Badge>}
              data-testid="lab-resume-queue"
            >
              <Notice
                errorSource="preview-home-and-resume-specimen"
                intent="destructive"
                role="none"
              >
                Could not resume: the worktree is missing.
              </Notice>
            </InterruptedSessionRow>
          </div>
        </SpecimenCell>
        <SpecimenCell
          label="Indented under a workspace and a worktree header"
          wide
        >
          <div className="w-full">
            <InterruptedSessionRow
              as="li"
              indent="group"
              title="Under a workspace"
              metadata="Claude · interrupted"
              data-testid="lab-resume-group"
            />
            <InterruptedSessionRow
              as="li"
              indent="worktree"
              title="Under a worktree"
              metadata="Claude · interrupted"
              data-testid="lab-resume-worktree"
            />
          </div>
        </SpecimenCell>
        <SpecimenCell
          label="Very long title truncates; masked in session replay"
          wide
        >
          <div className="w-80 max-w-full">
            <InterruptedSessionRow
              title="A chat title that is very long indeed and keeps going well past the edge of the dialog"
              replayMaskTitle
              context="A workspace named with a very long and descriptive name"
              replayMaskContext
              metadata="Claude · interrupted"
              trailing={<Button size="compact">Resume</Button>}
              data-testid="lab-resume-long"
            />
          </div>
        </SpecimenCell>
      </SpecimenPanel>

      <SpecimenPanel title="GuestModelGateContent">
        <SpecimenGrid min={320}>
          <SpecimenCell label="Sign in, then dismiss">
            <div className="w-full max-w-sm">
              <GuestModelGateContent
                subject={{ modelLabel: 'Opus', appName: 'Acme' }}
                renderSignIn={SignInLink}
                onDismiss={noop}
                dataTestId="lab-guest-gate-plain"
              />
            </div>
          </SpecimenCell>
          <SpecimenCell label="With a guest fallback model">
            <div className="w-full max-w-sm">
              <GuestModelGateContent
                subject={{ modelLabel: 'Opus', appName: 'Acme' }}
                fallback={{ label: 'Sonnet', onActivate: noop }}
                renderSignIn={SignInLink}
                onDismiss={noop}
                dataTestId="lab-guest-gate-fallback"
              />
            </div>
          </SpecimenCell>
          <SpecimenCell label="Sign in, then purchase">
            <div className="w-full max-w-sm">
              <GuestModelGateContent
                subject={{
                  modelLabel: 'Opus',
                  appName: 'Acme',
                  access: 'needs_sign_in_then_purchase',
                }}
                renderSignIn={SignInLink}
                onDismiss={noop}
                dataTestId="lab-guest-gate-purchase"
              />
            </div>
          </SpecimenCell>
          <SpecimenCell label="Busy: starting the guest chat">
            <div className="w-full max-w-sm">
              <GuestModelGateContent
                subject={{ modelLabel: 'Opus', appName: 'Acme' }}
                fallback={{ label: 'Sonnet', onActivate: noop }}
                renderSignIn={SignInLink}
                onDismiss={noop}
                busy
                status="Starting a guest chat…"
                dataTestId="lab-guest-gate-busy"
              />
            </div>
          </SpecimenCell>
          <SpecimenCell label="Error from the fallback">
            <div className="w-full max-w-sm">
              <GuestModelGateContent
                subject={{ modelLabel: 'Opus', appName: 'Acme' }}
                fallback={{ label: 'Sonnet', onActivate: noop }}
                renderSignIn={SignInLink}
                onDismiss={noop}
                error="Could not start a guest chat. Try again."
                dataTestId="lab-guest-gate-error"
              />
            </div>
          </SpecimenCell>
          <SpecimenCell label="Long model name">
            <div className="w-full max-w-sm">
              <GuestModelGateContent
                subject={{
                  modelLabel:
                    'A model whose display name is unusually long for a button',
                  appName: 'Acme',
                }}
                renderSignIn={SignInLink}
                onDismiss={noop}
                dataTestId="lab-guest-gate-long"
              />
            </div>
          </SpecimenCell>
        </SpecimenGrid>
      </SpecimenPanel>
    </div>
  );
}

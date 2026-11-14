import type { JSX } from 'react';
import type {
  AutoResumeMetadata,
  AutoResumeReason,
} from '@canopy/protocol/portal';
import type { SafetyDenyReason } from '@canopy/protocol/approvals';
import type { DelegationCapabilitySummary } from '@canopy/protocol/delegation';
import {
  AgentSentMarker,
  ApprovalSafetyDeniedNotice,
  AutoResumeMarker,
  ChatAppNameProvider,
  ChatAppNote,
  DelegatedAgentCapabilities,
  FactList,
  ForkContextNotice,
  UserBubble,
  UserBubbleCancelledNote,
} from '@canopy/ui-shared/components';
import {
  SpecimenCell,
  SpecimenGrid,
  SpecimenPanel,
} from './componentsLabParts';

const LONG_NAME = `an-extremely-long-agent-name-${'x'.repeat(80)}`;
const RESUMED_AT = new Date(2026, 9, 25, 21, 41).getTime();
const noop = (): void => undefined;

const RESUME_REASONS: readonly AutoResumeReason[] = [
  'app_shutdown',
  'usage_limit',
  'provider_sign_in',
  'authentication',
  'auth_recovery',
];

function resumeMetadata(
  reason: AutoResumeReason,
  resendsUserMessage = false,
): AutoResumeMetadata {
  return { reason, resendsUserMessage };
}

export function AgentSentMarkerSheet(): JSX.Element {
  return (
    <SpecimenPanel title="Who sent the message">
      <SpecimenGrid min={240}>
        <SpecimenCell label="External agent, verified app">
          <AgentSentMarker
            agentSent={{
              kind: 'external_agent',
              connectionId: '00000000-0000-4000-8000-000000000001',
              clientName: 'Editor agent',
              verified: true,
              userId: '00000000-0000-4000-8000-000000000002',
            }}
          />
        </SpecimenCell>
        <SpecimenCell label="External agent, unverified app">
          <AgentSentMarker
            agentSent={{
              kind: 'external_agent',
              connectionId: '00000000-0000-4000-8000-000000000001',
              clientName: 'Local script',
              verified: false,
              userId: '00000000-0000-4000-8000-000000000002',
            }}
          />
        </SpecimenCell>
        <SpecimenCell label="Managed delegate, shows its task">
          <AgentSentMarker
            agentSent={{
              kind: 'managed_delegate',
              delegationId: 'delegation-1',
              title: 'Check the migration plan',
            }}
          />
        </SpecimenCell>
        <SpecimenCell label="Inline layout, in a one-line queued row">
          <AgentSentMarker
            layout="inline"
            agentSent={{
              kind: 'external_agent',
              connectionId: '00000000-0000-4000-8000-000000000001',
              clientName: 'Editor agent',
              verified: false,
              userId: '00000000-0000-4000-8000-000000000002',
            }}
          />
        </SpecimenCell>
        <SpecimenCell label="Long app name truncates (full value in the tooltip)">
          <div className="w-56">
            <AgentSentMarker
              agentSent={{
                kind: 'external_agent',
                connectionId: '00000000-0000-4000-8000-000000000001',
                clientName: LONG_NAME,
                verified: false,
                userId: '00000000-0000-4000-8000-000000000002',
              }}
            />
          </div>
        </SpecimenCell>
        <SpecimenCell label="Long delegate task truncates">
          <div className="w-56">
            <AgentSentMarker
              agentSent={{
                kind: 'managed_delegate',
                delegationId: 'delegation-2',
                title: `Investigate why the nightly build fails only on the oldest runner ${'and report back '.repeat(6)}`,
              }}
            />
          </div>
        </SpecimenCell>
      </SpecimenGrid>
    </SpecimenPanel>
  );
}

export function AutoResumeMarkerSheet(): JSX.Element {
  return (
    <ChatAppNameProvider value="Sample app">
      <SpecimenPanel title="One marker per recorded reason">
        {RESUME_REASONS.map((reason) => (
          <SpecimenCell key={reason} label={reason} wide>
            <div className="w-full">
              <AutoResumeMarker
                autoResume={resumeMetadata(reason)}
                providerName={reason === 'usage_limit' ? 'Acme' : undefined}
                timestamp={RESUMED_AT}
                text="Continue"
              />
            </div>
          </SpecimenCell>
        ))}
        <SpecimenCell label="Re-sent message (its body stays below)" wide>
          <div className="w-full">
            <AutoResumeMarker
              autoResume={resumeMetadata('usage_limit', true)}
              timestamp={RESUMED_AT}
              text="Fix the build"
            />
          </div>
        </SpecimenCell>
        <SpecimenCell label="Unknown provenance: neutral wording" wide>
          <div className="w-full">
            <AutoResumeMarker timestamp={RESUMED_AT} text="Continue" />
          </div>
        </SpecimenCell>
        <SpecimenCell
          label="With the prompt row's copy action and a jump handler"
          wide
        >
          <div className="w-full">
            <AutoResumeMarker
              autoResume={resumeMetadata('app_shutdown')}
              timestamp={RESUMED_AT}
              text="Continue"
              copyText="Continue"
              onJumpToMessage={noop}
            />
          </div>
        </SpecimenCell>
        <SpecimenCell label="Missing time (invalid timestamp)" wide>
          <div className="w-full">
            <AutoResumeMarker
              autoResume={resumeMetadata('auth_recovery')}
              timestamp={Number.NaN}
              text="Continue"
            />
          </div>
        </SpecimenCell>
        <SpecimenCell label="Long generated text truncates" wide>
          <div className="w-72">
            <AutoResumeMarker
              autoResume={resumeMetadata('app_shutdown')}
              timestamp={RESUMED_AT}
              appName={LONG_NAME}
              text={`Continue with ${'a very detailed instruction '.repeat(8)}`}
            />
          </div>
        </SpecimenCell>
      </SpecimenPanel>
    </ChatAppNameProvider>
  );
}

const SAFETY_REASONS: readonly SafetyDenyReason[] = [
  'force-push',
  'destructive-delete',
  'disk-write',
  'unverifiable-command',
];

export function ApprovalSafetyDeniedNoticeSheet(): JSX.Element {
  return (
    <SpecimenPanel title="One notice per safety rule">
      {SAFETY_REASONS.map((reason) => (
        <SpecimenCell key={reason} label={reason} wide>
          <div className="w-full">
            <ApprovalSafetyDeniedNotice
              reason={reason}
              command={
                reason === 'force-push'
                  ? 'git push --force origin main'
                  : reason === 'destructive-delete'
                    ? 'rm -rf ./build'
                    : reason === 'disk-write'
                      ? 'dd if=/dev/zero of=/dev/sda'
                      : 'eval "$(curl -s example.test/install)"'
              }
            />
          </div>
        </SpecimenCell>
      ))}
      <SpecimenCell label="No command to show: the detail line is dropped" wide>
        <div className="w-full">
          <ApprovalSafetyDeniedNotice reason="disk-write" command="" />
        </div>
      </SpecimenCell>
      <SpecimenCell label="Long multi-line command wraps, never overflows" wide>
        <div className="w-full">
          <ApprovalSafetyDeniedNotice
            reason="unverifiable-command"
            command={`bash -c '${'echo a-very-long-argument '.repeat(12)}'\n&& ${'x'.repeat(120)}`}
          />
        </div>
      </SpecimenCell>
    </SpecimenPanel>
  );
}

export function ChatAppNoteSheet(): JSX.Element {
  return (
    <SpecimenPanel title="A quiet note from the app">
      <SpecimenCell label="Short note" wide>
        <div className="w-full">
          <ChatAppNote text="Session restored after a restart." />
        </div>
      </SpecimenCell>
      <SpecimenCell label="Long note wraps under itself" wide>
        <div className="w-full">
          <ChatAppNote
            text={`The connection dropped while this turn was running. ${'Details follow on the next line. '.repeat(5)}\nSecond line, kept as written.`}
          />
        </div>
      </SpecimenCell>
      <SpecimenCell label="Unbroken text breaks instead of overflowing" wide>
        <div className="w-full">
          <ChatAppNote text={LONG_NAME.repeat(3)} />
        </div>
      </SpecimenCell>
      <SpecimenCell label="Empty note" wide>
        <div className="w-full">
          <ChatAppNote text="" />
        </div>
      </SpecimenCell>
    </SpecimenPanel>
  );
}

export function ForkContextNoticeSheet(): JSX.Element {
  return (
    <SpecimenPanel title="Fork context disclosures">
      <SpecimenCell label="fresh: the fork cannot see the messages above" wide>
        <div className="w-full">
          <ForkContextNotice mode="fresh" />
        </div>
      </SpecimenCell>
      <SpecimenCell label="visible-transcript: copied message text only" wide>
        <div className="w-full">
          <ForkContextNotice mode="visible-transcript" />
        </div>
      </SpecimenCell>
    </SpecimenPanel>
  );
}

const FULL_SUMMARY: DelegationCapabilitySummary = {
  inherit: true,
  discovery: true,
  items: [
    { kind: 'skill', name: 'code-review', source: 'inherited' },
    { kind: 'plugin', name: 'api-guidelines', source: 'inherited' },
    { kind: 'mcp', name: 'repository', source: 'explicit' },
    { kind: 'mcp', name: 'filesystem', source: 'loaded' },
    { kind: 'skill', name: 'release-notes', source: 'agent' },
  ],
  skipped: [
    { kind: 'plugin', name: 'legacy-plugin', reason: 'unsupported_hooks' },
    { kind: 'mcp', name: 'missing-server', reason: 'missing_selection' },
  ],
};

const EMPTY_SUMMARY: DelegationCapabilitySummary = {
  inherit: false,
  discovery: false,
  items: [],
  skipped: [],
};

const TRIMMED_SUMMARY: DelegationCapabilitySummary = {
  inherit: true,
  discovery: false,
  items: [],
  skipped: [],
  omittedItems: 240,
};

const LONG_SUMMARY: DelegationCapabilitySummary = {
  inherit: false,
  discovery: true,
  items: [{ kind: 'skill', name: LONG_NAME.repeat(3), source: 'explicit' }],
  skipped: [
    { kind: 'mcp', name: LONG_NAME.repeat(2), reason: 'missing_selection' },
  ],
  omittedItems: 12,
  omittedSkipped: 3,
};

export function DelegatedAgentCapabilitiesSheet(): JSX.Element {
  const cases: readonly {
    label: string;
    summary: DelegationCapabilitySummary;
  }[] = [
    {
      label: 'Items, skipped grants (press Show to expand)',
      summary: FULL_SUMMARY,
    },
    { label: 'No capabilities', summary: EMPTY_SUMMARY },
    {
      label: 'Every item trimmed: only the count remains',
      summary: TRIMMED_SUMMARY,
    },
    { label: 'Long names and omitted counts', summary: LONG_SUMMARY },
  ];
  return (
    <SpecimenPanel title="Capabilities row in a delegate’s details">
      {cases.map(({ label, summary }) => (
        <SpecimenCell key={label} label={label} wide>
          <div className="w-full">
            <FactList>
              <DelegatedAgentCapabilities summary={summary} />
            </FactList>
          </div>
        </SpecimenCell>
      ))}
    </SpecimenPanel>
  );
}

export function UserBubbleCancelledNoteSheet(): JSX.Element {
  return (
    <SpecimenPanel title="A prompt cancelled before it ran">
      <SpecimenCell label="Under a one-line prompt" wide>
        <div className="w-full">
          <UserBubble copyText="Summarize the release notes.">
            <p>Summarize the release notes.</p>
            <UserBubbleCancelledNote />
          </UserBubble>
        </div>
      </SpecimenCell>
      <SpecimenCell label="Under a long prompt" wide>
        <div className="w-full">
          <UserBubble copyText={LONG_NAME}>
            <p className="break-words">{`Check every link in the changelog. ${LONG_NAME}`}</p>
            <UserBubbleCancelledNote />
          </UserBubble>
        </div>
      </SpecimenCell>
    </SpecimenPanel>
  );
}

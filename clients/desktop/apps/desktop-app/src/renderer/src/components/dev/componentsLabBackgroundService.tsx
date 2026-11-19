import { useEffect, useRef, type JSX, type ReactNode } from 'react';
import {
  projectRemoteW5Recovery,
  type BackgroundServiceStatus,
  type W5RecoveryStatus,
} from '@canopy/protocol/remote-control/shell';
import {
  BackgroundServiceNotice,
  W5RecoveryNotice,
  type W5RecoveryNoticeProps,
} from '@canopy/ui-shared/components';
import { backgroundServiceRepairCommand } from '@canopy/ui-shared/lib';
import { SpecimenCell, SpecimenPanel } from './componentsLabParts';

/**
 * The background service notice (CAN-7061) as it renders: inside the
 * blocked-changes banner through `W5RecoveryNotice`'s `service`, the same
 * composition desktop and Portal mount. Handlers only resolve fixtures.
 */

const NEVER = new Promise<never>(() => undefined);
const settle = (): Promise<void> => Promise.resolve();
const restartScheduled = (): Promise<boolean> => Promise.resolve(true);
// Fixture CLI name; hosts pass their branded one.
const REPAIR_COMMAND = backgroundServiceRepairCommand('app-cli');

/**
 * Presses or focuses the named button once on mount, so a busy, refused or
 * focused state shows without a pointer.
 */
function ActOnMount({
  act,
  children,
}: {
  readonly act: NonNullable<Case['act']>;
  readonly children: ReactNode;
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const { kind, testId } = act;
  useEffect(() => {
    const target = ref.current?.querySelector<HTMLButtonElement>(
      `[data-testid="${testId}"]`,
    );
    if (kind === 'press') target?.click();
    else target?.focus({ preventScroll: true });
  }, [kind, testId]);
  return (
    <div ref={ref} className="w-full">
      {children}
    </div>
  );
}

const outage: BackgroundServiceStatus = {
  state: 'unavailable',
  reason: 'connection_lost',
  retry: 'idle',
  sequence: 4,
};

const degradedHandoff: BackgroundServiceStatus = {
  state: 'unavailable',
  reason: 'start_failed',
  retry: 'idle',
  recovery: 'restart_app',
  handoff: 'writer_held',
  sequence: 2,
};

const endpointRepair: BackgroundServiceStatus = {
  state: 'unavailable',
  reason: 'endpoint_repair_required',
  retry: 'idle',
  sequence: 3,
};

const blocked: W5RecoveryStatus = {
  state: 'blocked',
  canRecover: false,
  reason: 'log-unavailable',
  entries: [
    {
      id: 'journals:interrupted-change',
      operation: 'core.workspace.update',
      detail: 'Interrupted workspace record update',
    },
  ],
};

// Like the desktop host: both handlers, whichever the status calls for.
const local = {
  repairCommand: REPAIR_COMMAND,
  onRetry: settle,
  onRestart: restartScheduled,
};

interface Case {
  readonly label: string;
  readonly props: W5RecoveryNoticeProps;
  /** A notice button to press or focus on mount, by test id. */
  readonly act?: {
    readonly kind: 'press' | 'focus';
    readonly testId: string;
  };
}

const RETRY = 'background-service-notice-retry';
const RESTART = 'background-service-notice-restart';

const desktopCases: readonly Case[] = [
  {
    label: 'Outage with no blocked changes: the notice alone, Try again',
    props: { service: { ...local, status: outage } },
  },
  {
    label: 'Outage with blocked changes: Try again above the banner',
    props: {
      status: blocked,
      canRecover: true,
      service: { ...local, status: outage },
    },
  },
  {
    label: 'Try again focused',
    props: { service: { ...local, status: outage } },
    act: { kind: 'focus', testId: RETRY },
  },
  {
    label: 'Try again busy: the service reports a retry running',
    props: { service: { ...local, status: { ...outage, retry: 'running' } } },
  },
  {
    label: 'Try again busy: pressed, waiting on the answer',
    props: { service: { ...local, onRetry: () => NEVER, status: outage } },
    act: { kind: 'press', testId: RETRY },
  },
  {
    label: 'Try again failed',
    props: {
      status: blocked,
      canRecover: true,
      service: { ...local, status: { ...outage, retry: 'failed' } },
    },
  },
  {
    label: 'Degraded startup handoff: Restart app, no Try again',
    props: {
      status: blocked,
      canRecover: true,
      service: { ...local, status: degradedHandoff },
    },
  },
  {
    label: 'Degraded startup before Files opens: Restart app alone',
    props: { service: { ...local, status: degradedHandoff } },
  },
  {
    label: 'Restart app busy: pressed, waiting on the restart',
    props: {
      service: {
        ...local,
        onRestart: () => NEVER,
        status: degradedHandoff,
      },
    },
    act: { kind: 'press', testId: RESTART },
  },
  {
    label: 'Restart app refused: quit and reopen guidance',
    props: {
      service: {
        ...local,
        onRestart: () => Promise.resolve(false),
        status: degradedHandoff,
      },
    },
    act: { kind: 'press', testId: RESTART },
  },
  {
    label: 'Endpoint repair: run the repair command, then Try again',
    props: { service: { ...local, status: endpointRepair } },
  },
  {
    label: 'Endpoint repair after a degraded handoff: then Restart app',
    props: {
      service: {
        ...local,
        status: {
          ...endpointRepair,
          recovery: 'restart_app',
          handoff: 'endpoint_repair_required',
        },
      },
    },
  },
  {
    label: 'Endpoint repair still failing after Try again',
    props: {
      service: { ...local, status: { ...endpointRepair, retry: 'failed' } },
    },
  },
];

const remote = { repairCommand: REPAIR_COMMAND };

const remoteControlCases: readonly Case[] = [
  {
    label: 'Outage: Copy diagnostics only, Try again on the paired computer',
    props: {
      status: projectRemoteW5Recovery(blocked),
      service: { ...remote, status: outage },
    },
  },
  {
    label: 'Try again failed on the paired computer',
    props: { service: { ...remote, status: { ...outage, retry: 'failed' } } },
  },
  {
    label: 'Degraded startup handoff: restart the app on the paired computer',
    props: {
      status: projectRemoteW5Recovery(blocked),
      service: { ...remote, status: degradedHandoff },
    },
  },
  {
    label: 'Endpoint repair on the paired computer, then Try again there',
    props: { service: { ...remote, status: endpointRepair } },
  },
  {
    label: 'Endpoint repair on the paired computer, then restart there',
    props: {
      service: {
        ...remote,
        status: {
          ...endpointRepair,
          recovery: 'restart_app',
          handoff: 'endpoint_repair_required',
        },
      },
    },
  },
  {
    label:
      'Endpoint repair without a repair command from the host: generic copy',
    props: { service: { status: endpointRepair } },
  },
];

const longTextCases: readonly Case[] = [
  {
    label: 'Long unbroken repair command with six long blocked entries',
    props: {
      status: {
        ...blocked,
        entries: Array.from({ length: 6 }, (_, index) => ({
          id: `journals:long-${index}`,
          operation: 'core.workspace.update',
          detail: 'Long diagnostic detail. '.repeat(12),
        })),
      },
      canRecover: true,
      service: {
        ...local,
        repairCommand: backgroundServiceRepairCommand(
          `app-cli-${'x'.repeat(120)}`,
        ),
        status: endpointRepair,
      },
    },
  },
  {
    label: 'Long repair command on the paired computer after a handoff',
    props: {
      service: {
        repairCommand: backgroundServiceRepairCommand(
          `app-cli-${'long-segment-'.repeat(10)}preview`,
        ),
        status: {
          ...endpointRepair,
          recovery: 'restart_app',
          handoff: 'endpoint_repair_required',
        },
      },
    },
  },
];

function Cases({ cases }: { readonly cases: readonly Case[] }): JSX.Element {
  return (
    <>
      {cases.map(({ label, props, act }) => (
        <SpecimenCell key={label} label={label} wide>
          {act ? (
            <ActOnMount act={act}>
              <W5RecoveryNotice {...props} />
            </ActOnMount>
          ) : (
            <div className="w-full">
              <W5RecoveryNotice {...props} />
            </div>
          )}
        </SpecimenCell>
      ))}
    </>
  );
}

export function BackgroundServiceSpecimen(): JSX.Element {
  return (
    <div className="flex flex-col gap-6">
      <SpecimenPanel title="This computer: Try again, Restart app and Copy diagnostics">
        <Cases cases={desktopCases} />
      </SpecimenPanel>
      <SpecimenPanel title="Portal: Copy diagnostics and owning-computer guidance, no action">
        <Cases cases={remoteControlCases} />
      </SpecimenPanel>
      <SpecimenPanel title="Long text">
        <Cases cases={longTextCases} />
      </SpecimenPanel>
      <SpecimenPanel title="Hidden: reached, or reconnecting before a restart fails">
        {(['ok', 'reconnecting'] as const).map((state) => (
          <SpecimenCell key={state} label={`${state}: no notice`} wide>
            <div className="w-full">
              <BackgroundServiceNotice
                {...local}
                status={{ state, retry: 'idle', sequence: 1 }}
              />
            </div>
          </SpecimenCell>
        ))}
      </SpecimenPanel>
    </div>
  );
}

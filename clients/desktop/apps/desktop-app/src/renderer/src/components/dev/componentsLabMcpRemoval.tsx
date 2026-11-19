import { useMemo, useState, type JSX } from 'react';
import type { CanopyClient } from '@canopy/app-core';
import { McpRemovalRepair } from '@canopy/ui-app/capability';
import { Button } from '@canopy/ui-shared/components';
import { SpecimenPanel } from './componentsLabParts';

const token = '11111111-1111-4111-8111-111111111111';
const scenarios = [
  'Damaged server and unresolved index',
  'Readable server',
  'Unreadable server',
  'Missing server',
  'Newer server format',
  'Unexpected file',
  'Repair unavailable',
  'Inspection only',
  'Empty discovery',
  'Incomplete discovery',
  'Discovery error',
  'Inspection error',
  'Inspection busy',
  'Preservation unavailable',
  'Saved uninstall',
  'Removal busy',
  'Removal error',
  'Removal pending',
  'Removal unknown',
  'Removal refused',
  'Removal complete',
  'Uninstall pending',
  'Uninstall complete',
  'Long server ID',
] as const;
type Scenario = (typeof scenarios)[number];

function fixture(scenario: Scenario): CanopyClient {
  const serverId = scenario === 'Long server ID' ? 'a'.repeat(256) : 'a1';
  const unexpected = (): Promise<never> =>
    Promise.reject(new Error('This sheet has no live backend.'));
  const fail = (): Promise<never> =>
    Promise.reject(
      new Error('The device could not complete the request. Inspect again.'),
    );
  const pending = (): Promise<void> =>
    new Promise((resolve) => window.setTimeout(resolve, 3_000));
  return {
    capabilities: {
      mcpRemoval: scenario !== 'Repair unavailable',
      mcpRemovalForce:
        scenario !== 'Repair unavailable' && scenario !== 'Inspection only',
      localExecution: false,
      terminalPty: false,
      fileSystemAccess: 'none',
      voice: false,
      settingsScope: 'api-keys-only',
      pipelines: 'read-only',
      routing: 'in-memory',
      overviewNotifications: false,
    },
    query: unexpected,
    command: unexpected,
    subscribe: () => () => undefined,
    mcpRemoval: {
      candidates: async () => {
        if (scenario === 'Discovery error') return fail();
        return {
          candidates:
            scenario === 'Empty discovery'
              ? []
              : [
                  {
                    serverId,
                    pendingUninstall: scenario === 'Saved uninstall',
                  },
                ],
          incomplete: scenario === 'Incomplete discovery',
        };
      },
      inspect: async (request) => {
        if (scenario === 'Inspection error') return fail();
        if (scenario === 'Inspection busy') await pending();
        return {
          serverId: request.serverId,
          target:
            scenario === 'Readable server'
              ? 'valid'
              : scenario === 'Unreadable server'
                ? 'unreadable'
                : scenario === 'Missing server'
                  ? 'absent'
                  : scenario === 'Newer server format'
                    ? 'unsupported'
                    : scenario === 'Unexpected file'
                      ? 'unexpected'
                      : 'malformed',
          index: 'malformed',
          scope:
            scenario === 'Preservation unavailable'
              ? 'unavailable'
              : 'preserve-evidence',
          inspectedState: token,
          recoveries:
            scenario === 'Saved uninstall'
              ? [
                  {
                    recoveryId: token,
                    custody: true,
                    credentials: false,
                    index: 'unresolved',
                  },
                ]
              : [],
        };
      },
      force: async (request) => {
        if (scenario === 'Removal error') return fail();
        if (scenario === 'Removal busy') await pending();
        const complete =
          scenario === 'Removal complete' ||
          scenario === 'Uninstall pending' ||
          scenario === 'Uninstall complete';
        return {
          serverId: request.serverId,
          status: complete
            ? 'complete'
            : scenario === 'Removal pending'
              ? 'pending'
              : scenario === 'Removal unknown'
                ? 'unknown'
                : scenario === 'Removal refused'
                  ? 'refused'
                  : 'unresolved',
          recoveryId: token,
          custody: true,
          credentials: scenario !== 'Removal pending',
          index: complete ? 'complete' : 'unresolved',
          ...(scenario === 'Uninstall pending'
            ? { uninstall: 'pending' as const }
            : scenario === 'Uninstall complete'
              ? { uninstall: 'complete' as const }
              : {}),
        };
      },
    },
  };
}

/** Exercise real disclosure, validation, focus, confirmation and async states without IPC. */
export function McpRemovalSpecimen(): JSX.Element {
  const [scenario, setScenario] = useState<Scenario>(scenarios[0]);
  const client = useMemo(() => fixture(scenario), [scenario]);
  return (
    <div className="flex flex-col gap-6">
      <SpecimenPanel title="Choose a device repair fixture">
        <div className="flex flex-wrap gap-2">
          {scenarios.map((item) => (
            <Button
              key={item}
              variant={scenario === item ? 'secondary' : 'ghost'}
              onClick={() => setScenario(item)}
            >
              {item}
            </Button>
          ))}
        </div>
      </SpecimenPanel>
      <SpecimenPanel title={scenario}>
        <p className="text-pretty">
          Open repair, select a discovered ID, inspect, then review the
          destructive confirmation. An empty ID disables inspection; type an
          invalid ID to see validation. Hover, press, and keyboard-focus the
          real controls. Busy fixtures settle after three seconds.
        </p>
        <McpRemovalRepair key={scenario} client={client} />
      </SpecimenPanel>
    </div>
  );
}

import {
  INTERFACE_RELAY_ALLOWLIST,
  type InterfaceRelayAccessMode,
  type InterfaceRelayOperationKind,
} from '../interface-allowlist.generated';
import { RENDERER_RELAY_SURFACES, relayAllows } from '../surface-allowlist';
import { RELAY_DEFINITIONS } from '../definitions';
import { RENDERER_RELAY_GRANTS } from '../../../ipc/canopy-core-relay';

// CAN-5771: the daemon owner's host request channel stays out of every
// renderer relay surface, so no renderer, Portal session or bridge client
// reaches it or sends an owner proof.
const HOST_REQUEST_OPERATIONS = [
  'worker.pipeline.hostRequests',
  'worker.pipeline.hostRequest.respond',
];
const MODES: readonly InterfaceRelayAccessMode[] = [
  'authority',
  'replica',
  'delegated-execution',
  'read-only',
  'owner',
];
const KINDS: readonly InterfaceRelayOperationKind[] = [
  'query',
  'instruction',
  'stream',
];

describe('renderer relay host requests (CAN-5771)', () => {
  it('no relay surface or access mode admits the host request operations', () => {
    const admitted: string[] = [];
    for (const surface of RENDERER_RELAY_SURFACES)
      for (const kind of KINDS)
        for (const mode of MODES)
          for (const name of HOST_REQUEST_OPERATIONS)
            if (relayAllows(surface, kind, name, mode))
              admitted.push(`${surface} ${kind} ${mode} ${name}`);
    expect(admitted).toEqual([]);
    const generated = JSON.stringify(INTERFACE_RELAY_ALLOWLIST);
    for (const name of HOST_REQUEST_OPERATIONS)
      expect(generated.includes(name)).toBe(false);
  });

  it("the relay never initializes on a renderer's behalf", () => {
    expect(relayAllows('main', 'query', 'core.runtime.initialize')).toBe(false);
  });
});

// CAN-7197: source-change apply adds the worktree lifecycle grant to its own
// calls only; the renderer relay, which derives its grants from the
// definitions it reaches, withholds it while keeping worker.git.write.
describe('renderer relay worktree lifecycle grant (CAN-7197)', () => {
  it('no renderer relay caller holds worker.git.worktree.write', () => {
    expect(
      RELAY_DEFINITIONS.instructions['worker.git.worktree.add']?.requiredGrants,
    ).toEqual(['worker.git.worktree.write']);
    expect(RENDERER_RELAY_GRANTS).not.toContain('worker.git.worktree.write');
    expect(RENDERER_RELAY_GRANTS).toContain('worker.git.write');
  });
});

/** CAN-4730 E2-G: the owner's fence publish never reaches a renderer or any interface caller. */
import { CORE_MUTATION_FENCE_INSTRUCTION_DEFINITIONS } from '@canopy/protocol/canopy-core';
import {
  INTERFACE_RELAY_ALLOWLIST,
  type InterfaceRelayAccessMode,
} from '../interface-allowlist.generated';
import { RENDERER_RELAY_SURFACES, relayAllows } from '../surface-allowlist';

it('lists no mutation fence operation in any access mode, and relays none to any surface', () => {
  const modes: readonly InterfaceRelayAccessMode[] = [
    'authority',
    'replica',
    'delegated-execution',
    'read-only',
    'owner',
  ];
  expect(Object.keys(INTERFACE_RELAY_ALLOWLIST).sort()).toEqual(
    [...modes].sort(),
  );
  for (const mode of modes)
    for (const names of Object.values(INTERFACE_RELAY_ALLOWLIST[mode]))
      expect(
        names.filter((name) => name.startsWith('core.mutationFence.')),
      ).toEqual([]);
  for (const name of Object.keys(CORE_MUTATION_FENCE_INSTRUCTION_DEFINITIONS))
    for (const surface of RENDERER_RELAY_SURFACES)
      for (const mode of modes)
        expect(relayAllows(surface, 'instruction', name, mode)).toBe(false);
});

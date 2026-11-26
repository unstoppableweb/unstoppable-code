/**
 * The `--remote-control` hooks `runPerformanceScenarioAttempt` calls
 * (CAN-7852): `controller.mjs`, where the scenario app controls scripted
 * computers. (The other direction, where scripted controllers control the
 * scenario app, is CAN-7910.) Order: `prepareRemoteControl` after the fixture is seeded,
 * `connectRemoteControl` after the shell is ready,
 * `markRemoteControlCaptureStart` once the monitor is running,
 * `markRemoteControlCaptureEnd` as the monitor stops,
 * `verifyRemoteControlCapture` after it has stopped, and
 * `teardownRemoteControl` before the app closes, always.
 */
import {
  connectRemoteControlController,
  markRemoteControlCaptureEnd as markControllerCaptureEnd,
  markRemoteControlCaptureStart as markControllerCaptureStart,
  prepareRemoteControlController,
  remoteControlPartialEvidence as controllerPartialEvidence,
  teardownRemoteControlController,
  verifyRemoteControlCapture as verifyControllerCapture,
} from './controller.mjs';

export { REMOTE_CONTROL_ELECTRON_ARGS } from './controller.mjs';

const ROLES = Object.freeze({
  controller: {
    prepare: prepareRemoteControlController,
    connect: connectRemoteControlController,
    markCaptureStart: markControllerCaptureStart,
    markCaptureEnd: markControllerCaptureEnd,
    verify: verifyControllerCapture,
    partialEvidence: controllerPartialEvidence,
    teardown: teardownRemoteControlController,
  },
});

function hooks(session) {
  return ROLES[session.config.role];
}

/** Before launch; returns the attempt's session. */
export async function prepareRemoteControl({ config, runtime, userDataDir }) {
  const role = ROLES[config.role];
  if (!role)
    throw new Error(`Unknown --remote-control role ${String(config.role)}`);
  if (runtime && runtime.role !== config.role)
    throw new Error(
      `The run's Remote Control runtime serves --remote-control ${String(runtime.role)}, not ${config.role}`,
    );
  return role.prepare({ config, runtime, userDataDir });
}

/** After the shell is ready and before the measured window. */
export function connectRemoteControl(session, { page, electronApp }) {
  return hooks(session).connect(session, { page, electronApp });
}

/** Just before the monitor starts. */
export function markRemoteControlCaptureStart(session) {
  return hooks(session).markCaptureStart(session);
}

export function markRemoteControlCaptureEnd(session) {
  return hooks(session).markCaptureEnd(session);
}

/** Just after the monitor stops; throws when a connection did not hold. */
export function verifyRemoteControlCapture(session) {
  return hooks(session).verify(session);
}

/** What is known so far, for a failed attempt's record. */
export function remoteControlPartialEvidence(session) {
  return hooks(session).partialEvidence(session);
}

/** Before the app closes, whatever failed. Never throws. */
export function teardownRemoteControl(session) {
  return hooks(session).teardown(session);
}

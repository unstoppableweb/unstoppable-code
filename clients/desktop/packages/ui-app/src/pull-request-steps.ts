// Dedicated entry for the pure Portal PR step planner (REG-3025). The web's
// always-loaded PR hook imports THIS subpath instead of `./pull-requests` so
// the chat route does not carry the header's components until they render.
export {
  remoteControlPlannedSteps,
  type RemoteControlPullRequestStep,
} from './code/pull-requests/pull-request-planned-steps';

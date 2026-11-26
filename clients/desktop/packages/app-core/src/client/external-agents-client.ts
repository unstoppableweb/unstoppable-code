import type {
  ExternalAgentAccessUpdate,
  ExternalAgentConnectionDetail,
  ExternalAgentPendingAction,
  ExternalAgentsOverview,
  ExternalAgentDesktopList,
  ExternalAgentComputerConnectOutcome,
  ExternalAgentComputerList,
  ExternalAgentComputerRemoval,
} from '@canopy/protocol/external-agents';

/** Why an External agents operation did not apply. */
export type ExternalAgentsFailure =
  /** Not this person's connection, already removed, or the page is off. */
  | 'not_found'
  /**
   * The connection changed since it was loaded, or a request was already
   * decided; reload before acting again.
   */
  | 'conflict'
  /** The connection has ended and can no longer be edited, paused or resumed. */
  | 'expired'
  /** The chosen access cannot be granted (for example over 80 tools). */
  | 'invalid_policy'
  /** The request did not reach a decision (network or server error). */
  | 'unavailable';

export type ExternalAgentsResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: ExternalAgentsFailure };

/**
 * Host-bound operations behind the External agents pages. Server
 * authorization remains authoritative: every call is checked against the
 * signed-in owner and the feature flag.
 */
export interface ExternalAgentsClient {
  getOverview(): Promise<ExternalAgentsResult<ExternalAgentsOverview>>;
  getConnection(
    connectionId: string,
  ): Promise<ExternalAgentsResult<ExternalAgentConnectionDetail>>;
  updateAccess(
    connectionId: string,
    update: ExternalAgentAccessUpdate,
  ): Promise<ExternalAgentsResult<ExternalAgentConnectionDetail>>;
  pause(
    connectionId: string,
    revision: number,
  ): Promise<ExternalAgentsResult<ExternalAgentConnectionDetail>>;
  resume(
    connectionId: string,
    revision: number,
  ): Promise<ExternalAgentsResult<ExternalAgentConnectionDetail>>;
  /** Removes the connection and invalidates every token at once. */
  remove(connectionId: string): Promise<ExternalAgentsResult<null>>;
  /** One request an agent asked the person to confirm. */
  getPendingAction(
    pendingActionId: string,
  ): Promise<ExternalAgentsResult<ExternalAgentPendingAction>>;
  /** Confirm runs the action once; decline ends it without running. */
  decidePendingAction(
    pendingActionId: string,
    decision: 'confirm' | 'decline',
  ): Promise<ExternalAgentsResult<ExternalAgentPendingAction>>;
  /** How many requests wait for the person across their connections. */
  getWaitingCount(): Promise<ExternalAgentsResult<number>>;
  /** Every desktop the person has paired, for the desktop selector. */
  listDesktops(): Promise<ExternalAgentsResult<ExternalAgentDesktopList>>;
  /**
   * Computers hosted agents can work on over the direct Remote Control
   * protocol (CAN-5985). Absent where the host cannot pair them; the page
   * then omits the section.
   */
  readonly computers?: ExternalAgentComputersClient;
}

export interface ExternalAgentComputersClient {
  list(): Promise<ExternalAgentsResult<ExternalAgentComputerList>>;
  /**
   * Asks the computer to approve hosted agents. `onCode` receives the code to
   * compare on the computer. Aborting stops waiting and cancels the request.
   */
  connect(
    deviceId: string,
    onCode: (code: string) => void,
    signal: AbortSignal,
  ): Promise<ExternalAgentsResult<ExternalAgentComputerConnectOutcome>>;
  remove(
    remoteId: string,
  ): Promise<ExternalAgentsResult<ExternalAgentComputerRemoval>>;
}

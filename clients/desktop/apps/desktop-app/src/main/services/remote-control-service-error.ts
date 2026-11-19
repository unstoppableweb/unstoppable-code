export type RemoteControlServiceErrorCode =
  | 'invalid_payload'
  | 'invalid_target'
  | 'not_found'
  | 'execution_failed'
  | 'github_not_connected';

export class RemoteControlServiceError extends Error {
  public constructor(
    public readonly code: RemoteControlServiceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'RemoteControlServiceError';
  }
}

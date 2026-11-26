/** A placement decision raised before any daemon create/restore is dispatched. */
export class TerminalRecordAdmissionDeferred extends Error {
  public constructor() {
    super('Terminal record custody is not ready for daemon attribution.');
    this.name = 'TerminalRecordAdmissionDeferred';
  }
}

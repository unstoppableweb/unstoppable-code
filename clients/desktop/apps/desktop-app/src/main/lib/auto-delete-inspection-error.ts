/** No lifecycle verdict was reached; background callers may inspect again. */
export class AutoDeleteInspectionError extends Error {
  constructor(readonly inspectionCause: unknown) {
    super(
      inspectionCause instanceof Error
        ? inspectionCause.message
        : String(inspectionCause),
    );
    this.name = 'AutoDeleteInspectionError';
  }
}

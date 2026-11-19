/** A local Ledger authority's connection epoch, not the run's lifetime. */
export class PipelineLedgerOwnerLifetime {
  private epoch: AbortController | null = new AbortController();

  current(): AbortSignal | null {
    return this.epoch?.signal ?? null;
  }

  setAvailable(available: boolean): void {
    if (available) {
      this.epoch ??= new AbortController();
      return;
    }
    const previous = this.epoch;
    this.epoch = null;
    // Reconnection creates a fresh epoch; issued tools never regain authority.
    previous?.abort();
  }
}

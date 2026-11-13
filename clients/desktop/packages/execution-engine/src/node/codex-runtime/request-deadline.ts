/**
 * A request timeout that can be suspended and resumed.
 *
 * Codex app-server request timeouts measure app-server responsiveness. While
 * the connection deliberately stops reading the shared stdout (the retained
 * frame byte cap in `OwnerAdmissionLanes`), a reply can sit unread in the pipe
 * through no fault of the app-server, so the deadline is suspended for that
 * interval and resumes with its remaining budget. Once the response frame has
 * been read, the deadline is cancelled even if delivery to its owner is still
 * queued behind that owner's admission.
 */
export class RequestDeadline {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private remainingMs: number;
  private armedAt = 0;
  private state: 'idle' | 'running' | 'suspended' | 'done' = 'idle';

  constructor(
    timeoutMs: number,
    private readonly onExpire: () => void,
    private readonly now: () => number = Date.now,
  ) {
    this.remainingMs = timeoutMs;
  }

  /** Starts the deadline, or parks it until `resume()` when `suspended`. */
  start(suspended: boolean): void {
    if (this.state !== 'idle') return;
    if (suspended) {
      this.state = 'suspended';
      return;
    }
    this.arm();
  }

  suspend(): void {
    if (this.state !== 'running') return;
    this.clearTimer();
    this.remainingMs = Math.max(
      0,
      this.remainingMs - Math.max(0, this.now() - this.armedAt),
    );
    this.state = 'suspended';
  }

  resume(): void {
    if (this.state !== 'suspended') return;
    this.arm();
  }

  cancel(): void {
    this.clearTimer();
    this.state = 'done';
  }

  isSuspended(): boolean {
    return this.state === 'suspended';
  }

  private arm(): void {
    this.state = 'running';
    this.armedAt = this.now();
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.state !== 'running') return;
      this.state = 'done';
      this.onExpire();
    }, this.remainingMs);
    this.timer.unref?.();
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

import type {
  RemoteTerminals,
  TerminalAttachment,
  TerminalAttachmentRequest,
  TerminalCreateRequest,
  TerminalKillAllOptions,
  TerminalRestoreRequest,
  TerminalWorktreeScope,
  WorkerTerminalEvent,
  WorkerTerminalEventListener,
  WorkerTerminalPort,
} from '@canopy/core-runtime/node/terminal';
import type {
  TerminalAttachResponse,
  TerminalSession,
  TerminalShellProfile,
} from '@canopy/protocol/terminal';

/**
 * The `worker.terminal` port every main-process caller uses: the in-process
 * engine, plus eligible local window terminals placed
 * in the daemon's terminal host (CAN-5088). New terminals from the port's own
 * `create` stay in process; only the renderer route places one in the daemon.
 * Every call naming a terminal reaches whichever side holds it, and
 * worktree-wide calls reach both, so auto-archive, cleanup, runtime status
 * and quit treat daemon terminals as their own.
 */
export class RoutedWorkerTerminal implements WorkerTerminalPort {
  private daemon: RemoteTerminals | undefined;

  private sink: WorkerTerminalEventListener = (): void => undefined;

  private readonly listeners = new Set<WorkerTerminalEventListener>();

  public constructor(private readonly engine: WorkerTerminalPort) {
    engine.setEventSink((event) => this.emit(event));
  }

  /** Daemon terminals, once the route first places one. */
  public get daemonTerminals(): RemoteTerminals | undefined {
    return this.daemon;
  }

  public useDaemonTerminals(daemon: RemoteTerminals): void {
    this.daemon = daemon;
  }

  /** Daemon terminals report their events here. */
  public emit(event: WorkerTerminalEvent): void {
    this.sink(event);
    for (const listener of this.listeners) listener(event);
  }

  private inDaemon(terminalId: string): RemoteTerminals | undefined {
    return this.daemon?.has(terminalId) ? this.daemon : undefined;
  }

  public create(request: TerminalCreateRequest): TerminalSession {
    return this.engine.create(request);
  }

  public restore(request: TerminalRestoreRequest): TerminalSession {
    return this.engine.restore(request);
  }

  public list(): TerminalSession[] {
    return [...this.engine.list(), ...(this.daemon?.list() ?? [])];
  }

  public get(terminalId: string): TerminalSession | null {
    return (
      this.inDaemon(terminalId)?.get(terminalId) ?? this.engine.get(terminalId)
    );
  }

  public replay(terminalId: string): TerminalAttachResponse {
    return (
      this.inDaemon(terminalId)?.replay(terminalId) ??
      this.engine.replay(terminalId)
    );
  }

  public attach(request: TerminalAttachmentRequest): TerminalAttachment {
    // No in-process client opens attachments to daemon terminals; windows read replay and the event sink (CAN-4148 D13). CAN-5092 ends main's mirror.
    if (this.inDaemon(request.terminalId))
      throw new Error(`Terminal not found: ${request.terminalId}`);
    return this.engine.attach(request);
  }

  public acknowledgeAttachment(attachmentId: string, offset: number): void {
    this.engine.acknowledgeAttachment(attachmentId, offset);
  }

  public releaseAttachment(attachmentId: string): void {
    this.engine.releaseAttachment(attachmentId);
  }

  public replayText(terminalId: string): string | null {
    const daemon = this.inDaemon(terminalId);
    return daemon
      ? daemon.replayText(terminalId)
      : this.engine.replayText(terminalId);
  }

  public write(terminalId: string, data: string): void {
    const daemon = this.inDaemon(terminalId);
    if (daemon) daemon.write(terminalId, data);
    else this.engine.write(terminalId, data);
  }

  public resize(terminalId: string, cols: number, rows: number): void {
    const daemon = this.inDaemon(terminalId);
    if (daemon) daemon.resize(terminalId, cols, rows);
    else this.engine.resize(terminalId, cols, rows);
  }

  public kill(terminalId: string, options?: { signal?: string | null }): void {
    const daemon = this.inDaemon(terminalId);
    if (daemon) daemon.kill(terminalId, options?.signal);
    else this.engine.kill(terminalId, options);
  }

  public killWorktree(scope: TerminalWorktreeScope): void {
    this.engine.killWorktree(scope);
    this.daemon?.killWorktree(scope);
  }

  public killAll(options?: TerminalKillAllOptions): void {
    this.engine.killAll(options);
    void this.daemon?.killAll(options);
  }

  public release(terminalId: string): Promise<void> {
    const daemon = this.inDaemon(terminalId);
    return daemon
      ? daemon.release(terminalId)
      : this.engine.release(terminalId);
  }

  public async releaseWorktree(scope: TerminalWorktreeScope): Promise<void> {
    const results = await Promise.allSettled([
      this.engine.releaseWorktree(scope),
      this.daemon?.releaseWorktree(scope),
    ]);
    const failed = results.find((result) => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
  }

  public hasLiveTerminals(scope: TerminalWorktreeScope): boolean {
    return (
      this.engine.hasLiveTerminals(scope) ||
      (this.daemon?.hasLiveTerminals(scope) ?? false)
    );
  }

  public runningWorktrees(): TerminalWorktreeScope[] {
    const seen = new Set<string>();
    return [
      ...this.engine.runningWorktrees(),
      ...(this.daemon?.runningWorktrees() ?? []),
    ].filter(({ projectId, worktreeId }) => {
      const key = `${projectId}\u0000${worktreeId}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  public lowerPriority(terminalId: string): void {
    // Daemon terminals run in their own host; only managed callers lower one.
    if (!this.inDaemon(terminalId)) this.engine.lowerPriority(terminalId);
  }

  public profiles(): TerminalShellProfile[] {
    return this.engine.profiles();
  }

  public defaultShellBasename(): string {
    return this.engine.defaultShellBasename();
  }

  public prewarmShell(): Promise<void> {
    return this.engine.prewarmShell();
  }

  public setEventSink(sink: WorkerTerminalEventListener): void {
    this.sink = sink;
  }

  public addEventListener(listener: WorkerTerminalEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

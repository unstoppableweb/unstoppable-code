/**
 * Each live delegate run's working directory and root chat (CAN-6031): the
 * directory its tools use, which the watcher host resolves a delegate's
 * WatchCommand and WatchGitHubItems directory from. An entry lives as long as
 * the run that registered it.
 */
export class DelegationWorkingDirectories {
  private readonly directories = new Map<
    string,
    { readonly chatId: string; readonly cwd: string }
  >();

  /**
   * Records a run's directory and returns the cleanup that removes it; a
   * later run of the same delegation replaces it, and an earlier run's
   * cleanup then leaves the later entry alone.
   */
  register(delegationId: string, chatId: string, cwd: string): () => void {
    const directory = { chatId, cwd };
    this.directories.set(delegationId, directory);
    return (): void => {
      if (this.directories.get(delegationId) === directory)
        this.directories.delete(delegationId);
    };
  }

  /** The live run's directory when its root chat is `chatId`. */
  get(delegationId: string, chatId: string): string | undefined {
    const directory = this.directories.get(delegationId);
    return directory?.chatId === chatId ? directory.cwd : undefined;
  }
}

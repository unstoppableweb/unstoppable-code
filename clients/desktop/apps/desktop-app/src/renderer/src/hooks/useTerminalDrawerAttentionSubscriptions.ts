import { useEffect } from 'react';
import { useTerminalDrawerAttentionStore } from '@/stores/terminalDrawerAttentionStore';

export function useTerminalDrawerAttentionSubscriptions(): void {
  useEffect(() => {
    const store = useTerminalDrawerAttentionStore.getState();
    const running = window.api.terminal.onRunningChanged((event) =>
      store.applyRunning(event),
    );
    const output = window.api.terminal.onOutput((event) =>
      store.applyOutput(event),
    );
    // A terminal this window reads on its own connection (CAN-8070).
    const progress = window.api.terminal.onOutputProgress((event) =>
      store.applyOutput(event),
    );
    const exit = window.api.terminal.onExit((event) => store.applyExit(event));
    const spawned = window.api.terminal.onSpawned((session) =>
      store.applyRunning({
        projectId: session.projectId,
        worktreeId: session.worktreeId,
        terminalId: session.id,
        running: false,
        processName: null,
      }),
    );
    void window.api.terminal
      .list()
      .then((sessions) => store.reconcileSessions(sessions))
      .catch(() => undefined);
    return (): void => {
      running();
      output();
      progress();
      exit();
      spawned();
    };
  }, []);
}

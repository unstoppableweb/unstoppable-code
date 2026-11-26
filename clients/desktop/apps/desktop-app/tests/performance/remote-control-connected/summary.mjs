/** The result caveat for a run's `config.remoteControl` (CAN-7852). */
export function remoteControlCaveat(config) {
  const timing =
    'The connection is set up after the shell is ready and before the measured window, so durationMs includes it (remoteControl.setup.totalMs). Compare only with runs using the same --remote-control options.';
  return `Remote Control connected (--remote-control ${config.role}): the scenario app is signed in to the mock cloud and its main window holds ${String(config.peers)} scripted paired computer(s) in one-window mode, re-reading each one's ${String(config.tasks)}-task session snapshot on every stale push (one every ${String(config.statusIntervalMs)} ms). ${timing}`;
}

/** The console lines for a scenario's `remoteControl` evidence (CAN-7852). */
export function remoteControlSummaryLines(evidence) {
  if (!evidence?.computers) return [];
  const setup = evidence.setup ?? {};
  const lines = [
    `[perf]   Remote Control ${evidence.role}: ${evidence.peers} computer(s), ${evidence.tasks} tasks, a stale push every ${evidence.statusIntervalMs} ms; setup ${setup.totalMs ?? 'n/a'}ms (sign-in ${setup.signInMs ?? 'n/a'}ms, pair ${(setup.pairMs ?? []).join('/')}ms, connected ${(setup.connectedMs ?? []).join('/')}ms, first snapshot ${(setup.firstSnapshotMs ?? []).join('/')}ms)`,
  ];
  for (const [index, computer] of evidence.computers.entries()) {
    const latency = computer.readLatencyMs ?? {};
    lines.push(
      `[perf]   computer ${index + 1}: ${computer.connectedThroughout ? 'connected throughout' : 'NOT connected throughout'}, ${computer.stalePushesReceived} stale pushes, ${computer.snapshotReads} snapshot reads (p50 ${latency.p50 ?? 'n/a'}ms, p95 ${latency.p95 ?? 'n/a'}ms, max ${latency.max ?? 'n/a'}ms), served ${computer.peer?.snapshotsServed ?? 'n/a'}, pushed ${computer.peer?.pushesSent ?? 'n/a'}`,
    );
  }
  return lines;
}

import { TerminalPersistenceStore } from '../../persistence';
const store = new TerminalPersistenceStore();
store.loadWorktreeState('p', 'w');
if (process.env.TERMINAL_FORGET === '1') store.forget('a');
store.flushAllSync();
process.exit(0);

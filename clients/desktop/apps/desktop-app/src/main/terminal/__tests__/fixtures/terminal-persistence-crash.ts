import fs from 'node:fs';
import process from 'node:process';
import { syncBuiltinESMExports } from 'node:module';

const point = process.env.TERMINAL_CRASH_POINT;
const descriptors = new Map<number, string>();
const open = fs.openSync;
const close = fs.closeSync;
const write = fs.writeFileSync;
const rename = fs.renameSync;

fs.openSync = (...args: Parameters<typeof open>): number => {
  const fd = open(...args);
  descriptors.set(fd, String(args[0]));
  return fd;
};
fs.closeSync = (fd: number): void => {
  descriptors.delete(fd);
  close(fd);
};
fs.writeFileSync = (...args: Parameters<typeof write>): void => {
  write(...args);
  const file = args[0];
  if (
    point === 'temp-write' &&
    typeof file === 'number' &&
    descriptors.get(file)?.endsWith('.tmp')
  )
    process.exit(73);
};
fs.renameSync = (from: fs.PathLike, to: fs.PathLike): void => {
  const target = String(to).replaceAll('\\', '/');
  const kind = target.endsWith('/terminal-state.json')
    ? 'worker'
    : target.endsWith('/terminal-presentation.json')
      ? 'presentation'
      : undefined;
  const atomic = kind && String(from).endsWith('.tmp');
  if (atomic && point === `before-${kind}`) process.exit(73);
  rename(from, to);
  if (atomic && point === `after-${kind}`) process.exit(73);
};
syncBuiltinESMExports();

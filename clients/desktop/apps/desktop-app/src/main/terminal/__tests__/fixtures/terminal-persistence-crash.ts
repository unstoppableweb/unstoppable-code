import fs from 'node:fs';
import process from 'node:process';
import { syncBuiltinESMExports } from 'node:module';

const point = process.env.TERMINAL_CRASH_POINT;
// A run that forgets crashes only on writes from its forget on.
const armed = (): boolean =>
  process.env.TERMINAL_FORGET !== '1' ||
  process.env.TERMINAL_CRASH_ARMED === '1';
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
    armed() &&
    typeof file === 'number' &&
    descriptors.get(file)?.endsWith('.tmp')
  )
    process.exit(73);
};
const promisedRename = fs.promises.rename;
// The record (the authority's install), main's layout, and main's legacy
// file, which it only ever replaces with the forward fence.
function installKind(from: fs.PathLike, to: fs.PathLike): string | undefined {
  const target = String(to).replaceAll('\\', '/');
  const kind = target.endsWith('/record.json')
    ? 'record'
    : target.endsWith('/terminal-state.json')
      ? 'worker'
      : target.endsWith('/terminal-presentation.json')
        ? 'presentation'
        : undefined;
  return kind && String(from).endsWith('.tmp') ? kind : undefined;
}
fs.renameSync = (from: fs.PathLike, to: fs.PathLike): void => {
  const kind = installKind(from, to);
  if (kind && point === `before-${kind}` && armed()) process.exit(73);
  rename(from, to);
  if (kind && point === `after-${kind}` && armed()) process.exit(73);
};
fs.promises.rename = async (
  from: fs.PathLike,
  to: fs.PathLike,
): Promise<void> => {
  const kind = installKind(from, to);
  if (kind && point === `before-${kind}` && armed()) process.exit(73);
  await promisedRename(from, to);
  if (kind && point === `after-${kind}` && armed()) process.exit(73);
};
syncBuiltinESMExports();

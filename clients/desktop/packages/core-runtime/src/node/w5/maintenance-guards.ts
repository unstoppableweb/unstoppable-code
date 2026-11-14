export { isRecord } from './commit-log/is-record';
export function isErrnoException(
  error: unknown,
): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error;
}

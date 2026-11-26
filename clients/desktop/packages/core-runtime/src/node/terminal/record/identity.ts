/** Assignment must retain opaque keys even after structuredClone restores Object.prototype. */
export function setOwn<T>(
  dictionary: Record<string, T>,
  key: string,
  value: T,
): void {
  Object.defineProperty(dictionary, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

/** Both watermarks and seals identify a producer's run, not its public run name. */
export function producerRunKey(producer: {
  id: string;
  runId: string;
}): string {
  const component = (value: string): string =>
    value.replace(/%/g, '%25').replace(/\//g, '%2F');
  return `${component(producer.id)}/${component(producer.runId)}`;
}

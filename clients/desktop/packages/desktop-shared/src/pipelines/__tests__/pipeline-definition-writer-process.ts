import {
  saveStoredPipeline,
  writeStoredPipeline,
} from '@canopy/execution-engine/pipelines/store';

if (process.argv[2] === '--save-once') {
  process.once('message', () => {
    const start = Date.now();
    const result = writeStoredPipeline({
      name: 'Review',
      description: '',
      icon: '',
      content: { name: 'Review', on: 'dispatch', jobs: {} },
    });
    process.send?.({ result, elapsed: Date.now() - start }, () =>
      process.disconnect(),
    );
  });
  process.send?.('ready');
} else {
  const [prefix, count, sharedId, startAt] = process.argv.slice(2);
  while (Date.now() < Number(startAt)) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  for (let index = 0; index < Number(count); index += 1) {
    const name = `${prefix}-${index}`;
    const input = {
      name,
      description: '',
      icon: '',
      content: { name, on: 'dispatch' as const, jobs: {} },
    };
    for (const result of [
      saveStoredPipeline(input),
      saveStoredPipeline({ ...input, id: sharedId }),
    ]) {
      if (!result.success) throw new Error(result.error);
    }
  }
}

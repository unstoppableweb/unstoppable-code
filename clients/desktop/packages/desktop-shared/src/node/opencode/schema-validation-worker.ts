import { parentPort, workerData } from 'node:worker_threads';
import { classifyMcpSchemaInput } from './schema-classification';

try {
  parentPort?.postMessage(classifyMcpSchemaInput(workerData));
} catch {
  parentPort?.postMessage('error');
}

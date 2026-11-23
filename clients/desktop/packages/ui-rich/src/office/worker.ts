import {
  parseDocxToHtml,
  parseXlsxWorkbook,
  type OfficeParseFailure,
  type OfficeParseRequest,
  type OfficeParseResponse,
} from './office-parse';
import { parsePptxPresentation } from './pptx-parse';

export interface OfficeWorkerScope {
  onmessage: ((event: MessageEvent<OfficeParseRequest>) => void) | null;
  postMessage(message: OfficeParseResponse): void;
}

/**
 * The thrown value's class and system code only. The message never leaves the
 * worker: parser errors can quote document content.
 */
function parseFailure(error: unknown): OfficeParseFailure {
  if (!(error instanceof Error)) return {};
  try {
    const name: unknown = Reflect.get(error, 'name');
    const code: unknown = Reflect.get(error, 'code');
    return {
      ...(typeof name === 'string' ? { name } : {}),
      ...(typeof code === 'string' ? { code } : {}),
    };
  } catch {
    // A throwing accessor still settles the parse.
    return {};
  }
}

export function installOfficeParseWorker(scope: OfficeWorkerScope): void {
  scope.onmessage = (event: MessageEvent<OfficeParseRequest>): void => {
    const { kind, bytes } = event.data;
    void (async (): Promise<void> => {
      try {
        const result =
          kind === 'docx'
            ? await parseDocxToHtml(bytes)
            : kind === 'pptx'
              ? parsePptxPresentation(bytes)
              : parseXlsxWorkbook(bytes);
        scope.postMessage({ ok: true, result });
      } catch (error) {
        scope.postMessage({ ok: false, error: parseFailure(error) });
      }
    })();
  };
}

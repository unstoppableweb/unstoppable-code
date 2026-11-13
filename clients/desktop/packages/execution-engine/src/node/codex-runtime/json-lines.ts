import { type Readable, Transform, type TransformCallback } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';

interface PendingInput {
  text: string;
  callback: TransformCallback;
  final: boolean;
}

class JsonLineTransform extends Transform {
  private readonly decoder = new StringDecoder('utf8');
  private fragments: string[] = [];
  private pending: PendingInput | null = null;

  constructor() {
    super({ readableObjectMode: true });
  }

  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    this.append(this.decoder.write(chunk), callback, false);
  }

  override _flush(callback: TransformCallback): void {
    this.append(this.decoder.end(), callback, true);
  }

  override _read(size: number): void {
    // The previous transform callback remains pending after readable push()
    // reaches its high-water mark. Resume parsing only when a reader asks for
    // more, so one input chunk cannot become a second unbounded frame queue.
    const pending = this.pending;
    if (pending) {
      this.pending = null;
      this.append(pending.text, pending.callback, pending.final);
    }
    super._read(size);
  }

  override _destroy(
    error: Error | null,
    callback: (error?: Error | null) => void,
  ): void {
    this.fragments = [];
    const pending = this.pending;
    this.pending = null;
    // Destroying while readable pressure holds a transform must settle the
    // producer's write callback; otherwise a canceled rollout read can leave
    // its upstream writer waiting forever.
    pending?.callback(error ?? new Error('JSONL parser destroyed'));
    super._destroy(error, callback);
  }

  private append(
    text: string,
    callback: TransformCallback,
    final: boolean,
  ): void {
    let start = 0;
    let end: number;
    while ((end = text.indexOf('\n', start)) !== -1) {
      this.fragments.push(text.slice(start, end));
      const line = this.fragments.join('');
      this.fragments = [];
      start = end + 1;
      if (!this.push(line)) {
        this.pending = { text: text.slice(start), callback, final };
        return;
      }
    }
    if (start < text.length) this.fragments.push(text.slice(start));
    if (final && this.fragments.length > 0) {
      this.push(this.fragments.join(''));
      this.fragments = [];
    }
    callback();
  }
}

/**
 * JSONL frames end at LF bytes, not Unicode line/paragraph separators. Node's
 * readline also splits U+2028/U+2029, which are legal inside JSON strings.
 * Keep partial frames as fragments so large resume histories are copied once.
 */
export function createJsonLineStream(input: Readable): Transform {
  const lines = new JsonLineTransform();
  const onError = (error: Error): void => {
    lines.destroy(error);
  };
  input.on('error', onError);
  lines.once('close', () => {
    input.off('error', onError);
  });
  return input.pipe(lines);
}

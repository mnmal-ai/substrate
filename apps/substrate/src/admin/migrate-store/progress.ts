/** Progress of a migrate-store copy, counted off the COPY text stream as it passes. */

import { Transform } from 'node:stream';

export interface ProgressEvent {
  table: string;
  /** Rows copied so far for `table`. */
  rows: number;
  /** COPY text bytes copied so far for `table`. */
  bytes: number;
  /** True once, when `table` has finished. */
  done: boolean;
}

/**
 * A pass-through that counts rows (one newline each: COPY text escapes the
 * newlines inside values) and reports every `batchRows` rows. A throw from
 * `onProgress` fails the stream, which aborts the copy.
 */
export class RowCounter extends Transform {
  rows = 0;
  bytes = 0;
  #next: number;

  constructor(
    private readonly table: string,
    private readonly batchRows: number,
    private readonly onProgress: (e: ProgressEvent) => void,
    from: { rows: number; bytes: number } = { rows: 0, bytes: 0 }
  ) {
    super();
    this.rows = from.rows;
    this.bytes = from.bytes;
    this.#next = from.rows - (from.rows % batchRows) + batchRows;
  }

  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: (err?: Error | null) => void) {
    try {
      this.bytes += chunk.length;
      for (let i = chunk.indexOf(10); i !== -1; i = chunk.indexOf(10, i + 1)) this.rows++;
      if (this.rows >= this.#next) {
        this.#next = this.rows - (this.rows % this.batchRows) + this.batchRows;
        this.onProgress({ table: this.table, rows: this.rows, bytes: this.bytes, done: false });
      }
      this.push(chunk);
      cb(null);
    } catch (err) {
      cb(err as Error);
    }
  }
}

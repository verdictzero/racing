/**
 * A minimal store-only ZIP writer.
 *
 * Both Office formats this project exports — .xlsx and .pptx — are ZIP containers of XML parts.
 * Rather than pull in a compression library, this writes the archive uncompressed: the entries are
 * XML that compresses well but is not large, and store-only means the whole writer is sixty lines
 * with no dependency, no WASM, and identical behaviour in a browser and on a server.
 *
 * DETERMINISM IS A FEATURE. Nothing here reads the clock — every entry gets a fixed DOS timestamp —
 * so the same workspace produces the same bytes every time. That makes the output diffable, makes
 * it cacheable, and makes it testable without freezing time.
 *
 * This is the legacy app's `zipBytes`, moved out of the browser and given a name.
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export interface ZipEntry {
  readonly path: string;
  readonly content: string | Uint8Array;
}

/**
 * A fixed timestamp for every entry: 1980-01-01 00:00, the earliest a DOS date can express.
 *
 * Using the real time would make two exports of an unchanged workspace differ, which turns every
 * download into a spurious diff and makes the output impossible to assert on.
 */
const DOS_TIME = 0;
const DOS_DATE = 33; // (1980-1980)<<9 | 1<<5 | 1

class ByteWriter {
  private parts: Uint8Array[] = [];
  private length = 0;

  bytes(value: Uint8Array): this {
    this.parts.push(value);
    this.length += value.length;
    return this;
  }
  u16(value: number): this {
    return this.bytes(new Uint8Array([value & 0xff, (value >> 8) & 0xff]));
  }
  u32(value: number): this {
    return this.bytes(
      new Uint8Array([value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >>> 24) & 0xff]),
    );
  }
  get size(): number {
    return this.length;
  }
  finish(): Uint8Array<ArrayBuffer> {
    const out = new Uint8Array(new ArrayBuffer(this.length));
    let at = 0;
    for (const part of this.parts) {
      out.set(part, at);
      at += part.length;
    }
    return out;
  }
}

/** Pack entries into a ZIP archive. */
export function zipBytes(entries: readonly ZipEntry[]): Uint8Array<ArrayBuffer> {
  const encoder = new TextEncoder();
  const locals = new ByteWriter();
  const centrals = new ByteWriter();
  const offsets: number[] = [];

  for (const entry of entries) {
    const name = encoder.encode(entry.path);
    const data = typeof entry.content === 'string' ? encoder.encode(entry.content) : entry.content;
    const crc = crc32(data);
    offsets.push(locals.size);

    locals
      .u32(0x04034b50) // local file header
      .u16(20) // version needed
      .u16(0) // flags
      .u16(0) // method: stored
      .u16(DOS_TIME)
      .u16(DOS_DATE)
      .u32(crc)
      .u32(data.length)
      .u32(data.length)
      .u16(name.length)
      .u16(0) // extra field length
      .bytes(name)
      .bytes(data);
  }

  entries.forEach((entry, i) => {
    const name = encoder.encode(entry.path);
    const data = typeof entry.content === 'string' ? encoder.encode(entry.content) : entry.content;
    centrals
      .u32(0x02014b50) // central directory header
      .u16(20) // version made by
      .u16(20) // version needed
      .u16(0)
      .u16(0) // method: stored
      .u16(DOS_TIME)
      .u16(DOS_DATE)
      .u32(crc32(data))
      .u32(data.length)
      .u32(data.length)
      .u16(name.length)
      .u16(0) // extra
      .u16(0) // comment
      .u16(0) // disk number
      .u16(0) // internal attrs
      .u32(0) // external attrs
      .u32(offsets[i]!)
      .bytes(name);
  });

  const centralSize = centrals.size;
  const centralStart = locals.size;
  const end = new ByteWriter()
    .u32(0x06054b50) // end of central directory
    .u16(0)
    .u16(0)
    .u16(entries.length)
    .u16(entries.length)
    .u32(centralSize)
    .u32(centralStart)
    .u16(0); // comment length

  return new ByteWriter()
    .bytes(locals.finish())
    .bytes(centrals.finish())
    .bytes(end.finish())
    .finish();
}

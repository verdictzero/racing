/**
 * Reading a ZIP, which is what a .xlsx is.
 *
 * The counterpart to `export/zip.ts`, and harder in one respect: this has to read archives written
 * by Excel, which deflates its entries, where the writer only ever stores. The inflater is
 * `DecompressionStream('deflate-raw')` — a platform API present in Node 18+ and every current
 * browser — so this still ships with no dependency and no bundled inflater.
 *
 * ENTRIES COME FROM THE CENTRAL DIRECTORY, not from scanning for local headers. The directory is
 * the authoritative index: a local header may carry a zeroed size with the real one in a data
 * descriptor after the payload, which a forward scan cannot see. Where the data actually starts is
 * still read from the local header, though, because its extra field can differ in length from the
 * directory's copy — a mismatch that yields silent garbage rather than an error.
 */

export interface ZipContents {
  /** Entry path to raw bytes. */
  readonly files: ReadonlyMap<string, Uint8Array>;
}

export class ZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipError';
  }
}

async function inflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream !== 'function') {
    throw new ZipError(
      'This environment cannot decompress .xlsx files — it has no DecompressionStream.',
    );
  }
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Unpack an archive.
 *
 * `keep` filters by path before anything is inflated, so reading a workbook does not spend time on
 * embedded images it will never look at.
 */
export async function unzip(
  bytes: Uint8Array,
  keep: (path: string) => boolean = () => true,
): Promise<ZipContents> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // Scan back for the end-of-central-directory signature. Some writers append a comment, which
  // sits between it and the end of the file, so it is not simply the last 22 bytes.
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0 && i >= bytes.length - 66_000; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipError('That is not a .xlsx file — there is no ZIP directory in it.');

  const count = view.getUint16(eocd + 10, true);
  let at = view.getUint32(eocd + 16, true);
  if (at === 0xffffffff) {
    throw new ZipError(
      'That workbook is ZIP64, which this reader cannot handle. Re-save it from Excel as .xlsx.',
    );
  }

  const files = new Map<string, Uint8Array>();
  const decoder = new TextDecoder();

  for (let i = 0; i < count; i++) {
    if (at + 46 > bytes.length || view.getUint32(at, true) !== 0x02014b50) break;
    const method = view.getUint16(at + 10, true);
    const compressedSize = view.getUint32(at + 20, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const localOffset = view.getUint32(at + 42, true);
    const path = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));

    if (keep(path)) {
      const localNameLength = view.getUint16(localOffset + 26, true);
      const localExtraLength = view.getUint16(localOffset + 28, true);
      const dataAt = localOffset + 30 + localNameLength + localExtraLength;
      const raw = bytes.subarray(dataAt, dataAt + compressedSize);
      if (method === 0) files.set(path, raw);
      else if (method === 8) files.set(path, await inflateRaw(raw));
      else {
        throw new ZipError(
          `That workbook uses ZIP compression method ${method}, which this reader cannot handle. ` +
            'Re-save it from Excel as .xlsx.',
        );
      }
    }

    at += 46 + nameLength + extraLength + commentLength;
  }

  return { files };
}

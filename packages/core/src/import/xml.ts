/**
 * A tiny XML scanner, for the handful of shapes a spreadsheet part actually contains.
 *
 * `DOMParser` is browser-only and a real XML library is a dependency this package does not want, so
 * this walks the markup directly. It is safe to do here and would not be in general: the input is
 * machine-generated SpreadsheetML — regular, shallow, and with no DTD, no namespaces to resolve, and
 * no mixed content that matters. What it must get right is entity decoding and quoting, because
 * those DO appear in real files: a party called "R&D" arrives as `R&amp;D`.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: validate. A malformed part yields fewer elements rather than an
 * error, and the importer reports what it could not find in terms a person can act on. A parser
 * error message naming a byte offset helps nobody holding a spreadsheet.
 */

export interface XmlElement {
  readonly name: string;
  readonly attrs: Readonly<Record<string, string>>;
  /** Text content with descendants' text concatenated, entities decoded. */
  readonly text: string;
  /** Where the element's content began and ended, for nested scans. */
  readonly start: number;
  readonly end: number;
  readonly selfClosing: boolean;
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

export function decodeEntities(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body[0] === '#') {
      const code =
        body[1] === 'x' || body[1] === 'X'
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10);
      // An out-of-range or unparseable reference is left as written rather than becoming U+FFFD:
      // showing the source text is more useful than showing a replacement character.
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body] ?? whole;
  });
}

function parseAttrs(source: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    attrs[match[1]!] = decodeEntities(match[3] ?? match[4] ?? '');
  }
  return attrs;
}

/**
 * Every element with the given local name, in document order.
 *
 * The name is matched ignoring any namespace prefix, because a writer may or may not use one for
 * the default namespace and a reader that cared would work on one file and not the next.
 */
export function findElements(xml: string, localName: string, from = 0, to = xml.length): XmlElement[] {
  const out: XmlElement[] = [];
  const open = new RegExp(`<(?:[\\w.-]+:)?${localName}(?=[\\s/>])([^>]*)>`, 'g');
  open.lastIndex = from;

  let match: RegExpExecArray | null;
  while ((match = open.exec(xml)) !== null) {
    if (match.index >= to) break;
    const rawAttrs = match[1] ?? '';
    const selfClosing = rawAttrs.trimEnd().endsWith('/');
    const contentStart = match.index + match[0].length;

    let contentEnd = contentStart;
    if (!selfClosing) {
      // Depth-counted, so a <row> containing a <row> (which SpreadsheetML never does, but a
      // hand-edited file might) closes at the right place instead of the first close tag.
      const scan = new RegExp(`<(/?)(?:[\\w.-]+:)?${localName}(?=[\\s/>])([^>]*)>`, 'g');
      scan.lastIndex = contentStart;
      let depth = 1;
      let inner: RegExpExecArray | null;
      while ((inner = scan.exec(xml)) !== null) {
        if (inner[1] === '/') depth--;
        else if (!(inner[2] ?? '').trimEnd().endsWith('/')) depth++;
        if (depth === 0) break;
      }
      contentEnd = inner ? inner.index : xml.length;
      open.lastIndex = inner ? inner.index + inner[0].length : xml.length;
    }

    out.push({
      name: localName,
      attrs: parseAttrs(rawAttrs),
      text: selfClosing ? '' : textOf(xml.slice(contentStart, contentEnd)),
      start: contentStart,
      end: contentEnd,
      selfClosing,
    });
  }
  return out;
}

/** All text in a fragment, tags stripped and entities decoded. */
export function textOf(fragment: string): string {
  return decodeEntities(fragment.replace(/<[^>]*>/g, ''));
}

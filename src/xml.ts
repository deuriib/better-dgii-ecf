/**
 * Minimal, tolerant readers for signed DGII XML.
 *
 * The plugin never parses a full document: it needs two facts — which taxpayer
 * issued it, and which root element it is — and both are readable with a single
 * match. The readers do NOT mirror the DGII SDK's: the two layers disagree on
 * duplicate elements, CDATA and entities (issue #26), so nothing here assumes
 * they agree — the plugin scans for these two facts itself instead of reaching
 * into the SDK's non-public modules.
 *
 * Two properties are load-bearing:
 *
 * 1. **Nothing is read from a comment.** A document is attacker-influenced input,
 *    and `<!-- <RNCEmisor>…</RNCEmisor> -->` would otherwise be observable as the
 *    issuer. That is not a cosmetic bug: the issuer check is what stops a member
 *    of one organization from submitting a document for another taxpayer, so a
 *    value an author can hide in a comment cannot be the value the check reads.
 * 2. **Tolerance, not sanitization.** Markup is skipped by scanning spans
 *    (comment, processing instruction, declaration) rather than by deleting
 *    patterns, because deleting markup and then searching the remainder is how
 *    residue becomes a false root or a false issuer.
 */

const NAME_CHAR = /[A-Za-z0-9_.:-]/;

const isSpace = (ch: string): boolean =>
  ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n';

const readQualifiedName = (
  xml: string,
  start: number,
): { name: string; end: number } => {
  let index = start;
  while (index < xml.length && NAME_CHAR.test(xml[index]!)) {
    index += 1;
  }
  return { name: xml.slice(start, index), end: index };
};

const localName = (qualified: string): string => {
  const colon = qualified.lastIndexOf(':');
  return colon === -1 ? qualified : qualified.slice(colon + 1);
};

const skipAttributes = (xml: string, start: number): number | undefined => {
  let index = start;
  while (index < xml.length) {
    const ch = xml[index]!;
    if (ch === '"' || ch === "'") {
      const close = xml.indexOf(ch, index + 1);
      if (close === -1) {
        return undefined;
      }
      index = close + 1;
      continue;
    }
    if (ch === '>') {
      return xml[index - 1] === '/' ? -1 : index + 1;
    }
    if (ch === '<') {
      return undefined;
    }
    index += 1;
  }
  return undefined;
};

const findClosingTag = (xml: string, from: number, tag: string): number | undefined => {
  let index = from;
  for (;;) {
    const open = xml.indexOf('</', index);
    if (open === -1) {
      return undefined;
    }
    const { name, end } = readQualifiedName(xml, open + 2);
    if (localName(name) === tag) {
      let after = end;
      while (after < xml.length && isSpace(xml[after]!)) {
        after += 1;
      }
      if (xml[after] === '>') {
        return open;
      }
    }
    index = open + 2;
  }
};

const extractElementText = (xml: string, tag: string): string | undefined => {
  let from = 0;
  for (;;) {
    const open = xml.indexOf('<', from);
    if (open === -1) {
      return undefined;
    }
    const marker = xml[open + 1];
    if (marker === undefined) {
      return undefined;
    }
    if (marker === '?' || marker === '!' || marker === '/') {
      from = open + 1;
      continue;
    }
    const { name, end } = readQualifiedName(xml, open + 1);
    if (name === '') {
      from = open + 1;
      continue;
    }
    if (localName(name) !== tag) {
      from = end;
      continue;
    }
    const contentStart = skipAttributes(xml, end);
    if (contentStart === undefined) {
      from = end;
      continue;
    }
    if (contentStart === -1) {
      return undefined;
    }
    const contentEnd = findClosingTag(xml, contentStart, tag);
    if (contentEnd === undefined) {
      return undefined;
    }
    const text = xml.slice(contentStart, contentEnd).trim();
    return text === '' ? undefined : text;
  }
};

/**
 * End (exclusive) of the non-element span that starts at `open`, or `-1` when
 * the `<` begins an element.
 *
 * An unterminated span swallows the rest of the document: an unterminated
 * comment is a malformed document, and treating its contents as markup is
 * exactly the behaviour this function exists to prevent.
 */
const skipNonElement = (xml: string, open: number): number => {
  if (xml.startsWith('<!--', open)) {
    const end = xml.indexOf('-->', open + 4);
    return end === -1 ? xml.length : end + 3;
  }
  if (xml.startsWith('<?', open)) {
    const end = xml.indexOf('?>', open + 2);
    return end === -1 ? xml.length : end + 2;
  }
  if (xml.startsWith('<!', open)) {
    // A declaration (DOCTYPE, or a CDATA section). The internal subset of a
    // DOCTYPE may contain `>` inside `[...]`, so the bracket depth is tracked.
    let depth = 0;
    for (let cursor = open + 2; cursor < xml.length; cursor += 1) {
      const character = xml[cursor];
      if (character === '[') {
        depth += 1;
      } else if (character === ']') {
        depth = Math.max(0, depth - 1);
      } else if (character === '>' && depth === 0) {
        return cursor + 1;
      }
    }
    return xml.length;
  }
  return -1;
};

/**
 * The document with every comment, processing instruction and declaration
 * removed — element markup untouched.
 *
 * Removing these spans means a later element match can only find real elements.
 * The scan is linear and allocation-light; DGII documents are small and a request
 * reads at most a handful of values from one.
 */
const withoutNonElementMarkup = (xml: string): string => {
  const parts: string[] = [];
  let index = 0;
  for (;;) {
    const open = xml.indexOf('<', index);
    if (open === -1) {
      parts.push(xml.slice(index));
      return parts.join('');
    }
    parts.push(xml.slice(index, open));
    const end = skipNonElement(xml, open);
    if (end === -1) {
      // A real element: keep the `<` and continue scanning after it, so a later
      // comment inside the element (or after it) is still removed.
      parts.push('<');
      index = open + 1;
      continue;
    }
    index = end;
  }
};

/**
 * Text content of the first `<tag>` element, tolerating a namespace prefix and
 * attributes. Returns `undefined` when the element is absent, self-closing or
 * blank. Matching is case-sensitive, as XML element names are.
 */
export const elementText = (xml: string, tag: string): string | undefined =>
  extractElementText(withoutNonElementMarkup(xml), tag);

const ROOT_PATTERN = /<\s*(?:[A-Za-z_][\w.-]*:)?([A-Za-z_][\w.-]*)[\s/>]/;

/**
 * Local name of the document's root element, ignoring the XML declaration, a
 * DOCTYPE and any leading comments.
 *
 * DGII routing depends on the root: `<ECF>` goes to the general reception and
 * `<RFCE>` to the consumption-summary reception.
 */
export const rootElementName = (xml: string): string | undefined =>
  ROOT_PATTERN.exec(withoutNonElementMarkup(xml))?.[1];

/** Issuer identifiers DGII uses across the e-CF, ACECF and ANECF schemas. */
const ISSUER_TAGS = ['RNCEmisor', 'RncEmisor'] as const;

/**
 * The taxpayer id that issued the document, or `undefined` when the document
 * does not carry one.
 *
 * Both spellings are read because DGII's schemas disagree: the e-CF and ACECF
 * documents use `RNCEmisor` and the ANECF voiding request uses `RncEmisor`.
 */
export const issuerTaxPayerId = (xml: string): string | undefined => {
  for (const tag of ISSUER_TAGS) {
    const value = elementText(xml, tag);
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
};

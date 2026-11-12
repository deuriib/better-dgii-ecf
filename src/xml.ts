/**
 * Minimal, tolerant readers for signed DGII XML.
 *
 * The plugin never parses a full document: it needs two facts — which taxpayer
 * issued it, and which root element it is — and both are readable with a single
 * match. This mirrors the DGII SDK's internal readers so both layers agree on
 * what a document says, without the plugin reaching into the SDK's non-public
 * modules.
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

const PATTERN_CACHE = new Map<string, RegExp>();

/**
 * An attribute span may contain `>` inside quotes (`nota="a > b"`), so each
 * quoted form gets its own alternative instead of a blanket `[^>]*`.
 */
const ATTRIBUTE_SPAN = `(?:[^>"']|"[^"]*"|'[^']*')*`;

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const elementPattern = (tag: string): RegExp => {
  const cached = PATTERN_CACHE.get(tag);
  if (cached !== undefined) {
    return cached;
  }
  const name = escapeRegExp(tag);
  const prefix = '(?:[\\w.-]+:)?';
  const pattern = new RegExp(
    `<${prefix}${name}${ATTRIBUTE_SPAN}>([\\s\\S]*?)<\\/${prefix}${name}\\s*>`,
  );
  PATTERN_CACHE.set(tag, pattern);
  return pattern;
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
export const elementText = (xml: string, tag: string): string | undefined => {
  const text = elementPattern(tag).exec(withoutNonElementMarkup(xml))?.[1]?.trim();
  return text === undefined || text === '' ? undefined : text;
};

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

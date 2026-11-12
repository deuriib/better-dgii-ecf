/**
 * Minimal, tolerant readers for signed DGII XML.
 *
 * The plugin never parses a full document: it only needs two facts — which
 * taxpayer issued it, and (for the summary channel) which root element it is —
 * both of which are readable with a single element match. This mirrors the
 * DGII SDK's internal readers so both layers agree on what a document says,
 * without the plugin reaching into the SDK's non-public modules.
 *
 * The tolerance is not cosmetic. The SDK never owns the XML it submits: DGII
 * responses, .NET-produced signatures and third-party generators all wrap the
 * same element in a namespace prefix and add attributes to it. A literal
 * `<RNCEmisor>` match would miss `<ns:RNCEmisor version="1.0">` and silently
 * fall back — and on the issuer check, "no issuer found" must never read as
 * "issuer matches".
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
 * Text content of the first `<tag>` element, tolerating a namespace prefix and
 * attributes. Returns `undefined` when the element is absent, self-closing or
 * blank. Matching is case-sensitive, as XML element names are.
 */
export const elementText = (xml: string, tag: string): string | undefined => {
  const text = elementPattern(tag).exec(xml)?.[1]?.trim();
  return text === undefined || text === '' ? undefined : text;
};

const ROOT_PATTERN = /<\s*(?:[A-Za-z_][\w.-]*:)?([A-Za-z_][\w.-]*)[\s/>]/;

/** Local name of the document's root element, ignoring declaration/comments. */
export const rootElementName = (xml: string): string | undefined =>
  ROOT_PATTERN.exec(
    xml
      .replace(/<\?[\s\S]*?\?>/g, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .trimStart(),
  )?.[1];

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

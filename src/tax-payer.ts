/**
 * Taxpayer id (RNC / cédula) handling for the DGII e-CF services.
 *
 * Two things are deliberately kept apart:
 *
 * - **Normalization** is unconditional. DGII accepts the identifier with or
 *   without separators, and a database that stores `1-31-12345-6` while the
 *   organization field stores `131123456` must not produce a mismatch.
 * - **Validation** is a policy. The only rule enforced by default is the
 *   documented shape: 9 digits for an RNC, 11 for a cédula. Anything stricter
 *   (a check digit, an allow-list of registered taxpayers) is the host's call,
 *   so it is injected rather than assumed.
 */

/** Separators DGII tolerates in a taxpayer id: spaces, dashes and dots. */
const SEPARATORS = /[\s.\-–—]/g;

/** 9 digits = RNC (legal entity), 11 digits = cédula (natural person). */
const SHAPE = /^(?:\d{9}|\d{11})$/;

/** Strip the separators a human types so comparison and storage are stable. */
export const normalizeTaxPayerId = (value: string): string =>
  value.replace(SEPARATORS, '').trim();

/**
 * True when the value is a syntactically valid DGII identifier.
 *
 * The input is expected to be already normalized; call
 * {@link normalizeTaxPayerId} first when it comes from user input.
 */
export const isTaxPayerIdShape = (value: string): boolean => SHAPE.test(value);

/**
 * Custom validation hook. Return `true` to accept, or a string to accept with
 * a normalized replacement (for example an alias resolved to its canonical
 * RNC). Returning `false` rejects.
 */
export type TaxPayerIdValidator = (
  taxPayerId: string,
) => boolean | string | Promise<boolean | string>;

/** How strictly a resolved taxpayer id is checked. Defaults to `format`. */
export type TaxPayerIdValidation = 'format' | 'off' | TaxPayerIdValidator;

export class TaxPayerIdError extends Error {
  readonly reason: 'shape' | 'custom';

  constructor(reason: 'shape' | 'custom', message: string) {
    super(message);
    this.name = 'TaxPayerIdError';
    this.reason = reason;
  }
}

/**
 * Normalize and validate, returning the canonical id.
 *
 * Throws {@link TaxPayerIdError} so the endpoint layer can map the failure to a
 * single error code regardless of which rule rejected it.
 */
export const applyTaxPayerIdValidation = async (
  raw: string,
  validation: TaxPayerIdValidation,
): Promise<string> => {
  const normalized = normalizeTaxPayerId(raw);
  if (normalized === '') {
    throw new TaxPayerIdError('shape', 'The taxpayer id is empty');
  }
  if (validation === 'off') {
    return normalized;
  }
  if (validation === 'format') {
    if (!isTaxPayerIdShape(normalized)) {
      throw new TaxPayerIdError(
        'shape',
        `"${raw}" is not a DGII RNC (9 digits) or cédula (11 digits)`,
      );
    }
    return normalized;
  }
  const verdict = await validation(normalized);
  if (verdict === false) {
    throw new TaxPayerIdError('custom', `"${raw}" was rejected by the validator`);
  }
  if (typeof verdict === 'string') {
    return normalizeTaxPayerId(verdict);
  }
  return normalized;
};

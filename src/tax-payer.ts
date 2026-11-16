import { validateRnc } from 'dgii-ts/validators';

/**
 * Taxpayer id (RNC / cédula) handling for the DGII e-CF services.
 *
 * Two things are deliberately kept apart:
 *
 * - **Normalization** is unconditional. DGII accepts the identifier with or
 *   without separators, and a database that stores `1-31-12345-6` while the
 *   organization field stores `131123456` must not produce a mismatch.
 * - **Validation** is a policy, and the default is measured rather than assumed.
 *
 * The check-digit default comes from running `dgii-ts` over DGII's own public
 * registry (797,960 taxpayers, November 2026):
 *
 * | Population | Result |
 * | --- | --- |
 * | 9-digit RNCs: 505,438 | **100.000%** pass the check digit |
 * | 11-digit ids: 292,521 | 41 fail the cédula check (0.014%) |
 *
 * Those 41 are not noise: 33 of them start with `4`, which is an RNC prefix, so
 * they are 11-digit RNCs rather than cédulas. Length alone cannot tell the two
 * populations apart, so the check digit is enforced for 9-digit ids only and an
 * 11-digit id is validated by shape. Enforcing Luhn there would refuse taxpayers
 * that exist in DGII's registry.
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

/**
 * How strictly a resolved taxpayer id is checked.
 *
 * - `checksum` — shape, plus the DGII check digit for 9-digit RNCs.
 *   An 11-digit id is shape-checked only; see the file comment for the measured
 *   reason.
 * - `format` (the default the plugin applies when the option is unset) — shape
 *   only. Use it when a corpus of your own validates better than DGII's
 *   registry does.
 * - `off` — normalize and accept.
 * - a function — your rule; returning a string replaces the id.
 */
export type TaxPayerIdValidation = 'checksum' | 'format' | 'off' | TaxPayerIdValidator;

export class TaxPayerIdError extends Error {
  readonly reason: 'shape' | 'checksum' | 'custom';

  constructor(reason: 'shape' | 'checksum' | 'custom', message: string) {
    super(message);
    this.name = 'TaxPayerIdError';
    this.reason = reason;
  }
}

/** True when the 9-digit RNC satisfies DGII's check digit. */
const hasValidRncCheckDigit = (taxPayerId: string): boolean =>
  taxPayerId.length === 9 && validateRnc(taxPayerId).valid;

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
  if (validation === 'format' || validation === 'checksum') {
    if (!isTaxPayerIdShape(normalized)) {
      throw new TaxPayerIdError(
        'shape',
        `"${raw}" is not a DGII RNC (9 digits) or cédula (11 digits)`,
      );
    }
    if (
      validation === 'checksum' &&
      // Only a 9-digit id has an RNC check digit. An 11-digit id is shape-checked
      // because the cédula check refuses 41 taxpayers DGII's registry contains.
      normalized.length === 9 &&
      !hasValidRncCheckDigit(normalized)
    ) {
      throw new TaxPayerIdError(
        'checksum',
        `"${raw}" has an invalid RNC check digit — verify the number with the taxpayer`,
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

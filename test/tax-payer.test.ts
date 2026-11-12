import { describe, expect, it } from 'vitest';
import {
  applyTaxPayerIdValidation,
  isTaxPayerIdShape,
  normalizeTaxPayerId,
  TaxPayerIdError,
} from '../src/tax-payer.js';
import {
  CEDULA,
  TAXPAYER_A,
  TAXPAYER_A_FORMATTED,
  TAXPAYER_B,
  TAXPAYER_INVALID_CHECKSUM,
} from './helpers.js';

/**
 * Nine real RNCs from DGII's public registry (November 2026 snapshot), covering the
 * three prefixes the registry contains: `1` (companies), `4` and `5`.
 *
 * They are here to pin the claim the default rests on — that the check digit does
 * not reject real taxpayers — against identifiers DGII actually issued.
 */
const REAL_RNCS_BY_PREFIX = {
  '1': ['113613804', '101588861', '102043736'],
  '4': ['430448834', '430299014', '430352306'],
  '5': ['531058447', '505074758', '531110023'],
} as const;

const REAL_RNCS = Object.values(REAL_RNCS_BY_PREFIX).flat();

describe('normalizeTaxPayerId', () => {
  it('strips the separators a human types', () => {
    expect(normalizeTaxPayerId(TAXPAYER_A_FORMATTED)).toBe(TAXPAYER_A);
    expect(normalizeTaxPayerId(' 531 058 447 ')).toBe(TAXPAYER_A);
    expect(normalizeTaxPayerId('5.31.05844.7')).toBe(TAXPAYER_A);
    expect(normalizeTaxPayerId('026-0132209-8')).toBe(CEDULA);
  });

  it('is idempotent', () => {
    const once = normalizeTaxPayerId(` ${TAXPAYER_A_FORMATTED} `);
    expect(normalizeTaxPayerId(once)).toBe(once);
  });

  it('leaves an already canonical id untouched', () => {
    expect(normalizeTaxPayerId(TAXPAYER_A)).toBe(TAXPAYER_A);
  });
});

describe('isTaxPayerIdShape', () => {
  it('accepts a 9-digit RNC and an 11-digit cédula', () => {
    expect(isTaxPayerIdShape(TAXPAYER_A)).toBe(true);
    expect(isTaxPayerIdShape(CEDULA)).toBe(true);
  });

  it('rejects every other length', () => {
    for (const value of ['', '12345678', '1234567890', '123456789012']) {
      expect(isTaxPayerIdShape(value)).toBe(false);
    }
  });

  it('rejects non-digits even at a valid length', () => {
    expect(isTaxPayerIdShape('53105844A')).toBe(false);
    expect(isTaxPayerIdShape('5-3105844')).toBe(false);
  });
});

describe('checksum policy (the default)', () => {
  it('accepts real RNCs from DGII registry', async () => {
    // The measurement behind the default: 505,438 of 505,438 real RNCs pass. Each
    // prefix the registry contains is represented, so a failure here would show
    // which population the check digit rejects.
    for (const rnc of REAL_RNCS) {
      await expect(applyTaxPayerIdValidation(rnc, 'checksum')).resolves.toBe(rnc);
    }
  });

  it('covers the prefixes the registry actually contains', () => {
    expect(REAL_RNCS).toHaveLength(9);
    expect(new Set(REAL_RNCS.map((rnc) => rnc[0]))).toEqual(new Set(['1', '4', '5']));
  });

  it('accepts a formatted RNC after normalization', async () => {
    await expect(
      applyTaxPayerIdValidation(TAXPAYER_A_FORMATTED, 'checksum'),
    ).resolves.toBe(TAXPAYER_A);
  });

  it('refuses a 9-digit id with the wrong check digit', async () => {
    const failure = await applyTaxPayerIdValidation(
      TAXPAYER_INVALID_CHECKSUM,
      'checksum',
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(TaxPayerIdError);
    expect((failure as TaxPayerIdError).reason).toBe('checksum');
    // The message has to tell a developer what to do, not just that it failed.
    expect((failure as Error).message).toMatch(/check digit/);
  });

  it('does not apply the cédula check to an 11-digit id', async () => {
    // 41 real taxpayers in DGII's registry fail the cédula check, and 33 of them
    // are 11-digit RNCs, so length cannot decide the population. Shape only.
    await expect(applyTaxPayerIdValidation(CEDULA, 'checksum')).resolves.toBe(CEDULA);
  });

  it('still enforces the shape', async () => {
    await expect(applyTaxPayerIdValidation('123', 'checksum')).rejects.toBeInstanceOf(
      TaxPayerIdError,
    );
  });
});

describe('format policy', () => {
  it('accepts an RNC whose check digit is wrong', async () => {
    await expect(
      applyTaxPayerIdValidation(TAXPAYER_INVALID_CHECKSUM, 'format'),
    ).resolves.toBe(TAXPAYER_INVALID_CHECKSUM);
  });

  it('rejects a shape violation with the reason attached', async () => {
    const failure = await applyTaxPayerIdValidation('123', 'format').catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(TaxPayerIdError);
    expect((failure as TaxPayerIdError).reason).toBe('shape');
  });
});

describe('off and custom policies', () => {
  it('rejects an empty id regardless of policy', async () => {
    for (const policy of ['checksum', 'format', 'off'] as const) {
      await expect(applyTaxPayerIdValidation('   ', policy)).rejects.toBeInstanceOf(
        TaxPayerIdError,
      );
    }
  });

  it('skips both shape and checksum when validation is off', async () => {
    await expect(applyTaxPayerIdValidation('531-058', 'off')).resolves.toBe('531058');
  });

  it('honours a custom validator that rejects', async () => {
    const failure = await applyTaxPayerIdValidation(TAXPAYER_A, () => false).catch(
      (error: unknown) => error,
    );
    expect((failure as TaxPayerIdError).reason).toBe('custom');
  });

  it('accepts a custom validator that rewrites the id', async () => {
    await expect(
      applyTaxPayerIdValidation('alias', () => TAXPAYER_A_FORMATTED),
    ).resolves.toBe(TAXPAYER_A);
  });

  it('accepts a custom validator that approves without a check digit', async () => {
    await expect(
      applyTaxPayerIdValidation(TAXPAYER_INVALID_CHECKSUM, () => true),
    ).resolves.toBe(TAXPAYER_INVALID_CHECKSUM);
  });
});

describe('fixtures', () => {
  it('uses distinct identifiers so a test cannot pass by accident', () => {
    expect(new Set([TAXPAYER_A, TAXPAYER_B, TAXPAYER_INVALID_CHECKSUM]).size).toBe(3);
  });
});

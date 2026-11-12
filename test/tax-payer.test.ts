import { describe, expect, it } from 'vitest';
import {
  isTaxPayerIdShape,
  normalizeTaxPayerId,
  applyTaxPayerIdValidation,
  TaxPayerIdError,
} from '../src/tax-payer.js';

describe('normalizeTaxPayerId', () => {
  it('strips the separators a human types', () => {
    expect(normalizeTaxPayerId('1-31-12345-6')).toBe('131123456');
    expect(normalizeTaxPayerId(' 131 123 456 ')).toBe('131123456');
    expect(normalizeTaxPayerId('1.31.12345.6')).toBe('131123456');
    expect(normalizeTaxPayerId('001-1234567-8')).toBe('00112345678');
  });

  it('is idempotent', () => {
    const once = normalizeTaxPayerId(' 1-31-12345-6 ');
    expect(normalizeTaxPayerId(once)).toBe(once);
  });

  it('leaves an already canonical id untouched', () => {
    expect(normalizeTaxPayerId('131123456')).toBe('131123456');
  });
});

describe('isTaxPayerIdShape', () => {
  it('accepts a 9-digit RNC and an 11-digit cédula', () => {
    expect(isTaxPayerIdShape('131123456')).toBe(true);
    expect(isTaxPayerIdShape('00112345678')).toBe(true);
  });

  it('rejects every other length', () => {
    for (const value of ['', '12345678', '1234567890', '123456789012']) {
      expect(isTaxPayerIdShape(value)).toBe(false);
    }
  });

  it('rejects non-digits even at a valid length', () => {
    expect(isTaxPayerIdShape('13112345A')).toBe(false);
    expect(isTaxPayerIdShape('1-3112345')).toBe(false);
  });
});

describe('applyTaxPayerIdValidation', () => {
  it('normalizes under the default format policy', async () => {
    await expect(applyTaxPayerIdValidation('1-31-12345-6', 'format')).resolves.toBe(
      '131123456',
    );
  });

  it('rejects an empty id regardless of policy', async () => {
    for (const policy of ['format', 'off'] as const) {
      await expect(applyTaxPayerIdValidation('   ', policy)).rejects.toBeInstanceOf(
        TaxPayerIdError,
      );
    }
  });

  it('reports a shape violation with the reason attached', async () => {
    const failure = await applyTaxPayerIdValidation('123', 'format').catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(TaxPayerIdError);
    expect((failure as TaxPayerIdError).reason).toBe('shape');
  });

  it('skips the shape rule entirely when validation is off', async () => {
    await expect(applyTaxPayerIdValidation('131-123', 'off')).resolves.toBe('131123');
  });

  it('honours a custom validator that rejects', async () => {
    const failure = await applyTaxPayerIdValidation('131123456', () => false).catch(
      (error: unknown) => error,
    );
    expect((failure as TaxPayerIdError).reason).toBe('custom');
  });

  it('accepts a custom validator that rewrites the id', async () => {
    await expect(
      applyTaxPayerIdValidation('alias', () => '1-31-12345-6'),
    ).resolves.toBe('131123456');
  });

  it('accepts a custom validator that approves', async () => {
    await expect(applyTaxPayerIdValidation('weird', () => true)).resolves.toBe('weird');
  });
});

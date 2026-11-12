import { describe, expect, it } from 'vitest';
import { elementText, issuerTaxPayerId, rootElementName } from '../src/xml.js';

describe('elementText', () => {
  it('reads a plain element', () => {
    expect(elementText('<a><eNCF>E31</eNCF></a>', 'eNCF')).toBe('E31');
  });

  it('reads through a namespace prefix', () => {
    expect(elementText('<a><dgii:eNCF>E31</dgii:eNCF></a>', 'eNCF')).toBe('E31');
  });

  it('reads through attributes, including a quoted >', () => {
    expect(elementText('<eNCF nota="a > b">E31</eNCF>', 'eNCF')).toBe('E31');
  });

  it('returns undefined for a blank element', () => {
    expect(elementText('<eNCF>   </eNCF>', 'eNCF')).toBeUndefined();
  });

  it('returns undefined for a self-closing element', () => {
    expect(elementText('<eNCF/>', 'eNCF')).toBeUndefined();
  });

  it('returns undefined when the element is absent', () => {
    expect(elementText('<a/>', 'eNCF')).toBeUndefined();
  });

  it('is case-sensitive, as XML is', () => {
    expect(elementText('<a><encf>E31</encf></a>', 'eNCF')).toBeUndefined();
  });
});

describe('rootElementName', () => {
  it('ignores the declaration and comments', () => {
    expect(rootElementName('<?xml version="1.0"?><!-- c -->\n<ECF><x/></ECF>')).toBe(
      'ECF',
    );
  });

  it('ignores a namespace prefix', () => {
    expect(rootElementName('<dgii:RFCE/>')).toBe('RFCE');
  });

  it('returns undefined when there is no element', () => {
    expect(rootElementName('<?xml version="1.0"?>')).toBeUndefined();
  });
});

describe('issuerTaxPayerId', () => {
  it('reads RNCEmisor from an e-CF document', () => {
    expect(issuerTaxPayerId('<ECF><RNCEmisor>131123456</RNCEmisor></ECF>')).toBe(
      '131123456',
    );
  });

  it('reads RncEmisor from an ANECF document', () => {
    expect(issuerTaxPayerId('<ANECF><RncEmisor>101010101</RncEmisor></ANECF>')).toBe(
      '101010101',
    );
  });

  it('prefers RNCEmisor when both spellings are present', () => {
    expect(
      issuerTaxPayerId(
        '<x><RNCEmisor>131123456</RNCEmisor><RncEmisor>101010101</RncEmisor></x>',
      ),
    ).toBe('131123456');
  });

  it('returns undefined rather than guessing', () => {
    expect(issuerTaxPayerId('<ECF><Otro>1</Otro></ECF>')).toBeUndefined();
  });
});

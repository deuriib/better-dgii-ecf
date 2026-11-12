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

  it('skips a DOCTYPE declaration', () => {
    expect(
      rootElementName('<?xml version="1.0"?><!DOCTYPE ECF [<!ENTITY x "y">]><ECF/>'),
    ).toBe('ECF');
  });

  it('ignores markup that looks like a tag inside a comment', () => {
    expect(rootElementName('<?xml version="1.0"?><!-- <FakeRoot> --><ECF/>')).toBe(
      'ECF',
    );
  });

  it('still finds the root when a comment sits inside the document', () => {
    expect(rootElementName('<ECF><!-- <FakeRoot> --><Encabezado/></ECF>')).toBe('ECF');
  });

  it('reads the root of a document with a namespace prefix and attributes', () => {
    expect(rootElementName('<ns:RFCE version="1.0"><ns:x/></ns:RFCE>')).toBe('RFCE');
  });
});

describe('issuerTaxPayerId', () => {
  it('never reads the issuer out of a comment', () => {
    // Reading from a comment would let a document pass the issuer check while
    // declaring a different taxpayer to DGII — the check is the tenant boundary.
    expect(
      issuerTaxPayerId(
        '<ECF><!-- <RNCEmisor>531058447</RNCEmisor> --><RNCEmisor>505074758</RNCEmisor></ECF>',
      ),
    ).toBe('505074758');
  });

  it('returns undefined when the only issuer is commented out', () => {
    expect(
      issuerTaxPayerId('<ECF><!-- <RNCEmisor>531058447</RNCEmisor> --></ECF>'),
    ).toBeUndefined();
  });

  it('does not read from an unterminated comment', () => {
    expect(
      issuerTaxPayerId('<ECF><!-- <RNCEmisor>531058447</RNCEmisor></ECF>'),
    ).toBeUndefined();
  });

  it('reads the issuer past a processing instruction and a declaration', () => {
    expect(
      issuerTaxPayerId(
        '<?xml version="1.0"?><?dgii mode="test"?><!DOCTYPE ECF><ECF><RNCEmisor>531058447</RNCEmisor></ECF>',
      ),
    ).toBe('531058447');
  });

  it('reads RNCEmisor from an e-CF document', () => {
    expect(issuerTaxPayerId('<ECF><RNCEmisor>531058447</RNCEmisor></ECF>')).toBe(
      '531058447',
    );
  });

  it('reads RncEmisor from an ANECF document', () => {
    expect(issuerTaxPayerId('<ANECF><RncEmisor>505074758</RncEmisor></ANECF>')).toBe(
      '505074758',
    );
  });

  it('prefers RNCEmisor when both spellings are present', () => {
    expect(
      issuerTaxPayerId(
        '<x><RNCEmisor>531058447</RNCEmisor><RncEmisor>505074758</RncEmisor></x>',
      ),
    ).toBe('531058447');
  });

  it('returns undefined rather than guessing', () => {
    expect(issuerTaxPayerId('<ECF><Otro>1</Otro></ECF>')).toBeUndefined();
  });
});

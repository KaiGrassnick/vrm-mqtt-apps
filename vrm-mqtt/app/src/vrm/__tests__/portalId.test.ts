import { toBrokerPortalId } from '../portalId';

describe('toBrokerPortalId', () => {
  it('returns the identifier unchanged when no replacement marker is present', () => {
    expect(toBrokerPortalId('c0619ab417b5')).toBe('c0619ab417b5');
  });

  it('strips a " - USEDASREPLACEMENT AT <digits>" suffix', () => {
    expect(toBrokerPortalId('c0619ab417b5 - USEDASREPLACEMENT AT 1719937767'))
      .toBe('c0619ab417b5');
  });

  it('strips the suffix even when surrounded by variable whitespace', () => {
    expect(toBrokerPortalId('c0619ab417b5   USEDASREPLACEMENT   AT   1719937767'))
      .toBe('c0619ab417b5');
  });

  it('accepts any digit run as the timestamp (defensive)', () => {
    expect(toBrokerPortalId('c0619ab417b5 USEDASREPLACEMENT AT 1')).toBe('c0619ab417b5');
    expect(toBrokerPortalId('c0619ab417b5 USEDASREPLACEMENT AT 99999999999'))
      .toBe('c0619ab417b5');
  });

  it('does not match "USEDASREPLACEMENT" without the trailing "AT <digits>"', () => {
    // Tokens without a digit run must be left alone — defends against partial matches.
    expect(toBrokerPortalId('c0619ab417b5 USEDASREPLACEMENT')).toBe('c0619ab417b5 USEDASREPLACEMENT');
  });

  it('matches the marker case-sensitively', () => {
    expect(toBrokerPortalId('c0619ab417b5 usedasreplacement at 1719937767'))
      .toBe('c0619ab417b5 usedasreplacement at 1719937767');
  });

  it('returns "" for an empty input', () => {
    expect(toBrokerPortalId('')).toBe('');
  });

  it('trims trailing whitespace after stripping the marker', () => {
    // 'c0619ab417b5  USEDASREPLACEMENT AT 17  ' → strips the marker, trims whitespace.
    expect(toBrokerPortalId('c0619ab417b5  USEDASREPLACEMENT AT 17  ')).toBe('c0619ab417b5');
  });
});

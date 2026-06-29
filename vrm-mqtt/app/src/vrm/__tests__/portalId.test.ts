import { toBrokerPortalId } from '../portalId';

describe('toBrokerPortalId', () => {
  it('returns the identifier unchanged when no replacement marker is present', () => {
    expect(toBrokerPortalId('samplePortalId')).toBe('samplePortalId');
  });

  it('strips a " - USEDASREPLACEMENT AT <digits>" suffix', () => {
    expect(toBrokerPortalId('samplePortalId - USEDASREPLACEMENT AT 1234567890'))
      .toBe('samplePortalId');
  });

  it('strips the suffix even when surrounded by variable whitespace', () => {
    expect(toBrokerPortalId('samplePortalId   USEDASREPLACEMENT   AT   1234567890'))
      .toBe('samplePortalId');
  });

  it('accepts any digit run as the timestamp (defensive)', () => {
    expect(toBrokerPortalId('samplePortalId USEDASREPLACEMENT AT 1')).toBe('samplePortalId');
    expect(toBrokerPortalId('samplePortalId USEDASREPLACEMENT AT 99999999999'))
      .toBe('samplePortalId');
  });

  it('does not match "USEDASREPLACEMENT" without the trailing "AT <digits>"', () => {
    // Tokens without a digit run must be left alone — defends against partial matches.
    expect(toBrokerPortalId('samplePortalId USEDASREPLACEMENT')).toBe('samplePortalId USEDASREPLACEMENT');
  });

  it('matches the marker case-sensitively', () => {
    expect(toBrokerPortalId('samplePortalId usedasreplacement at 1234567890'))
      .toBe('samplePortalId usedasreplacement at 1234567890');
  });

  it('returns "" for an empty input', () => {
    expect(toBrokerPortalId('')).toBe('');
  });

  it('trims trailing whitespace after stripping the marker', () => {
    // 'samplePortalId  USEDASREPLACEMENT AT 17  ' → strips the marker, trims whitespace.
    expect(toBrokerPortalId('samplePortalId  USEDASREPLACEMENT AT 17  ')).toBe('samplePortalId');
  });
});

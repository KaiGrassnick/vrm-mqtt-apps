import { VrmApiError, VrmApiAuthError, ConfigurationError } from '../errors';

describe('VrmApiError', () => {
  it('sets message, statusCode, and responseBody', () => {
    const err = new VrmApiError('VRM API request failed: 500 Internal Server Error', 500, '{"error":"boom"}');
    expect(err.message).toBe('VRM API request failed: 500 Internal Server Error');
    expect(err.statusCode).toBe(500);
    expect(err.responseBody).toBe('{"error":"boom"}');
  });

  it('sets name to VrmApiError', () => {
    const err = new VrmApiError('failed', 500, '');
    expect(err.name).toBe('VrmApiError');
  });

  it('is an instance of Error', () => {
    const err = new VrmApiError('failed', 500, '');
    expect(err).toBeInstanceOf(Error);
  });
});

describe('VrmApiAuthError', () => {
  it('hardcodes statusCode 401 and a fixed message', () => {
    const err = new VrmApiAuthError('{"error":"unauthorized"}');
    expect(err.statusCode).toBe(401);
    expect(err.message).toBe('VRM API authentication failed');
  });

  it('carries the response body through', () => {
    const err = new VrmApiAuthError('{"error":"unauthorized"}');
    expect(err.responseBody).toBe('{"error":"unauthorized"}');
  });

  it('sets name to VrmApiAuthError', () => {
    const err = new VrmApiAuthError('');
    expect(err.name).toBe('VrmApiAuthError');
  });

  it('is an instance of both VrmApiError and Error', () => {
    const err = new VrmApiAuthError('');
    expect(err).toBeInstanceOf(VrmApiError);
    expect(err).toBeInstanceOf(Error);
  });
});

describe('ConfigurationError', () => {
  it('sets the message', () => {
    const err = new ConfigurationError('Missing required environment variable: VRM_API_TOKEN');
    expect(err.message).toBe('Missing required environment variable: VRM_API_TOKEN');
  });

  it('sets name to ConfigurationError', () => {
    const err = new ConfigurationError('bad config');
    expect(err.name).toBe('ConfigurationError');
  });

  it('is an instance of Error', () => {
    const err = new ConfigurationError('bad config');
    expect(err).toBeInstanceOf(Error);
  });
});

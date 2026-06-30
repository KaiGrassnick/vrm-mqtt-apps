import { Logger, resolveLevel } from '../logger';

describe('resolveLevel', () => {
  it('defaults to info when undefined', () => {
    expect(resolveLevel(undefined)).toBe('info');
  });

  it('defaults to info for an unrecognised value', () => {
    expect(resolveLevel('verbose')).toBe('info');
  });

  it('accepts debug/info/warn/error/silent', () => {
    expect(resolveLevel('debug')).toBe('debug');
    expect(resolveLevel('info')).toBe('info');
    expect(resolveLevel('warn')).toBe('warn');
    expect(resolveLevel('error')).toBe('error');
    expect(resolveLevel('silent')).toBe('silent');
  });

  it('is case-insensitive', () => {
    expect(resolveLevel('DEBUG')).toBe('debug');
    expect(resolveLevel('Warn')).toBe('warn');
  });
});

describe('Logger', () => {
  let debugSpy: jest.SpyInstance;
  let logSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    debugSpy = jest.spyOn(console, 'debug').mockImplementation(() => {});
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('at level info, suppresses debug but allows info/warn/error', () => {
    const logger = new Logger('info');
    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');

    expect(debugSpy).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith('i');
    expect(warnSpy).toHaveBeenCalledWith('w');
    expect(errorSpy).toHaveBeenCalledWith('e');
  });

  it('at level debug, allows everything', () => {
    const logger = new Logger('debug');
    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');

    expect(debugSpy).toHaveBeenCalledWith('d');
    expect(logSpy).toHaveBeenCalledWith('i');
    expect(warnSpy).toHaveBeenCalledWith('w');
    expect(errorSpy).toHaveBeenCalledWith('e');
  });

  it('at level warn, suppresses debug and info but allows warn/error', () => {
    const logger = new Logger('warn');
    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');

    expect(debugSpy).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith('w');
    expect(errorSpy).toHaveBeenCalledWith('e');
  });

  it('at level error, suppresses everything but error', () => {
    const logger = new Logger('error');
    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');

    expect(debugSpy).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith('e');
  });

  it('at level silent, suppresses everything', () => {
    const logger = new Logger('silent');
    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');

    expect(debugSpy).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('setLevel/getLevel change behavior at runtime', () => {
    const logger = new Logger('error');
    expect(logger.getLevel()).toBe('error');
    logger.info('suppressed');
    expect(logSpy).not.toHaveBeenCalled();

    logger.setLevel('info');
    expect(logger.getLevel()).toBe('info');
    logger.info('visible');
    expect(logSpy).toHaveBeenCalledWith('visible');
  });

  it('forwards multiple arguments through to the underlying console method', () => {
    const logger = new Logger('debug');
    const err = new Error('boom');
    logger.error('[Test]', err);
    expect(errorSpy).toHaveBeenCalledWith('[Test]', err);
  });
});

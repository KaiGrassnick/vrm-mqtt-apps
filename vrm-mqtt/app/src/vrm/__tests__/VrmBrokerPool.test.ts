import type { MqttClient } from 'mqtt';

function makeMockClient(): Partial<MqttClient> & { endAsync: jest.Mock } {
  return {
    endAsync: jest.fn().mockResolvedValue(undefined),
    on: jest.fn().mockReturnThis(),
  } as unknown as Partial<MqttClient> & { endAsync: jest.Mock };
}

const mockConnect = jest.fn();

jest.mock('mqtt', () => ({
  connect: (...args: unknown[]): unknown => mockConnect(...args),
}));

import { VrmBrokerPool } from '../VrmBrokerPool';

describe('VrmBrokerPool', () => {
  const opts = { username: 'user@example.com', password: 'Token abc123' };

  beforeEach(() => {
    jest.clearAllMocks();
    mockConnect.mockReturnValue(makeMockClient());
  });

  describe('getOrCreate', () => {
    it('calls mqtt.connect with correct url and credentials', () => {
      const pool = new VrmBrokerPool(opts);
      pool.getOrCreate('mqtt5.victronenergy.com');

      expect(mockConnect).toHaveBeenCalledTimes(1);
      const [url, connectOpts] = mockConnect.mock.calls[0] as [string, Record<string, unknown>];
      expect(url).toBe('mqtts://mqtt5.victronenergy.com:8883');
      expect(connectOpts.username).toBe('user@example.com');
      expect(connectOpts.password).toBe('Token abc123');
    });

    it('sets resubscribe: false', () => {
      const pool = new VrmBrokerPool(opts);
      pool.getOrCreate('mqtt5.victronenergy.com');

      const [, connectOpts] = mockConnect.mock.calls[0] as [string, Record<string, unknown>];
      expect(connectOpts.resubscribe).toBe(false);
    });

    it('returns the same client for the same host', () => {
      const pool = new VrmBrokerPool(opts);
      const a = pool.getOrCreate('mqtt5.victronenergy.com');
      const b = pool.getOrCreate('mqtt5.victronenergy.com');

      expect(mockConnect).toHaveBeenCalledTimes(1);
      expect(a).toBe(b);
    });

    it('creates separate clients for different hosts', () => {
      mockConnect
        .mockReturnValueOnce(makeMockClient())
        .mockReturnValueOnce(makeMockClient());

      const pool = new VrmBrokerPool(opts);
      const a = pool.getOrCreate('mqtt5.victronenergy.com');
      const b = pool.getOrCreate('mqtt7.victronenergy.com');

      expect(mockConnect).toHaveBeenCalledTimes(2);
      expect(a).not.toBe(b);
    });
  });

  describe('destroyAll', () => {
    it('calls endAsync on all cached clients', async () => {
      const c1 = makeMockClient();
      const c2 = makeMockClient();
      mockConnect.mockReturnValueOnce(c1).mockReturnValueOnce(c2);

      const pool = new VrmBrokerPool(opts);
      pool.getOrCreate('mqtt5.victronenergy.com');
      pool.getOrCreate('mqtt7.victronenergy.com');

      await pool.destroyAll();

      expect(c1.endAsync).toHaveBeenCalledTimes(1);
      expect(c2.endAsync).toHaveBeenCalledTimes(1);
    });

    it('creates a new client after destroyAll for the same host', async () => {
      mockConnect.mockReturnValue(makeMockClient());

      const pool = new VrmBrokerPool(opts);
      pool.getOrCreate('mqtt5.victronenergy.com');
      await pool.destroyAll();
      pool.getOrCreate('mqtt5.victronenergy.com');

      expect(mockConnect).toHaveBeenCalledTimes(2);
    });
  });
});

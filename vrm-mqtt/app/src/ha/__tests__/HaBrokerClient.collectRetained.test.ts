import { jest } from '@jest/globals';
import { EventEmitter } from 'events';
import type { MqttClient } from 'mqtt';

function makeFakeClient(): MqttClient {
  const emitter = new EventEmitter();
  (emitter as unknown as { connected: boolean }).connected = true;
  return emitter as unknown as MqttClient;
}

describe('HaBrokerClient.collectRetained', () => {
  it('captures messages emitted before the subscribe callback fires', async () => {
    jest.useFakeTimers();
    const { HaBrokerClient } = await import('../HaBrokerClient');
    const fakeClient = makeFakeClient();

    const unsubCb = jest.fn();
    let subscribeCb: ((err?: Error) => void) | undefined;
    (fakeClient as unknown as { subscribe: jest.Mock }).subscribe = jest.fn(
      (_pattern: string, _opts: unknown, cb: (err?: Error) => void) => { subscribeCb = cb; },
    ) as unknown as jest.Mock;
    (fakeClient as unknown as { unsubscribe: jest.Mock }).unsubscribe = jest.fn(
      (_pattern: string, cb: () => void) => { unsubCb(); cb(); },
    ) as unknown as jest.Mock;

    const client = new HaBrokerClient({ host: 'h', port: 1 });
    (client as unknown as { client: MqttClient }).client = fakeClient;

    const emitter = fakeClient as unknown as EventEmitter;
    const promise = client.collectRetained('foo/#', 300);

    // Microtask drain so listener can be attached.
    await Promise.resolve();

    // Simulate a retained message arriving BEFORE the subscribe ack returns.
    emitter.emit('message', 'foo/bar', Buffer.from('payload-1'));

    // Now the subscribe ack fires.
    subscribeCb!();

    jest.advanceTimersByTime(300);
    await Promise.resolve();
    await Promise.resolve();

    const result = await promise;
    expect(result).toEqual([{ topic: 'foo/bar', payload: 'payload-1' }]);
    expect(unsubCb).toHaveBeenCalledTimes(1);

    // Listener must be removed after finish.
    expect(fakeClient.listeners('message').length).toBe(0);

    jest.useRealTimers();
  });

  it('cleans up the listener when subscribe callback fires with an error', async () => {
    jest.useFakeTimers();
    const { HaBrokerClient } = await import('../HaBrokerClient');
    const fakeClient = makeFakeClient();

    const unsubCb = jest.fn();
    let subscribeCb: ((err?: Error) => void) | undefined;
    (fakeClient as unknown as { subscribe: jest.Mock }).subscribe = jest.fn(
      (_pattern: string, _opts: unknown, cb: (err?: Error) => void) => { subscribeCb = cb; },
    ) as unknown as jest.Mock;
    (fakeClient as unknown as { unsubscribe: jest.Mock }).unsubscribe = jest.fn(
      (_p: string, cb: () => void) => { unsubCb(); cb(); },
    ) as unknown as jest.Mock;

    const client = new HaBrokerClient({ host: 'h', port: 1 });
    (client as unknown as { client: MqttClient }).client = fakeClient;

    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const promise = client.collectRetained('foo/#', 100);

    // Microtask drain so listener can be attached.
    await Promise.resolve();

    // Subscribe fails.
    subscribeCb!(new Error('nope'));
    await Promise.resolve();

    // Listener should be removed and unsubscribe called even on error.
    expect(fakeClient.listeners('message').length).toBe(0);
    expect(unsubCb).toHaveBeenCalledTimes(1);

    const result = await promise;
    expect(result).toEqual([]);

    errorSpy.mockRestore();
    jest.useRealTimers();
  });
});
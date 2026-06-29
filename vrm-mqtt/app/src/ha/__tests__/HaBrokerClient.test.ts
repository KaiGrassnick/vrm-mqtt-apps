import { jest } from '@jest/globals';
import { EventEmitter } from 'events';
import type { MqttClient } from 'mqtt';

jest.mock('mqtt', () => ({
  connect: jest.fn(),
}));

import mqtt from 'mqtt';
import { HaBrokerClient } from '../HaBrokerClient';

const mockedConnect = mqtt.connect as unknown as jest.Mock;

function makeFakeClient(connected = true): MqttClient & EventEmitter {
  const emitter = new EventEmitter() as unknown as MqttClient & EventEmitter;
  (emitter as unknown as { connected: boolean }).connected = connected;
  (emitter as unknown as { publish: jest.Mock }).publish = jest.fn(
    (_t: string, _p: string, _o: unknown, cb?: (err?: Error) => void) => cb && cb(),
  ) as unknown as jest.Mock;
  (emitter as unknown as { subscribe: jest.Mock }).subscribe = jest.fn(
    (_t: unknown, _o: unknown, cb?: (err?: Error) => void) => cb && cb(),
  ) as unknown as jest.Mock;
  (emitter as unknown as { end: jest.Mock }).end = jest.fn(
    (_f: boolean, _o: unknown, cb?: () => void) => cb && cb(),
  ) as unknown as jest.Mock;
  return emitter;
}

describe('HaBrokerClient', () => {
  beforeEach(() => {
    mockedConnect.mockReset();
  });

  it('connects with the configured host/port and credentials', () => {
    const fake = makeFakeClient();
    mockedConnect.mockReturnValue(fake);

    const client = new HaBrokerClient({ host: 'h', port: 1883, username: 'u', password: 'p' });
    client.start();

    expect(mockedConnect).toHaveBeenCalledWith(expect.objectContaining({
      host: 'h',
      port: 1883,
      username: 'u',
      password: 'p',
    }));
  });

  it('invokes onBirth when homeassistant/status "online" is received', () => {
    const fake = makeFakeClient();
    mockedConnect.mockReturnValue(fake);

    const client = new HaBrokerClient({ host: 'h', port: 1 });
    const onBirth = jest.fn();
    client.onBirth = onBirth;
    client.start();

    fake.emit('message', 'homeassistant/status', Buffer.from('online'));
    expect(onBirth).toHaveBeenCalledTimes(1);

    fake.emit('message', 'homeassistant/status', Buffer.from('offline'));
    expect(onBirth).toHaveBeenCalledTimes(1);
  });

  it('routes vrm/.../set topics to onCommand', () => {
    const fake = makeFakeClient();
    mockedConnect.mockReturnValue(fake);

    const client = new HaBrokerClient({ host: 'h', port: 1 });
    const onCommand = jest.fn();
    client.onCommand = onCommand;
    client.start();

    fake.emit('message', 'vrm/abc/solarcharger/512/Mode/set', Buffer.from('On'));
    expect(onCommand).toHaveBeenCalledWith('vrm/abc/solarcharger/512/Mode/set', 'On');

    // Non-/set topics are ignored.
    fake.emit('message', 'vrm/abc/system/0/Foo', Buffer.from('1'));
    expect(onCommand).toHaveBeenCalledTimes(1);
  });

  it('invokes onConnect on connect and onOffline on offline', () => {
    const fake = makeFakeClient();
    mockedConnect.mockReturnValue(fake);

    const client = new HaBrokerClient({ host: 'h', port: 1 });
    const onConnect = jest.fn();
    const onOffline = jest.fn();
    client.onConnect = onConnect;
    client.onOffline = onOffline;
    client.start();

    fake.emit('connect');
    expect(onConnect).toHaveBeenCalledTimes(1);

    fake.emit('offline');
    expect(onOffline).toHaveBeenCalledTimes(1);
  });

  it('publish() drops messages when not connected', () => {
    const fake = makeFakeClient(false);
    mockedConnect.mockReturnValue(fake);

    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const client = new HaBrokerClient({ host: 'h', port: 1 });
    client.start();

    client.publish('vrm/x', 'payload', false);
    expect((fake as unknown as { publish: jest.Mock }).publish).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Not connected'));

    warn.mockRestore();
  });

  it('publish() forwards to the underlying client when connected', () => {
    const fake = makeFakeClient(true);
    mockedConnect.mockReturnValue(fake);

    const client = new HaBrokerClient({ host: 'h', port: 1 });
    client.start();

    client.publish('vrm/x', 'payload', true);
    expect((fake as unknown as { publish: jest.Mock }).publish).toHaveBeenCalledWith(
      'vrm/x', 'payload', expect.objectContaining({ retain: true }), expect.any(Function),
    );
  });

  it('publish() defaults retained to true so throttle-driven state messages retain on the broker', () => {
    const fake = makeFakeClient(true);
    mockedConnect.mockReturnValue(fake);

    const client = new HaBrokerClient({ host: 'h', port: 1 });
    client.start();

    client.publish('vrm/1/system/0/Dc/Battery/Voltage', '13.4');
    expect((fake as unknown as { publish: jest.Mock }).publish).toHaveBeenCalledWith(
      'vrm/1/system/0/Dc/Battery/Voltage',
      '13.4',
      expect.objectContaining({ retain: true }),
      expect.any(Function),
    );
  });

  it('stop() calls end on the underlying client', async () => {
    const fake = makeFakeClient();
    mockedConnect.mockReturnValue(fake);

    const client = new HaBrokerClient({ host: 'h', port: 1 });
    client.start();

    await client.stop();
    expect((fake as unknown as { end: jest.Mock }).end).toHaveBeenCalledTimes(1);
  });
});
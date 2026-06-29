import { VrmApiClient } from '../VrmApiClient';
import { VrmApiError, VrmApiAuthError } from '../../errors';

const mockFetch = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>();
global.fetch = mockFetch;

function makeFetchResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

describe('VrmApiClient', () => {
  const client = new VrmApiClient({
    apiToken: 'test-token',
    baseUrl: 'https://vrmapi.victronenergy.com/v2',
  });

  beforeEach(() => {
    mockFetch.mockReset();
  });

  describe('getMe()', () => {
    it('returns a VrmUser with correct id, name, email', async () => {
      mockFetch.mockResolvedValueOnce(
        makeFetchResponse({
          user: { id: 1, name: 'Test User', email: 'test@example.com' },
          success: true,
        }),
      );

      const user = await client.getMe();

      expect(user.id).toBe(1);
      expect(user.name).toBe('Test User');
      expect(user.email).toBe('test@example.com');
    });

    it('calls /users/me with Token auth header', async () => {
      mockFetch.mockResolvedValueOnce(
        makeFetchResponse({
          user: { id: 1, name: 'u', email: 'u@u.com' },
          success: true,
        }),
      );

      await client.getMe();

      expect(mockFetch).toHaveBeenCalledWith(
        'https://vrmapi.victronenergy.com/v2/users/me',
        expect.objectContaining({
          headers: expect.objectContaining({
            'X-Authorization': 'Token test-token',
          }),
        }),
      );
    });

    it('throws VrmApiAuthError on 401', async () => {
      mockFetch.mockResolvedValueOnce(makeFetchResponse({ error: 'Unauthorized' }, 401));
      await expect(client.getMe()).rejects.toBeInstanceOf(VrmApiAuthError);
    });

    it('throws VrmApiError on 500', async () => {
      mockFetch.mockResolvedValueOnce(makeFetchResponse({ error: 'Server error' }, 500));
      await expect(client.getMe()).rejects.toBeInstanceOf(VrmApiError);
    });

    it('throws VrmApiError when fetch rejects (network failure)', async () => {
      mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));
      await expect(client.getMe()).rejects.toBeInstanceOf(VrmApiError);
    });
  });

  describe('getInstallations()', () => {
    it('returns mapped VrmInstallation array with camelCase fields', async () => {
      mockFetch.mockResolvedValueOnce(
        makeFetchResponse({
          records: [
            {
              idSite: 42,
              name: 'Home Solar',
              identifier: 'test-portal-efgh5678',
              mqtt_host: 'mqtt5.victronenergy.com',
              mqtt_webhost: 'mqtt5.victronenergy.com',
            },
          ],
          success: true,
        }),
      );

      const installations = await client.getInstallations(1);

      expect(installations).toHaveLength(1);
      expect(installations[0]).toEqual({
        idSite: 42,
        name: 'Home Solar',
        identifier: 'test-portal-efgh5678',
        brokerPortalId: 'test-portal-efgh5678',
        mqttHost: 'mqtt5.victronenergy.com',
        mqttWebHost: 'mqtt5.victronenergy.com',
      });
    });

    it('calls correct URL with userId and extended=1', async () => {
      mockFetch.mockResolvedValueOnce(
        makeFetchResponse({ records: [], success: true }),
      );

      await client.getInstallations(2);

      expect(mockFetch).toHaveBeenCalledWith(
        'https://vrmapi.victronenergy.com/v2/users/2/installations?extended=1',
        expect.anything(),
      );
    });

    it('returns empty array when no installations', async () => {
      mockFetch.mockResolvedValueOnce(
        makeFetchResponse({ records: [], success: true }),
      );
      const result = await client.getInstallations(1);
      expect(result).toEqual([]);
    });

    it('throws VrmApiAuthError on 401', async () => {
      mockFetch.mockResolvedValueOnce(makeFetchResponse({ error: 'Unauthorized' }, 401));
      await expect(client.getInstallations(1)).rejects.toBeInstanceOf(VrmApiAuthError);
    });
  });

  describe('getInstallations derivation', () => {
    it('returns brokerPortalId equal to identifier when no marker is present', async () => {
      mockFetch.mockResolvedValueOnce(
        makeFetchResponse({
          records: [
            {
              idSite: 1,
              name: 'Site',
              identifier: 'c0619ab417b5',
              mqtt_host: 'mqtt5.example',
              mqtt_webhost: 'webmqtt5.example',
            },
          ],
          success: true,
        }),
      );

      const installations = await client.getInstallations(42);

      expect(installations).toHaveLength(1);
      expect(installations[0].identifier).toBe('c0619ab417b5');
      expect(installations[0].brokerPortalId).toBe('c0619ab417b5');
    });

    it('strips the USEDASREPLACEMENT suffix from brokerPortalId', async () => {
      mockFetch.mockResolvedValueOnce(
        makeFetchResponse({
          records: [
            {
              idSite: 2,
              name: 'Replaced',
              identifier: 'c0619ab417b5 - USEDASREPLACEMENT AT 1719937767',
              mqtt_host: 'mqtt7.example',
              mqtt_webhost: 'webmqtt7.example',
            },
          ],
          success: true,
        }),
      );

      const installations = await client.getInstallations(42);

      expect(installations).toHaveLength(1);
      expect(installations[0].identifier).toBe('c0619ab417b5 - USEDASREPLACEMENT AT 1719937767');
      expect(installations[0].brokerPortalId).toBe('c0619ab417b5');
    });

    it('drops records whose brokerPortalId derivation is empty and warns', async () => {
      mockFetch.mockResolvedValueOnce(
        makeFetchResponse({
          records: [
            {
              idSite: 99,
              name: 'Bad',
              identifier: 'USEDASREPLACEMENT AT 1',
              mqtt_host: 'mqtt.example',
              mqtt_webhost: 'webmqtt.example',
            },
            {
              idSite: 100,
              name: 'Good',
              identifier: 'c0619ab417b5',
              mqtt_host: 'mqtt.example',
              mqtt_webhost: 'webmqtt.example',
            },
          ],
          success: true,
        }),
      );

      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

      const installations = await client.getInstallations(1);

      expect(installations).toHaveLength(1);
      expect(installations[0].idSite).toBe(100);
      expect(warnSpy).toHaveBeenCalledWith(
        '[VRM] Dropping installation idSite=99: empty brokerPortalId after derivation',
      );

      warnSpy.mockRestore();
    });
  });

  describe('constructor', () => {
    it('strips trailing slash from baseUrl', async () => {
      const clientWithSlash = new VrmApiClient({
        apiToken: 'tok',
        baseUrl: 'https://vrmapi.victronenergy.com/v2/',
      });
      mockFetch.mockResolvedValueOnce(
        makeFetchResponse({ user: { id: 1, name: 'u', email: 'u@u.com' }, success: true }),
      );
      await clientWithSlash.getMe();
      expect(mockFetch).toHaveBeenCalledWith(
        'https://vrmapi.victronenergy.com/v2/users/me',
        expect.anything(),
      );
    });
  });
});

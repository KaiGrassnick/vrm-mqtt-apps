import { VrmApiError, VrmApiAuthError } from '../errors';
import type {
  VrmMeResponse,
  VrmUser,
  VrmInstallationsResponse,
  VrmInstallation,
} from './types';

export interface VrmApiClientConfig {
  apiToken: string;
  baseUrl: string;
}

export class VrmApiClient {
  private readonly baseUrl: string;
  private readonly authHeader: string;

  constructor(config: VrmApiClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.authHeader = `Token ${config.apiToken}`;
  }

  async getMe(): Promise<VrmUser> {
    const data = await this.get<VrmMeResponse>('/users/me');
    return {
      id: data.user.id,
      name: data.user.name,
      email: data.user.email,
    };
  }

  async getInstallations(userId: number): Promise<VrmInstallation[]> {
    const data = await this.get<VrmInstallationsResponse>(
      `/users/${userId}/installations?extended=1`,
    );
    return data.records.map((r) => ({
      idSite: r.idSite,
      name: r.name,
      identifier: r.identifier,
      mqttHost: r.mqtt_host,
      mqttWebHost: r.mqtt_webhost,
    }));
  }

  private async get<T>(path: string): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    let response: Response;

    try {
      response = await fetch(url, {
        method: 'GET',
        headers: {
          'X-Authorization': this.authHeader,
          'Content-Type': 'application/json',
        },
      });
    } catch (cause) {
      throw new VrmApiError(
        `Network error calling ${url}: ${cause instanceof Error ? cause.message : String(cause)}`,
        0,
        '',
      );
    }

    const body = await response.text();

    if (response.status === 401) {
      throw new VrmApiAuthError(body);
    }

    if (!response.ok) {
      throw new VrmApiError(
        `VRM API request failed: ${response.status} ${response.statusText}`,
        response.status,
        body,
      );
    }

    try {
      return JSON.parse(body) as T;
    } catch {
      throw new VrmApiError('Failed to parse VRM API response as JSON', response.status, body);
    }
  }
}

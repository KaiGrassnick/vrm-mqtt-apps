export class VrmApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly responseBody: string,
  ) {
    super(message);
    this.name = 'VrmApiError';
  }
}

export class VrmApiAuthError extends VrmApiError {
  constructor(responseBody: string) {
    super('VRM API authentication failed', 401, responseBody);
    this.name = 'VrmApiAuthError';
  }
}

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

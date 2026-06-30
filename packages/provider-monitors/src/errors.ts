export class ProviderMonitorError extends Error {
  readonly provider: string;

  constructor(provider: string, message: string) {
    super(`${provider}: ${message}`);
    this.name = 'ProviderMonitorError';
    this.provider = provider;
  }
}

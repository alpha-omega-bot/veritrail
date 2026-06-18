import { describe, expect, it } from 'vitest';

import { VeritrailError } from '@veritrail/core';

import { VeritrailClient } from '../src/index.js';

function textResponse(body: string, init: ResponseInit): Response {
  return new Response(body, init);
}

describe('VeritrailClient', () => {
  it('wraps non-JSON error responses as VeritrailError', async () => {
    const client = new VeritrailClient({
      fetchImpl: async () =>
        textResponse('<html>bad gateway</html>', { status: 502, statusText: 'Bad Gateway' }),
    });

    await expect(client.health()).rejects.toMatchObject({
      name: 'VeritrailError',
      code: 'INTERNAL',
      message: 'Bad Gateway',
    });
  });

  it('wraps non-JSON successful responses as VeritrailError', async () => {
    const client = new VeritrailClient({
      fetchImpl: async () => textResponse('ok', { status: 200, statusText: 'OK' }),
    });

    let error: unknown;
    try {
      await client.health();
    } catch (cause) {
      error = cause;
    }
    expect(error).toBeInstanceOf(VeritrailError);
    expect(error).toMatchObject({
      code: 'INTERNAL',
      message: 'expected JSON response body',
    });
  });
});

import 'server-only';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { ACCESS_HEADER } from './access';
import { accessToken, signInPath } from './session';

/**
 * The control API, called server-to-server with the operator's own token and the Cloudflare Access
 * token this request arrived with, which the API checks again. The API URL is internal
 * configuration (`CONTROL_API_URL`) and is never sent to the browser.
 */
function baseUrl(): string {
  const url = process.env['CONTROL_API_URL'];
  if (url === undefined || url === '') throw new Error('CONTROL_API_URL is not configured.');
  return url.replace(/\/+$/, '');
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * The operator's Identity token and the Cloudflare Access token this request arrived with. Every
 * operator route on the API needs both, so every call sends both, downloads included.
 */
async function credentials(returnTo: string): Promise<Record<string, string>> {
  const token = await accessToken();
  if (token === undefined) redirect(signInPath(returnTo));
  const access = (await headers()).get(ACCESS_HEADER);
  return {
    authorization: `Bearer ${token}`,
    ...(access !== null && { [ACCESS_HEADER]: access }),
  };
}

async function call<T>(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH',
  path: string,
  options: { body?: unknown; idempotencyKey?: string; returnTo?: string } = {},
): Promise<T> {
  const response = await fetch(`${baseUrl()}/api/v1${path}`, {
    method,
    headers: {
      ...(await credentials(options.returnTo ?? '/')),
      accept: 'application/json',
      ...(options.body !== undefined && { 'content-type': 'application/json' }),
      ...(options.idempotencyKey !== undefined && { 'idempotency-key': options.idempotencyKey }),
    },
    ...(options.body !== undefined && { body: JSON.stringify(options.body) }),
    cache: 'no-store',
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status === 401) redirect(signInPath(options.returnTo ?? '/'));
  const text = await response.text();
  const json: unknown = text === '' ? null : JSON.parse(text);
  if (!response.ok) {
    const problem = (json ?? {}) as {
      code?: string;
      detail?: string;
      details?: Record<string, unknown>;
    };
    throw new ApiError(
      response.status,
      problem.code ?? String(response.status),
      problem.detail ??
        (response.status === 403
          ? 'You do not have permission to do that.'
          : 'The request failed.'),
      problem.details,
    );
  }
  return json as T;
}

export const apiGet = <T>(path: string, returnTo?: string): Promise<T> =>
  call<T>('GET', path, returnTo === undefined ? {} : { returnTo });

export const apiSend = <T>(
  method: 'POST' | 'PUT' | 'PATCH',
  path: string,
  body: unknown,
  idempotencyKey?: string,
): Promise<T> =>
  call<T>(method, path, { body, ...(idempotencyKey !== undefined && { idempotencyKey }) });

/** The raw response, for a download the portal streams back to the browser. */
export async function apiDownload(path: string): Promise<Response> {
  return fetch(`${baseUrl()}/api/v1${path}`, {
    headers: await credentials('/'),
    cache: 'no-store',
    signal: AbortSignal.timeout(10_000),
  });
}

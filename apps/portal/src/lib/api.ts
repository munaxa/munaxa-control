import 'server-only';

import { redirect } from 'next/navigation';

import { accessToken, signInPath } from './session';

/**
 * The control API, called server-to-server with the operator's own token. The API URL is internal
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

async function call<T>(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH',
  path: string,
  options: { body?: unknown; idempotencyKey?: string; returnTo?: string } = {},
): Promise<T> {
  const token = await accessToken();
  if (token === undefined) redirect(signInPath(options.returnTo ?? '/'));
  const response = await fetch(`${baseUrl()}/api/v1${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
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
  const token = await accessToken();
  if (token === undefined) redirect(signInPath('/'));
  return fetch(`${baseUrl()}/api/v1${path}`, {
    headers: { authorization: `Bearer ${token}` },
    cache: 'no-store',
    signal: AbortSignal.timeout(10_000),
  });
}

import { headers } from 'next/headers';

import { apiDownload, apiGet } from './api';
import { accessToken } from './session';

vi.mock('next/headers', () => ({ headers: vi.fn() }));
vi.mock('next/navigation', () => ({
  redirect: vi.fn(() => {
    throw new Error('redirected');
  }),
}));
vi.mock('./session', () => ({
  accessToken: vi.fn(),
  signInPath: (returnTo: string) => `/api/auth/login?returnTo=${returnTo}`,
}));

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubEnv('CONTROL_API_URL', 'http://control-api.internal:3100/');
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));
  vi.mocked(accessToken).mockResolvedValue('identity-token');
  vi.mocked(headers).mockResolvedValue(
    new Headers({ 'cf-access-jwt-assertion': 'access-token' }) as never,
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const sentHeaders = (): Record<string, string> =>
  (fetchMock.mock.calls[0]?.[1] as { headers: Record<string, string> }).headers;

describe('the control API client', () => {
  it('sends the Identity and Cloudflare Access tokens with a call', async () => {
    await apiGet('/admin/dashboard');
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'http://control-api.internal:3100/api/v1/admin/dashboard',
    );
    expect(sentHeaders()).toMatchObject({
      authorization: 'Bearer identity-token',
      'cf-access-jwt-assertion': 'access-token',
    });
  });

  it('sends both with a download too, which the API refuses without Access', async () => {
    await apiDownload('/admin/licences/x/download');
    expect(sentHeaders()).toMatchObject({
      authorization: 'Bearer identity-token',
      'cf-access-jwt-assertion': 'access-token',
    });
  });

  it('sends no Access header when the request carried none (Access off outside production)', async () => {
    vi.mocked(headers).mockResolvedValue(new Headers() as never);
    await apiDownload('/admin/products/docs/revocation-list');
    expect(sentHeaders()).toEqual({ authorization: 'Bearer identity-token' });
  });

  it('sends nobody without a session to sign-in, and calls nothing', async () => {
    vi.mocked(accessToken).mockResolvedValue(undefined);
    await expect(apiDownload('/admin/licences/x/download')).rejects.toThrow('redirected');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

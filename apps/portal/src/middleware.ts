import { type NextRequest, NextResponse } from 'next/server';

import { ACCESS_HEADER, AccessVerifier, accessConfigFrom } from './lib/access';
import { contentSecurityPolicy, newNonce } from './lib/csp';

const SESSION_COOKIE = '__Host-mx_session';

let verifier: { readonly key: string; readonly instance: AccessVerifier } | null = null;

/** One verifier per configuration, so its key set is kept between requests. */
function accessVerifier(): AccessVerifier | null | string {
  const config = accessConfigFrom(process.env);
  if (config === null || typeof config === 'string') return config;
  const key = `${config.teamDomain} ${config.audience}`;
  if (verifier?.key !== key) verifier = { key, instance: new AccessVerifier(config) };
  return verifier.instance;
}

/**
 * Cloudflare Access first: without its token (a request that went round Access, straight to the
 * load balancer), nothing here answers, not a page, not a script, not a server action. Then: no
 * session, no console: straight to Munaxa Identity's sign-in, returning here afterwards. The
 * session check is navigation only (the API authenticates every request itself) and never
 * inspects the token beyond its presence.
 */
export async function middleware(request: NextRequest): Promise<NextResponse> {
  const access = accessVerifier();
  if (typeof access === 'string') {
    console.error(`Operator access is misconfigured: ${access}`);
    return plain(503, 'Operator access is not configured.');
  }
  if (access !== null) {
    const outcome = await access.verify(request.headers.get(ACCESS_HEADER));
    if (!outcome.ok) {
      if (outcome.status === 503) console.error(`Operator access unavailable: ${outcome.reason}`);
      return outcome.status === 503
        ? plain(503, 'Operator sign-in is unavailable. Try again shortly.')
        : plain(401, 'Sign in through Cloudflare Access.');
    }
  }
  if (isAsset(request.nextUrl.pathname)) return NextResponse.next();

  const nonce = newNonce();
  const policy = contentSecurityPolicy(nonce, process.env.NODE_ENV === 'development');
  if (!request.cookies.get(SESSION_COOKIE)?.value) {
    const url = request.nextUrl.clone();
    url.pathname = '/api/auth/login';
    url.search = `?returnTo=${encodeURIComponent(request.nextUrl.pathname + request.nextUrl.search)}`;
    const redirect = NextResponse.redirect(url);
    redirect.headers.set('Content-Security-Policy', policy);
    return redirect;
  }
  // Next.js reads the policy from the request to stamp its own scripts with the nonce.
  const headers = new Headers(request.headers);
  headers.set('x-nonce', nonce);
  headers.set('Content-Security-Policy', policy);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set('Content-Security-Policy', policy);
  return response;
}

const plain = (status: number, body: string): NextResponse =>
  new NextResponse(body, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  });

const isAsset = (path: string): boolean =>
  path.startsWith('/_next/') || path.startsWith('/branding/') || path.startsWith('/favicon');

// Everything, Next's own assets included, but the load balancer's health check and the Identity
// routes the front door sends elsewhere. Node.js runtime, so the configuration is read when the
// portal starts, not baked in when it is built.
export const config = {
  matcher: ['/((?!healthz$|api/).*)'],
  runtime: 'nodejs',
};

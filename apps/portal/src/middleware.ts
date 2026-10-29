import { type NextRequest, NextResponse } from 'next/server';

import { contentSecurityPolicy, newNonce } from './lib/csp';

const SESSION_COOKIE = '__Host-mx_session';

/**
 * No session, no console: straight to Munaxa Identity's sign-in, returning here afterwards. This
 * is navigation only — the API authenticates every request itself — and it never inspects the
 * token beyond its presence.
 */
export function middleware(request: NextRequest): NextResponse {
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

// Everything but Next's own assets and the Identity routes the front door sends elsewhere.
export const config = { matcher: ['/((?!_next/|api/|favicon|branding/).*)'] };

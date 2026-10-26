import { type NextRequest, NextResponse } from 'next/server';

const SESSION_COOKIE = '__Host-mx_session';

/**
 * No session, no console: straight to Munaxa Identity's sign-in, returning here afterwards. This
 * is navigation only — the API authenticates every request itself — and it never inspects the
 * token beyond its presence.
 */
export function middleware(request: NextRequest): NextResponse {
  if (request.cookies.get(SESSION_COOKIE)?.value) return NextResponse.next();
  const url = request.nextUrl.clone();
  url.pathname = '/api/auth/login';
  url.search = `?returnTo=${encodeURIComponent(request.nextUrl.pathname + request.nextUrl.search)}`;
  return NextResponse.redirect(url);
}

// Everything but Next's own assets and the Identity routes the front door sends elsewhere.
export const config = { matcher: ['/((?!_next/|api/|favicon|branding/).*)'] };

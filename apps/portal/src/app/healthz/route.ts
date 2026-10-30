/**
 * The load balancer's health check. Outside the middleware (no Access token, no session), so it
 * says only that the process serves, and nothing about the console.
 */
export const dynamic = 'force-dynamic';

export function GET(): Response {
  return new Response('ok', {
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  });
}

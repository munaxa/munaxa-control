/**
 * The console's Content-Security-Policy, built per request around a fresh nonce.
 *
 * Scripts run only when they carry this response's nonce (Next.js stamps its own when the request
 * arrives with the policy), and `'strict-dynamic'` extends that trust to what they load — so an
 * injected `<script>` or an `<script src>` on another origin does not run. The console is never
 * framed, posts forms only to itself, and talks only to its own origin (the API is reached
 * server-side). Development adds `'unsafe-eval'`, which Next's dev server needs; production never.
 */
export function contentSecurityPolicy(nonce: string, development = false): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${development ? " 'unsafe-eval'" : ''}`,
    // Next.js and the design system set inline style attributes; styles cannot run code.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/** A nonce: 128 random bits, base64. */
export function newNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}

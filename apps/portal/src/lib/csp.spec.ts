import { describe, expect, it } from 'vitest';

import { contentSecurityPolicy, newNonce } from './csp';

const directives = (policy: string) =>
  new Map(
    policy.split('; ').map((d) => {
      const [name, ...values] = d.split(' ');
      return [name, values] as const;
    }),
  );

describe('the console content security policy', () => {
  it('runs only scripts carrying this response nonce, and nothing eval-like in production', () => {
    const script = directives(contentSecurityPolicy('abc'))?.get('script-src');
    expect(script).toEqual(["'self'", "'nonce-abc'", "'strict-dynamic'"]);
    expect(script).not.toContain("'unsafe-inline'");
    expect(script).not.toContain("'unsafe-eval'");
  });

  it('allows eval only for the development server', () => {
    expect(directives(contentSecurityPolicy('abc', true)).get('script-src')).toContain(
      "'unsafe-eval'",
    );
  });

  it('is never framed, has no plugins or base hijack, and posts and connects only to itself', () => {
    const d = directives(contentSecurityPolicy('n'));
    expect(d.get('frame-ancestors')).toEqual(["'none'"]);
    expect(d.get('object-src')).toEqual(["'none'"]);
    expect(d.get('base-uri')).toEqual(["'none'"]);
    expect(d.get('form-action')).toEqual(["'self'"]);
    expect(d.get('connect-src')).toEqual(["'self'"]);
    expect(d.get('default-src')).toEqual(["'self'"]);
  });

  it('draws a fresh 128-bit nonce each time', () => {
    const a = newNonce();
    expect(atob(a)).toHaveLength(16);
    expect(newNonce()).not.toBe(a);
  });
});

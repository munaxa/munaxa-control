import { operatorFrom, signInPath } from './session';

vi.mock('next/headers', () => ({ cookies: vi.fn() }));

const token = (claims: unknown): string =>
  `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;

describe('operatorFrom', () => {
  it('reads the subject and permissions, ignoring anything that is not a string', () => {
    const operator = operatorFrom(
      token({ sub: 'ops@munaxa', perms: ['control:customers:read', 7] }),
    );
    expect(operator?.subject).toBe('ops@munaxa');
    expect([...(operator?.permissions ?? [])]).toEqual(['control:customers:read']);
  });

  it('reads a token it cannot decode as nobody', () => {
    expect(operatorFrom('not-a-token')).toBeNull();
    expect(operatorFrom('h.%%%.s')).toBeNull();
    expect(operatorFrom(token({ perms: [] }))).toBeNull();
  });
});

describe('signInPath', () => {
  it('sends the operator back where they were, encoded', () => {
    expect(signInPath('/customers?q=a&b')).toBe(
      '/api/auth/login?returnTo=%2Fcustomers%3Fq%3Da%26b',
    );
  });
});

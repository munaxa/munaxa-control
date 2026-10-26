import { FormInputError, parseLimits, parseList } from './forms';

describe('parseLimits', () => {
  it('reads numbers and unlimited, one per line', () => {
    expect(parseLimits('users=25\r\nstorage.bytes = unlimited\n\nseats=\n')).toEqual({
      users: 25,
      'storage.bytes': null,
      seats: null,
    });
  });

  it('refuses what would be sent as something else', () => {
    for (const text of ['users', '=5', 'users=-1', 'users=2.5', 'users=1e3', 'users=ten']) {
      expect(() => parseLimits(text), text).toThrow(FormInputError);
    }
    expect(() => parseLimits('users=1\nusers=2')).toThrow(/twice/);
  });

  it('treats nothing as no limits, which the API reads as zero for every metric', () => {
    expect(parseLimits(undefined)).toEqual({});
  });
});

describe('parseList', () => {
  it('splits on spaces, commas and new lines and drops duplicates', () => {
    expect(parseList('api.access, integration.webhooks\napi.access  sso.federation')).toEqual([
      'api.access',
      'integration.webhooks',
      'sso.federation',
    ]);
    expect(parseList(undefined)).toEqual([]);
  });
});

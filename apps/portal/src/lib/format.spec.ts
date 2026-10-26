import { formatDate, formatDateTime, formatLimit, formatMoney, statusTone } from './format';

describe('format', () => {
  it('shows dates in UTC and missing values as a dash', () => {
    expect(formatDate('2026-10-26T23:30:00-02:00')).toBe('2026-10-27');
    expect(formatDateTime('2026-10-26T10:05:00Z')).toBe('2026-10-26 10:05 UTC');
    expect(formatDate(null)).toBe('—');
    expect(formatDate('nonsense')).toBe('—');
  });

  it('shows money from minor units only with a currency', () => {
    expect(formatMoney(9900, 'JOD')).toBe('99.00 JOD');
    expect(formatMoney(9900, null)).toBe('—');
  });

  it('reads null as unlimited and every status as a tone', () => {
    expect(formatLimit(null)).toBe('Unlimited');
    expect(formatLimit(1500)).toBe('1,500');
    expect(statusTone('SUSPENDED')).toBe('danger');
    expect(statusTone('CANCELLED')).toBe('muted');
  });
});

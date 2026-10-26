/** Display helpers. Dates are shown in UTC with the zone named, because operators span zones. */
export function formatDate(value: string | null | undefined): string {
  if (value === null || value === undefined) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : `${date.toISOString().slice(0, 10)}`;
}

export function formatDateTime(value: string | null | undefined): string {
  if (value === null || value === undefined) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? '—'
    : `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

export function formatMoney(
  minor: number | null | undefined,
  currency: string | null | undefined,
): string {
  if (minor === null || minor === undefined || currency === null || currency === undefined)
    return '—';
  return `${(minor / 100).toFixed(2)} ${currency}`;
}

export function formatLimit(value: number | null | undefined): string {
  return value === null || value === undefined ? 'Unlimited' : value.toLocaleString('en');
}

export type Tone = 'default' | 'success' | 'warning' | 'danger' | 'muted';

/** How each lifecycle status reads at a glance. */
export function statusTone(status: string | null | undefined): Tone {
  switch (status) {
    case 'ACTIVE':
      return 'success';
    case 'TRIAL':
      return 'default';
    case 'PAST_DUE':
    case 'GRACE_PERIOD':
      return 'warning';
    case 'EXPIRED':
    case 'SUSPENDED':
      return 'danger';
    default:
      return 'muted';
  }
}

export const PRODUCT_NAMES: Readonly<Record<string, string>> = {
  school: 'Munaxa School',
  work: 'Munaxa Work',
  docs: 'Munaxa Docs',
};

export const productName = (product: string): string => PRODUCT_NAMES[product] ?? product;

export function formString(data: FormData, name: string): string | undefined {
  const value = data.get(name);
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

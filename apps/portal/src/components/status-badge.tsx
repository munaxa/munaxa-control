import type { ReactNode } from 'react';

import { Badge } from '@munaxa/ui';

import { statusTone } from '@/lib/format';

const LABEL: Readonly<Record<string, string>> = {
  TRIAL: 'Trial',
  ACTIVE: 'Active',
  PAST_DUE: 'Past due',
  GRACE_PERIOD: 'Grace period',
  EXPIRED: 'Expired',
  SUSPENDED: 'Suspended',
  CANCELLED: 'Cancelled',
};

export function StatusBadge({ status }: { status: string }): ReactNode {
  return <Badge tone={statusTone(status)}>{LABEL[status] ?? status}</Badge>;
}

'use client';

import { type ReactNode, useActionState, useState } from 'react';

import { Alert, Button, Input } from '@munaxa/ui';

import type { FormState } from '@/app/actions';

/**
 * A form posting to a server action, showing the API's answer in place.
 *
 * It mints its `Idempotency-Key` once, when drawn, and sends it with every submission of that form
 * — so a double click or a retried submit is one action, and drawing the form again (after a
 * success) is a new one.
 */
export function ActionForm({
  action,
  submitLabel,
  children,
  tone = 'primary',
  confirm,
}: {
  action: (state: FormState, data: FormData) => Promise<FormState>;
  submitLabel: string;
  children?: ReactNode;
  tone?: 'primary' | 'destructive' | 'outline';
  confirm?: string;
}): ReactNode {
  const [state, submit, pending] = useActionState(action, {});
  const [key] = useState(() => crypto.randomUUID());

  return (
    <form
      action={submit}
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        if (confirm !== undefined && !window.confirm(confirm)) event.preventDefault();
      }}
    >
      <input type="hidden" name="idempotencyKey" value={key} />
      {children}
      {state.error !== undefined && (
        <Alert tone="danger" live="alert">
          {state.error}
        </Alert>
      )}
      {state.message !== undefined && (
        <Alert tone={state.secret === undefined ? 'success' : 'warning'} live="status">
          {state.message}
        </Alert>
      )}
      {state.secret !== undefined && (
        <Input
          readOnly
          value={state.secret}
          aria-label="New credential"
          className="font-mono"
          onFocus={(e) => e.currentTarget.select()}
        />
      )}
      <div>
        <Button type="submit" variant={tone === 'primary' ? 'default' : tone} disabled={pending}>
          {pending ? 'Working…' : submitLabel}
        </Button>
      </div>
    </form>
  );
}

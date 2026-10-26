'use client';

import type { ReactNode } from 'react';

import { Button, ErrorState, Page } from '@munaxa/ui';

/** A failed page says so, with no detail that could carry a customer's data or a credential. */
export default function ConsoleError({ reset }: { error: Error; reset: () => void }): ReactNode {
  return (
    <Page>
      <ErrorState
        title="This page could not be loaded"
        description="The control API refused or did not answer. Try again; if it persists, check the API's health."
        action={<Button onClick={reset}>Try again</Button>}
      />
    </Page>
  );
}

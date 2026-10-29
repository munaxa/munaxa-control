'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { ApiError, apiSend } from '@/lib/api';
import { formString } from '@/lib/format';
import { FormInputError, parseLimits, parseList } from '@/lib/forms';

/**
 * Every mutation the portal can make. Each is a thin, typed call to the control API with the
 * operator's own token; the API decides, authorises and audits. Nothing here holds state.
 *
 * Every form carries an `idempotencyKey` minted once when it is drawn, sent as `Idempotency-Key`:
 * a double click, a retried submission or a flaky connection performs the action once.
 */
export interface FormState {
  readonly error?: string;
  readonly message?: string;
  /** A value shown once and never again — a newly issued service credential. */
  readonly secret?: string;
}

type Action = (state: FormState, data: FormData) => Promise<FormState>;

const required = (data: FormData, name: string): string => {
  const value = formString(data, name);
  if (value === undefined) throw new FormInputError(`${name} is required.`);
  return value;
};

const optionalNumber = (data: FormData, name: string): number | undefined => {
  const value = formString(data, name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0)
    throw new FormInputError(`${name} must be a whole number.`);
  return parsed;
};

const isoOrUndefined = (data: FormData, name: string): string | undefined => {
  const value = formString(data, name);
  if (value === undefined) return undefined;
  // A date input gives YYYY-MM-DD; a term ends at the end of that day, UTC.
  const date = new Date(`${value}T23:59:59.000Z`);
  if (Number.isNaN(date.getTime())) throw new FormInputError(`${name} is not a date.`);
  return date.toISOString();
};

/** Runs the call, turning an API refusal into a message the form shows. Redirects pass through. */
function action(
  run: (data: FormData, key: string | undefined) => Promise<FormState | undefined>,
): Action {
  return async (_state, data) => {
    try {
      return (await run(data, formString(data, 'idempotencyKey'))) ?? {};
    } catch (error) {
      if (error instanceof FormInputError) return { error: error.message };
      if (error instanceof ApiError) {
        const issues = Array.isArray(error.details?.['issues'])
          ? ` ${(error.details['issues'] as string[]).join('; ')}`
          : '';
        return { error: `${error.message}${issues}` };
      }
      throw error;
    }
  };
}

// --- Customers ---------------------------------------------------------------------------------

export const createCustomer = action(async (data, key) => {
  const customer = await apiSend<{ id: string }>(
    'POST',
    '/admin/customers',
    {
      name: required(data, 'name'),
      ...(formString(data, 'legalName') !== undefined && {
        legalName: formString(data, 'legalName'),
      }),
      ...(formString(data, 'country') !== undefined && {
        country: formString(data, 'country')?.toUpperCase(),
      }),
      ...(formString(data, 'contactEmail') !== undefined && {
        contactEmail: formString(data, 'contactEmail'),
      }),
    },
    key,
  );
  redirect(`/customers/${customer.id}`);
});

export const setCustomerStatus = action(async (data, key) => {
  const id = required(data, 'customerId');
  await apiSend(
    'PATCH',
    `/admin/customers/${id}`,
    { expectedVersion: Number(required(data, 'version')), status: required(data, 'status') },
    key,
  );
  revalidatePath(`/customers/${id}`);
  return { message: 'Customer updated.' };
});

export const linkTenant = action(async (data, key) => {
  const customerId = required(data, 'customerId');
  const deploymentType = required(data, 'deploymentType');
  await apiSend(
    'POST',
    `/admin/customers/${customerId}/tenants`,
    {
      product: required(data, 'product'),
      tenantRef: required(data, 'tenantRef'),
      deploymentType,
      ...(deploymentType === 'SAAS' && { deploymentId: required(data, 'deploymentId') }),
      displayName: required(data, 'displayName'),
    },
    key,
  );
  revalidatePath(`/customers/${customerId}`);
  return { message: 'Tenant linked.' };
});

// --- Deployments and credentials ----------------------------------------------------------------

export const createDeployment = action(async (data, key) => {
  await apiSend(
    'POST',
    '/admin/deployments',
    { product: required(data, 'product'), name: required(data, 'name') },
    key,
  );
  revalidatePath('/deployments');
  return { message: 'Deployment created.' };
});

export const issueCredential = action(async (data, key) => {
  const deploymentId = required(data, 'deploymentId');
  const issued = await apiSend<{ token: string }>(
    'POST',
    `/admin/deployments/${deploymentId}/credentials`,
    { label: required(data, 'label') },
    key,
  );
  revalidatePath('/deployments');
  return {
    message: 'Copy this credential now. It is not stored and cannot be shown again.',
    secret: issued.token,
  };
});

export const revokeCredential = action(async (data, key) => {
  await apiSend('POST', `/admin/credentials/${required(data, 'credentialId')}/revoke`, {}, key);
  revalidatePath('/deployments');
  return { message: 'Credential revoked. The deployment is refused from its next request.' };
});

// --- Plans --------------------------------------------------------------------------------------

export const createPlan = action(async (data, key) => {
  const plan = await apiSend<{ id: string }>(
    'POST',
    '/admin/plans',
    {
      product: required(data, 'product'),
      code: required(data, 'code'),
      name: required(data, 'name'),
      ...(formString(data, 'description') !== undefined && {
        description: formString(data, 'description'),
      }),
    },
    key,
  );
  redirect(`/plans/${plan.id}`);
});

export const draftVersion = action(async (data, key) => {
  const planId = required(data, 'planId');
  const priceMinor = optionalNumber(data, 'priceMinor');
  await apiSend(
    'POST',
    `/admin/plans/${planId}/versions`,
    {
      features: parseList(formString(data, 'features')),
      limits: parseLimits(formString(data, 'limits')),
      priceMinor: priceMinor ?? null,
      currency: formString(data, 'currency')?.toUpperCase() ?? null,
      billingPeriod: formString(data, 'billingPeriod') ?? null,
      trialDays: optionalNumber(data, 'trialDays') ?? 0,
      graceDays: optionalNumber(data, 'graceDays') ?? 14,
    },
    key,
  );
  revalidatePath(`/plans/${planId}`);
  return { message: 'Draft version created. Publish it to sell it.' };
});

export const publishVersion = action(async (data, key) => {
  await apiSend('POST', `/admin/plan-versions/${required(data, 'versionId')}/publish`, {}, key);
  revalidatePath(`/plans/${required(data, 'planId')}`);
  return { message: 'Published. Its terms are now frozen.' };
});

export const retireVersion = action(async (data, key) => {
  await apiSend('POST', `/admin/plan-versions/${required(data, 'versionId')}/retire`, {}, key);
  revalidatePath(`/plans/${required(data, 'planId')}`);
  return { message: 'Retired. Existing subscribers keep it; it can no longer be sold.' };
});

// --- Subscriptions -----------------------------------------------------------------------------

export const createSubscription = action(async (data, key) => {
  const expiresAt = isoOrUndefined(data, 'expiresAt');
  const subscription = await apiSend<{ id: string }>(
    'POST',
    '/admin/subscriptions',
    {
      tenantLinkId: required(data, 'tenantLinkId'),
      planVersionId: required(data, 'planVersionId'),
      start: required(data, 'start'),
      ...(expiresAt !== undefined && { expiresAt }),
      ...(formString(data, 'reason') !== undefined && { reason: formString(data, 'reason') }),
    },
    key,
  );
  redirect(`/subscriptions/${subscription.id}`);
});

export const transitionSubscription = action(async (data, key) => {
  const id = required(data, 'subscriptionId');
  const expiresAt = isoOrUndefined(data, 'expiresAt');
  await apiSend(
    'POST',
    `/admin/subscriptions/${id}/transitions`,
    {
      event: required(data, 'event'),
      expectedVersion: Number(required(data, 'version')),
      ...(expiresAt !== undefined && { expiresAt }),
      ...(formString(data, 'reason') !== undefined && { reason: formString(data, 'reason') }),
    },
    key,
  );
  revalidatePath(`/subscriptions/${id}`);
  return { message: 'Done.' };
});

export const changePlan = action(async (data, key) => {
  const id = required(data, 'subscriptionId');
  await apiSend(
    'POST',
    `/admin/subscriptions/${id}/plan`,
    {
      planVersionId: required(data, 'planVersionId'),
      expectedVersion: Number(required(data, 'version')),
      ...(formString(data, 'reason') !== undefined && { reason: formString(data, 'reason') }),
    },
    key,
  );
  revalidatePath(`/subscriptions/${id}`);
  return { message: 'Plan changed.' };
});

// --- Licences and installations -----------------------------------------------------------------

export const issueLicence = action(async (data, key) => {
  const id = required(data, 'subscriptionId');
  const expiresAt = isoOrUndefined(data, 'expiresAt');
  await apiSend(
    'POST',
    `/admin/subscriptions/${id}/licences`,
    {
      installationRef: formString(data, 'installationRef') ?? null,
      ...(expiresAt !== undefined && { expiresAt }),
    },
    key,
  );
  revalidatePath(`/subscriptions/${id}`);
  return { message: 'Licence issued. Download it from the list below.' };
});

export const revokeLicence = action(async (data, key) => {
  const subscriptionId = required(data, 'subscriptionId');
  await apiSend(
    'POST',
    `/admin/licences/${required(data, 'licenceId')}/revoke`,
    { reason: required(data, 'reason'), category: required(data, 'category') },
    key,
  );
  revalidatePath(`/subscriptions/${subscriptionId}`);
  return {
    message:
      'Revocation recorded. An offline installation applies it once it receives the new revocation list.',
  };
});

export const registerInstallation = action(async (data, key) => {
  const tenantLinkId = required(data, 'tenantLinkId');
  await apiSend(
    'POST',
    `/admin/tenants/${tenantLinkId}/installations`,
    { installationRef: required(data, 'installationRef') },
    key,
  );
  revalidatePath(`/customers/${required(data, 'customerId')}`);
  return { message: 'Installation registered.' };
});

export const activate = action(async (data, key) => {
  const issued = await apiSend<{ id: string; installationRef: string; expiresAt: string }>(
    'POST',
    '/admin/activations',
    { code: required(data, 'code') },
    key,
  );
  return {
    message: `Licence ${issued.id} issued for installation ${issued.installationRef}, valid to ${issued.expiresAt.slice(0, 10)}. Download it from the subscription.`,
  };
});

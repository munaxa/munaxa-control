import { randomUUID } from 'node:crypto';

/** Identifiers this service mints. UUIDv4: nothing here orders by id. */
export const newId = (): string => randomUUID();

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

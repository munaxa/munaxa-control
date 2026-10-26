import { z } from 'zod';

/** Common query shapes, so every list pages the same way. */
export const pageSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const uuidParam = z.string().uuid();

export const isoDate = z
  .string()
  .datetime({ offset: true })
  .transform((value) => new Date(value));

/** Optimistic concurrency: every change names the version it was made against. */
export const expectedVersion = z.number().int().min(1);

export const reasonSchema = z.string().trim().min(3).max(500);

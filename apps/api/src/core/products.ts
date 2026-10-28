import { z } from 'zod';
import { isKey } from '@munaxa/licensing';

/**
 * The products this control plane sells, by their `@munaxa/licensing` product key. The database
 * refuses any other (`ck_*_product`), so adding one is a migration and a line here, deliberately.
 */
export const PRODUCTS = ['school', 'work', 'docs'] as const;
export type Product = (typeof PRODUCTS)[number];

export const productSchema = z.enum(PRODUCTS);
export const isProduct = (value: string): value is Product =>
  (PRODUCTS as readonly string[]).includes(value);

/** A feature or limit key in the shared grammar. Its meaning is the product's, never this service's. */
export const keySchema = z
  .string()
  .refine(isKey, 'must be a lowercase key such as "reports.advanced"');

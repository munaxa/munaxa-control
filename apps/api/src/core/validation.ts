import { type PipeTransform } from '@nestjs/common';
import type { ZodType } from 'zod';

import { invalid } from './errors';

/** Validates a body or query with zod, refusing unknown shapes with the failing paths named. */
export class ZodPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T, unknown>) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw invalid('The request is not valid.', {
        issues: result.error.issues.map(
          (i) => `${i.path.map(String).join('.') || '(body)'}: ${i.message}`,
        ),
      });
    }
    return result.data;
  }
}

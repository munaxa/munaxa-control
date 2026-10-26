/**
 * `bigint` columns (prices, usage values, audit ids) as numbers when safe and strings when not.
 * `JSON.stringify` throws on a bigint; every serialisation here goes through this.
 */
export const bigintReplacer = (_key: string, value: unknown): unknown =>
  typeof value === 'bigint'
    ? value <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(value)
      : value.toString()
    : value;

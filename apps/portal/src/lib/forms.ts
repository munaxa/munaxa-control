/** What an operator typed that cannot be sent: shown on the form, never sent to the API. */
export class FormInputError extends Error {}

/** `users=25`, `storage.bytes=unlimited`, one per line. A blank value means unlimited. */
export function parseLimits(text: string | undefined): Record<string, number | null> {
  const limits: Record<string, number | null> = {};
  for (const line of (text ?? '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const separator = trimmed.indexOf('=');
    if (separator <= 0) throw new FormInputError(`"${trimmed}" is not key=value.`);
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim();
    if (key in limits) throw new FormInputError(`${key} is listed twice.`);
    if (value === '' || value.toLowerCase() === 'unlimited') limits[key] = null;
    else {
      const parsed = Number(value);
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed))
        throw new FormInputError(`${key} must be a whole number or "unlimited".`);
      limits[key] = parsed;
    }
  }
  return limits;
}

/** Feature keys separated by spaces, commas or new lines; duplicates collapse. */
export const parseList = (text: string | undefined): string[] => [
  ...new Set(
    (text ?? '')
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter((s) => s !== ''),
  ),
];

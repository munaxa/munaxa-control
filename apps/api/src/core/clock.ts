/** Time, injectable so lifecycle rules are assertions rather than waits. */
export const CLOCK = Symbol('Clock');

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

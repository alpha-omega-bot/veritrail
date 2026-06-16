import {
  DefaultIdGenerator,
  noopLogger,
  systemClock,
  type Clock,
  type IdGenerator,
  type Ledger,
  type Logger,
  type ModuleContext,
} from '@veritrail/core';

export interface ContextOverrides {
  clock?: Clock;
  ids?: IdGenerator;
  logger?: Logger;
}

/**
 * Build a `ModuleContext` from a ledger plus optional port overrides, filling in
 * production-safe defaults (system clock, time-ordered ids, silent logger). All
 * modules built from one context share the same ledger — that is what makes the
 * capabilities one system.
 */
export function createModuleContext(
  ledger: Ledger,
  overrides: ContextOverrides = {},
): ModuleContext {
  const clock = overrides.clock ?? systemClock;
  return {
    ledger,
    clock,
    ids: overrides.ids ?? new DefaultIdGenerator(clock),
    logger: overrides.logger ?? noopLogger,
  };
}

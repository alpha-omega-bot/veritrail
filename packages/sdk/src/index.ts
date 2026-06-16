/**
 * `@veritrail/sdk` — integrate Veritrail into an agent.
 *
 * - {@link Governor}: in-process instrumentation that enforces the
 *   propose → permit → guard-spend → execute → record lifecycle on the ledger.
 * - {@link VeritrailClient}: a typed HTTP client for the Veritrail server.
 * - {@link createModuleContext}: build a shared `ModuleContext` for the modules.
 */
export { createModuleContext, type ContextOverrides } from './context.js';
export {
  Governor,
  createGovernor,
  type ActionInput,
  type GovernanceConfig,
  type RunOptions,
  type GovernedExecution,
} from './governor.js';
export { VeritrailClient, type VeritrailClientOptions } from './client.js';

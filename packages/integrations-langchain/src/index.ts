/**
 * `@veritrail/integrations-langchain` — drop-in LangChain JS callback handler
 * that streams agent lifecycle events (LLM start/end, tool invocations, chain
 * boundaries) into a Veritrail server via the SDK's HTTP client.
 *
 * The handler is duck-typed against LangChain's `BaseCallbackHandler`. Users
 * bring their own LangChain version — this package has no LangChain dependency
 * and stays stable across LangChain releases.
 */
export {
  VeritrailCallbackHandler,
  type VeritrailCallbackHandlerOptions,
  type LangChainLLMStartRun,
  type LangChainLLMResult,
} from './callback-handler.js';

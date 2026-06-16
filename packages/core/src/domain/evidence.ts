import { z } from 'zod';

import { IdSchema, TimestampSchema } from './common.js';

export const EvidenceKindSchema = z.enum([
  'document',
  'observation',
  'tool_output',
  'citation',
  'dataset',
  'artifact',
]);
export type EvidenceKind = z.infer<typeof EvidenceKindSchema>;

/**
 * A piece of evidence in a provenance graph: a document, a tool output, a
 * citation, etc. `contentHash` lets the evidence tracer prove the referenced
 * content has not changed since it was captured. `links` connect evidence to the
 * decisions and actions it supports, and to upstream evidence it derives from.
 */
export const EvidenceSchema = z
  .object({
    id: IdSchema,
    kind: EvidenceKindSchema,
    /** A URI or opaque reference to the source. */
    source: z.string().default(''),
    /** SHA-256 (hex) of the referenced content, for integrity over time. */
    contentHash: z
      .string()
      .regex(/^[0-9a-f]{64}$/, 'contentHash must be a 64-char hex sha256')
      .optional(),
    summary: z.string().default(''),
    capturedAt: TimestampSchema.optional(),
    links: z
      .object({
        decisionIds: z.array(IdSchema).default([]),
        actionIds: z.array(IdSchema).default([]),
        /** Upstream evidence this was derived from — enables provenance chains. */
        evidenceIds: z.array(IdSchema).default([]),
      })
      .strict()
      .default({}),
  })
  .strict();

export type Evidence = z.infer<typeof EvidenceSchema>;

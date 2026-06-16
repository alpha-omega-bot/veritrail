import { z } from 'zod';

import { IdSchema, LabelsSchema, TimestampSchema } from './common.js';

export const VendorCategorySchema = z.enum(['llm', 'api', 'data', 'infra', 'tooling', 'other']);
export type VendorCategory = z.infer<typeof VendorCategorySchema>;

export const VendorCriticalitySchema = z.enum(['low', 'medium', 'high', 'critical']);
export type VendorCriticality = z.infer<typeof VendorCriticalitySchema>;

export const VendorSignalKindSchema = z.enum([
  'incident', // service incident / outage
  'breach', // security breach
  'degradation', // performance/quality degradation
  'policy_change', // terms, data-handling, or pricing change
  'certification', // gained/lost a compliance certification
  'deprecation', // model/API/version deprecation
  'availability', // uptime/availability signal
  'other',
]);
export type VendorSignalKind = z.infer<typeof VendorSignalKindSchema>;

export const VendorSignalSeveritySchema = z.enum(['info', 'low', 'medium', 'high', 'critical']);
export type VendorSignalSeverity = z.infer<typeof VendorSignalSeveritySchema>;

/** A discrete risk observation about a vendor. */
export const VendorSignalSchema = z
  .object({
    id: IdSchema,
    vendorId: IdSchema,
    kind: VendorSignalKindSchema,
    severity: VendorSignalSeveritySchema,
    summary: z.string().min(1).max(2000),
    /** Where the signal came from (feed name, url, analyst). */
    source: z.string().default(''),
    observedAt: TimestampSchema.optional(),
  })
  .strict();
export type VendorSignal = z.infer<typeof VendorSignalSchema>;

/** A third party the platform depends on: a model provider, API, data source, etc. */
export const VendorSchema = z
  .object({
    id: IdSchema,
    name: z.string().min(1).max(512),
    category: VendorCategorySchema,
    criticality: VendorCriticalitySchema.default('medium'),
    labels: LabelsSchema.default({}),
    createdAt: TimestampSchema.optional(),
  })
  .strict();
export type Vendor = z.infer<typeof VendorSchema>;

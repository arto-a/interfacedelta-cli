import { z } from 'zod';

const count = z.number().int().nonnegative().safe();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const labelWithdrawalReasonSchema = z.enum([
  'BREAKING_CHANGE_OBSERVED',
  'PUBLISHER_DISPUTE',
  'OPERATOR_REMOVED',
  'SUPERSEDED',
]);
export const labelChangeClassSchema = z.enum([
  'baseline',
  'unchanged',
  'breaking',
  'indeterminate',
  'non_breaking',
  'informational',
  'unclassified',
  'not_comparable',
  'not_computed',
]);
export const labelDescriptionCodeSchema = z.enum([
  'INVISIBLE_CHARACTERS',
  'INSTRUCTION_TO_MODEL',
  'CREDENTIAL_OR_FILE_REQUEST',
  'CROSS_TOOL_REFERENCE',
  'HIDDEN_SCHEMA_TEXT',
  'DESCRIPTION_CHANGED_WITHOUT_REVISION',
]);
export const labelDisagreementCodeSchema = z.enum([
  'DECLARED_READ_ONLY_READ_AS_WRITE',
  'DECLARED_DESTRUCTIVE_READ_AS_NON_WRITING',
  'DECLARED_NON_DESTRUCTIVE_READ_AS_DELETE',
  'DECLARED_CLOSED_WORLD_READ_AS_EXTERNAL',
]);
export const labelSignInSchema = z.enum([
  'apiKey',
  'http',
  'oauth2',
  'openIdConnect',
  'mutualTLS',
  'other_declared',
]);
const document = z
  .object({
    version: z.literal('interfacedelta-capability-label-v1'),
    subject: z
      .object({
        targetKey: z.string().regex(/^sha256:[a-f0-9]{64}$/),
        origin: z
          .string()
          .url()
          .refine((value) => {
            try {
              const url = new URL(value);
              return url.protocol === 'https:' && url.origin === value;
            } catch {
              return false;
            }
          }),
      })
      .strict(),
    issuedAt: z.string().datetime(),
    observedAt: z.string().datetime(),
    passportFingerprint: hash,
    ruleVersion: z.enum(['compatibility-rules-v8', 'compatibility-rules-v10']),
    descriptionRuleVersion: z.literal('description-checks-v1'),
    lensVersions: z.array(z.literal('side-effects@1')).max(2),
    facts: z
      .object({
        protocols: z
          .array(
            z.enum([
              'mcp',
              'mcp-server-card',
              'openapi',
              'a2a',
              'ard',
              'webmcp',
            ]),
          )
          .max(6),
        toolCount: count,
        countedReadings: z
          .object({
            move_money: count,
            delete: count,
            send_message: count,
            change_permissions: count,
            execute_code: count,
            ask_human: count,
          })
          .strict(),
        readingCoverage: z
          .object({
            examinedTools: count,
            countedTools: count,
            disputedTools: count,
          })
          .strict(),
        disagreements: z
          .array(
            z.object({ code: labelDisagreementCodeSchema, count }).strict(),
          )
          .max(4),
        descriptionChecks: z
          .array(z.object({ code: labelDescriptionCodeSchema, count }).strict())
          .max(6),
        descriptionCoverage: z
          .object({
            tools: count,
            schemaTextAvailable: count,
            annotationTextAvailable: count,
          })
          .strict(),
        declaredSignInSchemes: z.array(labelSignInSchema).max(6),
        latestRevision: hash,
        lastChange: z
          .object({
            observedAt: z.string().datetime(),
            classification: labelChangeClassSchema,
          })
          .strict()
          .nullable(),
        changeClassification: labelChangeClassSchema,
      })
      .strict(),
  })
  .strict();
export const capabilityLabelSchema = z.discriminatedUnion('status', [
  document.extend({ status: z.literal('current') }).strict(),
  document
    .extend({
      status: z.literal('withdrawn'),
      reason: labelWithdrawalReasonSchema,
    })
    .strict(),
]);
export const signedCapabilityLabelSchema = z
  .object({
    label: capabilityLabelSchema,
    fingerprint: hash,
    signature: z.string().regex(/^[A-Za-z0-9_-]+\.\.[A-Za-z0-9_-]+$/),
  })
  .strict();
export type CapabilityLabel = z.infer<typeof capabilityLabelSchema>;
export type SignedCapabilityLabel = z.infer<typeof signedCapabilityLabelSchema>;
export type LabelWithdrawalReason = z.infer<typeof labelWithdrawalReasonSchema>;

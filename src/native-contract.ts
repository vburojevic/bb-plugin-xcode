/** Atlas is the allocation authority. These RPCs execute only its fenced jobs. */
import { defineRpcContract } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import { stepSchema, MAX_STEPS } from './sim/steps';

export const laneIdentity = z.object({
  capability: z.string().regex(/^[a-f0-9]{64}$/),
  operationId: z.string().uuid(),
  action: z.enum(['open', 'build', 'test', 'drive', 'capture', 'install', 'launch', 'close']),
  threadId: z.string().min(1),
  deviceId: z.string().uuid(),
  derivedData: z.string().startsWith('/'),
  sourceSha: z.string().regex(/^[a-f0-9]{40}$/),
}).strict();
export const laneValidationInput = laneIdentity.extend({
  phase: z.enum(['begin', 'end']),
  outcome: z.enum(['passed', 'failed', 'cancelled']).optional(),
}).strict();
export const laneDescriptor = z.object({
  ok: z.literal(true),
  threadId: z.string().min(1),
  environmentId: z.string().min(1),
  checkoutPath: z.string().startsWith('/'),
  hostId: z.string().min(1),
  deviceId: z.string().uuid(),
  derivedData: z.string().startsWith('/'),
  sourceSha: z.string().regex(/^[a-f0-9]{40}$/),
  resultsRoot: z.string().startsWith('/'),
  compilerWorkers: z.number().int().min(1).max(16),
}).strict();
export type LaneIdentity = z.infer<typeof laneIdentity>;
export type LaneDescriptor = z.infer<typeof laneDescriptor>;
export const nativeExecuteInput = laneIdentity.extend({
  // Build argv is intentionally not arbitrary: resource-routing flags are minted here.
  project: z.string().min(1).optional(),
  scheme: z.string().min(1).regex(/^[^-]/).optional(),
  configuration: z.enum(['Debug', 'Release']).optional(),
  onlyTesting: z.array(z.string().min(1).max(256)).max(64).optional(),
  steps: z.array(stepSchema).min(1).max(MAX_STEPS).optional(),
  bundleId: z.string().regex(/^[A-Za-z0-9.-]+$/).optional(),
}).strict().superRefine((v, ctx) => {
  if (['build', 'test'].includes(v.action) && (!v.project || !v.scheme))
    ctx.addIssue({code:'custom', message:'Build and test require project and scheme'});
  if (v.action === 'drive' && !v.steps)
    ctx.addIssue({code:'custom', message:'Drive requires steps'});
  if (['install','launch','drive','capture'].includes(v.action) && !v.bundleId)
    ctx.addIssue({code:'custom', message:'Install, launch, drive and capture require bundleId'});
});
export const nativeJob = z.object({
  operationId: z.string().uuid(), deviceId: z.string().uuid(),
  state: z.enum(['running', 'passed', 'failed', 'cancelled', 'fence-held']),
  pid: z.number().int().positive().nullable(),
  bundlePath: z.string().nullable(), imagePath: z.string().nullable(),
  error: z.string().nullable(), log: z.array(z.string()),
}).strict();
export type NativeJob = z.infer<typeof nativeJob>;
const credentials = z.object({capability: z.string().regex(/^[a-f0-9]{64}$/), operationId: z.string().uuid()}).strict();
export const nativeContract = defineRpcContract({
  experimental_nativeCapabilities: {input:z.object({}).strict(),output:z.object({version:z.literal(2), exactDevice:z.literal(true), fencing:z.literal(true), managedRuns:z.literal(true), legacyInterlock:z.literal(true)}).strict()},
  experimental_nativeRelease: {input:z.object({capability:z.string().regex(/^[a-f0-9]{64}$/),threadId:z.string().min(1),deviceId:z.string().uuid()}).strict(),output:z.object({released:z.literal(true)}).strict()},
  experimental_nativeActive: {input:z.object({}).strict(),output:z.object({active:z.array(z.object({pid:z.number().int().positive(),operationId:z.string().uuid(),deviceId:z.string().uuid(),threadId:z.string(),derivedData:z.string(),sourceSha:z.string(),hostId:z.string()}).strict())}).strict()},
  experimental_nativeExecute: {input:nativeExecuteInput,output:nativeJob},
  experimental_nativeStatus: {input:credentials,output:nativeJob},
  experimental_nativeCancel: {input:credentials,output:nativeJob},
});

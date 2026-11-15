import { z } from 'zod';
import { AuditAction } from '../constants/audit-actions.js';
import { idSchema } from './common.js';
import { pageSchema } from './pagination.js';

export const auditActionSchema = z.enum(AuditAction);

export const auditSchema = z.strictObject({
  id: z.string(),
  actorId: idSchema.nullable(),
  actorName: z.string().nullable(),
  operatorName: z.string().nullable(),
  serviceName: z.string().nullable(),
  targetId: idSchema,
  action: z.string(),
  before: z.record(z.string(), z.unknown()).nullable(),
  after: z.record(z.string(), z.unknown()).nullable(),
  createdAt: z.iso.datetime(),
});

export type Audit = z.infer<typeof auditSchema>;

export const auditPageSchema = pageSchema(auditSchema);

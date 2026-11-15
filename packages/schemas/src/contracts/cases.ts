import { z } from 'zod';
import { CaseLimits, CaseStatus } from '../constants/case-statuses.js';
import { idSchema } from './common.js';
import { pageQuerySchema, pageSchema } from './pagination.js';
import { userSchema } from './users.js';

export const caseStatusSchema = z.enum(CaseStatus);
export const incidentDateSchema = z.iso.date().refine((value) => !value.startsWith('0000-'), {
  message: 'Enter a valid calendar date.',
});

export const caseCreateSchema = z.strictObject({
  title: z.string().trim().min(1, 'Enter a case title.').max(CaseLimits.Title),
  clientName: z.string().trim().min(1, 'Enter a fictional client name.').max(CaseLimits.ClientName),
  incidentDate: incidentDateSchema.nullable().default(null),
  status: caseStatusSchema.default(CaseStatus.Intake),
  summary: z.string().trim().max(CaseLimits.Summary).default(''),
});

export type CaseCreate = z.infer<typeof caseCreateSchema>;

export const caseSchema = caseCreateSchema.extend({
  incidentDate: incidentDateSchema.nullable(),
  status: caseStatusSchema,
  summary: z.string().max(CaseLimits.Summary),
  id: idSchema,
  caseNumber: z.string().regex(/^CF-\d{6,}$/),
  createdAt: z.iso.datetime(),
  createdBy: idSchema.nullable(),
});

export type Case = z.infer<typeof caseSchema>;

export const caseQuerySchema = pageQuerySchema.extend({
  search: z.string().trim().max(CaseLimits.Search).default(''),
  status: caseStatusSchema.optional(),
});

export type CaseQuery = z.infer<typeof caseQuerySchema>;

export const caseDetailSchema = z.strictObject({
  case: caseSchema,
  assignedUsers: z.array(userSchema),
});

export const casePageSchema = pageSchema(caseSchema);

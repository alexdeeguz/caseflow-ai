import { z } from 'zod';
import { idSchema } from './common.js';
import { pageSchema } from './pagination.js';
import { userSchema } from './users.js';

export const caseSchema = z.strictObject({
  id: idSchema,
  title: z.string(),
  summary: z.string(),
});

export type Case = z.infer<typeof caseSchema>;

export const caseDetailSchema = z.strictObject({
  case: caseSchema,
  assignedUsers: z.array(userSchema),
});

export const casePageSchema = pageSchema(caseSchema);

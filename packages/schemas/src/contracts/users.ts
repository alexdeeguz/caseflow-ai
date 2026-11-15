import { z } from 'zod';
import { Role } from '../constants/roles.js';
import { idSchema } from './common.js';
import { pageQuerySchema, pageSchema } from './pagination.js';

export const roleSchema = z.enum(Role);

export const profilePatchSchema = z.strictObject({
  displayName: z.string().trim().min(1).max(100),
});

export const rolePatchSchema = z.strictObject({ role: z.enum([Role.Staff, Role.Admin]) });
export const accessPatchSchema = z.strictObject({ active: z.boolean() });

export const userSchema = z.strictObject({
  id: idSchema,
  displayName: z.string(),
  role: roleSchema,
  active: z.boolean(),
});

export type User = z.infer<typeof userSchema>;

export const userQuerySchema = pageQuerySchema.extend({
  search: z.string().trim().max(100).default(''),
  role: roleSchema.optional(),
});

export const userPageSchema = pageSchema(userSchema);

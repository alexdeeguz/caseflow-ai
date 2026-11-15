import { z } from 'zod';

export const idSchema = z.uuid();
export const successSchema = z.strictObject({ success: z.literal(true) });

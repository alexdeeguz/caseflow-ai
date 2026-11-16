import { z } from 'zod';

/** Short-lived access token for the shared demo Admin account (only when the API enables demo). */
export const demoSessionSchema = z.strictObject({
  accessToken: z.string().min(20).max(4096),
  expiresAt: z.iso.datetime(),
});

export type DemoSession = z.infer<typeof demoSessionSchema>;

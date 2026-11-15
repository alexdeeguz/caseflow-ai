import { z } from 'zod';

const storageConfigSchema = z.strictObject({
  bucket: z
    .string()
    .min(3)
    .max(63)
    .regex(/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/)
    .refine((value) => !value.includes('..') && !/^\d+\.\d+\.\d+\.\d+$/.test(value))
    .refine((value) => !/^(xn--|sthree-|amzn-s3-demo-)/.test(value))
    .refine((value) => !/(-s3alias|--ol-s3|\.mrap|--x-s3|--table-s3)$/.test(value)),
  region: z.string().regex(/^[a-z]{2}(?:-[a-z]+)+-\d+$/),
  environment: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/),
  profile: z
    .string()
    .regex(/^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,127}$/)
    .optional(),
});

export type StorageConfig = z.infer<typeof storageConfigSchema>;

export function readStorageConfig(env: NodeJS.ProcessEnv): StorageConfig | undefined {
  if (env.S3_BUCKET === undefined && env.S3_ENVIRONMENT === undefined) {
    return undefined;
  }

  const parsed = storageConfigSchema.safeParse({
    bucket: env.S3_BUCKET,
    region: env.AWS_REGION,
    environment: env.S3_ENVIRONMENT,
    profile: env.AWS_PROFILE,
  });

  if (!parsed.success) {
    throw new Error(
      'Set valid S3_BUCKET, AWS_REGION, S3_ENVIRONMENT, and an optional named AWS_PROFILE in the API environment.',
    );
  }

  return parsed.data;
}

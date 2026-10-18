import { S3Storage, type S3StorageConfig } from '../src/s3-storage.ts'

const env = process.env

export const s3TestConfig: S3StorageConfig | undefined =
  env.S3_TEST_ENDPOINT && env.S3_TEST_BUCKET && env.S3_TEST_ACCESS_KEY_ID && env.S3_TEST_SECRET_ACCESS_KEY
    ? {
        endpoint: env.S3_TEST_ENDPOINT,
        region: env.S3_TEST_REGION ?? 'us-east-1',
        bucket: env.S3_TEST_BUCKET,
        accessKeyId: env.S3_TEST_ACCESS_KEY_ID,
        secretAccessKey: env.S3_TEST_SECRET_ACCESS_KEY,
        forcePathStyle: env.S3_TEST_FORCE_PATH_STYLE !== 'false',
        prefix: env.S3_TEST_PREFIX ?? 'git-forge-test/',
      }
    : undefined

export const makeS3TestStorage = (overrides: Partial<S3StorageConfig> = {}): S3Storage => {
  if (!s3TestConfig) throw new Error('S3_TEST_* environment variables are not set')
  return new S3Storage({ ...s3TestConfig, ...overrides })
}

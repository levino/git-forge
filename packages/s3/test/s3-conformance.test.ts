import { describeStorageConformance } from '@git-forge/core/test/storage-conformance.ts'
import { describe, it } from 'vitest'
import { makeS3TestStorage, s3TestConfig } from './env.ts'

if (s3TestConfig) {
  describeStorageConformance(`S3Storage (${s3TestConfig.endpoint})`, () => makeS3TestStorage({ listPageSize: 7 }))
  describeStorageConformance(`S3Storage without prefix (${s3TestConfig.endpoint})`, () => makeS3TestStorage({ prefix: '' }), {
    paginationKeys: 1005,
  })
} else {
  describe('S3Storage against a real server', () => {
    it.skip('skipped: S3_TEST_ENDPOINT, S3_TEST_BUCKET, S3_TEST_ACCESS_KEY_ID and S3_TEST_SECRET_ACCESS_KEY are not set', () => {})
  })
}

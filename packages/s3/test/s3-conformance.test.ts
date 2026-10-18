import { describeStorageConformance } from '@git-forge/core/test/storage-conformance'
import { describe, it } from 'vitest'
import { makeS3TestStorage, s3TestConfig, s3TestPagination } from './env.ts'

if (s3TestConfig) {
  describeStorageConformance(`S3Storage (${s3TestConfig.endpoint})`, () => makeS3TestStorage(), { pagination: s3TestPagination })
  describeStorageConformance(`S3Storage ohne Präfix (${s3TestConfig.endpoint})`, () => makeS3TestStorage({ prefix: '' }))
} else {
  describe('S3Storage gegen echten Server', () => {
    it.skip('übersprungen: S3_TEST_ENDPOINT usw. nicht gesetzt', () => {})
  })
}

import { MemoryStorage } from '../src/memory-storage.ts'
import { describeStorageConformance } from './storage-conformance.ts'

describeStorageConformance('MemoryStorage', () => new MemoryStorage(), { pagination: true })

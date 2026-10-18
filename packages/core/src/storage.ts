export type ObjectInfo = {
  readonly key: string
  readonly size: number
  readonly etag: string
}

export type StoredObject = ObjectInfo & {
  readonly body: ReadableStream<Uint8Array>
}

export type ByteRange = {
  readonly offset: number
  readonly length: number
}

export type PutOptions = {
  readonly ifMatch?: string
  readonly ifNoneMatch?: '*'
  readonly contentType?: string
}

export type PutBody = Uint8Array | ReadableStream<Uint8Array>

export type PutResult = { readonly ok: true; readonly info: ObjectInfo } | { readonly ok: false; readonly reason: 'precondition-failed' }

export type PresignedPut = {
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
  readonly expiresAt: Date
}

export interface Storage {
  get(key: string, range?: ByteRange): Promise<StoredObject | null>
  head(key: string): Promise<ObjectInfo | null>
  put(key: string, body: PutBody, size: number, options?: PutOptions): Promise<PutResult>
  list(prefix: string): AsyncIterable<ObjectInfo>
  presignGet?(key: string, expiresInSeconds: number): Promise<string>
  presignPut?(key: string, size: number, sha256Hex: string, expiresInSeconds: number): Promise<PresignedPut>
}

declare module 'pako/lib/zlib/zstream.js' {
  export default class ZStream {
    input: Uint8Array
    next_in: number
    avail_in: number
    output: Uint8Array
    next_out: number
    avail_out: number
  }
}

declare module 'pako/lib/zlib/inflate.js' {
  import type ZStream from 'pako/lib/zlib/zstream.js'
  const inflate: {
    inflateInit2(strm: ZStream, windowBits: number): number
    inflate(strm: ZStream, flush: number): number
    inflateEnd(strm: ZStream): number
  }
  export default inflate
}

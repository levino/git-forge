import { describe, expect, it } from 'vitest'
import { decodeXmlText, normalizeEtag, parseListObjectsV2 } from '../src/xml.ts'

describe('ListObjectsV2-Parser', () => {
  it('liest Schlüssel, Größen, ETags und Fortsetzungs-Token', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Name>bucket</Name><Prefix>a/</Prefix><KeyCount>2</KeyCount><MaxKeys>1000</MaxKeys>
  <IsTruncated>true</IsTruncated>
  <Contents><Key>a/x&amp;y.txt</Key><LastModified>2026-01-01T00:00:00.000Z</LastModified>
    <ETag>&quot;abc123&quot;</ETag><Size>12</Size><StorageClass>STANDARD</StorageClass></Contents>
  <Contents>
    <Key>a/&lt;z&gt; &#252;&#x1F600;</Key><ETag>"def"</ETag><Size>0</Size>
    <Owner><ID>o</ID></Owner>
  </Contents>
  <NextContinuationToken>tok+/=&amp;1</NextContinuationToken>
</ListBucketResult>`
    expect(parseListObjectsV2(xml)).toEqual({
      contents: [
        { key: 'a/x&y.txt', size: 12, etag: 'abc123' },
        { key: 'a/<z> ü😀', size: 0, etag: 'def' },
      ],
      nextContinuationToken: 'tok+/=&1',
      isTruncated: true,
    })
  })

  it('erkennt das Ende der Liste und leere Ergebnisse', () => {
    const xml = '<ListBucketResult><Name>b</Name><Prefix/><KeyCount>0</KeyCount><IsTruncated>false</IsTruncated></ListBucketResult>'
    expect(parseListObjectsV2(xml)).toEqual({ contents: [], nextContinuationToken: undefined, isTruncated: false })
  })

  it('normalisiert ETags und dekodiert Entitäten', () => {
    expect(normalizeEtag('"abc"')).toBe('abc')
    expect(normalizeEtag('W/"abc"')).toBe('abc')
    expect(normalizeEtag('abc')).toBe('abc')
    expect(decodeXmlText('&quot;&apos;&lt;&gt;&amp;amp;')).toBe(`"'<>&amp;`)
  })
})

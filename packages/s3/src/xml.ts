const ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

export const decodeXmlText = (text: string): string =>
  text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (match, entity: string) => {
    if (entity.startsWith('#x')) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16))
    if (entity.startsWith('#')) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10))
    return ENTITIES[entity] ?? match
  })

const elementPattern = (name: string): RegExp => new RegExp(`<${name}(?:\\s[^>]*)?(?:/>|>([\\s\\S]*?)</${name}\\s*>)`, 'g')

export const xmlElements = (xml: string, name: string): string[] =>
  [...xml.matchAll(elementPattern(name))].map((match) => match[1] ?? '')

export const xmlText = (xml: string, name: string): string | undefined => {
  const [first] = xmlElements(xml, name)
  return first === undefined ? undefined : decodeXmlText(first)
}

export type ListPage = {
  readonly contents: readonly { readonly key: string; readonly size: number; readonly etag: string }[]
  readonly nextContinuationToken: string | undefined
  readonly isTruncated: boolean
}

export const parseListObjectsV2 = (xml: string): ListPage => {
  const contents = xmlElements(xml, 'Contents').map((block) => {
    const key = xmlText(block, 'Key')
    const size = xmlText(block, 'Size')
    if (key === undefined || size === undefined) throw new Error('ListObjectsV2: Contents ohne Key oder Size')
    return { key, size: Number.parseInt(size, 10), etag: normalizeEtag(xmlText(block, 'ETag') ?? '') }
  })
  const withoutContents = xml.replace(elementPattern('Contents'), '')
  return {
    contents,
    nextContinuationToken: xmlText(withoutContents, 'NextContinuationToken'),
    isTruncated: xmlText(withoutContents, 'IsTruncated')?.trim() === 'true',
  }
}

export const parseErrorCode = (xml: string): string | undefined => xmlText(xml, 'Code')?.trim()

export const normalizeEtag = (etag: string): string => {
  const trimmed = etag.trim().replace(/^W\//, '')
  return trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"') ? trimmed.slice(1, -1) : trimmed
}

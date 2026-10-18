import rehypeSanitize from 'rehype-sanitize'
import rehypeStringify from 'rehype-stringify'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import remarkRehype from 'remark-rehype'
import { unified } from 'unified'

export type LinkBase = {
  readonly blob: string
  readonly raw: string
  readonly directory: string
}

type HastNode = {
  type: string
  tagName?: string
  properties?: Record<string, unknown>
  children?: HastNode[]
}

const isRelative = (url: string): boolean => url !== '' && !url.startsWith('#') && !url.startsWith('/') && !/^[a-z][a-z0-9+.-]*:/i.test(url)

export const resolveRelative = (directory: string, url: string): string => {
  const [pathPart, ...rest] = url.split(/(?=[?#])/)
  const segments = directory === '' ? [] : directory.split('/')
  for (const segment of pathPart!.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') segments.pop()
    else segments.push(segment)
  }
  return segments.map(encodeURIComponent).join('/') + rest.join('')
}

const rewriteLinks = (base: LinkBase) => () => (tree: HastNode) => {
  const visit = (node: HastNode): void => {
    const properties = node.properties
    if (node.type === 'element' && properties) {
      if (node.tagName === 'img' && typeof properties.src === 'string' && isRelative(properties.src)) {
        properties.src = `${base.raw}/${resolveRelative(base.directory, properties.src)}`
      }
      if (node.tagName === 'a' && typeof properties.href === 'string' && isRelative(properties.href)) {
        properties.href = `${base.blob}/${resolveRelative(base.directory, properties.href)}`
      }
    }
    node.children?.forEach(visit)
  }
  visit(tree)
}

export const renderMarkdown = async (source: string, base: LinkBase): Promise<string> =>
  String(
    await unified()
      .use(remarkParse)
      .use(remarkGfm)
      .use(remarkRehype)
      .use(rewriteLinks(base))
      .use(rehypeSanitize)
      .use(rehypeStringify)
      .process(source),
  )

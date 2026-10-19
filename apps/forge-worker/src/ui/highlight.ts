import { createHighlighterCore, type HighlighterCore, type LanguageRegistration, type ThemedToken, type ThemeRegistration } from 'shiki/core'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'
import type { Hunk } from '@git-forge/core'
import githubDark from 'shiki/dist/themes/github-dark.mjs'
import githubLight from 'shiki/dist/themes/github-light.mjs'

type Grammar = { readonly default: LanguageRegistration[] }

const LANGUAGES: Readonly<Record<string, () => Promise<Grammar>>> = {
  typescript: () => import('shiki/dist/langs/typescript.mjs'),
  javascript: () => import('shiki/dist/langs/javascript.mjs'),
  tsx: () => import('shiki/dist/langs/tsx.mjs'),
  jsx: () => import('shiki/dist/langs/jsx.mjs'),
  json: () => import('shiki/dist/langs/json.mjs'),
  jsonc: () => import('shiki/dist/langs/jsonc.mjs'),
  python: () => import('shiki/dist/langs/python.mjs'),
  rust: () => import('shiki/dist/langs/rust.mjs'),
  go: () => import('shiki/dist/langs/go.mjs'),
  markdown: () => import('shiki/dist/langs/markdown.mjs'),
  yaml: () => import('shiki/dist/langs/yaml.mjs'),
  css: () => import('shiki/dist/langs/css.mjs'),
  html: () => import('shiki/dist/langs/html.mjs'),
  shellscript: () => import('shiki/dist/langs/shellscript.mjs'),
  toml: () => import('shiki/dist/langs/toml.mjs'),
  dockerfile: () => import('shiki/dist/langs/dockerfile.mjs'),
  sql: () => import('shiki/dist/langs/sql.mjs'),
  java: () => import('shiki/dist/langs/java.mjs'),
  c: () => import('shiki/dist/langs/c.mjs'),
  diff: () => import('shiki/dist/langs/diff.mjs'),
  ini: () => import('shiki/dist/langs/ini.mjs'),
  xml: () => import('shiki/dist/langs/xml.mjs'),
  kotlin: () => import('shiki/dist/langs/kotlin.mjs'),
  csharp: () => import('shiki/dist/langs/csharp.mjs'),
  graphql: () => import('shiki/dist/langs/graphql.mjs'),
  lua: () => import('shiki/dist/langs/lua.mjs'),
  make: () => import('shiki/dist/langs/make.mjs'),
}

const EXTENSIONS: Readonly<Record<string, string>> = {
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  tsx: 'tsx',
  jsx: 'jsx',
  json: 'json',
  jsonc: 'jsonc',
  json5: 'jsonc',
  py: 'python',
  rs: 'rust',
  go: 'go',
  md: 'markdown',
  markdown: 'markdown',
  mdx: 'markdown',
  yml: 'yaml',
  yaml: 'yaml',
  css: 'css',
  html: 'html',
  htm: 'html',
  astro: 'html',
  vue: 'html',
  svelte: 'html',
  sh: 'shellscript',
  bash: 'shellscript',
  zsh: 'shellscript',
  toml: 'toml',
  sql: 'sql',
  java: 'java',
  c: 'c',
  h: 'c',
  diff: 'diff',
  patch: 'diff',
  ini: 'ini',
  cfg: 'ini',
  conf: 'ini',
  xml: 'xml',
  svg: 'xml',
  kt: 'kotlin',
  kts: 'kotlin',
  cs: 'csharp',
  graphql: 'graphql',
  gql: 'graphql',
  lua: 'lua',
  mk: 'make',
}

const FILENAMES: Readonly<Record<string, string>> = {
  Dockerfile: 'dockerfile',
  Containerfile: 'dockerfile',
  Makefile: 'make',
  GNUmakefile: 'make',
  '.gitignore': 'ini',
  '.gitattributes': 'ini',
  '.editorconfig': 'ini',
  '.npmrc': 'ini',
}

export const languageFor = (filename: string): string | null => {
  const named = FILENAMES[filename]
  if (named) return named
  if (filename.startsWith('Dockerfile.')) return 'dockerfile'
  const dot = filename.lastIndexOf('.')
  if (dot <= 0) return null
  return EXTENSIONS[filename.slice(dot + 1).toLowerCase()] ?? null
}

export type Token = { readonly content: string; readonly className: string }

export type HighlightedLine = readonly Token[]

export const MAX_HIGHLIGHT_BYTES = 256 * 1024

let highlighter: Promise<HighlighterCore> | undefined

const loaded = new Map<string, Promise<HighlighterCore>>()

const load = (lang: string): Promise<HighlighterCore> => {
  highlighter ??= createHighlighterCore({ themes: [githubLight, githubDark], langs: [], engine: createJavaScriptRegexEngine({ forgiving: true }) })
  const known = loaded.get(lang)
  if (known) return known
  const ready = highlighter.then(async (core) => {
    await core.loadLanguage((await LANGUAGES[lang]!()).default)
    return core
  })
  loaded.set(lang, ready)
  return ready
}

const FENCE = /^ {0,3}(?:`{3,}|~{3,})\s*([\w+#.-]+)/gm

const getHighlighter = async (text: string, lang: string): Promise<HighlighterCore> => {
  const fences = lang === 'markdown' ? [...text.matchAll(FENCE)].flatMap((match) => languageOfFence(match[1]!) ?? []) : []
  return (await Promise.all([lang, ...new Set(fences)].map(load)))[0]!
}

const paletteOf = (theme: ThemeRegistration) => {
  const fg = theme.colors!['editor.foreground']!.toUpperCase()
  const colors = [...new Set((theme.tokenColors ?? []).flatMap((rule) => rule.settings.foreground?.toUpperCase() ?? []))].filter((color) => color !== fg)
  return { fg, index: new Map(colors.map((color, i) => [color, i])) }
}

const LIGHT = paletteOf(githubLight)
const DARK = paletteOf(githubDark)

const rules = (palette: typeof LIGHT, prefix: string, scope: string) => [...palette.index].map(([color, i]) => `${scope}.${prefix}${i}{color:${color}}`).join('')

export const HIGHLIGHT_CSS = `.hl{color:${LIGHT.fg}}${rules(LIGHT, 'l', '')}@media (prefers-color-scheme:dark){.hl{color:${DARK.fg}}.hl span{color:inherit}${rules(DARK, 'd', '.hl ')}}`

const classOf = (token: ThemedToken): string => {
  const light = LIGHT.index.get(token.htmlStyle?.['--shiki-light']?.toUpperCase() ?? '')
  const dark = DARK.index.get(token.htmlStyle?.['--shiki-dark']?.toUpperCase() ?? '')
  return [light === undefined ? '' : `l${light}`, dark === undefined ? '' : `d${dark}`].join(' ').trim()
}

const merged = (tokens: readonly ThemedToken[]): Token[] =>
  tokens.reduce<Token[]>((line, token) => {
    const className = classOf(token)
    const last = line.at(-1)
    if (last?.className === className) line[line.length - 1] = { content: last.content + token.content, className }
    else line.push({ content: token.content, className })
    return line
  }, [])

const escape = (text: string): string => text.replace(/[&<>]/g, (char) => (char === '&' ? '&amp;' : char === '<' ? '&lt;' : '&gt;'))

export const lineHtml = (line: HighlightedLine): string =>
  line.map((token) => (token.className ? `<span class="${token.className}">${escape(token.content)}</span>` : escape(token.content))).join('')

export const codeRows = (lines: readonly HighlightedLine[]): string =>
  lines.map((line, index) => `<tr id="L${index + 1}"><td><a href="#L${index + 1}">${index + 1}</a><td>${lineHtml(line)}`).join('')

const plain = (text: string): HighlightedLine[] => text.split('\n').map((line) => (line === '' ? [] : [{ content: line, className: '' }]))

export const languageOfFence = (info: string): string | null => {
  const name = info.toLowerCase()
  return Object.hasOwn(LANGUAGES, name) ? name : (EXTENSIONS[name] ?? null)
}

export const highlightLines = (text: string, filename: string): Promise<HighlightedLine[]> => highlightText(text, languageFor(filename))

export const highlightText = async (text: string, lang: string | null): Promise<HighlightedLine[]> => {
  const body = text.endsWith('\n') ? text.slice(0, -1) : text
  if (!lang || body.length > MAX_HIGHLIGHT_BYTES) return plain(body)
  try {
    const result = (await getHighlighter(body, lang)).codeToTokens(body, { lang, themes: { light: 'github-light', dark: 'github-dark' }, defaultColor: false })
    return result.tokens.map(merged)
  } catch {
    return plain(body)
  }
}

export const highlightHunks = async (hunks: readonly Hunk[], filename: string): Promise<HighlightedLine[][]> =>
  Promise.all(
    hunks.map(async (hunk) => {
      const side = (skip: '+' | '-') => highlightLines(`${hunk.lines.filter((line) => line.kind !== skip).map((line) => line.text).join('\n')}\n`, filename)
      const [before, after] = await Promise.all([side('+'), side('-')])
      let i = 0
      let j = 0
      return hunk.lines.map((line) => {
        if (line.kind === '-') return before[i++] ?? []
        if (line.kind === ' ') i++
        return after[j++] ?? []
      })
    }),
  )

import { createHighlighterCore, type HighlighterCore, type ThemedToken } from 'shiki/core'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'
import githubDark from 'shiki/dist/themes/github-dark.mjs'
import githubLight from 'shiki/dist/themes/github-light.mjs'
import typescript from 'shiki/dist/langs/typescript.mjs'
import javascript from 'shiki/dist/langs/javascript.mjs'
import tsx from 'shiki/dist/langs/tsx.mjs'
import jsx from 'shiki/dist/langs/jsx.mjs'
import json from 'shiki/dist/langs/json.mjs'
import jsonc from 'shiki/dist/langs/jsonc.mjs'
import python from 'shiki/dist/langs/python.mjs'
import rust from 'shiki/dist/langs/rust.mjs'
import go from 'shiki/dist/langs/go.mjs'
import markdown from 'shiki/dist/langs/markdown.mjs'
import yaml from 'shiki/dist/langs/yaml.mjs'
import css from 'shiki/dist/langs/css.mjs'
import html from 'shiki/dist/langs/html.mjs'
import shellscript from 'shiki/dist/langs/shellscript.mjs'
import toml from 'shiki/dist/langs/toml.mjs'
import dockerfile from 'shiki/dist/langs/dockerfile.mjs'
import sql from 'shiki/dist/langs/sql.mjs'
import java from 'shiki/dist/langs/java.mjs'
import c from 'shiki/dist/langs/c.mjs'
import diff from 'shiki/dist/langs/diff.mjs'
import ini from 'shiki/dist/langs/ini.mjs'
import xml from 'shiki/dist/langs/xml.mjs'
import kotlin from 'shiki/dist/langs/kotlin.mjs'
import csharp from 'shiki/dist/langs/csharp.mjs'
import graphql from 'shiki/dist/langs/graphql.mjs'
import lua from 'shiki/dist/langs/lua.mjs'
import make from 'shiki/dist/langs/make.mjs'

const LANGUAGES = [typescript, javascript, tsx, jsx, json, jsonc, python, rust, go, markdown, yaml, css, html, shellscript, toml, dockerfile, sql, java, c, diff, ini, xml, kotlin, csharp, graphql, lua, make]

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

export type Token = { readonly content: string; readonly style: string }

export type HighlightedLine = readonly Token[]

export const MAX_HIGHLIGHT_BYTES = 256 * 1024

let highlighter: Promise<HighlighterCore> | undefined

const getHighlighter = (): Promise<HighlighterCore> => {
  highlighter ??= createHighlighterCore({ themes: [githubLight, githubDark], langs: LANGUAGES, engine: createJavaScriptRegexEngine({ forgiving: true }) })
  return highlighter
}

const styleOf = (token: ThemedToken): string =>
  Object.entries(token.htmlStyle ?? {})
    .map(([key, value]) => `${key}:${value}`)
    .join(';')

const plain = (text: string): HighlightedLine[] => text.split('\n').map((line) => (line === '' ? [] : [{ content: line, style: '' }]))

export const highlightLines = async (text: string, filename: string): Promise<HighlightedLine[]> => {
  const body = text.endsWith('\n') ? text.slice(0, -1) : text
  const lang = languageFor(filename)
  if (!lang || body.length > MAX_HIGHLIGHT_BYTES) return plain(body)
  try {
    const result = (await getHighlighter()).codeToTokens(body, { lang, themes: { light: 'github-light', dark: 'github-dark' }, defaultColor: false })
    return result.tokens.map((line) => line.map((token) => ({ content: token.content, style: styleOf(token) })))
  } catch {
    return plain(body)
  }
}

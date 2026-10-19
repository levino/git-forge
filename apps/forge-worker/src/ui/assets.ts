import tailwind from '../styles/global.css?inline'
import { HIGHLIGHT_CSS } from './highlight.ts'

const stylesheet = `${tailwind}${HIGHLIGHT_CSS}`

const fnv1a = (text: string): string => {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193)
  return (hash >>> 0).toString(16).padStart(8, '0')
}

export const STYLESHEET = stylesheet

export const STYLESHEET_VERSION = fnv1a(stylesheet)

export const STYLESHEET_PATH = `/-/style.css?v=${STYLESHEET_VERSION}`

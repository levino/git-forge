import type { APIRoute } from 'astro'
import { STYLESHEET, STYLESHEET_VERSION } from '../../ui/assets.ts'

export const GET: APIRoute = ({ url }) =>
  new Response(STYLESHEET, {
    headers: {
      'Content-Type': 'text/css; charset=utf-8',
      'Cache-Control': url.searchParams.get('v') === STYLESHEET_VERSION ? 'public, max-age=31536000, immutable' : 'no-cache',
      ETag: `"${STYLESHEET_VERSION}"`,
    },
  })

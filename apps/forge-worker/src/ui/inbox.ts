import type { ThreadRow } from '@git-forge/notifications'
import type { ForgeServices, UiSession } from '../app.ts'
import { repoUrl } from './repository.ts'

export const INBOX_PAGE_SIZE = 50

export const threadLink = (thread: ThreadRow): string => {
  if (thread.html_url) {
    try {
      const url = new URL(thread.html_url)
      if (url.protocol === 'https:' || url.protocol === 'http:') return `${url.pathname}${url.search}${url.hash}`
    } catch {}
  }
  return repoUrl({ owner: thread.owner_login, name: thread.repository_name })
}

export const inboxAction = async (forge: ForgeServices, session: UiSession, form: FormData): Promise<'ok' | 'unknown'> => {
  const action = form.get('action')
  if (action === 'read-all') {
    await forge.inbox.markAllRead(session.principal)
    return 'ok'
  }
  const id = Number(form.get('id'))
  if (!Number.isSafeInteger(id)) return 'unknown'
  if (action === 'read') return (await forge.inbox.markRead(session.principal, id)) ? 'ok' : 'unknown'
  if (action === 'done') return (await forge.inbox.markDone(session.principal, id)) ? 'ok' : 'unknown'
  return 'unknown'
}

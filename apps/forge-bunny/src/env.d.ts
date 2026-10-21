declare module 'git-forge:astro-entry' {
  const worker: { fetch(request: Request, env: unknown, context: unknown): Promise<Response> }
  export default worker
}

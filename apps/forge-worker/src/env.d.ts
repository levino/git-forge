declare namespace App {
  interface Locals {
    forge: import('./app.ts').ForgeServices
    principal: import('@git-forge/accounts').Principal
    cfContext?: { waitUntil(promise: Promise<unknown>): void }
  }
}

declare module '*.css?inline' {
  const css: string
  export default css
}

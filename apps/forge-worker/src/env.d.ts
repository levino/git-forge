declare namespace App {
  interface Locals {
    forge: import('./app.ts').ForgeServices
    principal: import('@git-forge/accounts').Principal
    session: import('./app.ts').UiSession | null
    loginPage?: import('@git-forge/accounts').LoginPage
    cfContext?: { waitUntil(promise: Promise<unknown>): void }
  }
}

declare module '*.css?inline' {
  const css: string
  export default css
}

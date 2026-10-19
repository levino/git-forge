import { sqldBinary, startSqld } from './sqld.ts'

export default async () => {
  if (!sqldBinary || process.env.SQLD_TEST_URL) return
  const sqld = await startSqld(sqldBinary)
  Object.assign(process.env, sqld.env)
  return sqld.stop
}

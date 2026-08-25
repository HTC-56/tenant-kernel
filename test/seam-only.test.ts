/**
 * Prove that the seam is the only door into tenant data.
 *
 * This test reads source text — no database, no engine, no beforeAll.
 * Every rule is an allowlist: it builds the set of files containing a string
 * and checks that set against the allowed list. The test file itself contains
 * all of those strings (in comments / assertions), which is fine because the
 * scan only walks `src/`.
 *
 * §B7. Gate: typecheck + test + scrub.
 */
import { describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { readdir } from 'node:fs/promises'

const SRC_ROOT = fileURLToPath(new URL('../src/', import.meta.url))

it('scans at least four .ts files and finds seam.ts', async () => {
  const entries = await readdir(SRC_ROOT, { recursive: true })
  const tsFiles = entries.filter((p: string) => p.endsWith('.ts'))
  expect(tsFiles.length).toBeGreaterThanOrEqual(4)
  expect(tsFiles).toContain('db/seam.ts')
})

/**
 * Given a list of repo-relative `src/` paths and a search string,
 * return the paths that contain the string.
 */
async function grepSrc(needle: string): Promise<string[]> {
  const entries = await readdir(SRC_ROOT, { recursive: true })
  const tsFiles = entries.filter((p: string) => p.endsWith('.ts'))
  const { readFileSync } = await import('node:fs')
  return tsFiles.filter((p) =>
    readFileSync(`${SRC_ROOT}${p}`, 'utf8').includes(needle),
  )
}

describe('source-text allowlists', () => {
  it('openEngine( appears only in engine.ts and the composition root', async () => {
    const offenders = await grepSrc('openEngine(')
    expect(offenders.sort()).toEqual(['db/engine.ts', 'index.ts'])
  })

  it('.transaction( appears only in engine, migrate, and seam', async () => {
    const offenders = await grepSrc('.transaction(')
    expect(offenders.sort()).toEqual(['db/engine.ts', 'db/migrate.ts', 'db/seam.ts'])
  })

  it('SET LOCAL ROLE appears only in src/db/seam.ts', async () => {
    const offenders = await grepSrc('SET LOCAL ROLE')
    expect(offenders.sort()).toEqual(['db/seam.ts'])
  })

  it("set_config('app. appears only in src/db/seam.ts", async () => {
    const offenders = await grepSrc("set_config('app.")
    expect(offenders.sort()).toEqual(['db/seam.ts'])
  })
})

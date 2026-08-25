/**
 * YAML config for the served process (SPEC.md feature 9). Tests never load a
 * file — they build a `Config` literal — so the file half stays a thin shell:
 * read, parse, validate with zod, fail loudly with the field path.
 *
 * `DATABASE_URL` stays an environment concern (the two-engine seam reads it),
 * so the config deliberately does not carry it: one switch, one place.
 */
import { readFile } from 'node:fs/promises'
import { parse } from 'yaml'
import { z } from 'zod'

export const ConfigSchema = z.object({
  server: z
    .object({
      host: z.string().default('127.0.0.1'),
      port: z.number().int().min(1).max(65535).default(8100),
    })
    .prefault({}),
  operator: z.object({
    /** Static bearer for /operator/api — SPEC.md feature 7. Non-blank. */
    token: z.string().min(16, 'operator.token must be at least 16 characters'),
    email: z.email(),
    name: z.string().min(1),
  }),
  ops: z
    .object({
      /** JSONL ops ledger path; relative paths resolve against the cwd. */
      ledgerPath: z.string().default('ledger.jsonl'),
    })
    .prefault({}),
})

export type Config = z.infer<typeof ConfigSchema>

/** Loads and validates one YAML config file. Throws with the offending path. */
export async function loadConfig(path: string): Promise<Config> {
  const raw = await readFile(path, 'utf8')
  const parsed: unknown = parse(raw)
  const result = ConfigSchema.safeParse(parsed ?? {})
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ')
    throw new Error(`config: ${path} is invalid — ${detail}`)
  }
  return result.data
}

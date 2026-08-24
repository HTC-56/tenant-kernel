import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Each suite file stands up its own database engine; running files serially
    // keeps PGlite memory bounded and makes a shared real-Postgres run
    // (DATABASE_URL) deterministic.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
})

import type { Config } from 'drizzle-kit';

export default {
  schema: './src/schema.ts',
  out: './migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://raci:raci_dev_password@localhost:5432/raci',
  },
  // Verbose diffs: a migration that silently drops a column is exactly the review this needs.
  verbose: true,
  strict: true,
} satisfies Config;

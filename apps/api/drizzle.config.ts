import { defineConfig } from 'drizzle-kit';
import { config } from './src/config/env.js';

export default config.db.driver === 'postgres'
  ? defineConfig({
      schema: './src/db/schema.pg.ts',
      out: './drizzle-pg',
      dialect: 'postgresql',
      dbCredentials: { url: config.db.url },
    })
  : defineConfig({
      schema: './src/db/schema.sqlite.ts',
      out: './drizzle',
      dialect: 'sqlite',
      dbCredentials: { url: config.db.url },
    });

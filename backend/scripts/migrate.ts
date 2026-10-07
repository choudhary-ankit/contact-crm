import { Pool } from 'pg';
import { loadConfig } from '../src/config';
import { runMigrations } from '../src/database/migrate';

(async () => {
  const pool = new Pool({ connectionString: loadConfig().databaseUrl });
  const applied = await runMigrations(pool);
  console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Database already up to date');
  await pool.end();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

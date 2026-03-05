'use strict';

// Chạy trong Cloud Build Step 4 sau khi deploy Cloud Run thành công
// Kết nối Cloud SQL qua @google-cloud/cloud-sql-connector (không cần Unix socket)
// SA của Cloud Build cần: roles/cloudsql.client

const { Connector }  = require('@google-cloud/cloud-sql-connector');
const { Pool }       = require('pg');

async function main() {
  const instanceConnectionName = process.env.INSTANCE_CONNECTION_NAME;
  const dbUser    = process.env.DB_USER    || 'app_user';
  const dbName    = process.env.DB_NAME    || 'zero2prod';
  const dbPassword= process.env.DB_PASSWORD;
  const version   = process.env.VERSION    || 'unknown';
  const commitSha = process.env.COMMIT_SHA || 'unknown';
  const buildTime = process.env.BUILD_TIME || new Date().toISOString();

  if (!instanceConnectionName) {
    throw new Error('INSTANCE_CONNECTION_NAME is required');
  }
  if (!dbPassword) {
    throw new Error('DB_PASSWORD is required');
  }

  console.log(`[record-deploy] version=${version} sha=${commitSha}`);

  const connector = new Connector();

  const clientOpts = await connector.getOptions({
    instanceConnectionName,
    ipType: 'PUBLIC',   // đổi thành 'PRIVATE' nếu dùng VPC
  });

  const pool = new Pool({
    ...clientOpts,
    user:     dbUser,
    password: dbPassword,
    database: dbName,
  });

  try {
    const result = await pool.query(
      `INSERT INTO deployments (version, commit_sha, build_time, status)
       VALUES ($1, $2, $3, 'success')
       RETURNING id, deployed_at`,
      [version, commitSha, buildTime]
    );
    const row = result.rows[0];
    console.log(`[record-deploy] ✅ Saved — id=${row.id} at ${row.deployed_at}`);
  } finally {
    await pool.end();
    connector.close();
  }
}

main().catch(err => {
  console.error('[record-deploy] ❌ Failed:', err.message);
  process.exit(1);
});

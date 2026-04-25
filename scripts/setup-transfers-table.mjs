/**
 * Database migration script to create transfers table
 * Run: npx tsx scripts/setup-transfers-table.mjs
 */

import pg from 'pg';

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function setupTransfersTable() {
  const client = await pool.connect();

  try {
    console.log('Creating transfers table...');

    // Create transfers table
    await client.query(`
      CREATE TABLE IF NOT EXISTS transfers (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        transaction_id UUID NOT NULL UNIQUE,
        merchant_id TEXT NOT NULL,
        merchant_address TEXT NOT NULL,
        amount NUMERIC(18, 8) NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        pi_transfer_id TEXT UNIQUE,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        completed_at TIMESTAMP,
        error_message TEXT,
        retry_count INTEGER DEFAULT 0,
        last_retry_at TIMESTAMP,
        FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE CASCADE
      )
    `);

    console.log('Creating indexes...');

    // Create indexes
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_transfers_merchant_status
      ON transfers(merchant_id, status)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_transfers_status
      ON transfers(status)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_transfers_created
      ON transfers(created_at DESC)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_transfers_merchant_created
      ON transfers(merchant_id, created_at DESC)
    `);

    // Create transfer_notifications table
    await client.query(`
      CREATE TABLE IF NOT EXISTS transfer_notifications (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        transfer_id UUID NOT NULL,
        merchant_id TEXT NOT NULL,
        notification_type TEXT NOT NULL,
        title TEXT NOT NULL,
        message TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'unread',
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        read_at TIMESTAMP,
        FOREIGN KEY (transfer_id) REFERENCES transfers(id) ON DELETE CASCADE
      )
    `);

    console.log('Creating notification indexes...');

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_transfer_notifications_merchant
      ON transfer_notifications(merchant_id, status, created_at DESC)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_transfer_notifications_transfer
      ON transfer_notifications(transfer_id)
    `);

    console.log('✓ Database migration completed successfully');
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

setupTransfersTable();

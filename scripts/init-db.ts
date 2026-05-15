#!/usr/bin/env node
/**
 * Database initialization script
 * Ensures PostgreSQL schema is created and ready
 *
 * Usage: npx ts-node scripts/init-db.ts
 */

import { initializeSchema } from "../lib/db"

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("❌ DATABASE_URL is not configured")
    console.log("Set DATABASE_URL environment variable in Vercel")
    process.exit(1)
  }

  console.log("🚀 Initializing PostgreSQL schema...")
  try {
    await initializeSchema()
    console.log("✅ PostgreSQL schema initialized successfully")
  } catch (error) {
    console.error("❌ Schema initialization failed:", error)
    process.exit(1)
  }
}

main()

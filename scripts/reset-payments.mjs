#!/usr/bin/env node

/**
 * Emergency Payment Reset Script
 * 
 * Usage:
 *   node scripts/reset-payments.mjs
 *   npx ts-node scripts/reset-payments.ts
 * 
 * This script:
 * - Connects directly to Redis
 * - Lists all stuck payments
 * - Offers option to clear them
 * - Restores system to operational state
 * 
 * Requires:
 * - UPSTASH_REDIS_REST_URL environment variable
 * - UPSTASH_REDIS_REST_TOKEN environment variable
 */

import { Redis } from "@upstash/redis"

async function main() {
  console.log("🔧 FlashPay Payment System Emergency Reset Script")
  console.log("=" * 60)

  // Validate environment
  const redisUrl = process.env.UPSTASH_REDIS_REST_URL
  const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN

  if (!redisUrl || !redisToken) {
    console.error("❌ ERROR: Redis environment variables not set")
    console.error("   Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN")
    process.exit(1)
  }

  // Initialize Redis
  console.log("📡 Connecting to Redis...")
  const redis = new Redis({
    url: redisUrl,
    token: redisToken,
  })

  try {
    // Scan for all payment keys
    console.log("🔍 Scanning for all payment keys...")
    const allKeys = await redis.keys("payment:*")

    if (allKeys.length === 0) {
      console.log("✅ No payments found in Redis - system is clean")
      console.log("   You can safely create new payments")
      process.exit(0)
    }

    console.log(`\n📊 Found ${allKeys.length} payment(s) in Redis:\n`)

    // Analyze payments by status
    const paymentsByStatus = {
      pending: 0,
      paid: 0,
      failed: 0,
      cancelled: 0,
      unknown: 0,
    }

    const payments = []

    for (const key of allKeys) {
      try {
        const data = await redis.get(key)
        if (data) {
          const payment = typeof data === "string" ? JSON.parse(data) : data
          payments.push(payment)

          const status = payment.status || "unknown"
          paymentsByStatus[status as keyof typeof paymentsByStatus]++

          console.log(`   • ID: ${payment.id}`)
          console.log(`     Status: ${status}`)
          console.log(`     Amount: ${payment.amount} Pi`)
          console.log(`     Created: ${payment.createdAt}`)
          console.log()
        }
      } catch (err) {
        console.error(`   ⚠️  Could not read ${key}:`, err instanceof Error ? err.message : err)
      }
    }

    // Summary
    console.log("\n📈 Summary by Status:")
    console.log(`   Pending: ${paymentsByStatus.pending} ⚠️`)
    console.log(`   Paid: ${paymentsByStatus.paid} ✅`)
    console.log(`   Failed: ${paymentsByStatus.failed}`)
    console.log(`   Cancelled: ${paymentsByStatus.cancelled}`)

    // Determine if system is blocked
    const isBlocked = paymentsByStatus.pending > 0

    console.log("\n" + "=" * 60)
    if (isBlocked) {
      console.log("🚨 SYSTEM BLOCKED: " + paymentsByStatus.pending + " pending payment(s)")
      console.log("   Pi Network is refusing new payments due to pending payment(s)")
      console.log("\n   To fix, you must delete these stuck payments.")
    } else {
      console.log("✅ SYSTEM HEALTHY: No pending payments blocking flow")
      console.log("   You can safely create new payments")
      process.exit(0)
    }

    // Ask user confirmation
    console.log("\n⚠️  WARNING: This will permanently delete all pending payments")
    console.log("   (Paid and failed payments will be preserved)")

    const answer = prompt("\nClear stuck payments and reset system? (yes/no): ")

    if (answer?.toLowerCase() !== "yes") {
      console.log("❌ Cancelled - no changes made")
      process.exit(0)
    }

    // Delete all pending payments
    console.log("\n🧹 Clearing stuck payments...")

    let deleted = 0
    for (const payment of payments) {
      if (payment.status === "pending") {
        try {
          const key = `payment:${payment.id}`
          await redis.del(key)
          deleted++
          console.log(`   ✓ Deleted: ${payment.id}`)
        } catch (err) {
          console.error(`   ✗ Failed to delete ${payment.id}:`, err instanceof Error ? err.message : err)
        }
      }
    }

    console.log(`\n✅ Reset complete! Cleared ${deleted} stuck payment(s)`)
    console.log("   System is now ready to accept new payments")
    console.log("\n💡 Next steps:")
    console.log("   1. Reload the app in Pi Browser")
    console.log("   2. Try creating a new payment")
    console.log("   3. Verify payment flow works normally")

    process.exit(0)
  } catch (error) {
    console.error("\n❌ Fatal error during reset:")
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  }
}

main().catch((error) => {
  console.error("❌ Unhandled error:", error)
  process.exit(1)
})

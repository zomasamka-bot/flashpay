#!/usr/bin/env node

/**
 * EMERGENCY PAYMENT RESET TOOL
 * 
 * Direct manual reset for stuck payments when the UI is broken.
 * 
 * Usage:
 *   node scripts/emergency-reset.mjs
 * 
 * This script:
 * 1. Connects directly to Redis
 * 2. Lists all stuck pending payments
 * 3. Clears them on confirmation
 * 4. Verifies the system is reset
 */

import { createClient } from "redis"
import { readlineSync } from "readline-sync"

const REDIS_URL = process.env.KV_REST_API_URL || process.env.REDIS_URL

if (!REDIS_URL) {
  console.error("❌ Error: REDIS_URL or KV_REST_API_URL environment variable not set")
  console.error("   Set this in your .env file or Vercel project settings")
  process.exit(1)
}

console.log("🔧 FlashPay - Emergency Payment Reset Tool")
console.log("=" + "=".repeat(49))

const client = createClient({ url: REDIS_URL })

async function run() {
  try {
    console.log("\n📡 Connecting to Redis...")
    await client.connect()
    console.log("✅ Connected")

    // Get all payment keys
    console.log("\n🔍 Scanning for payments...")
    const allKeys = await client.keys("payment:*")
    console.log(`Found ${allKeys.length} total payment(s)`)

    if (allKeys.length === 0) {
      console.log("\n✅ No payments found. System is clean.")
      await client.disconnect()
      process.exit(0)
    }

    // Analyze payments
    console.log("\n📊 Payment Status Breakdown:")
    console.log("=" + "=".repeat(49))

    let pending = 0
    let paid = 0
    let failed = 0
    const paymentDetails = []

    for (const key of allKeys) {
      const data = await client.get(key)
      if (data) {
        const payment = typeof data === "string" ? JSON.parse(data) : data
        const status = payment.status || "unknown"

        paymentDetails.push({
          id: payment.id,
          amount: payment.amount,
          status,
          createdAt: payment.createdAt,
        })

        if (status === "pending") pending++
        else if (status === "paid") paid++
        else if (status === "failed") failed++
      }
    }

    console.log(`  🟡 Pending:  ${pending}`)
    console.log(`  🟢 Paid:     ${paid}`)
    console.log(`  🔴 Failed:   ${failed}`)

    // Show pending payments in detail
    if (pending > 0) {
      console.log("\n⚠️  Stuck Pending Payments (BLOCKING NEW PAYMENTS):")
      console.log("=" + "=".repeat(49))
      paymentDetails.filter((p) => p.status === "pending").forEach((p) => {
        console.log(`  • ID: ${p.id.substring(0, 8)}...`)
        console.log(`    Amount: ${p.amount} π`)
        console.log(`    Created: ${p.createdAt}`)
        console.log()
      })
    }

    if (pending === 0) {
      console.log("\n✅ No stuck pending payments. System is healthy.")
      await client.disconnect()
      process.exit(0)
    }

    // Ask for confirmation
    console.log("⚠️  WARNING: About to delete stuck pending payment(s)")
    console.log("   • This will PERMANENTLY remove the pending payment record(s)")
    console.log("   • Paid/completed transactions will NOT be affected")
    console.log("   • The payment flow will be restored immediately")
    console.log()

    const confirm = readlineSync.keyInYN("Do you want to proceed with reset? (y/n): ")

    if (!confirm) {
      console.log("\n❌ Reset cancelled by user")
      await client.disconnect()
      process.exit(0)
    }

    // Delete all stuck payments
    console.log("\n🗑️  Deleting stuck pending payment(s)...")
    let deleted = 0

    for (const key of allKeys) {
      const data = await client.get(key)
      if (data) {
        const payment = typeof data === "string" ? JSON.parse(data) : data
        if (payment.status === "pending") {
          await client.del(key)
          deleted++
          console.log(`   ✓ Deleted: ${payment.id.substring(0, 8)}... (${payment.amount} π)`)
        }
      }
    }

    // Verify reset
    console.log("\n✅ Verifying reset...")
    const finalKeys = await client.keys("payment:*")
    let finalPending = 0

    for (const key of finalKeys) {
      const data = await client.get(key)
      if (data) {
        const payment = typeof data === "string" ? JSON.parse(data) : data
        if (payment.status === "pending") finalPending++
      }
    }

    console.log("\n" + "=".repeat(50))
    console.log("🎉 RESET COMPLETE!")
    console.log("=".repeat(50))
    console.log(`  ✅ Deleted:        ${deleted} stuck payment(s)`)
    console.log(`  ✅ Remaining:      ${finalKeys.length - deleted} payment(s)`)
    console.log(`  ✅ Pending count:  ${finalPending} (should be 0)`)
    console.log("\n📝 Next Steps:")
    console.log("  1. Close this script")
    console.log("  2. Refresh your FlashPay app")
    console.log("  3. The payment flow should now be restored")
    console.log("  4. You can create new payments immediately")

    await client.disconnect()
    process.exit(0)
  } catch (error) {
    console.error("\n❌ Error during reset:", error instanceof Error ? error.message : String(error))
    try {
      await client.disconnect()
    } catch {}
    process.exit(1)
  }
}

run()

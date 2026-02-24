import { NextResponse } from "next/server"
import { Redis } from "@upstash/redis"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

// Initialize Upstash Redis client
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL || "",
  token: process.env.UPSTASH_REDIS_REST_TOKEN || "",
})

export async function GET() {
  const diagnostics = {
    timestamp: new Date().toISOString(),
    environment: {
      NODE_ENV: process.env.NODE_ENV,
      VERCEL_ENV: process.env.VERCEL_ENV,
      VERCEL_URL: process.env.VERCEL_URL,
    },
    redis: {
      UPSTASH_REDIS_REST_URL_exists: !!process.env.UPSTASH_REDIS_REST_URL,
      UPSTASH_REDIS_REST_URL_value: process.env.UPSTASH_REDIS_REST_URL ? "SET (hidden)" : "NOT SET",
      UPSTASH_REDIS_REST_TOKEN_exists: !!process.env.UPSTASH_REDIS_REST_TOKEN,
      UPSTASH_REDIS_REST_TOKEN_value: process.env.UPSTASH_REDIS_REST_TOKEN ? "SET (hidden)" : "NOT SET",
      isRedisConfigured: !!(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN),
    },
    kvTest: {
      status: "pending",
      message: "",
    },
  }

  // Test Redis connectivity
  if (diagnostics.redis.isRedisConfigured) {
    try {
      const testKey = `diagnostic:${Date.now()}`
      const testValue = { test: "value", timestamp: Date.now() }
      
      // Try to write
      await redis.set(testKey, JSON.stringify(testValue), { ex: 60 }) // Expire in 60 seconds
      
      // Try to read
      const readValue = await redis.get(testKey)
      
      // Clean up
      await redis.del(testKey)
      
      diagnostics.kvTest.status = readValue ? "SUCCESS" : "FAILED"
      diagnostics.kvTest.message = readValue 
        ? "Redis write and read successful" 
        : "Redis write succeeded but read failed"
    } catch (error) {
      diagnostics.kvTest.status = "ERROR"
      diagnostics.kvTest.message = error instanceof Error ? error.message : String(error)
    }
  } else {
    diagnostics.kvTest.status = "SKIPPED"
    diagnostics.kvTest.message = "Redis environment variables not configured"
  }

  return NextResponse.json(diagnostics, {
    headers: {
      "Cache-Control": "no-store, no-cache, must-revalidate",
    },
  })
}

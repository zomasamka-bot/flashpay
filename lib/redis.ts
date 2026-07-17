/**
 * Shared Upstash Redis client (SERVER-ONLY).
 * All API routes must import redis and isRedisConfigured from here.
 * Do NOT initialize Redis directly in route files.
 * Do NOT import this into client code ("use client" modules).
 */

import { Redis } from "@upstash/redis"
import { serverConfig } from "./server-config"

export const redis = new Redis({
  url: serverConfig.redisUrl,
  token: serverConfig.redisToken,
})

export const isRedisConfigured = serverConfig.isRedisConfigured

/**
 * Retry helper for Redis operations with exponential backoff.
 * Useful for immediate verification reads after writes.
 * @param operation - Async function to retry
 * @param maxRetries - Number of retries (default: 3)
 * @param delayMs - Initial delay in milliseconds (default: 100ms)
 * @returns Result of the operation or null if all retries fail
 */
export async function redisRetry<T>(
  operation: () => Promise<T | null>,
  maxRetries: number = 3,
  delayMs: number = 100
): Promise<T | null> {
  let lastError: Error | null = null

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await operation()
      if (result !== null) {
        if (attempt > 0) {
          console.log(`[Redis] ✓ Operation succeeded on attempt ${attempt + 1}/${maxRetries + 1}`)
        }
        return result
      }
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
      console.warn(`[Redis] Attempt ${attempt + 1}/${maxRetries + 1} failed:`, lastError.message)
    }

    // Don't delay on the last attempt
    if (attempt < maxRetries) {
      const backoffDelay = delayMs * Math.pow(2, attempt)
      console.log(`[Redis] Retrying after ${backoffDelay}ms...`)
      await new Promise((resolve) => setTimeout(resolve, backoffDelay))
    }
  }

  // All retries exhausted
  if (lastError) {
    console.error(`[Redis] ❌ Operation failed after ${maxRetries + 1} attempts:`, lastError.message)
    throw lastError
  }

  return null
}

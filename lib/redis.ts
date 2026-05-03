/**
 * Shared Upstash Redis client.
 * All API routes must import redis and isRedisConfigured from here.
 * Do NOT initialize Redis directly in route files.
 */

import { Redis } from "@upstash/redis"
import { config } from "./config"

export const redis = new Redis({
  url: config.redisUrl,
  token: config.redisToken,
})

export const isRedisConfigured = config.isRedisConfigured

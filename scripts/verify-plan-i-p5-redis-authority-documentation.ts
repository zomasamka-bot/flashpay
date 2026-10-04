import fs from "node:fs"
import path from "node:path"
const root = process.cwd()
const source = fs.readFileSync(path.join(root, "lib/a2u-response.ts"), "utf8")
function need(ok: boolean, msg: string) { if (!ok) throw new Error(msg) }
need(source.includes("Redis projection to return the latest response view; Redis is not financial authority"), "P5 response-view authority wording missing")
need(source.includes("latest Redis projection for response construction only"), "P5 response-construction projection wording missing")
need(source.includes("durable PostgreSQL checkpoints and verified Pi/Horizon evidence remain financial authority"), "P5 canonical financial authority wording missing")
need(!source.includes("Redis to ensure authoritative data"), "P5 stale Redis authoritative-data wording remains")
need(!source.includes("Redis record as sole authority"), "P5 stale Redis sole-authority wording remains")
need(source.includes("Response projection is not financial authority"), "P5 existing response-projection non-authority guard missing")
console.log("PLAN_I_P5_REDIS_AUTHORITY_DOCUMENTATION=PASS comments_only=true redis=projection financial_authority=durable_pg+verified_pi_horizon")

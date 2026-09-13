import { NextRequest, NextResponse } from "next/server"
import { redis, isRedisConfigured } from "@/lib/redis"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

type StoredReceiptFile = {
  paymentId: string
  filename: string
  pdfBase64: string
  createdAt: string
}

function parseRecord(raw: unknown): StoredReceiptFile | null {
  let value: unknown = raw
  if (typeof raw === "string") {
    try { value = JSON.parse(raw) } catch { return null }
  }
  if (!value || typeof value !== "object") return null
  const record = value as Partial<StoredReceiptFile>
  if (
    typeof record.paymentId !== "string" ||
    typeof record.filename !== "string" ||
    typeof record.pdfBase64 !== "string" ||
    typeof record.createdAt !== "string"
  ) return null
  return record as StoredReceiptFile
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  if (!isRedisConfigured) return NextResponse.json({ error: "Receipt unavailable" }, { status: 503 })
  const { token } = await params
  if (!/^[0-9a-f]{32}$/.test(token)) return NextResponse.json({ error: "Invalid receipt link" }, { status: 400 })

  const record = parseRecord(await redis.get(`receipt-file:${token}`))
  if (!record) return NextResponse.json({ error: "Receipt link expired" }, { status: 404 })

  let bytes: Buffer
  try {
    bytes = Buffer.from(record.pdfBase64, "base64")
  } catch {
    return NextResponse.json({ error: "Receipt unavailable" }, { status: 503 })
  }
  if (bytes.byteLength < 512 || bytes.byteLength > 512 * 1024) {
    return NextResponse.json({ error: "Receipt unavailable" }, { status: 503 })
  }

  const arrayBuffer = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(arrayBuffer).set(bytes)
  const download = request.nextUrl.searchParams.get("download") === "1"
  const disposition = download ? "attachment" : "inline"
  const safeFilename = record.filename.replace(/[^a-zA-Z0-9._-]/g, "-")

  return new Response(arrayBuffer, {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `${disposition}; filename="${safeFilename}"`,
      "Content-Length": String(bytes.byteLength),
      "Cache-Control": "private, no-store, max-age=0",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "sandbox",
    },
  })
}

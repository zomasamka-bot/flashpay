import type { FlashPayReceiptView } from "@/lib/types"

const PAGE_WIDTH_PX = 1240
const PAGE_HEIGHT_PX = 1754
const PDF_PAGE_WIDTH = 595.28
const PDF_PAGE_HEIGHT = 841.89

export interface ReceiptPdfLabels {
  paymentReceipt: string
  refundReceipt: string
  merchant: string
  customer: string
  unavailable: string
  type: string
  payment: string
  refund: string
  dateTime: string
  note: string
  flashPayId: string
  verified: string
  status: Record<FlashPayReceiptView["status"], string>
}

export interface ReceiptPdfOptions {
  labels: ReceiptPdfLabels
  direction: "ltr" | "rtl"
  locale: string
}


const encoder = new TextEncoder()

function formatReceiptDateTime(value: string, locale: string, unavailable: string): string {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return unavailable
  const formatter = new Intl.DateTimeFormat(locale, {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    numberingSystem: "latn",
  })
  const parts = Object.fromEntries(formatter.formatToParts(date).map(({ type, value: part }) => [type, part]))
  return `${parts.day} ${parts.month} ${parts.year} · ${parts.hour}:${parts.minute}:${parts.second}`
}

function roundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number) {
  const r = Math.min(radius, width / 2, height / 2)
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.lineTo(x + width - r, y)
  ctx.quadraticCurveTo(x + width, y, x + width, y + r)
  ctx.lineTo(x + width, y + height - r)
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height)
  ctx.lineTo(x + r, y + height)
  ctx.quadraticCurveTo(x, y + height, x, y + height - r)
  ctx.lineTo(x, y + r)
  ctx.quadraticCurveTo(x, y, x + r, y)
  ctx.closePath()
}

function fitFont(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, startSize: number, minSize: number, weight = 600): number {
  let size = startSize
  while (size > minSize) {
    ctx.font = `${weight} ${size}px Arial, Helvetica, sans-serif`
    if (ctx.measureText(text).width <= maxWidth) return size
    size -= 2
  }
  return minSize
}

function splitLongToken(ctx: CanvasRenderingContext2D, token: string, maxWidth: number): string[] {
  const parts: string[] = []
  let current = ""
  for (const char of token) {
    const candidate = current + char
    if (current && ctx.measureText(candidate).width > maxWidth) {
      parts.push(current)
      current = char
    } else {
      current = candidate
    }
  }
  if (current) parts.push(current)
  return parts
}

function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, maxLines = 4): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return []
  const lines: string[] = []
  let line = ""

  for (const word of words) {
    const pieces = ctx.measureText(word).width > maxWidth ? splitLongToken(ctx, word, maxWidth) : [word]
    for (const piece of pieces) {
      const candidate = line ? `${line} ${piece}` : piece
      if (line && ctx.measureText(candidate).width > maxWidth) {
        lines.push(line)
        line = piece
      } else {
        line = candidate
      }
      if (lines.length >= maxLines) break
    }
    if (lines.length >= maxLines) break
  }
  if (line && lines.length < maxLines) lines.push(line)

  const consumed = lines.join(" ").replace(/\s+/g, "").length
  const original = text.replace(/\s+/g, "").length
  if (original > consumed && lines.length > 0) {
    let last = lines[lines.length - 1]
    while (last.length > 1 && ctx.measureText(`${last}…`).width > maxWidth) last = last.slice(0, -1)
    lines[lines.length - 1] = `${last}…`
  }
  return lines
}

function drawLabel(ctx: CanvasRenderingContext2D, label: string, x: number, y: number, maxWidth = 420, direction: "ltr" | "rtl" = "ltr") {
  ctx.fillStyle = "#6b7280"
  ctx.font = "600 28px Arial, Helvetica, sans-serif"
  ctx.direction = direction
  ctx.textAlign = direction === "rtl" ? "right" : "left"
  ctx.fillText(label.toUpperCase(), direction === "rtl" ? x + maxWidth : x, y)
}

function drawValue(ctx: CanvasRenderingContext2D, value: string, x: number, y: number, maxWidth: number, startSize = 38, direction: "ltr" | "rtl" = "ltr") {
  const size = fitFont(ctx, value, maxWidth, startSize, 25, 600)
  ctx.font = `600 ${size}px Arial, Helvetica, sans-serif`
  ctx.fillStyle = "#111827"
  ctx.direction = direction
  ctx.textAlign = direction === "rtl" ? "right" : "left"
  ctx.fillText(value, direction === "rtl" ? x + maxWidth : x, y)
}

function statusFill(status: FlashPayReceiptView["status"]): string {
  if (status === "failed" || status === "needs_attention") return "#b91c1c"
  if (status === "refunded") return "#7c3aed"
  if (status === "processing") return "#d97706"
  if (status === "cancelled") return "#6b7280"
  return "#2563eb"
}

function createReceiptCanvas(receipt: FlashPayReceiptView, options: ReceiptPdfOptions): HTMLCanvasElement {
  const { labels, direction } = options
  const canvas = document.createElement("canvas")
  canvas.width = PAGE_WIDTH_PX
  canvas.height = PAGE_HEIGHT_PX
  const ctx = canvas.getContext("2d")
  if (!ctx) throw new Error("Canvas unavailable")

  ctx.fillStyle = "#ffffff"
  ctx.fillRect(0, 0, PAGE_WIDTH_PX, PAGE_HEIGHT_PX)

  const margin = 88
  const contentWidth = PAGE_WIDTH_PX - margin * 2

  ctx.fillStyle = "#6b7280"
  ctx.font = "700 26px Arial, Helvetica, sans-serif"
  ctx.textAlign = "left"
  ctx.fillText("FLASHPAY", margin, 115)

  ctx.fillStyle = "#111827"
  ctx.font = "700 60px Arial, Helvetica, sans-serif"
  ctx.direction = direction
  ctx.textAlign = direction === "rtl" ? "right" : "left"
  ctx.fillText(receipt.transactionType === "refund" ? labels.refundReceipt : labels.paymentReceipt, direction === "rtl" ? PAGE_WIDTH_PX - margin : margin, 190)

  const statusText = labels.status[receipt.status]
  ctx.font = "600 27px Arial, Helvetica, sans-serif"
  const badgeWidth = Math.max(230, ctx.measureText(statusText).width + 54)
  roundedRect(ctx, PAGE_WIDTH_PX - margin - badgeWidth, 93, badgeWidth, 58, 29)
  ctx.fillStyle = statusFill(receipt.status)
  ctx.fill()
  ctx.fillStyle = "#ffffff"
  ctx.textAlign = "center"
  ctx.fillText(statusText, PAGE_WIDTH_PX - margin - badgeWidth / 2, 132)

  ctx.strokeStyle = "#e5e7eb"
  ctx.lineWidth = 3
  ctx.beginPath()
  ctx.moveTo(margin, 250)
  ctx.lineTo(PAGE_WIDTH_PX - margin, 250)
  ctx.stroke()

  ctx.fillStyle = "#111827"
  ctx.font = "700 92px Arial, Helvetica, sans-serif"
  ctx.textAlign = "center"
  ctx.fillText(`${receipt.amount.toFixed(2)} ${receipt.currency}`, PAGE_WIDTH_PX / 2, 410)

  ctx.beginPath()
  ctx.moveTo(margin, 475)
  ctx.lineTo(PAGE_WIDTH_PX - margin, 475)
  ctx.stroke()

  const partyY = 530
  roundedRect(ctx, margin, partyY, contentWidth, 205, 44)
  ctx.fillStyle = "#f3f4f6"
  ctx.fill()
  const colGap = 48
  const colWidth = (contentWidth - colGap - 72) / 2
  const leftX = margin + 36
  const rightX = margin + 36 + colWidth + colGap
  drawLabel(ctx, labels.merchant, leftX, partyY + 62, colWidth, direction)
  drawValue(ctx, receipt.merchantName, leftX, partyY + 125, colWidth, 38, direction)
  drawLabel(ctx, labels.customer, rightX, partyY + 62, colWidth, direction)
  drawValue(ctx, receipt.customerName ?? labels.unavailable, rightX, partyY + 125, colWidth, 38, direction)

  const detailsY = 825
  drawLabel(ctx, labels.type, margin, detailsY, 390, direction)
  drawValue(ctx, receipt.transactionType === "refund" ? labels.refund : labels.payment, margin, detailsY + 66, 390, 40, direction)
  drawLabel(ctx, labels.dateTime, 630, detailsY, PAGE_WIDTH_PX - margin - 630, direction)
  drawValue(ctx, formatReceiptDateTime(receipt.occurredAt, options.locale, labels.unavailable), 630, detailsY + 66, PAGE_WIDTH_PX - margin - 630, 34)

  let nextY = 1005
  if (receipt.note) {
    drawLabel(ctx, labels.note, margin, nextY, contentWidth, direction)
    ctx.font = "400 31px Arial, Helvetica, sans-serif"
    ctx.fillStyle = "#111827"
    ctx.direction = direction
    ctx.textAlign = direction === "rtl" ? "right" : "left"
    const lines = wrapText(ctx, receipt.note, contentWidth, 3)
    lines.forEach((line, index) => ctx.fillText(line, direction === "rtl" ? PAGE_WIDTH_PX - margin : margin, nextY + 54 + index * 42))
    nextY += 92 + Math.max(0, lines.length - 1) * 42
  }

  const idBoxY = nextY + 30
  roundedRect(ctx, margin, idBoxY, contentWidth, 250, 42)
  ctx.strokeStyle = "#d1d5db"
  ctx.lineWidth = 3
  ctx.stroke()
  drawLabel(ctx, labels.flashPayId, margin + 36, idBoxY + 62, contentWidth - 72, direction)
  ctx.font = "600 31px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace"
  ctx.fillStyle = "#111827"
  ctx.direction = "ltr"
  ctx.textAlign = "left"
  const idLines = wrapText(ctx, receipt.flashPayPaymentId, contentWidth - 72, 3)
  idLines.forEach((line, index) => ctx.fillText(line, margin + 36, idBoxY + 122 + index * 42))

  const footerY = Math.min(PAGE_HEIGHT_PX - 100, idBoxY + 335)
  ctx.strokeStyle = "#e5e7eb"
  ctx.beginPath()
  ctx.moveTo(margin, footerY - 50)
  ctx.lineTo(PAGE_WIDTH_PX - margin, footerY - 50)
  ctx.stroke()
  ctx.fillStyle = "#6b7280"
  ctx.font = "400 27px Arial, Helvetica, sans-serif"
  ctx.textAlign = "center"
  ctx.fillText(labels.verified, PAGE_WIDTH_PX / 2, footerY)

  return canvas
}

async function canvasToJpegBytes(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92))
  if (blob) return new Uint8Array(await blob.arrayBuffer())

  const dataUrl = canvas.toDataURL("image/jpeg", 0.92)
  const base64 = dataUrl.split(",")[1]
  if (!base64) throw new Error("Unable to encode receipt image")
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

function ascii(value: string): Uint8Array {
  return encoder.encode(value)
}

function jpegToPdf(jpeg: Uint8Array, imageWidth: number, imageHeight: number): Uint8Array {
  const chunks: Uint8Array[] = []
  const offsets: number[] = [0]
  let length = 0
  const push = (chunk: Uint8Array) => {
    chunks.push(chunk)
    length += chunk.length
  }
  const addObject = (id: number, parts: Uint8Array[]) => {
    offsets[id] = length
    push(ascii(`${id} 0 obj\n`))
    parts.forEach(push)
    push(ascii("\nendobj\n"))
  }

  push(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]))
  addObject(1, [ascii("<< /Type /Catalog /Pages 2 0 R >>")])
  addObject(2, [ascii("<< /Type /Pages /Kids [3 0 R] /Count 1 >>")])
  addObject(3, [ascii(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PDF_PAGE_WIDTH} ${PDF_PAGE_HEIGHT}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`)])
  addObject(4, [
    ascii(`<< /Type /XObject /Subtype /Image /Width ${imageWidth} /Height ${imageHeight} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`),
    jpeg,
    ascii("\nendstream"),
  ])
  const content = `q\n${PDF_PAGE_WIDTH} 0 0 ${PDF_PAGE_HEIGHT} 0 0 cm\n/Im0 Do\nQ\n`
  addObject(5, [ascii(`<< /Length ${encoder.encode(content).length} >>\nstream\n${content}endstream`)])

  const xrefOffset = length
  push(ascii("xref\n0 6\n0000000000 65535 f \n"))
  for (let id = 1; id <= 5; id += 1) push(ascii(`${String(offsets[id]).padStart(10, "0")} 00000 n \n`))
  push(ascii(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`))
  return concatBytes(chunks)
}

export async function createReceiptPdfFile(receipt: FlashPayReceiptView, options: ReceiptPdfOptions): Promise<File> {
  if (typeof document === "undefined") throw new Error("PDF generation requires a browser")
  const canvas = createReceiptCanvas(receipt, options)
  const jpeg = await canvasToJpegBytes(canvas)
  const pdf = jpegToPdf(jpeg, canvas.width, canvas.height)
  const pdfBuffer = new ArrayBuffer(pdf.byteLength)
  new Uint8Array(pdfBuffer).set(pdf)
  const safeId = receipt.flashPayPaymentId.replace(/[^a-zA-Z0-9_-]/g, "-")
  return new File([pdfBuffer], `FlashPay-Receipt-${safeId}.pdf`, { type: "application/pdf" })
}

export function openHttpsPdfUrl(url: string): void {
  const opened = window.open(url, "_blank", "noopener,noreferrer")
  if (!opened) window.location.assign(url)
}

/**
 * Local fallback only. The primary mobile download path uses a short-lived
 * HTTPS URL so Android/iOS WebViews are not asked to download a blob: URL.
 */
export function downloadReceiptPdfFile(file: File): void {
  const url = URL.createObjectURL(file)
  const link = document.createElement("a")
  link.href = url
  link.download = file.name
  link.rel = "noopener"
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

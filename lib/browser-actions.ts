/** Browser capabilities affect presentation only; no financial authority. */
export function isShareCancelled(error: unknown): boolean {
  return !!error && typeof error === "object" && "name" in error && error.name === "AbortError"
}

export async function copyText(value: string): Promise<boolean> {
  if (!value || typeof document === "undefined") return false
  try {
    if (typeof navigator.clipboard?.writeText === "function") { await navigator.clipboard.writeText(value); return true }
  } catch { /* Embedded browsers can expose but deny Clipboard API. */ }
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null
  const selection = window.getSelection()
  const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, i) => selection.getRangeAt(i).cloneRange()) : []
  const field = document.createElement("textarea")
  field.value = value; field.readOnly = true
  field.style.cssText = "position:fixed;inset:0 auto auto 0;width:1px;height:1px;opacity:0;font-size:16px"
  document.body.appendChild(field)
  try { field.focus({ preventScroll: true }); field.select(); field.setSelectionRange(0, value.length); return document.execCommand("copy") }
  catch { return false }
  finally {
    field.remove(); active?.focus({ preventScroll: true })
    if (selection) { selection.removeAllRanges(); ranges.forEach(range => selection.addRange(range)) }
  }
}

export function downloadFile(file: File): void {
  const url = URL.createObjectURL(file), link = document.createElement("a")
  link.href = url; link.download = file.name; link.rel = "noopener"; link.hidden = true
  document.body.appendChild(link); link.click(); link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

export async function shareOrDownloadFile(file: File, title: string): Promise<"shared" | "cancelled" | "downloaded"> {
  const pi = window.Pi as (typeof window.Pi & { shareFile?: (file: File) => unknown }) | undefined
  if (typeof pi?.shareFile === "function") {
    try { await pi.shareFile(file); return "shared" } catch (error) { if (isShareCancelled(error)) return "cancelled" }
  }
  if (typeof navigator.share === "function") {
    try {
      if (!navigator.canShare || navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title }); return "shared" }
    } catch (error) { if (isShareCancelled(error)) return "cancelled" }
  }
  downloadFile(file); return "downloaded"
}

export function openExternalUrl(value: string): void {
  const url = new URL(value)
  if (url.protocol !== "https:") throw new Error("HTTPS_REQUIRED")
  // Opening before any await retains the click's user activation.
  const tab = window.open(url.href, "_blank")
  if (tab) tab.opener = null
  else window.location.assign(url.href)
}

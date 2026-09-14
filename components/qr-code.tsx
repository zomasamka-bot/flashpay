"use client"

import { useEffect, useRef } from "react"

interface QRCodeProps {
  value: string
  size?: number
}

export function QRCode({ value, size = 280 }: QRCodeProps) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const mount = ref.current
    if (!mount) return

    let cancelled = false
    void import("qr-code-styling")
      .then(({ default: QRCodeStyling }) => {
        if (cancelled) return
        const qrCode = new QRCodeStyling({
          width: size,
          height: size,
          data: value,
          margin: 10,
          qrOptions: {
            typeNumber: 0,
            mode: "Byte",
            errorCorrectionLevel: "H",
          },
          imageOptions: {
            hideBackgroundDots: true,
            imageSize: 0.4,
            margin: 5,
          },
          dotsOptions: {
            type: "rounded",
            color: "#6366f1",
          },
          backgroundOptions: {
            color: "#ffffff",
          },
          cornersSquareOptions: {
            type: "extra-rounded",
            color: "#4f46e5",
          },
          cornersDotOptions: {
            type: "dot",
            color: "#4f46e5",
          },
        })

        mount.innerHTML = ""
        qrCode.append(mount)
      })
      .catch(() => {
        // QR rendering is presentation-only; leave the container empty on load failure.
      })

    return () => {
      cancelled = true
      mount.innerHTML = ""
    }
  }, [value, size])

  return <div ref={ref} className="flex items-center justify-center" />
}

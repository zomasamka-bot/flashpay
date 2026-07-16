"use client"

import { useEffect, useRef } from "react"
import QRCodeStyling from "qr-code-styling"

interface QRCodeProps {
  value: string
  size?: number
}

export function QRCode({ value, size = 280 }: QRCodeProps) {
  const ref = useRef<HTMLDivElement>(null)
  const qrCode = useRef<QRCodeStyling | null>(null)

  useEffect(() => {
    if (!ref.current) return

    qrCode.current = new QRCodeStyling({
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

    ref.current.innerHTML = ""
    qrCode.current.append(ref.current)
  }, [value, size])

  return <div ref={ref} className="flex items-center justify-center" />
}

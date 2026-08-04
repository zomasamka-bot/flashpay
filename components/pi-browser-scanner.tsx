"use client"

import { useState, useRef, useEffect } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Camera, Upload, X, AlertCircle } from "lucide-react"
import { useToast } from "@/hooks/use-toast"

// Lazy-load jsQR for QR code decoding
let jsQR: any = null
const loadJsQR = async () => {
  if (!jsQR) {
    const module = await import("jsqr")
    jsQR = module.default
  }
  return jsQR
}

interface PiBrowserScannerProps {
  onPaymentIdDetected: (paymentId: string) => void
  onClose: () => void
}

/**
 * Pi Browser "Scan to Pay" scanner
 * Accepts QR codes encoding "flashpay:{UUID}", image uploads, or manual entry
 * Extracts UUID and passes to parent for rendering PaymentContentWithId
 */
export function PiBrowserScanner({ onPaymentIdDetected, onClose }: PiBrowserScannerProps) {
  const { toast } = useToast()
  const [scanning, setScanning] = useState(false)
  const [manualCode, setManualCode] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [cameraPermission, setCameraPermission] = useState<"pending" | "granted" | "denied">("pending")
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // UUID regex pattern (canonical form with hyphens)
  const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

  const extractPaymentId = (code: string): string | null => {
    const match = code.match(/^flashpay:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i)
    if (match && match[1]) {
      return match[1].toLowerCase()
    }
    return null
  }

  const handlePaymentIdFound = (id: string) => {
    console.log("[v0][PiBrowserScanner] Payment ID extracted:", id)
    setError(null)
    setScanning(false)
    if (videoRef.current?.srcObject) {
      const stream = videoRef.current.srcObject as MediaStream
      stream.getTracks().forEach(track => track.stop())
      videoRef.current.srcObject = null
    }
    onPaymentIdDetected(id)
  }

  const startCamera = async () => {
    setError(null)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" }
      })
      if (videoRef.current) {
        videoRef.current.srcObject = stream
        setScanning(true)
        setCameraPermission("granted")
        // Start continuous scanning
        scanFrame()
      }
    } catch (err) {
      setCameraPermission("denied")
      setError("Camera permission denied or not available")
      console.error("[v0][PiBrowserScanner] Camera error:", err)
    }
  }

  const scanFrame = async () => {
    if (!videoRef.current || !canvasRef.current || !scanning) return

    const ctx = canvasRef.current.getContext("2d")
    if (!ctx) return

    canvasRef.current.width = videoRef.current.videoWidth
    canvasRef.current.height = videoRef.current.videoHeight
    ctx.drawImage(videoRef.current, 0, 0)

    try {
      const decoder = await loadJsQR()
      const imageData = ctx.getImageData(0, 0, canvasRef.current.width, canvasRef.current.height)
      const code = decoder(imageData.data, imageData.width, imageData.height)
      
      if (code) {
        console.log("[v0][PiBrowserScanner] QR data detected:", code.data)
        const paymentId = extractPaymentId(code.data)
        if (paymentId) {
          handlePaymentIdFound(paymentId)
          return
        }
      }
    } catch (err) {
      console.error("[v0][PiBrowserScanner] Frame scan error:", err)
    }

    if (scanning) {
      requestAnimationFrame(scanFrame)
    }
  }

  const handleImageUpload = async (file: File) => {
    setError(null)
    try {
      const reader = new FileReader()
      reader.onload = async (e) => {
        const img = new Image()
        img.crossOrigin = "anonymous"
        img.onload = async () => {
          if (canvasRef.current) {
            const ctx = canvasRef.current.getContext("2d")
            if (!ctx) return
            canvasRef.current.width = img.width
            canvasRef.current.height = img.height
            ctx.drawImage(img, 0, 0)
            
            try {
              const decoder = await loadJsQR()
              const imageData = ctx.getImageData(0, 0, canvasRef.current.width, canvasRef.current.height)
              const code = decoder(imageData.data, imageData.width, imageData.height)
              
              if (code) {
                console.log("[v0][PiBrowserScanner] QR from image detected:", code.data)
                const paymentId = extractPaymentId(code.data)
                if (paymentId) {
                  handlePaymentIdFound(paymentId)
                  return
                }
              }
              
              setError("No valid flashpay QR code found in image")
            } catch (decodeErr) {
              setError("Failed to decode QR code from image")
              console.error("[v0][PiBrowserScanner] Image decode error:", decodeErr)
            }
          }
        }
        img.src = e.target?.result as string
      }
      reader.readAsDataURL(file)
    } catch (err) {
      setError("Failed to process image")
      console.error("[v0][PiBrowserScanner] Image upload error:", err)
    }
  }

  const handleManualEntry = () => {
    const trimmed = manualCode.trim()
    if (!trimmed) {
      setError("Please enter a payment code")
      return
    }

    const paymentId = extractPaymentId(trimmed)
    if (!paymentId) {
      setError("Invalid format. Expected: flashpay:UUID")
      return
    }

    handlePaymentIdFound(paymentId)
  }

  const stopScanning = () => {
    setScanning(false)
    if (videoRef.current?.srcObject) {
      const stream = videoRef.current.srcObject as MediaStream
      stream.getTracks().forEach(track => track.stop())
      videoRef.current.srcObject = null
    }
  }

  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Camera className="w-5 h-5" />
          Scan to Pay
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {/* Camera Scanner */}
        {!scanning && cameraPermission !== "denied" && (
          <Button onClick={startCamera} variant="outline" className="w-full">
            <Camera className="w-4 h-4 mr-2" />
            Start Camera Scan
          </Button>
        )}

        {scanning && (
          <div className="space-y-2">
            <video
              ref={videoRef}
              autoPlay
              playsInline
              className="w-full border-2 border-blue-500 rounded"
            />
            <canvas ref={canvasRef} className="hidden" />
            <Button onClick={stopScanning} variant="outline" className="w-full">
              <X className="w-4 h-4 mr-2" />
              Stop Camera
            </Button>
          </div>
        )}

        {/* Image Upload */}
        <div>
          <Button
            onClick={() => fileInputRef.current?.click()}
            variant="outline"
            className="w-full"
          >
            <Upload className="w-4 h-4 mr-2" />
            Upload QR Image
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              if (e.target.files?.[0]) {
                handleImageUpload(e.target.files[0])
              }
            }}
          />
        </div>

        {/* Manual Entry */}
        <div className="space-y-2 border-t pt-4">
          <label className="text-sm font-medium">Or enter manually</label>
          <Input
            placeholder="flashpay:xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
            value={manualCode}
            onChange={(e) => {
              setManualCode(e.target.value)
              setError(null)
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                handleManualEntry()
              }
            }}
          />
          <Button onClick={handleManualEntry} className="w-full">
            Submit Code
          </Button>
        </div>

        {/* Close */}
        <Button onClick={onClose} variant="ghost" className="w-full">
          Close
        </Button>
      </CardContent>
    </Card>
  )
}

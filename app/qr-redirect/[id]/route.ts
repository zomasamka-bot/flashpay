import { NextRequest, NextResponse } from 'next/server'

/**
 * Smart QR redirect endpoint
 * Detects environment when QR is scanned and routes accordingly:
 * - In Pi Browser: redirects to pinet.com
 * - Outside Pi Browser: stays on Vercel
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const searchParams = request.nextUrl.searchParams
  const amount = searchParams.get('amount') || ''
  const note = searchParams.get('note') || ''

  // Build query string
  const queryParts = []
  if (amount) queryParts.push(`amount=${amount}`)
  if (note) queryParts.push(`note=${encodeURIComponent(note)}`)
  queryParts.push('entry=pi')
  const queryString = queryParts.join('&')

  // Return an HTML page that detects environment on client side
  const html = `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8" />
        <title>Redirecting...</title>
        <script>
          // Detect if in Pi Browser
          const isPiBrowser = window.location.origin.includes('pinet.com') || 
                            (typeof window !== 'undefined' && window.Pi !== undefined);
          
          if (isPiBrowser) {
            // In Pi Browser: redirect to pinet.com
            window.location.href = 'https://flashpayaefebeff3375.pinet.com/pay/${id}?${queryString}';
          } else {
            // Outside Pi Browser: redirect to Vercel
            window.location.href = 'https://flashpay-two.vercel.app/pay/${id}?${queryString}';
          }
        </script>
      </head>
      <body>
        <p>Redirecting...</p>
      </body>
    </html>
  `

  return new NextResponse(html, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  })
}

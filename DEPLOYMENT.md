# FlashPay Deployment Guide

## Environment Variables

FlashPay requires the following environment variable to be set for proper QR code generation:

### Required Variables

```bash
NEXT_PUBLIC_APP_URL=https://your-actual-domain.com
```

**Important:** This URL must be:
- The **actual public-facing domain** where users will access the app
- **NOT** a Vercel internal preview URL (vusercontent.net)
- **NOT** localhost or 127.0.0.1

### Recommended Configurations

#### For Vercel Production (Current):
```bash
NEXT_PUBLIC_APP_URL=https://flashpay-two.vercel.app
```

#### For Custom Domain (Future):
```bash
NEXT_PUBLIC_APP_URL=https://flashpay.yourdomain.com
```

## Why This Matters

When users scan QR codes with their phone camera:
1. The QR code must contain a publicly accessible URL
2. Vercel preview URLs (vusercontent.net) are internal and don't load externally
3. The app automatically detects and rejects these internal URLs
4. Setting `NEXT_PUBLIC_APP_URL` ensures the correct public URL is always used

## Verification

After deployment, check the browser console when generating a QR code:
```
[v0] Current origin: https://...
[v0] NEXT_PUBLIC_APP_URL: https://...
[v0] Generated QR URL: https://...
```

The "Generated QR URL" should be your public-facing domain, not a vusercontent.net URL.

## Pi Browser Integration

For the QR code flow to work correctly:
1. User scans QR code with phone camera
2. Link opens in Safari/default browser
3. User selects "Open in Pi Browser"
4. Payment page loads in Pi Browser
5. User can complete payment via Pi Wallet

The URL must be accessible from external browsers for this flow to work.

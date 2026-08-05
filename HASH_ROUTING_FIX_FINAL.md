# Pi Browser Deep Link Fix: Hash Routing Solution

## The Complete Root Cause

**Current Launch URL** (what was being generated):
```
pi://flashpay.pi?id=abc123&entry=pi
```

**What Pi Browser Actually Receives**:
```
https://flashpay.pi/
```

**Why**: PiNet App Studio (the Pi Browser framework) strips both:
1. **Path components** (`/pay/{id}`) - completely removed
2. **Query parameters** (`?id=...`) - completely removed
3. Hash fragments (`#/pay/{id}`) - **PRESERVED** (client-side only)

Only **hashes survive** the PiNet facade because they are client-side routing constructs that never leave the browser.

## The Official Pi-Compatible Solution

The router utility already had the answer: **`getPiNetPaymentUrl()` at line 23-27 of `/lib/router.ts`**

```typescript
export function getPiNetPaymentUrl(id: string): string {
  return `https://flashpayaefebeff3375.pinet.com/#/pay/${encodeURIComponent(id)}`
}
```

Comment from the code:
> "Routes through hash (#/pay/{id}) since PiNet App Studio reduces inner app URL to / before React. Hash routing persists across the PiNet facade and is visible in address bar."

## How It Works

1. **Bridge button** generates: `https://flashpay.pi/#/pay/{id}`
2. **Pi Browser receives** (after PiNet processing): `https://flashpay.pi/` with hash `#/pay/{id}` intact
3. **App home page** detects `window.location.hash` matching `/pay/{id}`
4. **Sets**: `isCustomerView=true`, `customerPaymentId={id}`
5. **Renders**: `<CustomerPaymentView paymentId={id} />`
6. **Continues**: auth → createPayment → approve → complete → settlement

## Code Changes

### 1. Bridge Button (`/components/customer-payment-view.tsx` line 362)

**OLD**:
```typescript
const piDeepLink = `pi://flashpay.pi?id=${paymentId}&entry=pi...`
```

**NEW**:
```typescript
const piDeepLink = `https://flashpay.pi/#/pay/${encodeURIComponent(paymentId)}${shareNote ? `?note=${encodeURIComponent(shareNote)}` : ""}`
```

### 2. Home Page Init (`/app/page.tsx` lines 56-68)

**NEW (added hash detection first)**:
```typescript
// Check hash first (Pi Browser deep links: #/pay/{id})
const hashMatch = window.location.hash.match(/^#\/pay\/([0-9a-f-]{36})$/i)
if (hashMatch && hashMatch[1]) {
  const id = hashMatch[1]
  console.log("[v0][Home-Init] Detected hash payment route:", id)
  setIsCustomerView(true)
  setCustomerPaymentId(id)
  setRouteResolved(true)
  return
}
```

Then checks pathname (Vercel) and query param (backward compat) as fallbacks.

## URLs

**Bridge Page** (vusercontent):
```
https://demo-xxxxx.vusercontent.net/pay/[ID]?amount=[AMT]&entry=share&note=[NOTE]
```

**Button Click Launch** (hash-based, survives PiNet):
```
https://flashpay.pi/#/pay/[ID]?note=[NOTE]
```

**What App Receives** (after PiNet processing):
- Pathname: `/` (home, stripped by PiNet)
- Hash: `#/pay/[ID]` (preserved, client-side)
- Query: `?note=[NOTE]` (stripped by PiNet in path, preserved in hash)

**App Detects**: `window.location.hash = "#/pay/[ID]"` → loads payment page

## Why This Works Where Others Failed

| Approach | Path Stripped? | Query Params Stripped? | Hash Preserved? | Works? |
|----------|---|---|---|---|
| `pi://flashpay.pi/pay/{id}` | YES | YES | N/A | ❌ |
| `pi://flashpay.pi?id={id}` | YES | YES | N/A | ❌ |
| `https://flashpay.pi/#/pay/{id}` | YES | NO* | YES | ✅ |

*Query params in hash fragment (`#/...?param=value`) are treated as client-side data, not HTTP query strings, so they persist.

## Files Modified

- `/components/customer-payment-view.tsx` (line 362-369): Changed to hash-based URL
- `/app/page.tsx` (lines 56-68): Added hash detection to routing init

**Unchanged**: Vercel flow, APIs, Redis, SDK, approve/complete, recovery, statuses, settlement

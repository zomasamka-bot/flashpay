# FlashPay Bridge Handoff - Root Cause & Fix

## Root Cause Analysis

**Problem**: Bridge button opened Pi Browser, but home page rendered instead of payment page.

**Why it happened**: Two conflicting URL patterns:
1. **Hash-based URL** (`https://flashpay.pi/#/pay/{id}`) - used by customer-payment-view.tsx
2. **Pathname-based URL** (`https://flashpay.pi/pay/{id}`) - expected by Next.js routing

When hash URL was visited:
- Next.js server-side routing sees `/#/pay/{id}` as pathname `/` (hashes are client-side only)
- Server routes to home page (`/app/page.tsx`)
- Home page renders merchant form, not payment page
- Hash-based routing logic in home page was too complex and unreliable

## Exact Values Before Fix

### File 1: `/components/customer-payment-view.tsx` (line 366)
**Before**:
```typescript
const piDeepLink = `https://flashpay.pi/#/pay/${encodeURIComponent(paymentId)}${shareNote ? `?note=${encodeURIComponent(shareNote)}` : ""}`
```
**URL Example**: `https://flashpay.pi/#/pay/550e8400-e29b-41d4-a716-446655440000?note=Test`

### File 2: `/app/pay/[id]/payment-content-with-id.tsx` (line 379)
**Before**:
```typescript
const piDeepLink = `https://flashpayaefebeff3375.pinet.com/#/pay/${paymentId}`
```
**URL Example**: `https://flashpayaefebeff3375.pinet.com/#/pay/550e8400-e29b-41d4-a716-446655440000`

**Issues with "before"**:
- Hash URL prevents Next.js routing
- Wrong domain in second file (pinet.com instead of flashpay.pi)
- No `entry=pi` query param to identify bridge context

## Exact Values After Fix

### File 1: `/components/customer-payment-view.tsx` (line 366)
**After**:
```typescript
const piDeepLink = `https://flashpay.pi/pay/${paymentId}?entry=pi${shareNote ? `&note=${encodeURIComponent(shareNote)}` : ""}`
```
**URL Example**: `https://flashpay.pi/pay/550e8400-e29b-41d4-a716-446655440000?entry=pi&note=Test`

### File 2: `/app/pay/[id]/payment-content-with-id.tsx` (line 379)
**After**:
```typescript
const piDeepLink = `https://flashpay.pi/pay/${paymentId}?entry=pi${urlNote ? `&note=${encodeURIComponent(urlNote)}` : ""}`
```
**URL Example**: `https://flashpay.pi/pay/550e8400-e29b-41d4-a716-446655440000?entry=pi&note=Test`

**Benefits of "after"**:
- Uses pathname `/pay/{id}` which Next.js server-side routing handles correctly
- Both files now use correct domain `flashpay.pi`
- Includes `entry=pi` query param so PaymentContentWithId knows it came from bridge (Pi Browser context)
- Note parameter preserved through handoff

## How the Fix Works

1. **Bridge page displays**: User on Vercel sees payment details with "Open in Pi Browser & Pay" button
2. **Button clicked**: Browser navigates to `https://flashpay.pi/pay/{id}?entry=pi&note={note}`
3. **Pi Browser loads URL**: App loads as registered app at flashpay.pi
4. **Next.js routing**: Server sees `/pay/{id}` pathname → renders `/app/pay/[id]/page.tsx`
5. **Route params passed**: Next.js extracts `id` from URL and `entry=pi` from search params
6. **PaymentContentWithId rendered**: Component receives `entry="pi"` and knows to show payment page (not bridge)
7. **Payment page loads**: Customer sees payment amount and Payment ID, ready to approve

## What Stays Unchanged

- ✅ Bridge page logic (Vercel direct link with amount, note, Payment ID display)
- ✅ QR code generation for bridge link
- ✅ Vercel flow and `/pay/[id]?entry=share` route
- ✅ Pi SDK, authentication, and Pi.authenticate()
- ✅ API routes (`/api/payments/`, approval, completion)
- ✅ Redis payment store
- ✅ Status transitions and settlement logic
- ✅ Recovery flows

## Code Changes Summary

| File | Line | Change |
|------|------|--------|
| `/components/customer-payment-view.tsx` | 366 | Hash URL → Pathname URL |
| `/app/pay/[id]/payment-content-with-id.tsx` | 379 | pinet.com + hash → flashpay.pi + pathname |

Both now use: `https://flashpay.pi/pay/{paymentId}?entry=pi`

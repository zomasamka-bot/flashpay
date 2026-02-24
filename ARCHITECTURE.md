# FlashPay Unified System Architecture

**Status: LOCKED 🔒**  
**Version: 1.0.0**

## Overview

FlashPay operates on a single unified operational system with no duplicated state or logic. This document defines the locked architecture that must be followed for all development.

---

## Core Principles

1. **Single Source of Truth**: `lib/payments-store.ts` is the ONLY place payment data exists
2. **Unified Operations**: ALL payment operations go through `lib/operations.ts`
3. **Real-time Sync**: Changes propagate instantly to all pages via subscription pattern
4. **No Local State**: Pages use hooks, never maintain their own payment state
5. **Unified Navigation**: ALL routing uses `lib/router.ts` definitions
6. **Comprehensive Guards**: Duplicate payments and double-payments are impossible

---

## System Components

### Data Layer
- **`lib/payments-store.ts`** - Persistent storage with localStorage, subscription pattern, atomic operations
- **`lib/types.ts`** - Shared TypeScript definitions

### Operational Layer
- **`lib/operations.ts`** - createPayment, executePayment, getPaymentById, getAllPayments, getPaymentStats
- **`lib/pi-sdk.ts`** - Pi Wallet integration for Testnet

### Presentation Layer
- **`lib/use-payments.ts`** - React hooks: usePayments(), usePayment(id), usePaymentStats()
- **`lib/router.ts`** - Route definitions and navigation helpers

### Core System
- **`lib/core.ts`** - System validation, unified logging, architecture enforcement

---

## Page Bindings (MANDATORY)

### Home (`app/page.tsx`)
- **Hook**: `usePaymentStats()`
- **Operations**: None (read-only dashboard)
- **Purpose**: Display statistics and feature highlights

### Create Payment (`app/create/page.tsx`)
- **Hook**: None
- **Operations**: `createPayment(amount, note)`
- **Navigation**: `router.push(getPaymentLink(payment.id))`
- **Purpose**: Generate new payment requests

### Public Payment (`app/pay/payment-content.tsx`)
- **Hook**: `usePayment(id)`
- **Operations**: `executePayment(id, onSuccess, onError)`, `isPaymentPaid(id)`
- **Navigation**: `getPaymentLink(id)` for URL generation
- **Purpose**: Display payment details, execute payments, show QR codes

### Payments List (`app/payments/page.tsx`)
- **Hook**: `usePayments()`
- **Operations**: None (read-only list)
- **Navigation**: `getPaymentLink(payment.id)` for each card
- **Purpose**: Show all payment requests with status

### Profile (`app/profile/page.tsx`)
- **Hook**: `usePaymentStats()`
- **Operations**: None (read-only statistics)
- **Purpose**: Display user statistics and merchant wallet connection

---

## Operational Guarantees

### Duplicate Prevention
- Payment IDs are unique (timestamp + random)
- Processing locks prevent concurrent creation
- Status checks block duplicate updates

### Double Payment Prevention
- `isPaymentPaid()` check before execution
- Atomic status updates in store
- Guard logs for all blocked operations

### Real-time Synchronization
- Subscription pattern notifies all listeners
- useEffect-based hooks re-render on changes
- No manual refresh required

### Error Handling
- All operations return `OperationResult<T>`
- Guards validate inputs before execution
- Comprehensive logging via `CoreLogger`

### Unified Logging
- `CoreLogger.info()` - General information
- `CoreLogger.warn()` - Warnings and edge cases
- `CoreLogger.error()` - Errors and failures
- `CoreLogger.operation()` - Operation tracking
- `CoreLogger.sync()` - Synchronization events
- `CoreLogger.guard()` - Security gate results

---

## Development Rules

### ✅ DO
- Use unified hooks for all payment data
- Call operations layer for all actions
- Use ROUTES constants for navigation
- Log important events via CoreLogger
- Validate inputs at operation boundaries

### ❌ DON'T
- Create local state for payment data
- Access paymentsStore directly from pages
- Duplicate business logic
- Use hardcoded routes or URLs
- Bypass the operations layer

---

## Testing the System

### Payment Flow Testing
1. Create a payment on /create
2. Verify instant appearance on /payments list
3. Open payment on /pay?id=xxx
4. Execute payment with Pi Wallet (Testnet)
5. Verify status updates across all pages
6. Attempt double payment (should be blocked)

### Synchronization Testing
1. Open /payments in one tab
2. Open a specific payment in another tab
3. Execute payment in second tab
4. Verify first tab updates without refresh

---

## System Health

Check system health with:

\`\`\`typescript
import { getSystemHealth } from '@/lib/core'

const health = getSystemHealth()
console.log(health)
// {
//   version: "1.0.0",
//   status: "LOCKED",
//   valid: true,
//   errors: [],
//   timestamp: "2025-01-06T..."
// }
\`\`\`

---

## Version History

- **v1.0.0** (2025-01-06) - Initial locked architecture
  - Unified data store
  - Operational control layer
  - Real-time synchronization
  - Unified router
  - Comprehensive logging
  - System health validation

---

**This architecture is LOCKED and should not be modified without understanding the full system impact.**

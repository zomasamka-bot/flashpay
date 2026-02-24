# FlashPay Security & Operations Documentation

## Overview

FlashPay implements a comprehensive security and operational layer that operates entirely within the unified system architecture. All security checks, error handling, and operational monitoring flow through centralized, audited systems.

## Security Components

### 1. Error Tracking System

**Purpose:** Centralized error tracking with unique tracking IDs for debugging and support.

**Features:**
- Automatic tracking ID generation for all errors
- Error history with timestamps and context
- Recent error retrieval for monitoring
- Integration with audit logging

**Usage:**
\`\`\`typescript
import { errorTracker } from "@/lib/security"

// Log an error
const trackingId = errorTracker.logError("operationName", "Error message", { details })

// Get recent errors
const errors = errorTracker.getRecentErrors(20)

// Find specific error
const error = errorTracker.getErrorById(trackingId)
\`\`\`

### 2. Rate Limiting

**Purpose:** Prevent abuse and ensure fair resource usage.

**Default Limits:**
- Create Payment: 10 attempts per minute
- Execute Payment: 5 attempts per minute

**Features:**
- Configurable time windows
- Automatic attempt tracking
- Graceful degradation
- Manual reset capability

**Usage:**
\`\`\`typescript
import { rateLimiter } from "@/lib/security"

const check = rateLimiter.check("operation_key", {
  maxAttempts: 10,
  windowMs: 60000
})

if (!check.allowed) {
  // Handle rate limit exceeded
}
\`\`\`

### 3. Input Validation

**Purpose:** Validate all user inputs before processing.

**Validators:**
- `validateAmount()` - Payment amount validation (0-1M Pi, max 7 decimals)
- `validateNote()` - Note text validation (max 500 chars)
- `validatePaymentId()` - Payment ID format validation

**Usage:**
\`\`\`typescript
import { InputValidator } from "@/lib/security"

const validation = InputValidator.validateAmount(amount)
if (!validation.valid) {
  return { error: validation.error }
}
\`\`\`

### 4. Security Guards

**Purpose:** Enforce security boundaries before operations execute.

**Guards:**
- **Wallet Check:** Verifies Pi SDK availability and wallet connection
- **Domain Check:** Ensures domain is enabled for the operation
- **Master Toggle Check:** Validates master control allows operations
- **Pre-Operation Check:** Comprehensive validation before any operation

**Usage:**
\`\`\`typescript
import { SecurityGuard } from "@/lib/security"

// Check wallet
const walletCheck = SecurityGuard.checkWallet()
if (!walletCheck.passed) {
  return { error: walletCheck.reason, trackingId: walletCheck.trackingId }
}

// Comprehensive pre-operation check
const check = SecurityGuard.preOperationCheck("createPayment", "flashpay")
if (!check.passed) {
  return { error: check.reason, trackingId: check.trackingId }
}
\`\`\`

### 5. Audit Logging

**Purpose:** Track all sensitive operations for compliance and debugging.

**Features:**
- Automatic tracking ID assignment
- Operation outcome tracking (success/failure)
- User ID association (when available)
- Searchable audit trail

**Usage:**
\`\`\`typescript
import { auditLogger } from "@/lib/security"

// Log an audit entry
const trackingId = auditLogger.log(
  "paymentCreated",
  { paymentId, amount },
  "success",
  userId
)

// Retrieve audit trail
const audits = auditLogger.getRecentAudits(50)
\`\`\`

### 6. System Monitoring

**Purpose:** Real-time operational health monitoring.

**Features:**
- System health checks (PASS/FAIL)
- Component status validation
- Error rate monitoring
- Metrics collection

**Usage:**
\`\`\`typescript
import { SystemMonitor } from "@/lib/security"

// Get system health
const health = SystemMonitor.getSystemHealth()

// Get operational status
const status = SystemMonitor.getOperationalStatus()
\`\`\`

## Operational Flags

All operational behavior is controlled through centralized flags:

\`\`\`typescript
export const OPERATIONAL_FLAGS = {
  TESTNET_ONLY: true,              // Enforce testnet mode
  REQUIRE_WALLET: true,             // Require Pi Wallet connection
  REQUIRE_DOMAIN_ENABLED: true,     // Check domain status
  REQUIRE_MASTER_ENABLED: false,    // Master toggle control
  ENABLE_RATE_LIMITING: true,       // Enable rate limits
  ENABLE_AUDIT_LOGGING: true,       // Enable audit trail
}
\`\`\`

## Error Handling Flow

### 1. React Error Boundary

Catches all React component errors and displays a friendly error screen with:
- Clear error message
- Tracking ID for support
- "Try Again" button
- "Go to Home" fallback

### 2. Operation-Level Errors

All operations return a consistent result structure:

\`\`\`typescript
interface OperationResult<T> {
  success: boolean
  data?: T
  error?: string
  trackingId?: string
}
\`\`\`

### 3. Error Display

Errors are displayed to users through:
- Toast notifications (non-critical)
- Error boundary screen (critical React errors)
- Inline validation messages (form errors)
- Service disabled screens (domain/access errors)

## Security Best Practices

### 1. No Local State for Security

All security checks go through the unified store and security layer. No page-level security logic is allowed.

### 2. Tracking IDs for Support

Every error and audit event gets a unique tracking ID that users can provide to support.

### 3. Centralized Validation

All validation logic is centralized in `InputValidator`. No duplicated validation across pages.

### 4. Rate Limiting by Default

All sensitive operations are rate-limited to prevent abuse.

### 5. Audit Everything

All sensitive operations (payment creation, status updates, domain changes) are automatically audited.

## Monitoring Dashboard

The Control Panel provides real-time monitoring:

1. **System Status** - Core version, SDK status, payment counts
2. **Security & Compliance** - Operational flags status
3. **System Health** - Component health checks and error tracking
4. **Domain Management** - Domain enable/disable controls
5. **Recent Errors** - Last 5 errors with tracking IDs
6. **System Logs** - Latest 50 operational events

## Compliance

### Testnet Mode

The `TESTNET_ONLY` flag enforces testnet operation:
- All payments are test transactions
- Real funds are never at risk
- Development-safe environment

### Data Privacy

- All data stored locally (localStorage)
- No external data transmission
- User controls all data (clear data function)

### Audit Trail

Complete audit trail of all operations:
- Who performed the action (when user system is active)
- What operation was performed
- When it occurred (timestamp)
- Outcome (success/failure)
- Unique tracking ID

## Integration with Unified System

The security layer is fully integrated with the unified system:

- **Unified Store:** All security state (wallet, domains) stored centrally
- **Unified Operations:** All operations flow through security checks
- **Unified Logging:** All security events logged to CoreLogger
- **Unified Router:** Domain access checks integrated into routing

## Status: Production Ready

The security and operational layer is production-ready with:
- ✅ Comprehensive error tracking
- ✅ Rate limiting protection
- ✅ Input validation
- ✅ Security boundaries
- ✅ Audit logging
- ✅ System monitoring
- ✅ Unified error handling
- ✅ Testnet compliance

All security functionality operates exclusively through the unified system with zero duplicated logic or local state.

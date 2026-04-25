# FlashPay Transfer System - Environment Setup Guide

## Required Environment Variables

Add these to your Vercel project settings under "Vars":

### Pi Network Configuration

**PI_API_KEY** (Required)
- Value: Your Pi Network Testnet API key
- Where to get: https://developers.minepi.com/dashboard
- Format: String (starts with "SK_" or similar)
- Used by: Transfer service for API authentication

```
PI_API_KEY=sk_testnet_your_api_key_here
```

**PI_WALLET_SEED** (Required)
- Value: Your Pi Network Testnet wallet seed
- Where to get: Pi Wallet Testnet backup
- Format: 12-word mnemonic or seed
- Used by: Wallet authentication (if needed)
- ⚠️ Keep this secret - never commit to code

```
PI_WALLET_SEED=word1 word2 word3 ... word12
```

### Database Configuration

**DATABASE_URL** (Required)
- Value: PostgreSQL connection string
- Where to get: Database provider (Neon, AWS, etc.)
- Format: `postgresql://user:password@host:port/database`
- Used by: All database operations
- ⚠️ Keep this secret - never commit to code

```
DATABASE_URL=postgresql://user:password@host:5432/flashpay_db
```

## Setup Instructions

### 1. Get Pi Network Testnet Credentials

**Step 1a: Create Pi Developer Account**
```
1. Visit https://developers.minepi.com
2. Sign up with your Pi account
3. Verify your email
```

**Step 1b: Create API Key**
```
1. Go to Dashboard
2. Click "Create API Key"
3. Name: "FlashPay Transfer System"
4. Select: Testnet
5. Copy the API key
6. Save to safe location
```

**Step 1c: Get Wallet Seed (Optional but Recommended)**
```
1. Open Pi Wallet
2. Go to Settings
3. Select "Backup Wallet"
4. Write down 12-word seed
5. Store safely (encrypted)
```

### 2. Set Up PostgreSQL Database

**Option A: Neon (Recommended)**
```
1. Visit https://neon.tech
2. Sign up (free tier available)
3. Create new project
4. Copy connection string: "DATABASE_URL"
5. Save to Vercel
```

**Option B: AWS RDS**
```
1. Create PostgreSQL RDS instance
2. Configure security groups
3. Get connection string
4. Format: postgresql://user:password@host:port/db
5. Save to Vercel
```

**Option C: Local Testing**
```
1. Install PostgreSQL locally
2. Create database: createdb flashpay
3. Connection: postgresql://localhost:5432/flashpay
4. Set DATABASE_URL environment variable
```

### 3. Add Environment Variables to Vercel

**Via Vercel Dashboard:**
```
1. Go to Vercel.com → Your Project
2. Settings → Environment Variables
3. Add PI_API_KEY
   - Name: PI_API_KEY
   - Value: your_testnet_api_key
   - Environments: Production, Preview, Development
4. Add PI_WALLET_SEED
   - Name: PI_WALLET_SEED
   - Value: your_wallet_seed_or_key
   - Environments: Production, Preview, Development
5. Add DATABASE_URL
   - Name: DATABASE_URL
   - Value: postgresql://...
   - Environments: Production, Preview, Development
6. Click "Save"
```

**Via CLI:**
```bash
vercel env add PI_API_KEY
# Paste your API key

vercel env add PI_WALLET_SEED
# Paste your wallet seed

vercel env add DATABASE_URL
# Paste your connection string
```

### 4. Verify Configuration

**Test in Local Development:**
```bash
# Check if env vars are loaded
console.log(process.env.PI_API_KEY ? 'PI_API_KEY: ✓' : 'PI_API_KEY: ✗')
console.log(process.env.DATABASE_URL ? 'DATABASE_URL: ✓' : 'DATABASE_URL: ✗')
```

**Test API Connection:**
```bash
# After deployment, test with:
curl https://your-app.vercel.app/api/transfers/process?merchantId=test
```

## Environment Variables Reference

| Variable | Required | Type | Example |
|----------|----------|------|---------|
| `PI_API_KEY` | Yes | String | `sk_testnet_...` |
| `PI_WALLET_SEED` | Yes* | String | `word1 word2 ...` |
| `DATABASE_URL` | Yes | String | `postgresql://...` |
| `NODE_ENV` | No | String | `production` |

*PI_WALLET_SEED may not be required depending on Pi API version

## Configuration Validation

### After Deployment

**1. Check Database Connection**
```sql
-- Connect to your database
SELECT EXISTS (
  SELECT FROM information_schema.tables 
  WHERE table_name = 'transfers'
) as transfers_table_exists;
```

Should return: `true`

**2. Test Transfer API**
```bash
curl -X GET "https://your-app.vercel.app/api/transfers/process?merchantId=test"
```

Expected response:
```json
{
  "transfers": [],
  "stats": { "total": 0, ... },
  "merchantId": "test"
}
```

**3. Test Export API**
```bash
curl "https://your-app.vercel.app/api/transfers/export?format=csv&merchantId=test"
```

Should return CSV headers

## Testnet to Mainnet Migration

### When Ready to Go Live:

**1. Get Mainnet Credentials**
```
1. Create Mainnet API key in Pi Developer Dashboard
2. Update PI_API_KEY to Mainnet key
3. Update PI_WALLET_SEED to Mainnet seed
```

**2. Update Environment Variables**
```
In Vercel Dashboard:
- Update PI_API_KEY to mainnet value
- Update PI_WALLET_SEED to mainnet value
- DATABASE_URL remains the same
- Redeploy application
```

**3. Verify Mainnet Connection**
```bash
# Test new endpoint
curl https://api.minepi.com/v2/wallet/transfers
# Should return 401 (authentication required)
```

## Security Best Practices

### DO ✅
- [x] Store secrets in Vercel environment variables
- [x] Use separate keys for Testnet and Mainnet
- [x] Rotate API keys regularly
- [x] Monitor API usage
- [x] Enable database backups
- [x] Use TLS/SSL for database connections
- [x] Limit database access by IP

### DON'T ❌
- [ ] Commit secrets to GitHub
- [ ] Share API keys via email
- [ ] Use same key for multiple environments
- [ ] Store seeds in logs
- [ ] Expose DATABASE_URL in frontend code
- [ ] Use weak database passwords
- [ ] Leave debug mode enabled in production

## Troubleshooting

### "DATABASE_URL is not configured"
**Solution:**
1. Check Vercel project settings
2. Verify variable name: `DATABASE_URL` (case-sensitive)
3. Ensure value includes full connection string
4. Redeploy application
5. Clear build cache

### "PI_API_KEY not configured"
**Solution:**
1. Check Vercel project settings
2. Verify variable name: `PI_API_KEY` (case-sensitive)
3. Ensure value is correct Testnet key
4. Test API key at https://developers.minepi.com
5. Redeploy application

### Database Connection Timeout
**Solution:**
1. Verify PostgreSQL is running
2. Check connection string format
3. Verify firewall allows connection
4. Test connection locally first
5. Check database credentials

### Transfer API Returning 500
**Solution:**
1. Check all environment variables set
2. Verify database connection
3. Check server logs for error details
4. Verify Pi API key validity
5. Check database has transfers table

## Local Development Setup

### 1. Clone Repository
```bash
git clone your-repo
cd flashpay
```

### 2. Install Dependencies
```bash
npm install
```

### 3. Create .env.local
```bash
# Copy example
cp .env.example .env.local

# Edit .env.local
PI_API_KEY=your_testnet_key
PI_WALLET_SEED=your_seed
DATABASE_URL=postgresql://localhost:5432/flashpay
NODE_ENV=development
```

### 4. Run Local Server
```bash
npm run dev
# App available at http://localhost:3000
```

### 5. Test Transfers
```bash
# Create test transfer
curl -X POST http://localhost:3000/api/transfers/process \
  -H "Content-Type: application/json" \
  -d '{
    "transactionId": "test-123",
    "merchantId": "merchant_test",
    "merchantAddress": "test_address",
    "amount": 10
  }'
```

## Monitoring Environment Variables

### In Production
```typescript
// Check what's configured (safe to log)
console.log('PI_API_KEY configured:', !!process.env.PI_API_KEY)
console.log('DATABASE_URL configured:', !!process.env.DATABASE_URL)
```

### Update Environment
1. Go to Vercel Dashboard
2. Project Settings → Environment Variables
3. Edit variable value
4. Click Save
5. Redeploy (automatic or manual)

### Verify After Update
1. Wait 5 minutes for propagation
2. Check application logs
3. Test API endpoint
4. Verify transfer functionality

## Support

### Common Issues
1. **Variables not applying?** → Clear browser cache, wait 5 min
2. **Connection refused?** → Check DATABASE_URL format
3. **Authentication failed?** → Verify API_KEY is current
4. **Transfer stuck?** → Check Pi API status dashboard

### Get Help
1. Check `/DEVELOPER_QUICK_REFERENCE.md`
2. Review `/TRANSFER_SYSTEM_COMPLETE.md`
3. Check server logs in Vercel Dashboard
4. Contact Pi Network support

---

**Setup Status:** Ready for Configuration  
**Last Updated:** 2024-04-19  
**Version:** 1.0.0

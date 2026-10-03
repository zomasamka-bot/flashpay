import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const complete = fs.readFileSync(path.join(root, 'app/api/pi/complete/route.ts'), 'utf8')
const card = fs.readFileSync(path.join(root, 'components/customer-refund-status-card.tsx'), 'utf8')
const hold = complete.indexOf('await recordDr11RefundCertificationHold({')
const completed = complete.indexOf('await recordSettlementU2ACompletedCheckpoint({')
const authority = complete.indexOf('await createDr11RefundAuthorityFromDurableHold(preFlashPaymentId)')
if (hold < 0 || completed < 0 || authority < 0 || !(hold < completed && completed < authority)) throw new Error('DR11 ordering invariant failed: hold must precede U2A completion, which must precede Refund authority conversion')
if (!card.includes('presentation.customerStatus === "refund_completed" ? "border-green-300 bg-green-50 text-green-800" : "border-red-300 bg-red-50 text-red-800"')) throw new Error('Refund customer warning terminal color binding missing')
if (!card.includes('t("refund.warningProcessing")') || !card.includes('"refund.warningCompleted" : "refund.warningProcessing"')) throw new Error('Refund customer warning copy binding missing')
for (const lang of ['ar','en','ru','vi','es','hi','zh']) {
  const dict = fs.readFileSync(path.join(root, `lib/i18n/dictionaries/${lang}.ts`), 'utf8')
  if (!dict.includes("'refund.warningProcessing':") || !dict.includes("'refund.warningCompleted':")) throw new Error(`Refund warning translations missing: ${lang}`)
}
console.log('DR11_REFUND_RACE_UI_BINDING=PASS order=hold_before_completed_before_refund_authority ui=red_until_terminal_green translations=7')

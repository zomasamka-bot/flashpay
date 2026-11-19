import type { Metadata } from "next"
import Link from "next/link"
import { UIMessage } from "@/components/ui-message"
import { Card, CardContent, CardHeader } from "@/components/ui/card"

export const metadata: Metadata = {
  title: "Terms of Service - FLASHpay",
  description: "FLASHpay Testnet terms of service",
  alternates: { canonical: "https://flashpay-two.vercel.app/terms" },
}

export default function TermsPage() {
  return (
    <article className="container max-w-3xl mx-auto px-4 py-8 md:py-12 break-words">
      <Card>
        <CardHeader>
          <h1 className="text-2xl md:text-3xl font-semibold"><UIMessage text={"Terms of Service"} /></h1>
          <p className="text-sm text-muted-foreground"><UIMessage text={"Last updated:"} /> <time dateTime="2026-11-19">2026-11-19</time></p>
          <p className="text-sm font-medium"><UIMessage text={"Testnet Only"} /></p>
        </CardHeader>
        <CardContent className="space-y-8">
            <section aria-labelledby="section-0" className="space-y-3">
              <h2 id="section-0" className="text-xl font-semibold"><UIMessage text={"Service and Testnet scope"} /></h2>
              <p className="text-muted-foreground leading-relaxed"><UIMessage text={"FLASHpay, operated by Hazem Abo Ria, helps merchants create QR and shareable payment requests, including remote or delivery-order requests, and view sales, receipts and exports. This deployment uses Test-Pi on Pi Testnet only, not Mainnet Pi or fiat money. Test-Pi has no monetary value. Use it for testing, not payment for real goods. FLASHpay is independent of Pi Network and is not a delivery service."} /></p>
            </section>

            <section aria-labelledby="section-1" className="space-y-3">
              <h2 id="section-1" className="text-xl font-semibold"><UIMessage text={"Payment and settlement"} /></h2>
              <p className="text-muted-foreground leading-relaxed"><UIMessage text={"The customer confirms a payment in Pi Wallet. Test-Pi first enters the application's wallet; a separate verified transfer settles the eligible amount to the merchant. FLASHpay operates this application-wallet transfer flow: it is not merely a request generator. Customer payment confirmation alone does not prove merchant settlement. Check the verified final status and receipt. Identity, amount, network and transaction checks remain required before execution."} /></p>
            </section>

            <section aria-labelledby="section-2" className="space-y-3">
              <h2 id="section-2" className="text-xl font-semibold"><UIMessage text={"Refunds and recovery"} /></h2>
              <p className="text-muted-foreground leading-relaxed"><UIMessage text={"An eligible unsettled payment may be refunded automatically to the original payer after verification. The same payment cannot both settle and be refunded through this recovery flow. A completed merchant settlement is not automatically reversible or refundable through unfinished-payment recovery. A refund is a separate blockchain transfer, not deletion of the original transfer. Pending operations are resumed when their checks and services permit; do not create a replacement payment when the result is unclear."} /></p>
            </section>

            <section aria-labelledby="section-3" className="space-y-3">
              <h2 id="section-3" className="text-xl font-semibold"><UIMessage text={"Fees"} /></h2>
              <p className="text-muted-foreground leading-relaxed"><UIMessage text={"The current Testnet application commission is zero. Network transaction fees are separate and may appear in Pi Wallet. Any future application commission must be disclosed before activation and charged to the merchant, not added as an application surcharge to the payer. Existing payment terms are not silently repriced. Mainnet activation and future fees require a separate announced change."} /></p>
            </section>

            <section aria-labelledby="section-4" className="space-y-3">
              <h2 id="section-4" className="text-xl font-semibold"><UIMessage text={"Accounts, wallets and merchant responsibility"} /></h2>
              <p className="text-muted-foreground leading-relaxed"><UIMessage text={"Sign in through Pi and protect your account. Check the merchant, amount and network before approving a payment. A saved public address supports balance display only; its displayed balance is not proof of ownership or permission to spend. Merchants remain responsible for their products, delivery arrangements and customer disputes. Share payment links, receipts and exports only with intended recipients."} /></p>
            </section>

            <section aria-labelledby="section-5" className="space-y-3">
              <h2 id="section-5" className="text-xl font-semibold"><UIMessage text={"Availability and safe use"} /></h2>
              <p className="text-muted-foreground leading-relaxed"><UIMessage text={"Completion times depend on verification, Pi services, the blockchain and supporting infrastructure; no fixed completion time or uninterrupted availability is promised. Recovery does not override safeguards. Keep the payment reference and contact support if a status remains unclear. Do not impersonate others, misuse data, attempt unauthorized access, bypass safeguards or use the service unlawfully. Access may be restricted to protect users and the service."} /></p>
            </section>

            <section aria-labelledby="section-6" className="space-y-3">
              <h2 id="section-6" className="text-xl font-semibold"><UIMessage text={"Changes, privacy and support"} /></h2>
              <p className="text-muted-foreground leading-relaxed"><UIMessage text={"By using FLASHpay, you accept these terms. If you disagree, stop initiating new payments and contact us about unresolved transactions. The Privacy Policy explains data handling. Updates will be published here with a revision date; material changes to network, fees or data use should be reviewed before further use. Nothing here excludes rights or responsibilities that applicable law does not allow to be excluded. Contact Hazem Abo Ria using the email below; include the payment reference, never wallet secrets."} /></p>
            </section>

            <section aria-labelledby="section-7" className="space-y-3">
              <h2 id="section-7" className="text-xl font-semibold"><UIMessage text={"Contact and updates"} /></h2>
              <p className="text-muted-foreground leading-relaxed"><UIMessage text={"For privacy requests or service questions, contact Hazem Abo Ria at the email below. Changes to these pages are published with their revision date."} /></p>
              <a className="inline-block break-all text-primary underline underline-offset-4" href="mailto:zoma_samka@yahoo.com"><bdi>zoma_samka@yahoo.com</bdi></a>
            </section>
          <footer className="flex flex-wrap gap-5 border-t pt-5 text-primary underline underline-offset-4">
            <Link href="/privacy"><UIMessage text={"Privacy Policy"} /></Link>
            <Link href="/"><UIMessage text={"Home"} /></Link>
          </footer>
        </CardContent>
      </Card>
    </article>
  )
}

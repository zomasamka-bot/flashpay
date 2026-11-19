import type { Metadata } from "next"
import Link from "next/link"
import { UIMessage } from "@/components/ui-message"
import { Card, CardContent, CardHeader } from "@/components/ui/card"

export const metadata: Metadata = {
  title: "Privacy Policy - FLASHpay",
  description: "FLASHpay Testnet privacy policy",
  alternates: { canonical: "https://flashpay-two.vercel.app/privacy" },
}

export default function PrivacyPage() {
  return (
    <article className="container max-w-3xl mx-auto px-4 py-8 md:py-12 break-words">
      <Card>
        <CardHeader>
          <h1 className="text-2xl md:text-3xl font-semibold"><UIMessage text={"Privacy Policy"} /></h1>
          <p className="text-sm text-muted-foreground"><UIMessage text={"Last updated:"} /> <time dateTime="2026-11-19">2026-11-19</time></p>
          <p className="text-sm font-medium"><UIMessage text={"Testnet Only"} /></p>
        </CardHeader>
        <CardContent className="space-y-8">
            <section aria-labelledby="section-0" className="space-y-3">
              <h2 id="section-0" className="text-xl font-semibold"><UIMessage text={"About this policy"} /></h2>
              <p className="text-muted-foreground leading-relaxed"><UIMessage text={"FLASHpay is operated by Hazem Abo Ria. This policy covers the current Testnet application, including payment requests, settlement, eligible refunds, receipts, merchant records and optional wallet-balance display. FLASHpay is an independent application, not Pi Network."} /></p>
            </section>

            <section aria-labelledby="section-1" className="space-y-3">
              <h2 id="section-1" className="text-xl font-semibold"><UIMessage text={"Information processed"} /></h2>
              <p className="text-muted-foreground leading-relaxed"><UIMessage text={"We process Pi user identifiers and usernames, authentication data, public wallet addresses, payment amounts, notes, status, timestamps, transaction identifiers, receipts and accounting and verification records. Support messages and technical logs may include information you provide, request details, IP addresses and browser or device information. Do not include sensitive information in payment notes."} /></p>
            </section>

            <section aria-labelledby="section-2" className="space-y-3">
              <h2 id="section-2" className="text-xl font-semibold"><UIMessage text={"Why we use information"} /></h2>
              <p className="text-muted-foreground leading-relaxed"><UIMessage text={"We use this information to authenticate users, associate payments with the correct payer and merchant, verify transfers, settle or refund eligible payments, maintain receipts and accounts, prevent duplicate execution, recover unfinished operations and investigate faults. An optional saved public address is associated with your Pi account and network to display its balance; it does not authorize transfers or change the payment recipient."} /></p>
            </section>

            <section aria-labelledby="section-3" className="space-y-3">
              <h2 id="section-3" className="text-xl font-semibold"><UIMessage text={"Browser storage and analytics"} /></h2>
              <p className="text-muted-foreground leading-relaxed"><UIMessage text={"The app uses browser storage for settings, language and payment continuity. Clearing browser data or signing out does not erase server records. Vercel Web Analytics processes page-view and device/browser data for usage statistics without third-party analytics cookies. Hosting and security services also process technical request information."} /></p>
            </section>

            <section aria-labelledby="section-4" className="space-y-3">
              <h2 id="section-4" className="text-xl font-semibold"><UIMessage text={"Sharing and public records"} /></h2>
              <p className="text-muted-foreground leading-relaxed"><UIMessage text={"Necessary data is processed by Pi Network and providers supporting hosting, databases, queues, verification and archives, including Vercel, Neon and Upstash. Providers may process data in other countries under their terms. Payment participants receive relevant transaction details. Blockchain addresses and transactions are public. Shared links, exported CSV files and receipts disclose their contents to recipients; anyone holding a temporary receipt-file link can access that file while the link is valid. We do not sell personal data."} /></p>
            </section>

            <section aria-labelledby="section-5" className="space-y-3">
              <h2 id="section-5" className="text-xl font-semibold"><UIMessage text={"Retention and archives"} /></h2>
              <p className="text-muted-foreground leading-relaxed"><UIMessage text={"Payment, accounting and verification records are retained while needed to establish rights, prevent duplicates, resolve unfinished operations and meet applicable obligations. Moving evidence to an archive is not deletion. Temporary receipt files expire after one hour; downloaded copies remain with their recipients. Other retention depends on the record's purpose, unresolved claims and operational policy. Completion, logout and Testnet use do not automatically delete records. Blockchain records cannot be erased by FLASHpay."} /></p>
            </section>

            <section aria-labelledby="section-6" className="space-y-3">
              <h2 id="section-6" className="text-xl font-semibold"><UIMessage text={"Your choices and security"} /></h2>
              <p className="text-muted-foreground leading-relaxed"><UIMessage text={"You may request access, correction or deletion using the contact below. We may verify your identity and explain any records that must remain for accounting, security, unresolved operations or applicable obligations. Additional rights depend on applicable law. We use access controls and protected connections, but cannot promise absolute security. FLASHpay does not ask for your personal wallet's private key or recovery phrase; never send them to support."} /></p>
            </section>

            <section aria-labelledby="section-7" className="space-y-3">
              <h2 id="section-7" className="text-xl font-semibold"><UIMessage text={"Contact and updates"} /></h2>
              <p className="text-muted-foreground leading-relaxed"><UIMessage text={"For privacy requests or service questions, contact Hazem Abo Ria at the email below. Changes to these pages are published with their revision date."} /></p>
              <a className="inline-block break-all text-primary underline underline-offset-4" href="mailto:zoma_samka@yahoo.com"><bdi>zoma_samka@yahoo.com</bdi></a>
            </section>
          <footer className="flex flex-wrap gap-5 border-t pt-5 text-primary underline underline-offset-4">
            <Link href="/terms"><UIMessage text={"Terms of Service"} /></Link>
            <Link href="/"><UIMessage text={"Home"} /></Link>
          </footer>
        </CardContent>
      </Card>
    </article>
  )
}

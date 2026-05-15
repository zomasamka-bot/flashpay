import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"

export const metadata = {
  title: "Privacy Policy - FlashPay",
  description: "FlashPay Privacy Policy",
}

export default function PrivacyPage() {
  return (
    <div className="min-h-screen bg-background">
      <div className="container max-w-3xl mx-auto px-4 py-8 md:py-12">
        <Card>
          <CardHeader>
            <CardTitle className="text-2xl md:text-3xl">Privacy Policy</CardTitle>
            <p className="text-sm text-muted-foreground">Last updated: {new Date().toLocaleDateString()}</p>
          </CardHeader>
          <CardContent className="space-y-6">
            <section>
              <h2 className="text-xl font-semibold mb-3">Introduction</h2>
              <p className="text-muted-foreground leading-relaxed">
                FlashPay is a payment request application built for the Pi Network Testnet environment. 
                This privacy policy explains how we handle your information when you use our service.
              </p>
            </section>

            <Separator />

            <section>
              <h2 className="text-xl font-semibold mb-3">Information We Collect</h2>
              <p className="text-muted-foreground leading-relaxed mb-3">
                FlashPay collects minimal information to provide payment request functionality:
              </p>
              <ul className="list-disc list-inside space-y-2 text-muted-foreground">
                <li>Pi Network username (provided by Pi SDK during authentication)</li>
                <li>Payment request details (amount, memo, status)</li>
                <li>Testnet transaction identifiers</li>
              </ul>
            </section>

            <Separator />

            <section>
              <h2 className="text-xl font-semibold mb-3">Data Storage and Security</h2>
              <p className="text-muted-foreground leading-relaxed mb-3">
                We take your privacy seriously:
              </p>
              <ul className="list-disc list-inside space-y-2 text-muted-foreground">
                <li>No sensitive personal data is stored</li>
                <li>No financial information is retained</li>
                <li>Payment data is stored temporarily for transaction processing only</li>
                <li>All data is encrypted in transit</li>
              </ul>
            </section>

            <Separator />

            <section>
              <h2 className="text-xl font-semibold mb-3">Data Sharing</h2>
              <p className="text-muted-foreground leading-relaxed">
                FlashPay does not share, sell, or distribute your data to third parties. 
                Your information is used solely for processing payment requests within the Pi Network ecosystem.
              </p>
            </section>

            <Separator />

            <section>
              <h2 className="text-xl font-semibold mb-3">Testnet Environment</h2>
              <p className="text-muted-foreground leading-relaxed">
                FlashPay operates exclusively on the Pi Network Testnet. This means:
              </p>
              <ul className="list-disc list-inside space-y-2 text-muted-foreground mt-3">
                <li>All transactions are for testing purposes only</li>
                <li>No real financial value is exchanged</li>
                <li>Data may be reset during testing phases</li>
                <li>Service availability is not guaranteed</li>
              </ul>
            </section>

            <Separator />

            <section>
              <h2 className="text-xl font-semibold mb-3">Your Rights</h2>
              <p className="text-muted-foreground leading-relaxed">
                You have the right to access, correct, or delete your payment request data at any time. 
                Since we collect minimal information and operate on a testnet, most data is ephemeral and 
                automatically cleared after transaction completion.
              </p>
            </section>

            <Separator />

            <section>
              <h2 className="text-xl font-semibold mb-3">Changes to This Policy</h2>
              <p className="text-muted-foreground leading-relaxed">
                We may update this privacy policy as FlashPay evolves. Any changes will be posted on this page 
                with an updated revision date.
              </p>
            </section>

            <Separator />

            <section>
              <h2 className="text-xl font-semibold mb-3">Contact</h2>
              <p className="text-muted-foreground leading-relaxed">
                For privacy-related questions or concerns about FlashPay, please contact us through the 
                Pi Network developer portal.
              </p>
            </section>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

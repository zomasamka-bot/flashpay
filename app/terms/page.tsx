import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
import { AlertCircle } from "lucide-react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"

export const metadata = {
  title: "Terms of Service - FlashPay",
  description: "FlashPay Terms of Service",
}

export default function TermsPage() {
  return (
    <div className="min-h-screen bg-background">
      <div className="container max-w-3xl mx-auto px-4 py-8 md:py-12">
        <Card>
          <CardHeader>
            <CardTitle className="text-2xl md:text-3xl">Terms of Service</CardTitle>
            <p className="text-sm text-muted-foreground">Last updated: {new Date().toLocaleDateString()}</p>
          </CardHeader>
          <CardContent className="space-y-6">
            <Alert>
              <AlertCircle className="h-4 w-4" />
              <AlertTitle>Testnet Only</AlertTitle>
              <AlertDescription>
                FlashPay operates exclusively on Pi Network Testnet for testing and development purposes only.
              </AlertDescription>
            </Alert>

            <section>
              <h2 className="text-xl font-semibold mb-3">Agreement to Terms</h2>
              <p className="text-muted-foreground leading-relaxed">
                By accessing and using FlashPay, you agree to be bound by these Terms of Service. 
                If you do not agree to these terms, please do not use the application.
              </p>
            </section>

            <Separator />

            <section>
              <h2 className="text-xl font-semibold mb-3">Testnet Environment</h2>
              <p className="text-muted-foreground leading-relaxed mb-3">
                FlashPay is provided for testing purposes only:
              </p>
              <ul className="list-disc list-inside space-y-2 text-muted-foreground">
                <li>All payments are executed on Pi Network Testnet</li>
                <li>No real financial value is transferred</li>
                <li>Service may be interrupted or discontinued at any time</li>
                <li>Data may be reset without notice during testing phases</li>
              </ul>
            </section>

            <Separator />

            <section>
              <h2 className="text-xl font-semibold mb-3">No Financial Guarantees</h2>
              <p className="text-muted-foreground leading-relaxed mb-3">
                FlashPay provides no warranties or guarantees regarding:
              </p>
              <ul className="list-disc list-inside space-y-2 text-muted-foreground">
                <li>Service availability or uptime</li>
                <li>Transaction completion or accuracy</li>
                <li>Data persistence or backup</li>
                <li>Future functionality or features</li>
              </ul>
              <p className="text-muted-foreground leading-relaxed mt-3">
                The service is provided "as is" without warranty of any kind, express or implied.
              </p>
            </section>

            <Separator />

            <section>
              <h2 className="text-xl font-semibold mb-3">User Responsibility</h2>
              <p className="text-muted-foreground leading-relaxed mb-3">
                As a user of FlashPay, you are responsible for:
              </p>
              <ul className="list-disc list-inside space-y-2 text-muted-foreground">
                <li>Understanding that this is a testnet application</li>
                <li>Using the service in compliance with Pi Network policies</li>
                <li>Maintaining the security of your Pi Browser and wallet</li>
                <li>Any payment requests you create or process</li>
                <li>Verifying payment details before confirming transactions</li>
              </ul>
            </section>

            <Separator />

            <section>
              <h2 className="text-xl font-semibold mb-3">No Custody of Funds</h2>
              <p className="text-muted-foreground leading-relaxed">
                FlashPay does not have custody of, control, or access to user funds. All payments are 
                processed directly through the Pi Network protocol. FlashPay only facilitates the creation 
                of payment requests and displays transaction status.
              </p>
            </section>

            <Separator />

            <section>
              <h2 className="text-xl font-semibold mb-3">Limitation of Liability</h2>
              <p className="text-muted-foreground leading-relaxed">
                To the maximum extent permitted by law, FlashPay and its developers shall not be liable for 
                any indirect, incidental, special, consequential, or punitive damages resulting from your use 
                or inability to use the service, even if advised of the possibility of such damages.
              </p>
            </section>

            <Separator />

            <section>
              <h2 className="text-xl font-semibold mb-3">Service Modifications</h2>
              <p className="text-muted-foreground leading-relaxed">
                We reserve the right to modify, suspend, or discontinue FlashPay at any time without notice. 
                We may also update these terms as needed, with changes taking effect upon posting.
              </p>
            </section>

            <Separator />

            <section>
              <h2 className="text-xl font-semibold mb-3">Prohibited Uses</h2>
              <p className="text-muted-foreground leading-relaxed mb-3">
                You may not use FlashPay to:
              </p>
              <ul className="list-disc list-inside space-y-2 text-muted-foreground">
                <li>Violate any laws or regulations</li>
                <li>Infringe on intellectual property rights</li>
                <li>Transmit malicious code or harmful content</li>
                <li>Attempt to gain unauthorized access to the system</li>
                <li>Interfere with other users' access to the service</li>
              </ul>
            </section>

            <Separator />

            <section>
              <h2 className="text-xl font-semibold mb-3">Governing Law</h2>
              <p className="text-muted-foreground leading-relaxed">
                These terms shall be governed by and construed in accordance with applicable laws, 
                without regard to conflict of law provisions.
              </p>
            </section>

            <Separator />

            <section>
              <h2 className="text-xl font-semibold mb-3">Contact</h2>
              <p className="text-muted-foreground leading-relaxed">
                For questions about these Terms of Service, please contact us through the Pi Network 
                developer portal.
              </p>
            </section>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

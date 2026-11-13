
import { UIMessage } from "@/components/ui-message"
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
            <CardTitle className="text-2xl md:text-3xl"> <UIMessage text={"Terms of Service"} /> </CardTitle>
            <p className="text-sm text-muted-foreground"> <UIMessage text={"Last updated:"} /> {new Date().toLocaleDateString()}</p>
          </CardHeader>
          <CardContent className="space-y-6">
            <Alert>
              <AlertCircle className="h-4 w-4" />
              <AlertTitle> <UIMessage text={"Testnet Only"} /> </AlertTitle>
              <AlertDescription> <UIMessage text={"FlashPay operates exclusively on Pi Network Testnet for testing and development purposes only."} /> </AlertDescription>
            </Alert>

            <section>
              <h2 className="text-xl font-semibold mb-3"> <UIMessage text={"Agreement to Terms"} /> </h2>
              <p className="text-muted-foreground leading-relaxed"> <UIMessage text={"By accessing and using FlashPay, you agree to be bound by these Terms of Service. If you do not agree to these terms, please do not use the application."} /> </p>
            </section>

            <Separator />

            <section>
              <h2 className="text-xl font-semibold mb-3"> <UIMessage text={"Testnet Environment"} /> </h2>
              <p className="text-muted-foreground leading-relaxed mb-3"> <UIMessage text={"FlashPay is provided for testing purposes only:"} /> </p>
              <ul className="list-disc list-inside space-y-2 text-muted-foreground">
                <li> <UIMessage text={"All payments are executed on Pi Network Testnet"} /> </li>
                <li> <UIMessage text={"No real financial value is transferred"} /> </li>
                <li> <UIMessage text={"Service may be interrupted or discontinued at any time"} /> </li>
                <li> <UIMessage text={"Data may be reset without notice during testing phases"} /> </li>
              </ul>
            </section>

            <Separator />

            <section>
              <h2 className="text-xl font-semibold mb-3"> <UIMessage text={"No Financial Guarantees"} /> </h2>
              <p className="text-muted-foreground leading-relaxed mb-3"> <UIMessage text={"FlashPay provides no warranties or guarantees regarding:"} /> </p>
              <ul className="list-disc list-inside space-y-2 text-muted-foreground">
                <li> <UIMessage text={"Service availability or uptime"} /> </li>
                <li> <UIMessage text={"Transaction completion or accuracy"} /> </li>
                <li> <UIMessage text={"Data persistence or backup"} /> </li>
                <li> <UIMessage text={"Future functionality or features"} /> </li>
              </ul>
              <p className="text-muted-foreground leading-relaxed mt-3"> <UIMessage text={"The service is provided \"as is\" without warranty of any kind, express or implied."} /> </p>
            </section>

            <Separator />

            <section>
              <h2 className="text-xl font-semibold mb-3"> <UIMessage text={"User Responsibility"} /> </h2>
              <p className="text-muted-foreground leading-relaxed mb-3"> <UIMessage text={"As a user of FlashPay, you are responsible for:"} /> </p>
              <ul className="list-disc list-inside space-y-2 text-muted-foreground">
                <li> <UIMessage text={"Understanding that this is a testnet application"} /> </li>
                <li> <UIMessage text={"Using the service in compliance with Pi Network policies"} /> </li>
                <li> <UIMessage text={"Maintaining the security of your Pi Browser and wallet"} /> </li>
                <li> <UIMessage text={"Any payment requests you create or process"} /> </li>
                <li> <UIMessage text={"Verifying payment details before confirming transactions"} /> </li>
              </ul>
            </section>

            <Separator />

            <section>
              <h2 className="text-xl font-semibold mb-3"> <UIMessage text={"No Custody of Funds"} /> </h2>
              <p className="text-muted-foreground leading-relaxed"> <UIMessage text={"FlashPay does not have custody of, control, or access to user funds. All payments are processed directly through the Pi Network protocol. FlashPay only facilitates the creation of payment requests and displays transaction status."} /> </p>
            </section>

            <Separator />

            <section>
              <h2 className="text-xl font-semibold mb-3"> <UIMessage text={"Limitation of Liability"} /> </h2>
              <p className="text-muted-foreground leading-relaxed"> <UIMessage text={"To the maximum extent permitted by law, FlashPay and its developers shall not be liable for any indirect, incidental, special, consequential, or punitive damages resulting from your use or inability to use the service, even if advised of the possibility of such damages."} /> </p>
            </section>

            <Separator />

            <section>
              <h2 className="text-xl font-semibold mb-3"> <UIMessage text={"Service Modifications"} /> </h2>
              <p className="text-muted-foreground leading-relaxed"> <UIMessage text={"We reserve the right to modify, suspend, or discontinue FlashPay at any time without notice. We may also update these terms as needed, with changes taking effect upon posting."} /> </p>
            </section>

            <Separator />

            <section>
              <h2 className="text-xl font-semibold mb-3"> <UIMessage text={"Prohibited Uses"} /> </h2>
              <p className="text-muted-foreground leading-relaxed mb-3"> <UIMessage text={"You may not use FlashPay to:"} /> </p>
              <ul className="list-disc list-inside space-y-2 text-muted-foreground">
                <li> <UIMessage text={"Violate any laws or regulations"} /> </li>
                <li> <UIMessage text={"Infringe on intellectual property rights"} /> </li>
                <li> <UIMessage text={"Transmit malicious code or harmful content"} /> </li>
                <li> <UIMessage text={"Attempt to gain unauthorized access to the system"} /> </li>
                <li> <UIMessage text={"Interfere with other users' access to the service"} /> </li>
              </ul>
            </section>

            <Separator />

            <section>
              <h2 className="text-xl font-semibold mb-3"> <UIMessage text={"Governing Law"} /> </h2>
              <p className="text-muted-foreground leading-relaxed"> <UIMessage text={"These terms shall be governed by and construed in accordance with applicable laws, without regard to conflict of law provisions."} /> </p>
            </section>

            <Separator />

            <section>
              <h2 className="text-xl font-semibold mb-3"> <UIMessage text={"Contact"} /> </h2>
              <p className="text-muted-foreground leading-relaxed"> <UIMessage text={"For questions about these Terms of Service, please contact us through the Pi Network developer portal."} /> </p>
            </section>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

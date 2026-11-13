
import { UIMessage } from "@/components/ui-message"
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
            <CardTitle className="text-2xl md:text-3xl"> <UIMessage text={"Privacy Policy"} /> </CardTitle>
            <p className="text-sm text-muted-foreground"> <UIMessage text={"Last updated:"} /> {new Date().toLocaleDateString()}</p>
          </CardHeader>
          <CardContent className="space-y-6">
            <section>
              <h2 className="text-xl font-semibold mb-3"> <UIMessage text={"Introduction"} /> </h2>
              <p className="text-muted-foreground leading-relaxed"> <UIMessage text={"FlashPay is a payment request application built for the Pi Network Testnet environment. This privacy policy explains how we handle your information when you use our service."} /> </p>
            </section>

            <Separator />

            <section>
              <h2 className="text-xl font-semibold mb-3"> <UIMessage text={"Information We Collect"} /> </h2>
              <p className="text-muted-foreground leading-relaxed mb-3"> <UIMessage text={"FlashPay collects minimal information to provide payment request functionality:"} /> </p>
              <ul className="list-disc list-inside space-y-2 text-muted-foreground">
                <li> <UIMessage text={"Pi Network username (provided by Pi SDK during authentication)"} /> </li>
                <li> <UIMessage text={"Payment request details (amount, memo, status)"} /> </li>
                <li> <UIMessage text={"Testnet transaction identifiers"} /> </li>
              </ul>
            </section>

            <Separator />

            <section>
              <h2 className="text-xl font-semibold mb-3"> <UIMessage text={"Data Storage and Security"} /> </h2>
              <p className="text-muted-foreground leading-relaxed mb-3"> <UIMessage text={"We take your privacy seriously:"} /> </p>
              <ul className="list-disc list-inside space-y-2 text-muted-foreground">
                <li> <UIMessage text={"No sensitive personal data is stored"} /> </li>
                <li> <UIMessage text={"No financial information is retained"} /> </li>
                <li> <UIMessage text={"Payment data is stored temporarily for transaction processing only"} /> </li>
                <li> <UIMessage text={"All data is encrypted in transit"} /> </li>
              </ul>
            </section>

            <Separator />

            <section>
              <h2 className="text-xl font-semibold mb-3"> <UIMessage text={"Data Sharing"} /> </h2>
              <p className="text-muted-foreground leading-relaxed"> <UIMessage text={"FlashPay does not share, sell, or distribute your data to third parties. Your information is used solely for processing payment requests within the Pi Network ecosystem."} /> </p>
            </section>

            <Separator />

            <section>
              <h2 className="text-xl font-semibold mb-3"> <UIMessage text={"Testnet Environment"} /> </h2>
              <p className="text-muted-foreground leading-relaxed"> <UIMessage text={"FlashPay operates exclusively on the Pi Network Testnet. This means:"} /> </p>
              <ul className="list-disc list-inside space-y-2 text-muted-foreground mt-3">
                <li> <UIMessage text={"All transactions are for testing purposes only"} /> </li>
                <li> <UIMessage text={"No real financial value is exchanged"} /> </li>
                <li> <UIMessage text={"Data may be reset during testing phases"} /> </li>
                <li> <UIMessage text={"Service availability is not guaranteed"} /> </li>
              </ul>
            </section>

            <Separator />

            <section>
              <h2 className="text-xl font-semibold mb-3"> <UIMessage text={"Your Rights"} /> </h2>
              <p className="text-muted-foreground leading-relaxed"> <UIMessage text={"You have the right to access, correct, or delete your payment request data at any time. Since we collect minimal information and operate on a testnet, most data is ephemeral and automatically cleared after transaction completion."} /> </p>
            </section>

            <Separator />

            <section>
              <h2 className="text-xl font-semibold mb-3"> <UIMessage text={"Changes to This Policy"} /> </h2>
              <p className="text-muted-foreground leading-relaxed"> <UIMessage text={"We may update this privacy policy as FlashPay evolves. Any changes will be posted on this page with an updated revision date."} /> </p>
            </section>

            <Separator />

            <section>
              <h2 className="text-xl font-semibold mb-3"> <UIMessage text={"Contact"} /> </h2>
              <p className="text-muted-foreground leading-relaxed"> <UIMessage text={"For privacy-related questions or concerns about FlashPay, please contact us through the Pi Network developer portal."} /> </p>
            </section>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

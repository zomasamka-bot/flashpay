
import { UIMessage } from "@/components/ui-message"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { AlertCircle } from "lucide-react"

export default function NotFound() {
  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-gradient-to-br from-destructive/5 via-background to-destructive/10">
      <Card className="max-w-md w-full">
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-full bg-destructive/10 flex items-center justify-center">
              <AlertCircle className="h-5 w-5 text-destructive" />
            </div>
            <CardTitle> <UIMessage text={"Page Not Found"} /> </CardTitle>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-muted-foreground"> <UIMessage text={"The page you're looking for doesn't exist or has been moved."} /> </p>
          <Link href="/">
            <Button className="w-full"> <UIMessage text={"Go Back Home"} /> </Button>
          </Link>
        </CardContent>
      </Card>
    </div>
  )
}

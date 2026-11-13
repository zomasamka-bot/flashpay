"use client"
import { useI18n } from "@/components/i18n-provider"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import Link from "next/link"
export default function DomainsPage() {
  const { locale } = useI18n()
  const arabic = locale === "ar"
  return <div className="mx-auto max-w-4xl p-4"><Card>
    <CardHeader><CardTitle>{arabic ? "التحكم في النطاقات متوقف" : "Domain controls suspended"}</CardTitle></CardHeader>
    <CardContent className="space-y-4">
      <p>{arabic ? "تفعيل وتعطيل النطاقات متوقفان بطلب المالك. التطبيق الحالي وخدمات الدفع لم تتغير. يمكن إعادة إتاحة هذه الميزة في إصدار لاحق." : "Domain activation and deactivation are suspended at the owner's request. The current application and payment services are unchanged. This feature can be restored in a later release."}</p>
      <Link href="/operations" className="inline-flex min-h-11 items-center text-primary underline">{arabic ? "العودة إلى التشغيل" : "Back to Operations"}</Link>
    </CardContent>
  </Card></div>
}

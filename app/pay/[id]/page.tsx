import PaymentContentWithId from "./payment-content-with-id"

export default async function PaymentPageWithId({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ amount?: string; note?: string }>
}) {
  const { id } = await params
  const { amount, note } = await searchParams

  return <PaymentContentWithId paymentId={id} urlAmount={amount} urlNote={note} />
}

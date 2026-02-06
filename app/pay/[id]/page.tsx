import PaymentContentWithId from "./payment-content-with-id"

export default async function PaymentPageWithId({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params

  return <PaymentContentWithId paymentId={id} />
}

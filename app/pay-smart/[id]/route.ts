import { redirect } from 'next/navigation';

export async function GET(
  request: Request,
  { params }: { params: { id: string } }
) {
  const { id } = params;
  const url = new URL(request.url);
  const amount = url.searchParams.get('amount') || '';
  const note = url.searchParams.get('note') || '';

  // Detect if request is from Pi Browser by checking User-Agent
  const userAgent = request.headers.get('user-agent') || '';
  const isPiBrowser = userAgent.toLowerCase().includes('pibrowser') || 
                      userAgent.toLowerCase().includes('pi browser');

  // Build query parameters
  let queryParams = `amount=${amount}&entry=pi`;
  if (note) {
    queryParams += `&note=${note}`;
  }

  if (isPiBrowser) {
    // Redirect to pinet.com for Pi Browser
    redirect(`https://flashpayaefebeff3375.pinet.com/pay/${id}?${queryParams}`);
  } else {
    // Redirect to Vercel for normal browsers
    redirect(`https://flashpay-two.vercel.app/pay/${id}?${queryParams}`);
  }
}

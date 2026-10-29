import { NextResponse } from 'next/server';

import { apiDownload } from '@/lib/api';

/**
 * Streams a product's signed revocation list from the API to the operator's browser. Like a licence
 * file it is signed, not secret, and never cached: the next one may name more licences.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ product: string }> },
): Promise<NextResponse> {
  const { product } = await params;
  if (!/^[a-z][a-z0-9-]{1,31}$/.test(product))
    return new NextResponse('Not found', { status: 404 });
  const upstream = await apiDownload(`/admin/products/${product}/revocation-list`);
  if (!upstream.ok)
    return new NextResponse('The revocation list could not be downloaded.', {
      status: upstream.status,
    });
  return new NextResponse(await upstream.text(), {
    status: 200,
    headers: {
      'content-type': 'application/x-munaxa-revocation-list',
      'content-disposition':
        upstream.headers.get('content-disposition') ??
        `attachment; filename="${product}-revocations.mxr"`,
      'cache-control': 'no-store',
    },
  });
}

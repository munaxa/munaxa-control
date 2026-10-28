import { NextResponse } from 'next/server';

import { apiDownload } from '@/lib/api';

/**
 * Streams a licence file from the API to the operator's browser. The file carries no secret — it is
 * signed, not encrypted — but it is bearer material for an installation, so it is never cached.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return new NextResponse('Not found', { status: 404 });
  const upstream = await apiDownload(`/admin/licences/${id}/download`);
  if (!upstream.ok)
    return new NextResponse('The licence could not be downloaded.', { status: upstream.status });
  return new NextResponse(await upstream.text(), {
    status: 200,
    headers: {
      'content-type': 'application/x-munaxa-license',
      'content-disposition':
        upstream.headers.get('content-disposition') ?? `attachment; filename="${id}.license"`,
      'cache-control': 'no-store',
    },
  });
}

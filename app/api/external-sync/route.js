import { NextResponse } from 'next/server';
import { matchesBearerToken } from '../../../lib/bearer-auth.mjs';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const SYNC_URL = 'https://trackerforchaos.vercel.app/api/sync';

export async function POST(request) {
  const externalSecret = process.env.EXTERNAL_SYNC_SECRET;
  if (!matchesBearerToken(request.headers.get('authorization'), externalSecret)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json({ error: 'sync unavailable' }, { status: 503 });
  }

  try {
    const response = await fetch(SYNC_URL, {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + cronSecret,
        accept: 'application/json',
      },
      cache: 'no-store',
      signal: AbortSignal.timeout(55_000),
    });

    const body = await response.text();
    return new Response(body, {
      status: response.status,
      headers: {
        'content-type': response.headers.get('content-type') || 'application/json',
        'cache-control': 'no-store',
      },
    });
  } catch {
    return NextResponse.json({ error: 'sync forwarding failed' }, { status: 502 });
  }
}

/** What became of a World ID attempt — polled by the page that started it. */

import { NextResponse } from "next/server";

import { getResult } from "../../../../lib/world/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const id = new URL(req.url).searchParams.get("id") ?? "";
  const r = await getResult(id);
  if (!r) return NextResponse.json({ error: "Unknown attempt." }, { status: 404 });
  return NextResponse.json(r);
}

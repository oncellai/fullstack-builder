import { NextRequest, NextResponse } from "next/server";
import { getCellId } from "@/lib/oncell";

export async function GET(req: NextRequest) {
  const session_id = req.nextUrl.searchParams.get("session_id");
  if (!session_id) {
    return NextResponse.json({ error: "session_id required" }, { status: 400 });
  }

  try {
    const cellId = getCellId();
    const url = `https://${cellId}.cells.oncell.ai/preview-${session_id}.html`;
    const res = await fetch(url);
    if (!res.ok) {
      return NextResponse.json({ error: `Preview not found (${res.status})` }, { status: 404 });
    }
    const html = await res.text();
    return new Response(html, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

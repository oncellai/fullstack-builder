import { NextRequest, NextResponse } from "next/server";
import { getOnCell, getCellId } from "@/lib/oncell";

export async function POST(req: NextRequest) {
  try {
    const { prompt, session_id } = await req.json();
    if (!prompt?.trim()) {
      return NextResponse.json({ error: "prompt is required" }, { status: 400 });
    }

    const oncell = getOnCell();
    const cellId = getCellId();

    const result = await oncell.cells.request<{
      session_id: string;
      name: string;
      description: string;
      files: { path: string; bytes: number }[];
      file_count: number;
      error?: string;
    }>(cellId, "build", { prompt: prompt.trim(), session_id: session_id || null });

    if (result.error) {
      return NextResponse.json({ error: result.error }, { status: 500 });
    }

    return NextResponse.json(result);
  } catch (err: any) {
    console.error("build error:", err.message);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

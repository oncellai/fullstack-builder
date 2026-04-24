import { NextRequest, NextResponse } from "next/server";
import { getOnCell, getCellId } from "@/lib/oncell";

export async function GET(req: NextRequest) {
  const session_id = req.nextUrl.searchParams.get("session_id");
  if (!session_id) {
    return NextResponse.json({ error: "session_id required" }, { status: 400 });
  }

  try {
    const oncell = getOnCell();
    const cellId = getCellId();

    const result = await oncell.cells.request<{
      session_id: string;
      name: string;
      description: string;
      files: { path: string; bytes: number }[];
      built_at: string;
      error?: string;
    }>(cellId, "list_files", { session_id });

    if (result.error) {
      return NextResponse.json({ error: result.error }, { status: 404 });
    }

    return NextResponse.json(result);
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

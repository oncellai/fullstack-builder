import { NextRequest, NextResponse } from "next/server";
import { getOnCell, getCellId } from "@/lib/oncell";

export async function GET(req: NextRequest) {
  const session_id = req.nextUrl.searchParams.get("session_id");
  const path = req.nextUrl.searchParams.get("path");

  if (!session_id || !path) {
    return NextResponse.json({ error: "session_id and path required" }, { status: 400 });
  }

  try {
    const oncell = getOnCell();
    const cellId = getCellId();

    const result = await oncell.cells.request<{
      path: string;
      content: string;
      bytes: number;
      error?: string;
    }>(cellId, "read_file", { session_id, path });

    if (result.error) {
      return NextResponse.json({ error: result.error }, { status: 404 });
    }

    return NextResponse.json(result);
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const { session_id, path, instruction } = await req.json();
    if (!session_id || !path || !instruction) {
      return NextResponse.json({ error: "session_id, path, and instruction required" }, { status: 400 });
    }

    const oncell = getOnCell();
    const cellId = getCellId();

    const result = await oncell.cells.request<{
      path: string;
      updated: boolean;
      bytes: number;
      error?: string;
    }>(cellId, "update_file", { session_id, path, instruction });

    if (result.error) {
      return NextResponse.json({ error: result.error }, { status: 500 });
    }

    return NextResponse.json(result);
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

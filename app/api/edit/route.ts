import { NextRequest } from "next/server";
import { getOnCell, getCellId } from "@/lib/oncell";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const { session_id, instruction } = await req.json();
  if (!session_id || !instruction) {
    return Response.json({ error: "session_id and instruction are required" }, { status: 400 });
  }

  try {
    const oncell = getOnCell();
    const cellId = getCellId();
    const result = await oncell.cells.request(cellId, "edit", { session_id, instruction });
    return Response.json(result);
  } catch (err: any) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}

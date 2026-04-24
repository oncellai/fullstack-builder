import { NextRequest } from "next/server";
import { getOnCell, getCellId } from "@/lib/oncell";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const { session_id } = await req.json();
  if (!session_id) {
    return Response.json({ error: "session_id is required" }, { status: 400 });
  }

  try {
    const oncell = getOnCell();
    const cellId = getCellId();
    const result = await oncell.cells.request(cellId, "run", { session_id, cell_id: cellId });
    return Response.json(result);
  } catch (err: any) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}

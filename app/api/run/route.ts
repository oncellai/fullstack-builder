import { NextRequest } from "next/server";
import { getOnCell, getCellId } from "@/lib/oncell";
import { readFileSync } from "fs";
import { join } from "path";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const { session_id } = await req.json();
  if (!session_id) {
    return Response.json({ error: "session_id is required" }, { status: 400 });
  }

  try {
    const oncell = getOnCell();
    const builderCellId = getCellId();

    // Export all files + metadata from builder cell
    const exported = await oncell.cells.request<{
      session_id: string;
      files: { path: string; content: string }[];
      meta: any;
      error?: string;
    }>(builderCellId, "export_session", { session_id });

    if (exported.error) {
      return Response.json({ error: exported.error }, { status: 400 });
    }

    // Create a dedicated project cell with the same agent
    const agentCode = readFileSync(join(process.cwd(), "lib/agent-raw.js"), "utf-8");
    const projectCell = await oncell.cells.create({
      customerId: `project-${session_id}-${Date.now()}`,
      tier: "starter",
      permanent: true,
      agent: agentCode,
      secrets: {
        OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY || "",
        LLM_MODEL: process.env.LLM_MODEL || "google/gemini-2.5-flash",
      },
    });

    const projectCellId = projectCell.id;

    // Deploy files to project cell
    await oncell.cells.request(projectCellId, "deploy", {
      session_id,
      files: exported.files,
      meta: exported.meta,
    });

    // Start the app on the project cell
    const result = await oncell.cells.request<any>(projectCellId, "run", {
      session_id,
      cell_id: projectCellId,
    });

    return Response.json({ ...result, cell_id: projectCellId });
  } catch (err: any) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}

import { NextRequest } from "next/server";
import { getOnCell, getCellId } from "@/lib/oncell";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const { prompt, session_id } = await req.json();

  if (!prompt?.trim()) {
    return new Response(JSON.stringify({ error: "prompt is required" }), { status: 400 });
  }

  const oncell = getOnCell();
  const cellId = getCellId();
  const encoder = new TextEncoder();

  const sseStream = new ReadableStream({
    async start(controller) {
      const emit = (data: object) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));

      try {
        emit({ type: "status", message: "Generating your app..." });

        // Kick off async build in the cell
        const start = await oncell.cells.request<{ session_id: string; error?: string }>(
          cellId, "build", { prompt: prompt.trim(), session_id: session_id || null }
        );
        if (start.error) { emit({ type: "error", error: start.error }); return; }

        const sid = start.session_id;
        let seen = 0;

        // Poll build_progress — files arrive one-by-one as the LLM generates them
        while (true) {
          const progress = await oncell.cells.request<{
            status: string;
            files: { path: string; bytes: number; content?: string }[];
            done: boolean;
            error?: string;
            name?: string;
            description?: string;
            total: number;
          }>(cellId, "build_progress", { session_id: sid, seen });

          for (const file of progress.files) {
            emit({ type: "file", file });
            seen++;
          }

          if (progress.done) {
            if (progress.status === "error") {
              emit({ type: "error", error: progress.error || "Build failed" });
            } else {
              emit({
                type: "done",
                session_id: sid,
                name: progress.name || "app",
                description: progress.description || "",
                file_count: seen,
              });
            }
            return;
          }

          await new Promise((r) => setTimeout(r, 400));
        }
      } catch (err: any) {
        emit({ type: "error", error: err.message });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(sseStream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  });
}

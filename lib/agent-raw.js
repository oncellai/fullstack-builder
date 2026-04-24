// oncell-fullstack-builder — AI agent that generates fullstack Next.js + Node.js apps
// Runs inside an OnCell cell. Files persist in ctx.store across sessions.

module.exports = {
  async setup(ctx) {
    if (!ctx.store.exists("index.html")) {
      ctx.store.write("index.html", PLAYGROUND_HTML());
    }
  },

  // Generate a complete fullstack app from a prompt
  async build(ctx, params) {
    const { prompt, session_id } = params;
    if (!prompt) return { error: "prompt is required" };

    const sid = session_id || `session-${Date.now()}`;

    // 1. Generate app plan + all files via LLM
    const systemPrompt = `You are an expert fullstack developer. Given a description, generate a complete working app.

Output ONLY valid JSON (no markdown, no explanation) in this exact shape:
{
  "name": "short-app-name",
  "description": "one-line description of the app",
  "files": [
    { "path": "frontend/package.json", "content": "..." },
    { "path": "frontend/next.config.js", "content": "..." },
    { "path": "frontend/tailwind.config.js", "content": "..." },
    { "path": "frontend/app/globals.css", "content": "..." },
    { "path": "frontend/app/layout.tsx", "content": "..." },
    { "path": "frontend/app/page.tsx", "content": "..." },
    { "path": "backend/package.json", "content": "..." },
    { "path": "backend/server.js", "content": "..." }
  ]
}

Rules:
- Frontend: Next.js 14 App Router, TypeScript, Tailwind CSS. Run on port 3000.
- Backend: Express.js, in-memory storage (no database). Run on port 4000.
- Frontend calls backend via fetch("http://localhost:4000/api/...").
- Backend sets CORS headers: Access-Control-Allow-Origin: *.
- Keep code clean, complete, and runnable with just npm install && npm run dev.
- Dark UI with a clean minimal design.
- Include all files needed to run both apps.
- The frontend/package.json must include: "dev": "next dev", "build": "next build", "start": "next start".
- The backend/package.json must include: "start": "node server.js", "dev": "node --watch server.js". Set "type": "module" for ESM.`;

    let rawResponse;
    try {
      rawResponse = await callLLM([
        { role: "system", content: systemPrompt },
        { role: "user",   content: `Build this app: ${prompt}` },
      ]);
    } catch (err) {
      return { error: `LLM call failed: ${err.message}` };
    }

    // Parse JSON — try full response first, then extract from code block
    let parsed;
    try {
      const jsonStr = extractJSON(rawResponse);
      parsed = JSON.parse(jsonStr);
    } catch (err) {
      return { error: `Failed to parse LLM response: ${err.message}`, raw: rawResponse.slice(0, 500) };
    }

    if (!parsed.files || !Array.isArray(parsed.files)) {
      return { error: "LLM response missing files array" };
    }

    // Write all generated files to storage
    const written = [];
    for (const file of parsed.files) {
      if (!file.path || file.content == null) continue;
      const storePath = `sessions/${sid}/${file.path}`;
      ctx.store.write(storePath, file.content);
      written.push({ path: file.path, bytes: file.content.length });
    }

    // Persist build metadata
    ctx.db.set(`build:${sid}`, {
      session_id: sid,
      prompt,
      name: parsed.name || "app",
      description: parsed.description || "",
      files: written.map(f => f.path),
      built_at: new Date().toISOString(),
    });

    return {
      session_id: sid,
      name: parsed.name || "app",
      description: parsed.description || "",
      files: written,
      file_count: written.length,
    };
  },

  // List files and metadata for a session
  async list_files(ctx, params) {
    const { session_id } = params;
    if (!session_id) return { error: "session_id is required" };

    const meta = ctx.db.get(`build:${session_id}`);
    if (!meta) return { error: "Session not found", session_id };

    const files = (meta.files || []).map(path => ({
      path,
      bytes: ctx.store.read(`sessions/${session_id}/${path}`)?.length || 0,
    }));

    return { ...meta, files };
  },

  // Read a single file
  async read_file(ctx, params) {
    const { session_id, path } = params;
    if (!session_id || !path) return { error: "session_id and path are required" };

    const content = ctx.store.read(`sessions/${session_id}/${path}`);
    if (content == null) return { error: "File not found", path };

    return { path, content, bytes: content.length };
  },

  // Update a file based on a natural language instruction
  async update_file(ctx, params) {
    const { session_id, path, instruction } = params;
    if (!session_id || !path || !instruction) {
      return { error: "session_id, path, and instruction are required" };
    }

    const current = ctx.store.read(`sessions/${session_id}/${path}`);
    if (current == null) return { error: "File not found", path };

    let updated;
    try {
      updated = await callLLM([
        {
          role: "system",
          content: "You are an expert developer. Modify the given file based on the instruction. Return ONLY the complete updated file content — no explanation, no markdown code fences.",
        },
        {
          role: "user",
          content: `File: ${path}\n\nCurrent content:\n${current}\n\nInstruction: ${instruction}`,
        },
      ]);
    } catch (err) {
      return { error: `LLM call failed: ${err.message}` };
    }

    ctx.store.write(`sessions/${session_id}/${path}`, updated.trim());

    // Update build metadata
    const meta = ctx.db.get(`build:${session_id}`) || {};
    meta.updated_at = new Date().toISOString();
    ctx.db.set(`build:${session_id}`, meta);

    return { path, updated: true, bytes: updated.length };
  },

  // List all sessions
  async list_sessions(ctx) {
    // Scan db for all build: keys — use a prefix scan via stored index
    const sessions = ctx.db.get("sessions:index") || [];
    const result = [];
    for (const sid of sessions) {
      const meta = ctx.db.get(`build:${sid}`);
      if (meta) result.push({ session_id: sid, name: meta.name, description: meta.description, built_at: meta.built_at });
    }
    return { sessions: result };
  },
};

// ─── Helpers ────────────────────────────────────────────────────────────────

async function callLLM(messages) {
  const model = process.env.LLM_MODEL || "google/gemini-2.5-flash";
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model, messages, temperature: 0.2, max_tokens: 16384 }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status}: ${text.slice(0, 200)}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content || "";
}

function extractJSON(text) {
  // Try raw parse first
  try { JSON.parse(text); return text; } catch {}
  // Strip markdown code fence
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) return fenced[1].trim();
  // Extract outermost { ... }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end !== -1) return text.slice(start, end + 1);
  throw new Error("No JSON found in response");
}

function PLAYGROUND_HTML() {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Fullstack Builder — OnCell Playground</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:system-ui,sans-serif;background:#0a0a0a;color:#e8e4de;min-height:100vh;display:flex;flex-direction:column}
header{padding:16px 24px;border-bottom:1px solid rgba(255,255,255,0.06);display:flex;align-items:center;gap:10px}
header span{font-size:14px;font-weight:500}header small{font-size:11px;color:rgba(232,228,222,0.3)}
main{flex:1;padding:32px 24px;max-width:700px;margin:0 auto;width:100%}
h2{font-size:18px;font-weight:400;margin-bottom:24px;color:rgba(232,228,222,0.7)}
form{display:flex;gap:8px;margin-bottom:24px}
textarea{flex:1;padding:12px 14px;border-radius:10px;border:1px solid rgba(255,255,255,0.08);background:rgba(255,255,255,0.03);color:#e8e4de;font-size:14px;outline:none;resize:vertical;min-height:80px;font-family:inherit}
textarea:focus{border-color:rgba(212,165,74,0.4)}
button{padding:12px 20px;border-radius:10px;border:none;background:#d4a54a;color:#0a0a0a;font-size:14px;font-weight:600;cursor:pointer;align-self:flex-end}
button:disabled{opacity:0.4;cursor:not-allowed}
#status{font-size:13px;color:rgba(212,165,74,0.7);margin-bottom:16px;font-family:monospace}
#files{display:none}
#files h3{font-size:13px;color:rgba(232,228,222,0.4);margin-bottom:10px;letter-spacing:.06em;text-transform:uppercase}
.file{display:flex;justify-content:space-between;align-items:center;padding:10px 14px;border-radius:8px;border:1px solid rgba(255,255,255,0.06);margin-bottom:6px;background:rgba(255,255,255,0.02)}
.file-path{font-family:monospace;font-size:13px;color:#e8e4de}
.file-bytes{font-family:monospace;font-size:11px;color:rgba(232,228,222,0.3)}
@keyframes fadeIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
.fade{animation:fadeIn .4s ease}
</style></head>
<body>
<header>
<svg width="16" height="16" viewBox="0 0 32 32" fill="none"><rect x="4" y="4" width="24" height="24" rx="6" stroke="#d4a54a" stroke-width="1.5" fill="none"/><circle cx="16" cy="16" r="3.5" fill="#d4a54a"/></svg>
<span>Fullstack Builder</span><small>Playground · OnCell</small>
</header>
<main>
<h2>Describe the app you want to build.</h2>
<form id="f">
<textarea id="prompt" placeholder="e.g. A todo app with categories and due dates" rows="3"></textarea>
<button type="submit" id="btn">Build →</button>
</form>
<div id="status"></div>
<div id="files"><h3>Generated Files</h3><div id="file-list"></div></div>
</main>
<script>
var sid = null;
document.getElementById("f").onsubmit = async function(e) {
  e.preventDefault();
  var prompt = document.getElementById("prompt").value.trim();
  if (!prompt) return;
  var btn = document.getElementById("btn"), status = document.getElementById("status");
  btn.disabled = true;
  status.textContent = "Building... this takes 10-20 seconds";
  document.getElementById("files").style.display = "none";
  try {
    var res = await fetch("/request", {method:"POST",headers:{"Content-Type":"application/json"},
      body: JSON.stringify({method:"build",params:{prompt,session_id:null}})});
    var data = await res.json();
    if (data.error) { status.textContent = "Error: " + data.error; return; }
    sid = data.session_id;
    status.textContent = "✓ " + data.file_count + " files generated — " + data.description;
    var list = document.getElementById("file-list"); list.innerHTML = "";
    data.files.forEach(function(f) {
      var d = document.createElement("div"); d.className = "file fade";
      d.innerHTML = '<span class="file-path">'+f.path+'</span><span class="file-bytes">'+f.bytes+' bytes</span>';
      list.appendChild(d);
    });
    document.getElementById("files").style.display = "block";
  } catch(err) { status.textContent = "Error: " + err.message; }
  btn.disabled = false;
};
</script>
</body></html>`;
}

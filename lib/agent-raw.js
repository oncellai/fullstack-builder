// oncell-fullstack-builder — AI agent that generates and runs fullstack Next.js + Node.js apps
// Runs inside an OnCell cell. Files persist in ctx.store across sessions.

const { spawn } = require("child_process");
const { exec } = require("child_process");
const { promisify } = require("util");
const fs = require("fs");
const path = require("path");

const execAsync = promisify(exec);

module.exports = {
  async setup(ctx) {
    const exists = await ctx.store.exists("index.html");
    if (!exists) {
      await ctx.store.write("index.html", PLAYGROUND_HTML());
    }
  },

  // Start build async — returns immediately. Poll build_progress for results.
  async build(ctx, params) {
    const { prompt, session_id } = params;
    if (!prompt) return { error: "prompt is required" };

    const sid = session_id || `session-${Date.now()}`;

    const systemPrompt = `You are an expert fullstack developer. Given a description, generate a complete working app.

Output ONLY valid JSON (no markdown, no explanation) in this exact shape:
{
  "name": "short-app-name",
  "description": "one-line description of the app",
  "files": [
    { "path": "frontend/package.json", "content": "..." },
    { "path": "frontend/next.config.js", "content": "..." },
    { "path": "frontend/app/globals.css", "content": "..." },
    { "path": "frontend/app/layout.tsx", "content": "..." },
    { "path": "frontend/app/page.tsx", "content": "..." },
    { "path": "backend/package.json", "content": "..." },
    { "path": "backend/server.js", "content": "..." }
  ]
}

Rules:
- Frontend: Next.js 14 App Router, TypeScript, Tailwind CSS (via CDN in globals.css). Run on port 3000.
- Backend: Express.js, in-memory storage (no database). Run on port 4000.
- Frontend calls backend via fetch("/backend/api/...") — ALWAYS use this relative prefix, never localhost.
- The frontend/next.config.js MUST include rewrites to proxy /backend/* to http://localhost:4000:
  module.exports = { async rewrites() { return [{ source: '/backend/:path*', destination: 'http://localhost:4000/:path*' }] } }
- Backend sets CORS headers: Access-Control-Allow-Origin: *.
- Backend routes use /api/ prefix (e.g. GET /api/todos). Do NOT add /backend prefix on the backend.
- Dark UI with a clean minimal design.
- Include all files needed to run both apps.
- The frontend/package.json must include: "dev": "next dev", "build": "next build", "start": "next start".
- The backend/package.json must include: "start": "node server.js", "dev": "node --watch server.js". Set "type": "module" for ESM.
- Do NOT generate Next.js API routes (no app/api/ directory in frontend).`;

    // Seed progress record so polling can start immediately
    await ctx.db.set(`bp:${sid}`, { status: "generating", files: [], done: false });

    // Fire-and-forget: stream LLM, push files into DB as they complete
    (async () => {
      try {
        let fullText = "";
        const seenPaths = new Set();

        for await (const token of callLLMStream([
          { role: "system", content: systemPrompt },
          { role: "user", content: `Build this app: ${prompt}` },
        ])) {
          fullText += token;

          for (const file of extractNewFiles(fullText, seenPaths)) {
            await ctx.store.write(`sessions/${sid}/${file.path}`, file.content);
            seenPaths.add(file.path);
            const prog = await ctx.db.get(`bp:${sid}`);
            prog.files.push({ path: file.path, bytes: file.content.length, content: file.content });
            await ctx.db.set(`bp:${sid}`, prog);
          }
        }

        // Final parse for name/description + catch any files missed by the regex
        let name = "app", description = "";
        try {
          const parsed = JSON.parse(repairJSON(extractJSON(fullText)));
          name = parsed.name || "app";
          description = parsed.description || "";
          if (Array.isArray(parsed.files)) {
            for (const file of parsed.files) {
              if (file.path && file.content != null && !seenPaths.has(file.path)) {
                await ctx.store.write(`sessions/${sid}/${file.path}`, file.content);
                seenPaths.add(file.path);
                const prog = await ctx.db.get(`bp:${sid}`);
                prog.files.push({ path: file.path, bytes: file.content.length, content: file.content });
                await ctx.db.set(`bp:${sid}`, prog);
              }
            }
          }
        } catch (_) {}

        const prog = await ctx.db.get(`bp:${sid}`);
        await ctx.db.set(`build:${sid}`, {
          session_id: sid, prompt, name, description,
          files: prog.files.map(f => f.path),
          built_at: new Date().toISOString(),
        });
        prog.done = true;
        prog.status = "done";
        prog.name = name;
        prog.description = description;
        await ctx.db.set(`bp:${sid}`, prog);

      } catch (err) {
        const prog = (await ctx.db.get(`bp:${sid}`)) || {};
        prog.done = true;
        prog.status = "error";
        prog.error = err.message;
        await ctx.db.set(`bp:${sid}`, prog);
      }
    })();

    return { session_id: sid, started: true };
  },

  // Poll this to get files as they appear
  async build_progress(ctx, params) {
    const { session_id, seen = 0 } = params;
    if (!session_id) return { error: "session_id is required" };
    const prog = await ctx.db.get(`bp:${session_id}`);
    if (!prog) return { status: "not_started", files: [], done: false, total: 0 };
    return {
      status: prog.status,
      files: (prog.files || []).slice(seen),
      done: prog.done || false,
      error: prog.error,
      name: prog.name,
      description: prog.description,
      total: (prog.files || []).length,
    };
  },

  // Start the generated app inside the cell (fire-and-forget — poll run_status)
  async run(ctx, params) {
    const { session_id } = params;
    if (!session_id) return { error: "session_id is required" };

    const meta = await ctx.db.get(`build:${session_id}`);
    if (!meta) return { error: "Session not found", session_id };

    const cellId = params.cell_id || ctx.id || process.env.ONCELL_CELL_ID || "unknown";
    const previewUrl = `https://${cellId}.cells.oncell.ai`;
    const appPort = parseInt(process.env.CELL_APP_PORT || "3000");

    // Already running?
    const existing = await ctx.db.get(`run:${session_id}`);
    if (existing && existing.status === "running") {
      return { already_running: true, preview_url: previewUrl };
    }

    await ctx.db.set(`run:${session_id}`, { status: "installing", started_at: new Date().toISOString(), preview_url: previewUrl });

    const workDir = path.join("/tmp", "apps", session_id);
    const logPath = path.join(workDir, "run.log");

    const appendLog = (msg) => {
      try { fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${msg}\n`); } catch {}
    };

    // Write all source files to the cell's filesystem
    fs.mkdirSync(workDir, { recursive: true });
    for (const filePath of meta.files) {
      const content = await ctx.store.read(`sessions/${session_id}/${filePath}`);
      if (content == null) continue;
      const fullPath = path.join(workDir, filePath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, content);
    }

    const frontendDir = path.join(workDir, "frontend");
    const backendDir = path.join(workDir, "backend");

    // Run installs and start servers in background (non-blocking)
    (async () => {
      try {
        appendLog("Starting npm install in backend...");
        await execAsync("npm install --loglevel error 2>&1", { cwd: backendDir });
        appendLog("Backend install done. Starting frontend install...");
        await execAsync("npm install --loglevel error 2>&1", { cwd: frontendDir });
        appendLog("Frontend install done.");

        await ctx.db.set(`run:${session_id}`, { status: "starting", preview_url: previewUrl });

        // Start backend on port 4000
        const backendLog = fs.openSync(path.join(workDir, "backend.log"), "a");
        spawn("node", ["server.js"], {
          cwd: backendDir,
          detached: true,
          stdio: ["ignore", backendLog, backendLog],
          env: { ...process.env, PORT: "4000" },
        }).unref();
        appendLog("Backend spawned on port 4000.");

        // Start Next.js dev server on CELL_APP_PORT (unique per cell, set by OnCell runtime)
        const frontendLog = fs.openSync(path.join(workDir, "frontend.log"), "a");
        spawn("npm", ["run", "dev", "--", "--port", String(appPort)], {
          cwd: frontendDir,
          detached: true,
          stdio: ["ignore", frontendLog, frontendLog],
          env: { ...process.env, PORT: String(appPort), HOSTNAME: "0.0.0.0" },
        }).unref();
        appendLog(`Next.js dev spawned on port ${appPort}. Polling for readiness...`);

        // Poll until Next.js is ready (first compile can take 60s+)
        const deadline = Date.now() + 3 * 60 * 1000;
        let ready = false;
        while (Date.now() < deadline) {
          await new Promise(r => setTimeout(r, 3000));
          try {
            const res = await fetch(`http://localhost:${appPort}`, { signal: AbortSignal.timeout(2000) });
            if (res.ok || res.status < 500) { ready = true; break; }
          } catch {}
        }

        appendLog(ready ? `Port ${appPort} is up — marking running.` : `Timed out waiting for port ${appPort}.`);
        await ctx.db.set(`run:${session_id}`, {
          status: ready ? "running" : "error",
          error: ready ? undefined : "Next.js did not start within 3 minutes — check logs",
          preview_url: previewUrl,
          started_at: new Date().toISOString(),
        });
      } catch (err) {
        appendLog(`Error: ${err.message}`);
        await ctx.db.set(`run:${session_id}`, { status: "error", error: err.message, preview_url: previewUrl });
      }
    })();

    return { started: true, session_id, preview_url: previewUrl };
  },

  // Poll this to check if the app is running
  async run_status(ctx, params) {
    const { session_id } = params;
    if (!session_id) return { error: "session_id is required" };
    const info = await ctx.db.get(`run:${session_id}`);
    if (!info) return { status: "not_started" };
    return info;
  },

  // Return recent run logs for debugging
  async run_logs(ctx, params) {
    const { session_id } = params;
    if (!session_id) return { error: "session_id is required" };
    const logPath = path.join("/tmp", "apps", session_id, "run.log");
    const frontendLogPath = path.join("/tmp", "apps", session_id, "frontend.log");
    try {
      const runLog = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf-8") : "(no run.log)";
      const frontendLog = fs.existsSync(frontendLogPath)
        ? fs.readFileSync(frontendLogPath, "utf-8").slice(-4000)
        : "(no frontend.log)";
      return { run_log: runLog, frontend_log: frontendLog };
    } catch (err) {
      return { error: err.message };
    }
  },

  // Debug: run a shell command
  async shell(ctx, params) {
    const { cmd } = params;
    if (!cmd) return { error: "cmd is required" };
    try {
      const { stdout, stderr } = await execAsync(cmd, { timeout: 30000 });
      return { stdout, stderr };
    } catch (err) {
      return { error: err.message, stdout: err.stdout, stderr: err.stderr };
    }
  },

  // List files and metadata for a session
  async list_files(ctx, params) {
    const { session_id } = params;
    if (!session_id) return { error: "session_id is required" };

    const meta = await ctx.db.get(`build:${session_id}`);
    if (!meta) return { error: "Session not found", session_id };

    const files = await Promise.all((meta.files || []).map(async filePath => ({
      path: filePath,
      bytes: (await ctx.store.read(`sessions/${session_id}/${filePath}`))?.length || 0,
    })));

    return { ...meta, files };
  },

  // Read a single file
  async read_file(ctx, params) {
    const { session_id, path: filePath } = params;
    if (!session_id || !filePath) return { error: "session_id and path are required" };

    const content = await ctx.store.read(`sessions/${session_id}/${filePath}`);
    if (content == null) return { error: "File not found", path: filePath };

    return { path: filePath, content, bytes: content.length };
  },

  // Update a file based on a natural language instruction
  async update_file(ctx, params) {
    const { session_id, path: filePath, instruction } = params;
    if (!session_id || !filePath || !instruction) {
      return { error: "session_id, path, and instruction are required" };
    }

    const current = await ctx.store.read(`sessions/${session_id}/${filePath}`);
    if (current == null) return { error: "File not found", path: filePath };

    let updated;
    try {
      updated = await callLLM([
        {
          role: "system",
          content: "You are an expert developer. Modify the given file based on the instruction. Return ONLY the complete updated file content — no explanation, no markdown code fences.",
        },
        {
          role: "user",
          content: `File: ${filePath}\n\nCurrent content:\n${current}\n\nInstruction: ${instruction}`,
        },
      ]);
    } catch (err) {
      return { error: `LLM call failed: ${err.message}` };
    }

    await ctx.store.write(`sessions/${session_id}/${filePath}`, updated.trim());

    const meta = (await ctx.db.get(`build:${session_id}`)) || {};
    meta.updated_at = new Date().toISOString();
    await ctx.db.set(`build:${session_id}`, meta);

    return { path: filePath, updated: true, bytes: updated.length };
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

async function* callLLMStream(messages) {
  const model = process.env.LLM_MODEL || "google/gemini-2.5-flash";
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model, messages, temperature: 0.2, max_tokens: 16384, stream: true }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status}: ${text.slice(0, 200)}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6).trim();
      if (data === "[DONE]") return;
      try {
        const parsed = JSON.parse(data);
        const token = parsed.choices?.[0]?.delta?.content;
        if (token) yield token;
      } catch {}
    }
  }
}

// Extract complete file entries from a partial JSON stream.
// Matches {"path":"...","content":"..."} as soon as each one is complete.
function extractNewFiles(text, alreadyEmitted) {
  const files = [];
  const re = /"path"\s*:\s*"([^"]+)"\s*,\s*"content"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  let match;
  while ((match = re.exec(text)) !== null) {
    const filePath = match[1];
    if (alreadyEmitted.has(filePath)) continue;
    let content;
    try { content = JSON.parse(`"${match[2]}"`); } catch { continue; }
    files.push({ path: filePath, content });
  }
  return files;
}

function extractJSON(text) {
  let str;
  try { JSON.parse(text); return text; } catch {}
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) { str = fenced[1].trim(); }
  else {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start !== -1 && end !== -1) str = text.slice(start, end + 1);
    else throw new Error("No JSON found in response");
  }
  // Try raw first, then repair invalid escape sequences
  try { JSON.parse(str); return str; } catch {}
  return repairJSON(str);
}

// Fix invalid JSON escape sequences produced by LLMs (e.g. \d, \s, \w in regex patterns)
function repairJSON(str) {
  const validEscapes = new Set(['"', '\\', '/', 'b', 'f', 'n', 'r', 't', 'u']);
  let result = '';
  let inString = false;
  let i = 0;
  while (i < str.length) {
    const c = str[i];
    if (inString) {
      if (c === '\\') {
        const next = str[i + 1];
        if (next === undefined) { result += c; break; }
        if (validEscapes.has(next)) {
          // Valid escape — keep as-is; skip extra 4 hex digits for \uXXXX
          result += c + next;
          i += 2;
          if (next === 'u') { result += str.slice(i, i + 4); i += 4; }
        } else if (next === '\n' || next === '\r') {
          // Bare backslash before a real newline — just skip the backslash
          i += 1;
        } else {
          // Invalid escape — double the backslash
          result += '\\\\' + next;
          i += 2;
        }
        continue;
      } else if (c === '"') {
        inString = false;
      } else if (c === '\n') {
        result += '\\n'; i++; continue;
      } else if (c === '\r') {
        result += '\\r'; i++; continue;
      }
    } else if (c === '"') {
      inString = true;
    }
    result += c;
    i++;
  }
  return result;
}

function PLAYGROUND_HTML() {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Fullstack Builder — OnCell</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:system-ui,sans-serif;background:#0a0a0a;color:#e8e4de;display:flex;align-items:center;justify-content:center;min-height:100vh}
.box{text-align:center}.h1{font-size:18px;font-weight:500;margin-bottom:8px}.p{color:rgba(232,228,222,0.5);font-size:13px}</style></head>
<body><div class="box"><div class="h1">Fullstack Builder</div><div class="p">Use the builder UI to generate and run apps.</div></div></body></html>`;
}

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
  // 3-phase: Plan → Generate (parallel) → Verify+Fix
  async build(ctx, params) {
    const { prompt, session_id } = params;
    if (!prompt) return { error: "prompt is required" };
    const sid = session_id || `session-${Date.now()}`;

    await ctx.db.set(`bp:${sid}`, { status: "planning", files: [], done: false });

    (async () => {
      try {
        // ── Phase 1: Plan ───────────────────────────────────────────────────
        const plan = await planApp(prompt);

        await ctx.db.set(`bp:${sid}`, { status: "generating", files: [], done: false });

        // ── Phase 2: Generate files in dependency order ─────────────────────
        const written = new Map(); // filePath -> content

        // Mutex: serialize DB read-modify-write to prevent parallel clobber
        let dbMutex = Promise.resolve();
        const publishFile = async (filePath, content) => {
          written.set(filePath, content);
          await ctx.store.write(`sessions/${sid}/${filePath}`, content);
          dbMutex = dbMutex.then(async () => {
            const prog = await ctx.db.get(`bp:${sid}`);
            prog.files.push({ path: filePath, bytes: content.length, content });
            await ctx.db.set(`bp:${sid}`, prog);
          });
          await dbMutex;
        };

        await executeFiles(plan.files, plan, prompt, publishFile);

        // ── Phase 3: Verify + auto-fix ──────────────────────────────────────
        await verifyAndFix(written, sid, ctx);

        // ── Done ────────────────────────────────────────────────────────────
        const prog = await ctx.db.get(`bp:${sid}`);
        await ctx.db.set(`build:${sid}`, {
          session_id: sid, prompt,
          name: plan.name, description: plan.description,
          files: prog.files.map(f => f.path),
          built_at: new Date().toISOString(),
        });
        prog.done = true;
        prog.status = "done";
        prog.name = plan.name;
        prog.description = plan.description;
        await ctx.db.set(`bp:${sid}`, prog);

      } catch (err) {
        const prog = (await ctx.db.get(`bp:${sid}`)) || {};
        prog.done = true; prog.status = "error"; prog.error = err.message;
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

  // Edit the whole app based on a natural language instruction
  async edit(ctx, params) {
    const { session_id, instruction } = params;
    if (!session_id || !instruction) return { error: "session_id and instruction are required" };

    const meta = await ctx.db.get(`build:${session_id}`);
    if (!meta) return { error: "session not found" };

    // Load all current files (truncate very large ones to keep context manageable)
    const currentFiles = [];
    for (const filePath of meta.files || []) {
      try {
        const content = await ctx.store.read(`sessions/${session_id}/${filePath}`);
        if (content != null) currentFiles.push({ path: filePath, content: content.slice(0, 4000) });
      } catch {}
    }

    const filesContext = currentFiles.map(f => `=== ${f.path} ===\n${f.content}`).join("\n\n");

    let response;
    try {
      response = await callLLM([
        {
          role: "system",
          content: "You are an expert fullstack developer. Apply the requested change to the app. Return ONLY valid JSON with only the files that need to change. Return complete file contents. Do not include unchanged files.",
        },
        {
          role: "user",
          content: `Apply this change: "${instruction}"\n\nCurrent files:\n${filesContext}\n\nOutput JSON: {"files":[{"path":"...","content":"..."}]}`,
        },
      ]);
    } catch (err) {
      return { error: `LLM failed: ${err.message}` };
    }

    let updated;
    try { updated = JSON.parse(extractJSON(response)); } catch (err) { return { error: `Parse failed: ${err.message}` }; }

    const updatedFiles = [];
    for (const file of (updated.files || [])) {
      if (!file.path || file.content == null) continue;
      await ctx.store.write(`sessions/${session_id}/${file.path}`, file.content);
      // Write to /tmp/apps for live hot-reload if the app is running
      const tmpPath = path.join("/tmp", "apps", session_id, file.path);
      try {
        fs.mkdirSync(path.dirname(tmpPath), { recursive: true });
        fs.writeFileSync(tmpPath, file.content);
      } catch {}
      if (!meta.files.includes(file.path)) meta.files.push(file.path);
      updatedFiles.push({ path: file.path, bytes: file.content.length, content: file.content });
    }

    meta.updated_at = new Date().toISOString();
    await ctx.db.set(`build:${session_id}`, meta);

    return { updated_files: updatedFiles, session_id };
  },

  // Export all files for a session (called by builder cell to transfer to project cell)
  async export_session(ctx, params) {
    const { session_id } = params;
    if (!session_id) return { error: "session_id is required" };
    const meta = await ctx.db.get(`build:${session_id}`);
    if (!meta) return { error: "session not found" };
    const files = [];
    for (const filePath of meta.files || []) {
      const content = await ctx.store.read(`sessions/${session_id}/${filePath}`);
      if (content != null) files.push({ path: filePath, content });
    }
    return { session_id, files, meta };
  },

  // Deploy files to this cell (called on a fresh project cell)
  async deploy(ctx, params) {
    const { session_id, files, meta } = params;
    if (!session_id || !files || !meta) return { error: "session_id, files, and meta are required" };
    for (const { path: filePath, content } of files) {
      await ctx.store.write(`sessions/${session_id}/${filePath}`, content);
    }
    await ctx.db.set(`build:${session_id}`, meta);
    return { ok: true };
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

// ─── Multi-file build pipeline ───────────────────────────────────────────────

// Phase 1: One LLM call → file plan with dependency graph
async function planApp(prompt) {
  const resp = await callLLM([
    { role: "system", content: PLAN_PROMPT },
    { role: "user", content: `Build this app: ${prompt}` },
  ]);
  let parsed;
  try { parsed = JSON.parse(extractJSON(resp)); } catch { parsed = {}; }
  return {
    name: parsed.name || "app",
    description: parsed.description || "",
    files: (parsed.files || []).map(f => ({
      path: String(f.path || ""),
      role: String(f.role || "component"),
      description: String(f.description || ""),
      dependsOn: Array.isArray(f.dependsOn) ? f.dependsOn : [],
    })).filter(f => f.path),
  };
}

// Required config files — always present regardless of what the planner returns
const REQUIRED_CONFIGS = [
  "backend/package.json",
  "frontend/package.json",
  "frontend/next.config.js",
  "frontend/app/globals.css",
  "frontend/app/layout.tsx",
];

// Phase 2: Generate all files respecting dependency order.
// Config files → templates (no LLM). Logic files → parallel per wave.
async function executeFiles(files, plan, prompt, onFile) {
  const written = new Map();

  // Ensure required config files are always present
  const existingPaths = new Set(files.map(f => f.path));
  const allFiles = [...files];
  for (const cfgPath of REQUIRED_CONFIGS) {
    if (!existingPaths.has(cfgPath)) {
      allFiles.unshift({ path: cfgPath, role: "config", description: "", dependsOn: [] });
    }
  }

  // Config files are deterministic templates — write immediately, no LLM
  const configFiles = allFiles.filter(f => f.role === "config");
  const logicFiles = allFiles.filter(f => f.role !== "config");

  await Promise.all(configFiles.map(async f => {
    const content = configTemplate(f.path, plan.name);
    if (content) { written.set(f.path, content); await onFile(f.path, content); }
  }));

  // Topological execution: each wave = files whose deps are all written
  const remaining = [...logicFiles];
  while (remaining.length > 0) {
    const ready = remaining.filter(f => f.dependsOn.every(dep => written.has(dep)));

    if (ready.length === 0) {
      // Unresolved deps (circular or missing) — just generate next file
      const next = remaining.shift();
      const content = await generateFile(next, plan, written, prompt);
      written.set(next.path, content);
      await onFile(next.path, content);
      continue;
    }

    for (const f of ready) remaining.splice(remaining.indexOf(f), 1);

    // Generate this wave in parallel
    await Promise.all(ready.map(async f => {
      const content = await generateFile(f, plan, written, prompt);
      written.set(f.path, content);
      await onFile(f.path, content);
    }));
  }
}

// Generate one file with a focused LLM prompt + dep context
async function generateFile(step, plan, written, userPrompt) {
  const depContext = step.dependsOn
    .filter(dep => written.has(dep))
    .map(dep => `=== ${dep} ===\n${written.get(dep)}`)
    .join("\n\n");

  const sysPrompt = step.role === "backend" ? BACKEND_FILE_PROMPT : FRONTEND_FILE_PROMPT;

  const lines = [
    `App: "${plan.name}" — ${plan.description}`,
    `User request: ${userPrompt}`,
    ``,
    `File to create: ${step.path}`,
    `Purpose: ${step.description}`,
  ];
  if (depContext) lines.push(`\nFiles this depends on (already written):\n${depContext}`);
  lines.push(`\nReturn ONLY the complete file content. No markdown fences, no explanation.`);

  const result = await callLLM([
    { role: "system", content: sysPrompt },
    { role: "user", content: lines.join("\n") },
  ]);
  return stripCodeFences(result.trim());
}

// Phase 3: Static verification — auto-fix obvious issues
async function verifyAndFix(written, sid, ctx) {
  for (const [filePath, content] of written) {
    if (!filePath.endsWith(".tsx") && !filePath.endsWith(".ts")) continue;
    if (filePath === "frontend/app/layout.tsx") continue; // server component

    const firstLine = content.split("\n")[0].trim();
    const hasUseClient = firstLine === `'use client';` || firstLine === `"use client";`
      || firstLine === `'use client'` || firstLine === `"use client"`;

    if (!hasUseClient) {
      const fixed = `'use client';\n\n${content}`;
      written.set(filePath, fixed);
      await ctx.store.write(`sessions/${sid}/${filePath}`, fixed);
    }
  }
}

function stripCodeFences(text) {
  return text.replace(/^```[\w]*\n?/m, "").replace(/\n?```\s*$/m, "").trim();
}

// Deterministic config file templates — no LLM needed
function configTemplate(filePath, appName) {
  const safeAppName = (appName || "app").toLowerCase().replace(/[^a-z0-9-]/g, "-");
  const t = {
    "backend/package.json": JSON.stringify({
      name: "backend", version: "1.0.0", type: "module",
      scripts: { start: "node server.js", dev: "node --watch server.js" },
      dependencies: { express: "^4", cors: "^2" },
    }, null, 2),

    "frontend/package.json": JSON.stringify({
      name: safeAppName, version: "0.1.0", private: true,
      scripts: { dev: "next dev", build: "next build", start: "next start" },
      dependencies: { next: "14", react: "^18", "react-dom": "^18" },
      devDependencies: {
        typescript: "^5", "@types/node": "^20",
        "@types/react": "^18", "@types/react-dom": "^18",
      },
    }, null, 2),

    "frontend/next.config.js":
`module.exports = {
  async rewrites() {
    return [{ source: '/backend/:path*', destination: 'http://localhost:4000/:path*' }];
  },
};`,

    "frontend/app/globals.css": `* { box-sizing: border-box; margin: 0; padding: 0; }`,

    "frontend/app/layout.tsx":
`export const metadata = { title: '${appName || "App"}' };
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <script src="https://cdn.tailwindcss.com"></script>
      </head>
      <body className="bg-gray-950 text-white antialiased">{children}</body>
    </html>
  );
}`,
  };
  return t[filePath] || null;
}

// ─── Prompts ──────────────────────────────────────────────────────────────────

const PLAN_PROMPT = `You are an expert fullstack app architect. Output ONLY valid JSON — no markdown, no explanation:

{
  "name": "short-kebab-name",
  "description": "one-line app description",
  "files": [
    { "path": "...", "role": "config|backend|component|page", "description": "...", "dependsOn": [] }
  ]
}

ALWAYS include these files (role: config):
  backend/package.json, frontend/package.json, frontend/next.config.js,
  frontend/app/globals.css, frontend/app/layout.tsx

ALWAYS include (role: backend):
  backend/server.js (dependsOn: [])

ALWAYS include (role: page):
  frontend/app/page.tsx (dependsOn MUST list every component file)

ADD as needed (role: component):
  frontend/components/ComponentName.tsx (dependsOn: [] unless it uses another component)

RULES:
- Use 2–4 components for real apps; 0 for trivial ones
- Components are independent by default (no cross-deps unless truly needed)
- page.tsx dependsOn MUST list ALL component files
- Backend routes are prefixed /api/; frontend fetches /backend/api/...`;

const FRONTEND_FILE_PROMPT = `You are an expert React/Next.js developer generating a single file.

TECH RULES:
- Next.js 14 App Router, TypeScript
- Tailwind CSS is loaded via CDN — use any className with Tailwind utility classes directly, no config needed
- All client components MUST start with: 'use client';
- Import React hooks normally: import { useState, useEffect } from 'react';
- Import components using relative paths: import ComponentName from '../components/ComponentName';
- Fetch backend data at /backend/api/... (relative URL — never localhost)
- Do NOT create Next.js API routes (no app/api/ directory)

DESIGN — premium dark SaaS (Vercel/Linear aesthetic):
- Page wrapper: className="min-h-screen bg-gray-950 text-white"
- Content: className="max-w-5xl mx-auto px-6 py-10"
- Page title: className="text-3xl font-bold text-white mb-1"
- Subtitle: className="text-gray-400 text-sm mb-8"
- Cards: className="bg-gray-900 rounded-2xl border border-gray-800 p-6 shadow-xl"
- List row: className="flex items-center gap-3 p-4 rounded-xl bg-gray-900 border border-gray-800 hover:border-gray-700 transition-colors"
- Primary button: className="bg-indigo-600 hover:bg-indigo-500 text-white font-semibold px-5 py-2.5 rounded-xl transition-colors cursor-pointer"
- Secondary button: className="bg-gray-800 hover:bg-gray-700 text-gray-300 px-4 py-2 rounded-lg text-sm transition-colors cursor-pointer"
- Danger button: className="bg-red-600/10 hover:bg-red-600/20 text-red-400 px-3 py-1.5 rounded-lg text-sm transition-colors cursor-pointer"
- Input: className="w-full bg-gray-900 border border-gray-800 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 text-white placeholder-gray-500 rounded-xl px-4 py-3 outline-none transition-all"
- Badge: className="bg-indigo-600/20 text-indigo-400 text-xs font-medium px-2.5 py-1 rounded-full"
- Empty state: className="text-center py-16 text-gray-500" with large emoji
- Grid: className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4"
- Use emoji icons (✅ 📝 🗑️ ✨ 🔍 ⚡ 💡 🎯) for visual richness
- Every button/link has hover state + cursor-pointer
- text-green-400 success, text-red-400 error, text-yellow-400 warning

Return ONLY the file content. No markdown fences. No explanation.`;

const BACKEND_FILE_PROMPT = `You are an expert Node.js/Express developer generating a single backend file.

RULES:
- ESM syntax (import/export)
- Import cors: import cors from 'cors'; and use app.use(cors())
- All routes prefixed /api/ (e.g. GET /api/items — NOT /backend/api/)
- In-memory storage only (Map or array — no database)
- app.listen(4000)
- Return JSON. Handle 404 and errors gracefully.

Return ONLY the file content. No markdown fences. No explanation.`;

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

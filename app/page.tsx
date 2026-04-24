"use client";

import { useState, useRef } from "react";

// ─── Types ────────────────────────────────────────────────────────────────────

interface BuildFile {
  path: string;
  bytes: number;
}

interface BuildResult {
  session_id: string;
  name: string;
  description: string;
  files: BuildFile[];
  file_count: number;
}

type Status = "idle" | "building" | "done" | "error";

// ─── File tree helpers ────────────────────────────────────────────────────────

function buildTree(files: BuildFile[]) {
  const tree: Record<string, BuildFile[]> = {};
  for (const f of files) {
    const parts = f.path.split("/");
    const dir = parts.length > 1 ? parts[0] : "";
    if (!tree[dir]) tree[dir] = [];
    tree[dir].push(f);
  }
  return tree;
}

function langFromPath(path: string): string {
  const ext = path.split(".").pop() || "";
  const map: Record<string, string> = {
    ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
    json: "json", css: "css", html: "html", md: "markdown",
  };
  return map[ext] || "text";
}

// ─── Components ───────────────────────────────────────────────────────────────

function Spinner() {
  return (
    <svg
      width="14" height="14" viewBox="0 0 24 24" fill="none"
      style={{ animation: "spin 0.8s linear infinite" }}
    >
      <circle cx="12" cy="12" r="10" stroke="rgba(212,165,74,0.2)" strokeWidth="2.5" />
      <path d="M12 2a10 10 0 0 1 10 10" stroke="#d4a54a" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}

function OncellLogo() {
  return (
    <svg width="16" height="16" viewBox="0 0 32 32" fill="none">
      <rect x="4" y="4" width="24" height="24" rx="6" stroke="#d4a54a" strokeWidth="1.5" fill="none" />
      <circle cx="16" cy="16" r="3.5" fill="#d4a54a" />
    </svg>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function Builder() {
  const [prompt, setPrompt] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [build, setBuild] = useState<BuildResult | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [updateInstruction, setUpdateInstruction] = useState("");
  const [updating, setUpdating] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleBuild = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!prompt.trim() || status === "building") return;

    setStatus("building");
    setError(null);
    setBuild(null);
    setSelectedFile(null);
    setFileContent(null);

    try {
      const res = await fetch("/api/build", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: prompt.trim() }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setBuild(data);
      setStatus("done");
      // Auto-select first file
      if (data.files?.[0]) {
        loadFile(data.session_id, data.files[0].path);
      }
    } catch (err: any) {
      setError(err.message);
      setStatus("error");
    }
  };

  const loadFile = async (sessionId: string, path: string) => {
    setSelectedFile(path);
    setFileContent(null);
    setFileLoading(true);
    try {
      const res = await fetch(`/api/file?session_id=${sessionId}&path=${encodeURIComponent(path)}`);
      const data = await res.json();
      setFileContent(data.error ? `// Error: ${data.error}` : data.content);
    } catch {
      setFileContent("// Failed to load file");
    } finally {
      setFileLoading(false);
    }
  };

  const handleUpdate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!build || !selectedFile || !updateInstruction.trim() || updating) return;

    setUpdating(true);
    try {
      const res = await fetch("/api/file", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: build.session_id,
          path: selectedFile,
          instruction: updateInstruction.trim(),
        }),
      });
      const data = await res.json();
      if (!data.error) {
        setUpdateInstruction("");
        loadFile(build.session_id, selectedFile);
      }
    } finally {
      setUpdating(false);
    }
  };

  const tree = build ? buildTree(build.files) : {};

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", background: "var(--bg)" }}>

      {/* Header */}
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0 20px",
          height: "44px",
          borderBottom: "1px solid var(--border)",
          flexShrink: 0,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <OncellLogo />
          <span style={{ fontFamily: "var(--mono)", fontSize: "13px", color: "var(--accent)", fontWeight: 600 }}>
            fullstack-builder
          </span>
          <span style={{ fontFamily: "var(--mono)", fontSize: "11px", color: "var(--text-muted)" }}>
            / Next.js + Node.js from a prompt
          </span>
        </div>
        <a
          href="https://oncell.ai"
          target="_blank"
          rel="noopener noreferrer"
          style={{ fontFamily: "var(--mono)", fontSize: "11px", color: "var(--text-muted)", textDecoration: "none" }}
        >
          powered by oncell.ai
        </a>
      </header>

      {/* Body */}
      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>

        {/* Left panel */}
        <div
          style={{
            width: "300px",
            flexShrink: 0,
            borderRight: "1px solid var(--border)",
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
          }}
        >
          {/* Prompt input */}
          <div style={{ padding: "20px 16px", borderBottom: "1px solid var(--border)" }}>
            <div
              style={{
                fontFamily: "var(--mono)",
                fontSize: "9.5px",
                color: "var(--accent)",
                letterSpacing: "0.1em",
                marginBottom: "10px",
              }}
            >
              DESCRIBE YOUR APP
            </div>
            <form onSubmit={handleBuild}>
              <textarea
                ref={textareaRef}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleBuild(e as any);
                }}
                placeholder="e.g. a todo app with categories and due dates"
                rows={4}
                disabled={status === "building"}
                style={{
                  width: "100%",
                  background: "var(--surface)",
                  border: "1px solid var(--border)",
                  borderRadius: "7px",
                  padding: "10px 12px",
                  fontFamily: "var(--mono)",
                  fontSize: "12px",
                  color: "var(--text)",
                  resize: "none",
                  outline: "none",
                  lineHeight: 1.6,
                  transition: "border-color 0.15s",
                }}
                onFocus={(e) => (e.currentTarget.style.borderColor = "var(--border-gold)")}
                onBlur={(e) => (e.currentTarget.style.borderColor = "var(--border)")}
              />
              <button
                type="submit"
                disabled={!prompt.trim() || status === "building"}
                style={{
                  marginTop: "8px",
                  width: "100%",
                  padding: "9px",
                  background: status === "building" ? "rgba(212,165,74,0.15)" : "var(--accent)",
                  color: status === "building" ? "var(--accent)" : "#0a0a0a",
                  border: status === "building" ? "1px solid rgba(212,165,74,0.25)" : "none",
                  borderRadius: "6px",
                  fontFamily: "var(--mono)",
                  fontSize: "11px",
                  fontWeight: 700,
                  letterSpacing: "0.08em",
                  cursor: status === "building" ? "not-allowed" : "pointer",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: "8px",
                  transition: "all 0.15s",
                }}
              >
                {status === "building" ? <><Spinner /> BUILDING...</> : "BUILD →"}
              </button>
            </form>

            {/* Status / error */}
            {status === "building" && (
              <div
                style={{
                  marginTop: "10px",
                  fontFamily: "var(--mono)",
                  fontSize: "10.5px",
                  color: "rgba(212,165,74,0.5)",
                  lineHeight: 1.6,
                }}
              >
                Generating frontend + backend...
                <br />
                <span style={{ color: "var(--text-muted)" }}>Takes ~15–30 seconds</span>
              </div>
            )}
            {status === "error" && (
              <div
                style={{
                  marginTop: "10px",
                  fontFamily: "var(--mono)",
                  fontSize: "10.5px",
                  color: "#ff6b6b",
                  lineHeight: 1.6,
                }}
              >
                {error}
              </div>
            )}
            {status === "done" && build && (
              <div
                style={{
                  marginTop: "10px",
                  fontFamily: "var(--mono)",
                  fontSize: "10.5px",
                  color: "var(--green)",
                  lineHeight: 1.6,
                }}
              >
                ✓ {build.file_count} files — {build.description}
              </div>
            )}
          </div>

          {/* File tree */}
          <div style={{ flex: 1, overflowY: "auto", padding: "12px 0" }}>
            {build && (
              <>
                <div
                  style={{
                    fontFamily: "var(--mono)",
                    fontSize: "9.5px",
                    color: "var(--text-muted)",
                    letterSpacing: "0.1em",
                    padding: "0 16px 10px",
                  }}
                >
                  GENERATED FILES
                </div>
                {Object.entries(tree).map(([dir, files]) => (
                  <div key={dir} className="fade-up">
                    {dir && (
                      <div
                        style={{
                          padding: "4px 16px",
                          fontFamily: "var(--mono)",
                          fontSize: "11px",
                          color: "var(--accent)",
                          letterSpacing: "0.02em",
                        }}
                      >
                        {dir}/
                      </div>
                    )}
                    {files.map((f) => (
                      <button
                        key={f.path}
                        onClick={() => loadFile(build.session_id, f.path)}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          width: "100%",
                          padding: "5px 16px 5px " + (dir ? "28px" : "16px"),
                          background: selectedFile === f.path ? "rgba(212,165,74,0.06)" : "transparent",
                          border: "none",
                          borderLeft: selectedFile === f.path ? "2px solid var(--accent)" : "2px solid transparent",
                          cursor: "pointer",
                          textAlign: "left",
                          transition: "background 0.1s",
                        }}
                        onMouseEnter={(e) => {
                          if (selectedFile !== f.path)
                            (e.currentTarget as HTMLButtonElement).style.background = "rgba(255,255,255,0.02)";
                        }}
                        onMouseLeave={(e) => {
                          if (selectedFile !== f.path)
                            (e.currentTarget as HTMLButtonElement).style.background = "transparent";
                        }}
                      >
                        <span
                          style={{
                            fontFamily: "var(--mono)",
                            fontSize: "12px",
                            color: selectedFile === f.path ? "var(--accent)" : "var(--text-dim)",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {dir ? f.path.replace(`${dir}/`, "") : f.path}
                        </span>
                        <span
                          style={{
                            fontFamily: "var(--mono)",
                            fontSize: "10px",
                            color: "var(--text-muted)",
                            flexShrink: 0,
                            marginLeft: "8px",
                          }}
                        >
                          {(f.bytes / 1024).toFixed(1)}k
                        </span>
                      </button>
                    ))}
                  </div>
                ))}
              </>
            )}

            {status === "idle" && (
              <div
                style={{
                  padding: "24px 16px",
                  fontFamily: "var(--mono)",
                  fontSize: "11px",
                  color: "var(--text-muted)",
                  lineHeight: 1.8,
                }}
              >
                <div style={{ marginBottom: "16px" }}>Describe an app and hit Build.</div>
                <div style={{ color: "rgba(232,228,222,0.12)", fontSize: "10.5px" }}>
                  Try:
                  {[
                    "A todo app with categories",
                    "A note-taking app with search",
                    "A URL shortener with analytics",
                    "A simple blog with comments",
                  ].map((ex) => (
                    <div
                      key={ex}
                      onClick={() => { setPrompt(ex); textareaRef.current?.focus(); }}
                      style={{
                        marginTop: "6px",
                        cursor: "pointer",
                        color: "rgba(212,165,74,0.35)",
                        transition: "color 0.12s",
                        paddingLeft: "8px",
                        borderLeft: "1px solid rgba(212,165,74,0.12)",
                      }}
                      onMouseEnter={(e) => ((e.currentTarget as HTMLDivElement).style.color = "var(--accent)")}
                      onMouseLeave={(e) =>
                        ((e.currentTarget as HTMLDivElement).style.color = "rgba(212,165,74,0.35)")
                      }
                    >
                      {ex}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Right panel — code viewer */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
          {/* File tab */}
          {selectedFile && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "0 20px",
                height: "40px",
                borderBottom: "1px solid var(--border)",
                flexShrink: 0,
              }}
            >
              <span style={{ fontFamily: "var(--mono)", fontSize: "12px", color: "var(--accent)" }}>
                {selectedFile}
              </span>
              <span
                style={{
                  fontFamily: "var(--mono)",
                  fontSize: "10px",
                  color: "var(--text-muted)",
                  background: "var(--surface)",
                  padding: "2px 8px",
                  borderRadius: "4px",
                  border: "1px solid var(--border)",
                }}
              >
                {langFromPath(selectedFile)}
              </span>
            </div>
          )}

          {/* Code content */}
          <div style={{ flex: 1, overflow: "auto", position: "relative" }}>
            {fileLoading && (
              <div
                style={{
                  position: "absolute",
                  inset: 0,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: "10px",
                  fontFamily: "var(--mono)",
                  fontSize: "12px",
                  color: "var(--text-muted)",
                }}
              >
                <Spinner /> Loading...
              </div>
            )}
            {!fileLoading && fileContent && (
              <pre
                style={{
                  padding: "20px 24px",
                  fontFamily: "var(--mono)",
                  fontSize: "12.5px",
                  lineHeight: 1.75,
                  color: "var(--text-dim)",
                  margin: 0,
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-all",
                }}
              >
                {fileContent}
              </pre>
            )}
            {!fileLoading && !fileContent && !selectedFile && (
              <div
                style={{
                  position: "absolute",
                  inset: 0,
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: "12px",
                }}
              >
                <OncellLogo />
                <div style={{ fontFamily: "var(--mono)", fontSize: "12px", color: "var(--text-muted)" }}>
                  {status === "building"
                    ? "Generating your app..."
                    : "Select a file to view its code"}
                </div>
              </div>
            )}
          </div>

          {/* Update bar */}
          {selectedFile && build && (
            <form
              onSubmit={handleUpdate}
              style={{
                borderTop: "1px solid var(--border)",
                padding: "10px 16px",
                display: "flex",
                gap: "8px",
                alignItems: "center",
                flexShrink: 0,
              }}
            >
              <span style={{ fontFamily: "var(--mono)", fontSize: "11px", color: "rgba(92,219,127,0.5)", flexShrink: 0 }}>
                $
              </span>
              <input
                value={updateInstruction}
                onChange={(e) => setUpdateInstruction(e.target.value)}
                placeholder={`Update ${selectedFile.split("/").pop()}...`}
                disabled={updating}
                style={{
                  flex: 1,
                  background: "transparent",
                  border: "none",
                  outline: "none",
                  fontFamily: "var(--mono)",
                  fontSize: "12px",
                  color: "var(--text)",
                  caretColor: "var(--accent)",
                  opacity: updating ? 0.5 : 1,
                }}
              />
              <button
                type="submit"
                disabled={!updateInstruction.trim() || updating}
                style={{
                  fontFamily: "var(--mono)",
                  fontSize: "10px",
                  letterSpacing: "0.06em",
                  color: updateInstruction.trim() && !updating ? "var(--accent)" : "rgba(212,165,74,0.2)",
                  background: "transparent",
                  border: "none",
                  cursor: updateInstruction.trim() && !updating ? "pointer" : "default",
                  display: "flex",
                  alignItems: "center",
                  gap: "6px",
                  flexShrink: 0,
                }}
              >
                {updating ? <><Spinner /> UPDATING</> : "UPDATE →"}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}

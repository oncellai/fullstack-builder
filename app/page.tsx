"use client";

import { useState, useRef, useEffect } from "react";
import { Highlight, themes } from "prism-react-renderer";

// ─── Types ────────────────────────────────────────────────────────────────────

interface BuildFile {
  path: string;
  bytes: number;
}

interface BuildFileWithContent extends BuildFile {
  content?: string;
}

interface BuildResult {
  session_id: string;
  name: string;
  description: string;
  files: BuildFile[];
  file_count: number;
}

type Status = "idle" | "building" | "done" | "error";
type RightTab = "code" | "preview";
type RunStatus = "idle" | "installing" | "starting" | "running" | "error";

// ─── Helpers ──────────────────────────────────────────────────────────────────

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
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" style={{ animation: "spin 0.8s linear infinite", flexShrink: 0 }}>
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
  const [rightTab, setRightTab] = useState<RightTab>("code");

  // Run state
  const [runStatus, setRunStatus] = useState<RunStatus>("idle");
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const runPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Streaming state
  const [streamLog, setStreamLog] = useState<string[]>([]);
  const [streamedFiles, setStreamedFiles] = useState<BuildFileWithContent[]>([]);
  const [fileCache, setFileCache] = useState<Record<string, string>>({});

  // Code streaming animation
  const [displayedLines, setDisplayedLines] = useState(0);
  const streamTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Clear run state on new build
  const resetRunState = () => {
    if (runPollRef.current) clearInterval(runPollRef.current);
    setRunStatus("idle");
    setPreviewUrl(null);
  };

  const handleRun = async (sessionId: string) => {
    if (runStatus === "running" || runStatus === "installing" || runStatus === "starting") return;
    resetRunState();
    setRunStatus("installing");

    try {
      const res = await fetch("/api/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sessionId }),
      });
      const data = await res.json();
      if (data.error) { setRunStatus("error"); return; }
      if (data.already_running) {
        setPreviewUrl(data.preview_url);
        setRunStatus("running");
        return;
      }

      // Poll until running or error
      runPollRef.current = setInterval(async () => {
        try {
          const sr = await fetch(`/api/run-status?session_id=${sessionId}`);
          const s = await sr.json();
          if (s.status === "running") {
            setPreviewUrl(s.preview_url);
            setRunStatus("running");
            if (runPollRef.current) clearInterval(runPollRef.current);
          } else if (s.status === "error") {
            setRunStatus("error");
            if (runPollRef.current) clearInterval(runPollRef.current);
          } else if (s.status === "starting") {
            setRunStatus("starting");
          }
        } catch {}
      }, 2000);
    } catch {
      setRunStatus("error");
    }
  };

  // Animate code appearing line-by-line when file content changes
  useEffect(() => {
    if (!fileContent) { setDisplayedLines(0); return; }
    if (streamTimer.current) clearInterval(streamTimer.current);
    const lines = fileContent.split("\n");
    setDisplayedLines(0);
    let i = 0;
    streamTimer.current = setInterval(() => {
      i += 6;
      setDisplayedLines(Math.min(i, lines.length));
      if (i >= lines.length) clearInterval(streamTimer.current!);
    }, 20);
    return () => { if (streamTimer.current) clearInterval(streamTimer.current!); };
  }, [fileContent]);

  const visibleContent = fileContent
    ? fileContent.split("\n").slice(0, displayedLines).join("\n")
    : null;

  const handleBuild = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!prompt.trim() || status === "building") return;

    setStatus("building");
    setError(null);
    setBuild(null);
    setSelectedFile(null);
    setFileContent(null);
    setStreamLog([]);
    setStreamedFiles([]);
    setFileCache({});
    setRightTab("code");
    resetRunState();

    try {
      const res = await fetch("/api/build", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: prompt.trim() }),
      });

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      const allFiles: BuildFileWithContent[] = [];
      const cache: Record<string, string> = {};

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop()!;

        for (const part of parts) {
          const line = part.trim();
          if (!line.startsWith("data: ")) continue;
          let event: any;
          try { event = JSON.parse(line.slice(6)); } catch { continue; }

          if (event.type === "status") {
            setStreamLog((prev) => [...prev, event.message]);
          } else if (event.type === "file") {
            allFiles.push(event.file);
            if (event.file.content) cache[event.file.path] = event.file.content;
            setStreamedFiles([...allFiles]);
            setFileCache({ ...cache });
            // Auto-show each file as it arrives
            setSelectedFile(event.file.path);
            setFileContent(event.file.content || null);
          } else if (event.type === "done") {
            const buildResult: BuildResult = {
              session_id: event.session_id,
              name: event.name,
              description: event.description,
              files: allFiles.map((f) => ({ path: f.path, bytes: f.bytes })),
              file_count: event.file_count,
            };
            setBuild(buildResult);
            setFileCache({ ...cache });
            setStatus("done");
            // Auto-select first file
            if (allFiles[0]) {
              setSelectedFile(allFiles[0].path);
              setFileContent(cache[allFiles[0].path] || null);
            }
          } else if (event.type === "error") {
            setError(event.error);
            setStatus("error");
          }
        }
      }
    } catch (err: any) {
      setError(err.message);
      setStatus("error");
    }
  };

  const loadFile = async (sessionId: string, path: string) => {
    setSelectedFile(path);
    setRightTab("code");

    // Serve from cache first
    if (fileCache[path]) {
      setFileContent(fileCache[path]);
      return;
    }

    setFileContent(null);
    setFileLoading(true);
    try {
      const res = await fetch(`/api/file?session_id=${sessionId}&path=${encodeURIComponent(path)}`);
      const data = await res.json();
      const content = data.error ? `// Error: ${data.error}` : data.content;
      setFileContent(content);
      if (!data.error) setFileCache((prev) => ({ ...prev, [path]: content }));
    } catch {
      setFileContent("// Failed to load file");
    } finally {
      setFileLoading(false);
    }
  };

  const handleUpdate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!build || !updateInstruction.trim() || updating) return;

    setUpdating(true);
    try {
      const res = await fetch("/api/edit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: build.session_id,
          instruction: updateInstruction.trim(),
        }),
      });
      const data = await res.json();
      if (!data.error && data.updated_files) {
        setUpdateInstruction("");
        // Update cache for all changed files
        const newCache: Record<string, string> = {};
        for (const f of data.updated_files) {
          if (f.content) newCache[f.path] = f.content;
        }
        setFileCache((prev) => ({ ...prev, ...newCache }));
        // Reload current file if it was updated
        if (selectedFile && newCache[selectedFile]) {
          setFileContent(newCache[selectedFile]);
        }
      }
    } finally {
      setUpdating(false);
    }
  };

  // Use streamed files during build, settled files after done
  const treeFiles = status === "done" && build ? build.files : streamedFiles;
  const tree = buildTree(treeFiles);
  const sessionId = build?.session_id || null;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", background: "var(--bg)" }}>

      {/* Header */}
      <header style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "0 20px", height: "44px", borderBottom: "1px solid var(--border)", flexShrink: 0,
      }}>
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
          href="https://oncell.ai" target="_blank" rel="noopener noreferrer"
          style={{ fontFamily: "var(--mono)", fontSize: "11px", color: "var(--text-muted)", textDecoration: "none" }}
        >
          powered by oncell.ai
        </a>
      </header>

      {/* Body */}
      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>

        {/* Left panel */}
        <div style={{
          width: "300px", flexShrink: 0, borderRight: "1px solid var(--border)",
          display: "flex", flexDirection: "column", overflow: "hidden",
        }}>
          {/* Prompt input */}
          <div style={{ padding: "20px 16px", borderBottom: "1px solid var(--border)" }}>
            <div style={{
              fontFamily: "var(--mono)", fontSize: "9.5px", color: "var(--accent)",
              letterSpacing: "0.1em", marginBottom: "10px",
            }}>
              DESCRIBE YOUR APP
            </div>
            <form onSubmit={handleBuild}>
              <textarea
                ref={textareaRef}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleBuild(e as any); }}
                placeholder="e.g. a todo app with categories and due dates"
                rows={4}
                disabled={status === "building"}
                style={{
                  width: "100%", background: "var(--surface)", border: "1px solid var(--border)",
                  borderRadius: "7px", padding: "10px 12px", fontFamily: "var(--mono)",
                  fontSize: "12px", color: "var(--text)", resize: "none", outline: "none",
                  lineHeight: 1.6, transition: "border-color 0.15s",
                }}
                onFocus={(e) => (e.currentTarget.style.borderColor = "var(--border-gold)")}
                onBlur={(e) => (e.currentTarget.style.borderColor = "var(--border)")}
              />
              <button
                type="submit"
                disabled={!prompt.trim() || status === "building"}
                style={{
                  marginTop: "8px", width: "100%", padding: "9px",
                  background: status === "building" ? "rgba(212,165,74,0.15)" : "var(--accent)",
                  color: status === "building" ? "var(--accent)" : "#0a0a0a",
                  border: status === "building" ? "1px solid rgba(212,165,74,0.25)" : "none",
                  borderRadius: "6px", fontFamily: "var(--mono)", fontSize: "11px", fontWeight: 700,
                  letterSpacing: "0.08em", cursor: status === "building" ? "not-allowed" : "pointer",
                  display: "flex", alignItems: "center", justifyContent: "center", gap: "8px",
                  transition: "all 0.15s",
                }}
              >
                {status === "building" ? <><Spinner /> BUILDING...</> : "BUILD →"}
              </button>
            </form>

            {status === "error" && (
              <div style={{ marginTop: "10px", fontFamily: "var(--mono)", fontSize: "10.5px", color: "#ff6b6b", lineHeight: 1.6 }}>
                {error}
              </div>
            )}
            {status === "done" && build && (
              <div style={{ marginTop: "10px", fontFamily: "var(--mono)", fontSize: "10.5px", color: "var(--green)", lineHeight: 1.6 }}>
                ✓ {build.file_count} files — {build.description}
              </div>
            )}
          </div>

          {/* File tree */}
          <div style={{ flex: 1, overflowY: "auto", padding: "12px 0" }}>
            {treeFiles.length > 0 && (
              <>
                <div style={{
                  fontFamily: "var(--mono)", fontSize: "9.5px", color: "var(--text-muted)",
                  letterSpacing: "0.1em", padding: "0 16px 10px",
                  display: "flex", alignItems: "center", gap: "8px",
                }}>
                  GENERATED FILES
                  {status === "building" && <Spinner />}
                </div>
                {Object.entries(tree).map(([dir, files]) => (
                  <div key={dir} className="fade-up">
                    {dir && (
                      <div style={{
                        padding: "4px 16px", fontFamily: "var(--mono)", fontSize: "11px",
                        color: "var(--accent)", letterSpacing: "0.02em",
                      }}>
                        {dir}/
                      </div>
                    )}
                    {files.map((f) => (
                      <button
                        key={f.path}
                        onClick={() => sessionId ? loadFile(sessionId, f.path) : undefined}
                        style={{
                          display: "flex", alignItems: "center", justifyContent: "space-between",
                          width: "100%", padding: "5px 16px 5px " + (dir ? "28px" : "16px"),
                          background: selectedFile === f.path ? "rgba(212,165,74,0.06)" : "transparent",
                          border: "none",
                          borderLeft: selectedFile === f.path ? "2px solid var(--accent)" : "2px solid transparent",
                          cursor: "pointer", textAlign: "left", transition: "background 0.1s",
                        }}
                        onMouseEnter={(e) => { if (selectedFile !== f.path) (e.currentTarget as HTMLButtonElement).style.background = "rgba(255,255,255,0.02)"; }}
                        onMouseLeave={(e) => { if (selectedFile !== f.path) (e.currentTarget as HTMLButtonElement).style.background = "transparent"; }}
                      >
                        <span style={{
                          fontFamily: "var(--mono)", fontSize: "12px",
                          color: selectedFile === f.path ? "var(--accent)" : "var(--text-dim)",
                          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                        }}>
                          {dir ? f.path.replace(`${dir}/`, "") : f.path}
                        </span>
                        <span style={{
                          fontFamily: "var(--mono)", fontSize: "10px", color: "var(--text-muted)",
                          flexShrink: 0, marginLeft: "8px",
                        }}>
                          {(f.bytes / 1024).toFixed(1)}k
                        </span>
                      </button>
                    ))}
                  </div>
                ))}
              </>
            )}

            {status === "idle" && (
              <div style={{
                padding: "24px 16px", fontFamily: "var(--mono)", fontSize: "11px",
                color: "var(--text-muted)", lineHeight: 1.8,
              }}>
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
                        marginTop: "6px", cursor: "pointer", color: "rgba(212,165,74,0.35)",
                        transition: "color 0.12s", paddingLeft: "8px",
                        borderLeft: "1px solid rgba(212,165,74,0.12)",
                      }}
                      onMouseEnter={(e) => ((e.currentTarget as HTMLDivElement).style.color = "var(--accent)")}
                      onMouseLeave={(e) => ((e.currentTarget as HTMLDivElement).style.color = "rgba(212,165,74,0.35)")}
                    >
                      {ex}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Right panel */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>

          {/* Tab bar — only when a file is selected or build is done */}
          {(selectedFile || status === "done") && build && (
            <div style={{
              display: "flex", alignItems: "center", justifyContent: "space-between",
              padding: "0 20px", height: "40px", borderBottom: "1px solid var(--border)", flexShrink: 0,
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: "0" }}>
                {(["code", "preview"] as RightTab[]).map((tab) => (
                  <button
                    key={tab}
                    onClick={() => setRightTab(tab)}
                    style={{
                      fontFamily: "var(--mono)", fontSize: "10.5px", letterSpacing: "0.08em",
                      padding: "0 14px", height: "40px", background: "transparent", border: "none",
                      borderBottom: rightTab === tab ? "2px solid var(--accent)" : "2px solid transparent",
                      color: rightTab === tab ? "var(--accent)" : "var(--text-muted)",
                      cursor: "pointer", transition: "color 0.15s",
                    }}
                  >
                    {tab === "code" ? (selectedFile ? selectedFile.split("/").pop() : "CODE") : "PREVIEW"}
                  </button>
                ))}
              </div>
              {rightTab === "code" && selectedFile && (
                <span style={{
                  fontFamily: "var(--mono)", fontSize: "10px", color: "var(--text-muted)",
                  background: "var(--surface)", padding: "2px 8px",
                  borderRadius: "4px", border: "1px solid var(--border)",
                }}>
                  {langFromPath(selectedFile)}
                </span>
              )}
            </div>
          )}

          {/* Content area */}
          <div style={{ flex: 1, overflow: "auto", position: "relative" }}>

            {/* Generating state — before first file arrives */}
            {status === "building" && !selectedFile && (
              <div style={{
                position: "absolute", inset: 0, display: "flex",
                alignItems: "center", justifyContent: "center", gap: "10px",
              }}>
                <Spinner />
                <span style={{ fontFamily: "var(--mono)", fontSize: "12px", color: "var(--text-muted)" }}>
                  {streamLog[streamLog.length - 1] || "Generating..."}
                </span>
              </div>
            )}

            {/* Code view */}
            {rightTab === "code" && (
              <>
                {fileLoading && (
                  <div style={{
                    position: "absolute", inset: 0, display: "flex",
                    alignItems: "center", justifyContent: "center", gap: "10px",
                    fontFamily: "var(--mono)", fontSize: "12px", color: "var(--text-muted)",
                  }}>
                    <Spinner /> Loading...
                  </div>
                )}
                {!fileLoading && visibleContent !== null && (
                  <Highlight
                    theme={themes.oneDark}
                    code={visibleContent || " "}
                    language={langFromPath(selectedFile || "") as any}
                  >
                    {({ className, style, tokens, getLineProps, getTokenProps }) => (
                      <pre
                        className={className}
                        style={{
                          ...style,
                          background: "transparent",
                          padding: "20px 24px",
                          fontFamily: "var(--mono)",
                          fontSize: "12.5px",
                          lineHeight: 1.75,
                          margin: 0,
                          whiteSpace: "pre-wrap",
                          wordBreak: "break-all",
                        }}
                      >
                        {tokens.map((line, i) => (
                          <div key={i} {...getLineProps({ line })}>
                            <span style={{ color: "rgba(232,228,222,0.2)", userSelect: "none", marginRight: "20px", display: "inline-block", minWidth: "28px", textAlign: "right", fontSize: "11px" }}>
                              {i + 1}
                            </span>
                            {line.map((token, key) => (
                              <span key={key} {...getTokenProps({ token })} />
                            ))}
                          </div>
                        ))}
                        {displayedLines < (fileContent?.split("\n").length ?? 0) && (
                          <span style={{ display: "inline-block", width: "7px", height: "14px", background: "var(--accent)", marginLeft: "1px", animation: "pulse 0.8s ease-in-out infinite", verticalAlign: "text-bottom" }} />
                        )}
                      </pre>
                    )}
                  </Highlight>
                )}
                {!fileLoading && !fileContent && !selectedFile && status !== "building" && (
                  <div style={{
                    position: "absolute", inset: 0, display: "flex",
                    flexDirection: "column", alignItems: "center", justifyContent: "center", gap: "12px",
                  }}>
                    <OncellLogo />
                    <div style={{ fontFamily: "var(--mono)", fontSize: "12px", color: "var(--text-muted)" }}>
                      Select a file to view its code
                    </div>
                  </div>
                )}
              </>
            )}

            {/* Preview / Run */}
            {rightTab === "preview" && build && (
              <div style={{
                display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
                height: "100%", gap: "24px", padding: "40px",
              }}>
                {runStatus === "idle" && (
                  <>
                    <div style={{ fontFamily: "var(--mono)", fontSize: "13px", color: "var(--text-muted)", textAlign: "center", lineHeight: 1.8 }}>
                      Run the app inside the cell to get a live preview.<br />
                      <span style={{ fontSize: "11px", color: "rgba(232,228,222,0.25)" }}>
                        Starts Next.js + Node.js backend — takes ~30s on first run
                      </span>
                    </div>
                    <button
                      onClick={() => handleRun(build.session_id)}
                      style={{
                        padding: "10px 28px", background: "var(--accent)", color: "#0a0a0a",
                        border: "none", borderRadius: "6px", fontFamily: "var(--mono)",
                        fontSize: "12px", fontWeight: 700, letterSpacing: "0.08em", cursor: "pointer",
                      }}
                    >
                      RUN →
                    </button>
                  </>
                )}

                {(runStatus === "installing" || runStatus === "starting") && (
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "16px" }}>
                    <Spinner />
                    <div style={{ fontFamily: "var(--mono)", fontSize: "13px", color: "var(--text-muted)" }}>
                      {runStatus === "installing" ? "Installing dependencies..." : "Starting servers..."}
                    </div>
                    <div style={{ fontFamily: "var(--mono)", fontSize: "10.5px", color: "rgba(232,228,222,0.2)", textAlign: "center", lineHeight: 1.8 }}>
                      npm install · Next.js dev · Express
                    </div>
                  </div>
                )}

                {runStatus === "running" && previewUrl && (
                  <>
                    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "8px" }}>
                      <span style={{ fontFamily: "var(--mono)", fontSize: "11px", color: "var(--green)" }}>✓ App is running</span>
                      <code style={{
                        fontFamily: "var(--mono)", fontSize: "11px", color: "var(--text-dim)",
                        background: "var(--surface)", padding: "6px 12px", borderRadius: "5px",
                        border: "1px solid var(--border)",
                      }}>
                        {previewUrl}
                      </code>
                    </div>
                    <a
                      href={previewUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{
                        padding: "10px 28px", background: "var(--accent)", color: "#0a0a0a",
                        borderRadius: "6px", fontFamily: "var(--mono)", fontSize: "12px",
                        fontWeight: 700, letterSpacing: "0.08em", textDecoration: "none",
                        display: "inline-block",
                      }}
                    >
                      OPEN APP ↗
                    </a>
                  </>
                )}

                {runStatus === "error" && (
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "16px" }}>
                    <div style={{ fontFamily: "var(--mono)", fontSize: "12px", color: "#ff6b6b" }}>
                      Failed to start the app
                    </div>
                    <button
                      onClick={() => { setRunStatus("idle"); }}
                      style={{
                        fontFamily: "var(--mono)", fontSize: "11px", color: "var(--accent)",
                        background: "transparent", border: "1px solid rgba(212,165,74,0.3)",
                        borderRadius: "5px", padding: "6px 16px", cursor: "pointer",
                      }}
                    >
                      RETRY
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Edit bar — whole-app edit via natural language */}
          {build && status === "done" && (
            <form
              onSubmit={handleUpdate}
              style={{
                borderTop: "1px solid var(--border)", padding: "10px 16px",
                display: "flex", gap: "8px", alignItems: "center", flexShrink: 0,
              }}
            >
              <span style={{ fontFamily: "var(--mono)", fontSize: "11px", color: "rgba(92,219,127,0.5)", flexShrink: 0 }}>
                ✦
              </span>
              <input
                value={updateInstruction}
                onChange={(e) => setUpdateInstruction(e.target.value)}
                placeholder="Edit the app… e.g. add dark mode, improve the UI, add a search bar"
                disabled={updating}
                style={{
                  flex: 1, background: "transparent", border: "none", outline: "none",
                  fontFamily: "var(--mono)", fontSize: "12px", color: "var(--text)",
                  caretColor: "var(--accent)", opacity: updating ? 0.5 : 1,
                }}
              />
              <button
                type="submit"
                disabled={!updateInstruction.trim() || updating}
                style={{
                  fontFamily: "var(--mono)", fontSize: "10px", letterSpacing: "0.06em",
                  color: updateInstruction.trim() && !updating ? "var(--accent)" : "rgba(212,165,74,0.2)",
                  background: "transparent", border: "none",
                  cursor: updateInstruction.trim() && !updating ? "pointer" : "default",
                  display: "flex", alignItems: "center", gap: "6px", flexShrink: 0,
                }}
              >
                {updating ? <><Spinner /> EDITING</> : "EDIT →"}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}

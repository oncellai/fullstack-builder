# fullstack-builder

An open source AI agent that generates complete fullstack apps — Next.js frontend + Node.js backend — from a single text prompt.

Built with [OnCell](https://oncell.ai) — the agent harness for AI apps. OnCell runs your agent code in isolated, persistent cells with built-in storage, a database, and compute. No infrastructure to manage.

## What it does

Describe the app you want. The agent generates all the code: a Next.js 14 App Router frontend with Tailwind CSS, and an Express.js backend with in-memory storage. Files persist per session so you can view, edit, and iterate on any file with a natural language instruction.

**Agent methods:**
- `build` — generate a full app from a prompt
- `list_files` — list all generated files for a session
- `read_file` — read a single file
- `update_file` — modify a file with a natural language instruction

## Stack

- **Frontend:** Next.js 15, React 19, Tailwind CSS 4
- **Agent:** [OnCell](https://oncell.ai) cell (gVisor-isolated), OpenRouter LLM (default: `google/gemini-2.5-flash`)
- **Storage:** `ctx.store` (files), `ctx.db` (session metadata)

## Setup

### 1. Get API keys

- **OnCell API key:** [oncell.ai/dashboard](https://oncell.ai/dashboard)
- **OpenRouter API key:** [openrouter.ai/keys](https://openrouter.ai/keys)

### 2. Install and create the cell

```bash
npm install
npm run setup
```

`setup` uses the OnCell SDK to create a cell with the agent code and writes `ONCELL_CELL_ID` to `.env.local`.

### 3. Configure environment

```bash
cp .env.local.example .env.local
```

```env
ONCELL_API_KEY=your_oncell_api_key
ONCELL_CELL_ID=cell_...              # filled in by npm run setup
OPENROUTER_API_KEY=your_openrouter_api_key
LLM_MODEL=google/gemini-2.5-flash   # optional, any OpenRouter model
```

### 4. Run the dev server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## How it works

```
User prompt
    ↓
Next.js API route (/api/build)
    ↓
OnCell SDK → cell.request("build", { prompt })
    ↓
Agent (runs in gVisor-isolated OnCell cell)
    ├── calls OpenRouter LLM → JSON with all files
    ├── writes files to ctx.store (sessions/{id}/)
    └── saves metadata to ctx.db
    ↓
UI shows file tree — click any file to view code
Update bar: type an instruction → AI rewrites the file
```

The agent runs inside an [OnCell](https://oncell.ai) cell — a gVisor-isolated environment with persistent file storage (`ctx.store`), a key-value database (`ctx.db`), and full network access. Each `npm run setup` deploys the agent code to your cell via the OnCell SDK.

## Project structure

```
fullstack-builder/
├── lib/
│   ├── agent-raw.js     # OnCell agent (deployed to cell on setup)
│   └── oncell.ts        # OnCell SDK singleton
├── scripts/
│   └── setup.js         # creates the OnCell cell + writes .env.local
├── app/
│   ├── page.tsx         # split-panel builder UI
│   └── api/
│       ├── build/       # POST → cell.build()
│       ├── files/       # GET  → cell.list_files()
│       └── file/        # GET/PATCH → cell.read_file() / cell.update_file()
└── .env.local.example
```

## Learn more

- [OnCell docs](https://oncell.ai/docs)
- [OnCell dashboard](https://oncell.ai/dashboard)
- [@oncell/sdk on npm](https://www.npmjs.com/package/@oncell/sdk)

## License

Apache 2.0

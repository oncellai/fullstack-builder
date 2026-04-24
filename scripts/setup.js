// Setup script — creates an OnCell cell with the fullstack builder agent.
// Run: node scripts/setup.js

import { OnCell } from "@oncell/sdk";
import { readFileSync, writeFileSync, existsSync } from "fs";

// Load .env.local
const envPath = new URL("../.env.local", import.meta.url).pathname;
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf-8").split("\n")) {
    const match = line.match(/^(\w+)=(.+)$/);
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2].trim();
    }
  }
}

async function main() {
  if (!process.env.ONCELL_API_KEY) {
    console.error("Error: ONCELL_API_KEY not set in .env.local");
    process.exit(1);
  }
  if (!process.env.OPENROUTER_API_KEY) {
    console.error("Error: OPENROUTER_API_KEY not set in .env.local");
    process.exit(1);
  }

  const oncell = new OnCell({ apiKey: process.env.ONCELL_API_KEY });
  const agentCode = readFileSync(new URL("../lib/agent-raw.js", import.meta.url), "utf-8");

  console.log("Creating OnCell cell...");
  const cell = await oncell.cells.create({
    customerId: `fullstack-builder-${Date.now()}`,
    tier: "starter",
    permanent: true,
    secrets: {
      OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
      LLM_MODEL: process.env.LLM_MODEL || "google/gemini-2.5-flash",
    },
    agent: agentCode,
  });

  console.log(`Cell created: ${cell.id}`);
  console.log(`Preview URL:  https://${cell.id}.cells.oncell.run`);

  // Write cell ID to .env.local
  let env = existsSync(envPath) ? readFileSync(envPath, "utf-8") : "";
  if (env.includes("ONCELL_CELL_ID=")) {
    env = env.replace(/ONCELL_CELL_ID=.*/, `ONCELL_CELL_ID=${cell.id}`);
  } else {
    env = env.trimEnd() + `\nONCELL_CELL_ID=${cell.id}\n`;
  }
  writeFileSync(envPath, env);
  console.log(`Wrote ONCELL_CELL_ID to .env.local`);
  console.log("\nSetup complete. Run: npm run dev");
}

main().catch((err) => { console.error(err.message); process.exit(1); });

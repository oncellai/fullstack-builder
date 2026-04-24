import { OnCell } from "@oncell/sdk";

let client: OnCell | null = null;

export function getOnCell(): OnCell {
  if (!client) {
    const apiKey = process.env.ONCELL_API_KEY;
    if (!apiKey) throw new Error("ONCELL_API_KEY env var is required");
    client = new OnCell({ apiKey });
  }
  return client;
}

export function getCellId(): string {
  const cellId = process.env.ONCELL_CELL_ID;
  if (!cellId) throw new Error("ONCELL_CELL_ID env var is required");
  return cellId;
}

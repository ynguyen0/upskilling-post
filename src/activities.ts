import { mkdir, open, readFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type { Message } from "./types";
// Local SMS provider simulator. Exclusive creation is its idempotency contract:
// Activity replay/retry sees the same receipt and does not create another text.
// A real provider adapter must supply equivalent idempotency and delivery callbacks.
export async function deliverMessage(
  message: Message,
  workspace: string,
): Promise<{ delivered: boolean }> {
  const dir = path.join(process.cwd(), ".data", "sms");
  await mkdir(dir, { recursive: true });
  const key = createHash("sha256")
    .update(`${workspace}/${message.id}`)
    .digest("hex");
  const file = path.join(dir, `${key}.json`);
  const receipt = { delivered: !message.failDelivery };
  try {
    const handle = await open(file, "wx");
    try {
      await handle.writeFile(JSON.stringify({ ...receipt, message }));
    } finally {
      await handle.close();
    }
    return receipt;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    try {
      return JSON.parse(await readFile(file, "utf8"));
    } catch {
      // A crash after exclusive creation still counts as one attempted send.
      return receipt;
    }
  }
}

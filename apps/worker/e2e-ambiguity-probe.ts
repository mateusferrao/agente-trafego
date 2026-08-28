/** Qualidade/UX da resposta a UM pedido AMBÍGUO (E2E_PROMPT). Foco + pergunta, sem "sim" →
 *  nenhuma escrita. O bash limpa o thread entre casos (isolamento). Imprime a resposta do Roy. */
import { and, desc, eq } from "drizzle-orm";
import { messages } from "@trafego/db";
import { buildComposition } from "./src/composition.js";
import { runConversationTurn } from "./src/modules/conversation/turn.js";
import { createNotifyRepo } from "./src/modules/notify/repo.js";

const ORG = "2bf0205d-a02f-4934-9e1e-5246301f17fa";
const CONTACT = "028aa734-b068-440f-8f45-da831cebebf5";
const CONV = "7b9ba9ea-0869-497c-bbcc-5171abe4d222";

async function lastReply(db: Awaited<ReturnType<typeof buildComposition>>["db"]): Promise<string> {
  const [m] = await db.select({ body: messages.body }).from(messages).where(and(eq(messages.conversationId, CONV), eq(messages.direction, "outbound"))).orderBy(desc(messages.createdAt)).limit(1);
  return m?.body ?? "(sem resposta)";
}

async function main() {
  const deps = await buildComposition();
  const { db } = deps;
  const ref = { kind: "contact", contactId: CONTACT } as const;
  const prompt = process.env["E2E_PROMPT"];
  if (!prompt) throw new Error("E2E_PROMPT ausente");
  await createNotifyRepo(db).ensureConversation(ORG, CONTACT);
  await runConversationTurn(deps, { orgId: ORG, ref, conversationId: CONV, text: "foca na conta BM - Automato" });
  await runConversationTurn(deps, { orgId: ORG, ref, conversationId: CONV, text: prompt });
  console.log(`\n▶ "${prompt}"\n   ↳ ${(await lastReply(db)).replace(/\n+/g, "\n   ")}`);
}
main().then(() => process.exit(0)).catch((e) => { console.error("ERRO:", String(e).split("\n").slice(0, 3).join(" | ")); process.exit(1); });

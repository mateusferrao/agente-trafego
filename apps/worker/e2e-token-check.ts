/** Valida o token da conta BM Automato SEM logá-lo. Só reads (/me, /me/adaccounts). */
import { eq } from "drizzle-orm";
import { adAccounts, platformConnections } from "@trafego/db";
import { MetaGraphClient } from "@trafego/ads-meta";
import { buildComposition } from "./src/composition.js";

const ACC = process.env["E2E_ACCOUNT_ID"] ?? "d246db5c-d843-4519-a588-9197131458c4";

async function main() {
  const { db, ports } = await buildComposition();
  const [row] = await db
    .select({ meta: adAccounts.adAccountId, accTok: adAccounts.tokenCripto, connTok: platformConnections.tokenCripto })
    .from(adAccounts)
    .leftJoin(platformConnections, eq(adAccounts.connectionId, platformConnections.id))
    .where(eq(adAccounts.id, ACC))
    .limit(1);
  if (!row) throw new Error("conta não encontrada");
  const token = process.env["E2E_META_TOKEN"] || ports.vault.decrypt((row.connTok ?? row.accTok)!);
  const client = new MetaGraphClient({});
  const probe = async (label: string, path: string, params?: Record<string, string>) => {
    try {
      const r = await client.request<Record<string, unknown>>({ method: "GET", path, accessToken: token, ...(params ? { params } : {}) });
      const summary = path.endsWith("/adaccounts")
        ? { count: (r.data as unknown[])?.length }
        : path.endsWith("/ads")
          ? { ads: (r.data as unknown[])?.length }
          : Object.keys(r);
      console.log(`OK   ${label}:`, JSON.stringify(summary));
    } catch (e) {
      console.log(`FAIL ${label}:`, String(e).split("\n")[0]);
    }
  };
  console.log("metaAdAccountId:", row.meta, "| token source:", process.env["E2E_META_TOKEN"] ? "env" : "db");
  await probe("/me", "me", { fields: "id,name" });
  await probe("/me/adaccounts", "me/adaccounts", { fields: "id,name,account_status", limit: "50" });
  await probe("account/ads", `act_${row.meta.replace(/^act_/, "")}/ads`, { fields: "id", limit: "1" });
}
main().then(() => process.exit(0)).catch((e) => { console.error("ERRO:", String(e).split("\n")[0]); process.exit(1); });

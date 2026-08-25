import { eq } from "drizzle-orm";
import type { Database } from "./client.js";
import { orgs } from "./schema/index.js";

/**
 * Fuso configurado da org (`orgs.timezone`) com fallback (tipicamente `ANALYSIS_TZ`).
 * Datas de "hoje"/janela devem ser calculadas NESTE fuso (não UTC) — `insights_snapshots.date`
 * é gravado no fuso da conta Meta, então a consulta tem que casar o dia civil correto.
 */
export async function loadOrgTimezone(db: Database, orgId: string, fallback: string): Promise<string> {
  const [row] = await db.select({ timezone: orgs.timezone }).from(orgs).where(eq(orgs.id, orgId)).limit(1);
  return row?.timezone ?? fallback;
}

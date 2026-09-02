import { describe, expect, it, vi } from "vitest";
import type { Database } from "@trafego/db";
import { createNotifyRepo } from "./repo.js";

/** Mock de query builder do Drizzle: cada `.limit()` resolve a próxima lista enfileirada
 *  (ambient → directed → outbound, na ordem das queries de loadGroupTranscriptSources). */
function sequencedDb(results: readonly unknown[][]): Database {
  let call = 0;
  const chain: Record<string, unknown> = {};
  for (const m of ["select", "from", "innerJoin", "where", "orderBy"]) chain[m] = () => chain;
  chain["limit"] = () => Promise.resolve(results[call++] ?? []);
  return chain as unknown as Database;
}

describe("loadGroupTranscriptSources — inclui OUTBOUND do bot (fromBot)", () => {
  it("mescla ambiente + dirigidas (fromBot:false) + outbound do bot (fromBot:true, inclui o proativo)", async () => {
    const at = new Date("2026-09-02T21:00:00Z");
    const ambient = [{ authorPhone: "+5511111111111", authorName: "A", body: "papo do grupo", at, quotedAuthorPhone: null, quotedSnippet: null }];
    const directed = [{ authorPhone: "+5522222222222", authorName: "B", body: "pergunta", at, quotedAuthorPhone: null, quotedSnippet: null, quotedFromBot: false }];
    const outbound = [{ authorPhone: null, body: "Roy aqui. CPA de R$ 8,95 acima da meta.", at }];
    const db = sequencedDb([ambient, directed, outbound]);

    const res = await createNotifyRepo(db).loadGroupTranscriptSources("org", "grp", new Date(0), 25, "+5533333333333");

    const bot = res.filter((r) => r.fromBot);
    expect(bot).toHaveLength(1); // o proativo/análise do bot entra
    expect(bot[0]!.body).toContain("Roy aqui");
    expect(res.filter((r) => !r.fromBot)).toHaveLength(2); // ambiente + dirigida
  });
});

describe("purgeGroupMessagesBefore (retenção do contexto de grupo, S7)", () => {
  it("devolve o nº de linhas apagadas (delete .. where created_at < cutoff)", async () => {
    const returning = vi.fn(async () => [{ id: "a" }, { id: "b" }, { id: "c" }]);
    const where = vi.fn(() => ({ returning }));
    const del = vi.fn(() => ({ where }));
    const db = { delete: del } as unknown as Database;

    const count = await createNotifyRepo(db).purgeGroupMessagesBefore(new Date("2026-05-01T00:00:00Z"));

    expect(count).toBe(3);
    expect(del).toHaveBeenCalledOnce();
    expect(where).toHaveBeenCalledOnce();
  });
});

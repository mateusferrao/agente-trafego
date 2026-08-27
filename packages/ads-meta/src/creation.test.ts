import { afterEach, describe, expect, it, vi } from "vitest";
import { MetaGraphClient } from "./client.js";
import { MetaCreationService } from "./creation.js";

const account = { adAccountId: "act_123", accessToken: "tok" };

/** Stub: /copies devolve a cópia; POST no id da cópia (override de budget) devolve success. */
function stubGraph(copiesBody: Record<string, unknown>) {
  const posts: Array<{ url: string }> = [];
  const spy = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    posts.push({ url });
    const body = url.includes("/copies") ? copiesBody : { success: true };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", spy);
  return { posts: () => posts };
}

afterEach(() => vi.unstubAllGlobals());

function svc() {
  return new MetaCreationService(new MetaGraphClient({ graphVersion: "v26.0" }));
}

describe("MetaCreationService.duplicateEntity", () => {
  it("copia adset e retorna copiedId + childIds", async () => {
    stubGraph({
      copied_adset_id: "AS_NEW",
      ad_object_ids: [
        { ad_id: "AD1", copied_ad_id: "AD1_NEW" },
        { ad_id: "AD2", copied_ad_id: "AD2_NEW" },
      ],
    });
    const res = await svc().duplicateEntity(account, {
      sourceLevel: "adset",
      sourceId: "AS1",
      status: "paused",
    });
    expect(res.copiedId).toBe("AS_NEW");
    expect(res.childIds).toEqual(["AD1_NEW", "AD2_NEW"]);
  });

  it("duplicateEntity NÃO aplica budget (passo separado) — só /copies", async () => {
    const { posts } = stubGraph({ copied_adset_id: "AS_NEW", ad_object_ids: [] });
    await svc().duplicateEntity(account, { sourceLevel: "adset", sourceId: "AS1", status: "active" });
    const urls = posts().map((p) => p.url);
    expect(urls.some((u) => u.includes("AS1/copies"))).toBe(true);
    expect(urls.some((u) => u.includes("daily_budget"))).toBe(false);
  });

  it("setEntityBudget faz POST de daily_budget na entidade", async () => {
    const { posts } = stubGraph({ success: true });
    await svc().setEntityBudget(account, "AS_NEW", 9000);
    expect(posts().some((p) => p.url.includes("/AS_NEW") && p.url.includes("daily_budget=9000"))).toBe(true);
  });

  it("passa status_option ACTIVE/PAUSED no /copies", async () => {
    const { posts } = stubGraph({ copied_adset_id: "AS_NEW", ad_object_ids: [] });
    await svc().duplicateEntity(account, { sourceLevel: "adset", sourceId: "AS1", status: "paused" });
    const copies = posts().find((p) => p.url.includes("/copies"))!;
    expect(copies.url).toContain("status_option=PAUSED");
  });
});

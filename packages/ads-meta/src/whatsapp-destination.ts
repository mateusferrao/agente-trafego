import type { PageInfo, WhatsappDestination } from "@trafego/shared";
import { extractPhoneFromName } from "@trafego/shared";
import type { AdAccountRef } from "@trafego/shared/ports";
import type { MetaGraphClient } from "./client.js";
import { callWithGovernor } from "./call-with-governor.js";
import type { MetaGovernor } from "./governor.js";
import type { MetaCreativesService } from "./creatives.js";
import { normalizeAdAccountId } from "./ids.js";

/**
 * Resolve o número de WhatsApp de DESTINO de uma campanha (Fatia 7), escopado à campanha
 * — nunca de outra entidade (a raiz do bug). Hierarquia de honestidade:
 *  1. `meta_cta`  — número no `call_to_action.value` de um criativo da campanha (autoritativo).
 *  2. `meta_page` — número conectado à Página do criativo (best-effort; 403/ausente → cai adiante).
 *  3. `campaign_name` — telefone COMPLETO no nome da campanha (convenção do cliente; pede confirmação).
 *  4. `none`      — não consta.
 * Reusa `getCreatives` (mesma extração do cache do run → sem divergir).
 */
export class MetaWhatsappDestinationService {
  private readonly client: MetaGraphClient;
  private readonly governor: MetaGovernor;
  private readonly creatives: MetaCreativesService;
  /** teto de anúncios da campanha a inspecionar (só precisamos de 1 com CTA WhatsApp). */
  private static readonly AD_SCAN_LIMIT = 50;

  constructor(client: MetaGraphClient, governor: MetaGovernor, creatives: MetaCreativesService) {
    this.client = client;
    this.governor = governor;
    this.creatives = creatives;
  }

  async resolve(account: AdAccountRef, campaignId: string): Promise<WhatsappDestination> {
    const accountId = normalizeAdAccountId(account.adAccountId);
    // 1) promoted_object do CONJUNTO (destino CTWA REAL): em campanha click-to-WhatsApp o número NÃO
    // vai no link do CTA (vem genérico `api.whatsapp.com/send`) nem no `page.whatsapp_number` (vazio)
    // — mora em `adset.promoted_object.whatsapp_phone_number` (destination_type=WHATSAPP). É a fonte
    // autoritativa; 1 GET/campanha. Falha → cai pros tiers seguintes.
    const fromPromoted = await this.promotedObjectWhatsapp(account, campaignId);
    if (fromPromoted) return { number: fromPromoted, source: "meta_promoted_object" };

    // CTA dos criativos (quando o número está no wa.me). Falha (rate-limit/cooldown) NÃO derruba a
    // resolução: cai pros tiers seguintes (página → nome), que são baratos e igualmente honestos.
    let creatives: Awaited<ReturnType<MetaCreativesService["getCreatives"]>> = [];
    try {
      const adIds = await this.campaignAdIds(accountId, account.accessToken, campaignId);
      if (adIds.length > 0) creatives = await this.creatives.getCreatives(account, adIds);
    } catch {
      creatives = [];
    }

    const cta = creatives.find((c) => c.whatsappNumber);
    if (cta?.whatsappNumber) return { number: cta.whatsappNumber, source: "meta_cta" };

    const pageId = creatives.find((c) => c.pageId)?.pageId;
    if (pageId) {
      const fromPage = await this.pageWhatsapp(accountId, account.accessToken, pageId);
      if (fromPage) return { number: fromPage, source: "meta_page" };
    }

    const name = await this.campaignName(accountId, account.accessToken, campaignId);
    const fromName = name ? extractPhoneFromName(name) : null;
    if (fromName) return { number: fromName, source: "campaign_name", ...(name ? { entityName: name } : {}) };

    return { number: null, source: "none" };
  }

  /**
   * Número CTWA do `promoted_object.whatsapp_phone_number` dos conjuntos da campanha (destino REAL
   * de campanha click-to-WhatsApp). 1 GET/campanha; primeiro conjunto com número vence. Qualquer
   * falha → null (cai pros tiers seguintes). Escopado à campanha — nunca de outra entidade.
   */
  private async promotedObjectWhatsapp(account: AdAccountRef, campaignId: string): Promise<string | null> {
    try {
      const accountId = normalizeAdAccountId(account.adAccountId);
      const node = await callWithGovernor(
        accountId,
        () =>
          this.client.request<{ data?: ReadonlyArray<{ promoted_object?: { whatsapp_phone_number?: string } }> }>({
            method: "GET",
            path: `${campaignId}/adsets`,
            accessToken: account.accessToken,
            params: { fields: "promoted_object", limit: MetaWhatsappDestinationService.AD_SCAN_LIMIT },
          }),
        { governor: this.governor },
      );
      for (const adset of node.data ?? []) {
        const digits = (adset.promoted_object?.whatsapp_phone_number ?? "").replace(/\D+/g, "");
        if (digits.length > 0) return digits;
      }
      return null;
    } catch {
      return null;
    }
  }

  /** ids dos anúncios da campanha (1 página; só precisamos de um com CTA WhatsApp). */
  private async campaignAdIds(accountId: string, accessToken: string, campaignId: string): Promise<string[]> {
    const node = await callWithGovernor(
      accountId,
      () =>
        this.client.request<{ data?: ReadonlyArray<{ id?: string }> }>({
          method: "GET",
          path: `${campaignId}/ads`,
          accessToken,
          params: { fields: "id", limit: MetaWhatsappDestinationService.AD_SCAN_LIMIT },
        }),
      { governor: this.governor },
    );
    return (node.data ?? []).map((a) => a.id).filter((id): id is string => !!id);
  }

  /**
   * Número de WhatsApp conectado à Página — best-effort. O campo exato do Graph pode variar
   * por versão/permissão; sem `business_management` a chamada pode dar 403. Qualquer falha ou
   * ausência → `null` (cai pro nome). Não derruba a resolução.
   */
  private async pageWhatsapp(accountId: string, accessToken: string, pageId: string): Promise<string | null> {
    try {
      const node = await callWithGovernor(
        accountId,
        () =>
          this.client.request<{ whatsapp_number?: string }>({
            method: "GET",
            path: pageId,
            accessToken,
            params: { fields: "whatsapp_number" },
          }),
        { governor: this.governor },
      );
      const digits = (node.whatsapp_number ?? "").replace(/\D+/g, "");
      return digits.length > 0 ? digits : null;
    } catch {
      return null;
    }
  }

  /** Info de UMA Página (nome + WhatsApp conectado) — pra MOSTRAR o destino de uma campanha de
   *  conversas NO RASCUNHO (o número é da Página, conhecível antes de criar). `whatsappNumber`
   *  best-effort (a Meta frequentemente não expõe → ausente). Falha → só o pageId (nunca quebra). */
  async pageInfo(account: AdAccountRef, pageId: string): Promise<PageInfo> {
    const accountId = normalizeAdAccountId(account.adAccountId);
    try {
      const node = await callWithGovernor(
        accountId,
        () =>
          this.client.request<{ name?: string; whatsapp_number?: string }>({
            method: "GET",
            path: pageId,
            accessToken: account.accessToken,
            params: { fields: "name,whatsapp_number" },
          }),
        { governor: this.governor },
      );
      const digits = (node.whatsapp_number ?? "").replace(/\D+/g, "");
      return { pageId, ...(node.name ? { name: node.name } : {}), ...(digits.length > 0 ? { whatsappNumber: digits } : {}) };
    } catch {
      return { pageId };
    }
  }

  /**
   * Páginas que a conta pode promover (id/nome + WhatsApp conectado) — pra o dono ESCOLHER o destino
   * quando há N. `promote_pages` do ad account; `whatsapp_number` aninhado é best-effort. Sem
   * acesso/permissão (403) ou vazio → lista vazia (o caller degrada honesto). ⚠️ o campo exato pode
   * variar por versão/permissão da Graph — verificar contra conta real.
   */
  async listAccountPages(account: AdAccountRef): Promise<PageInfo[]> {
    const accountId = normalizeAdAccountId(account.adAccountId);
    try {
      const node = await callWithGovernor(
        accountId,
        () =>
          this.client.request<{ promote_pages?: { data?: ReadonlyArray<{ id?: string; name?: string; whatsapp_number?: string }> } }>({
            method: "GET",
            path: accountId,
            accessToken: account.accessToken,
            params: { fields: "promote_pages{id,name,whatsapp_number}" },
          }),
        { governor: this.governor },
      );
      const out: PageInfo[] = [];
      for (const p of node.promote_pages?.data ?? []) {
        if (!p.id) continue;
        const digits = (p.whatsapp_number ?? "").replace(/\D+/g, "");
        out.push({ pageId: p.id, ...(p.name ? { name: p.name } : {}), ...(digits.length > 0 ? { whatsappNumber: digits } : {}) });
      }
      return out;
    } catch {
      return [];
    }
  }

  private async campaignName(accountId: string, accessToken: string, campaignId: string): Promise<string | null> {
    try {
      const node = await callWithGovernor(
        accountId,
        () =>
          this.client.request<{ name?: string }>({
            method: "GET",
            path: campaignId,
            accessToken,
            params: { fields: "name" },
          }),
        { governor: this.governor },
      );
      return node.name ?? null;
    } catch {
      return null;
    }
  }
}

import type { AdAccountRef, DuplicateEntityInput, DuplicateResult } from "@trafego/shared/ports";
import type { MetaGraphClient } from "./client.js";

/** Sufixo de edge de cópia da Graph API. */
const COPIES_EDGE = "copies";
const STATUS_ACTIVE = "ACTIVE";
const STATUS_PAUSED = "PAUSED";
const BUDGET_FIELD_DAILY = "daily_budget";

/** Resposta do `/copies` (adset/campaign). `ad_object_ids` = pares origem→cópia. */
interface CopiesResponse {
  readonly copied_adset_id?: string;
  readonly copied_campaign_id?: string;
  readonly copied_ad_id?: string;
  readonly id?: string;
  readonly ad_object_ids?: ReadonlyArray<{ readonly ad_id?: string; readonly copied_ad_id?: string }>;
}

/** Id da cópia, tolerante ao nível (adset/campaign/ad) — a Graph nomeia por tipo. */
function copiedIdOf(body: CopiesResponse): string | null {
  return body.copied_adset_id ?? body.copied_campaign_id ?? body.copied_ad_id ?? body.id ?? null;
}

/**
 * Serviço de CRIAÇÃO/DUPLICAÇÃO na Meta (Fatia 7). Isola o vocabulário Meta (`/copies`,
 * `status_option`, `deep_copy`) — o core/shared falam `DuplicateEntityInput`/`DuplicateResult`.
 */
export class MetaCreationService {
  constructor(private readonly client: MetaGraphClient) {}

  /**
   * Duplica via `POST /{id}/copies` (deep_copy) e, quando `newDailyBudgetMinor`, ajusta o
   * budget da cópia num 2º POST. Retorna a cópia + filhos (ids p/ retomada idempotente).
   */
  async duplicateEntity(account: AdAccountRef, input: DuplicateEntityInput): Promise<DuplicateResult> {
    const statusOption = input.status === "active" ? STATUS_ACTIVE : STATUS_PAUSED;
    const params: Record<string, string> = {
      deep_copy: "true",
      status_option: statusOption,
    };
    if (input.destinationCampaignId) params["campaign_id"] = input.destinationCampaignId;
    if (input.renameSuffix) params["rename_options"] = JSON.stringify({ rename_suffix: input.renameSuffix });

    const { data } = await this.client.request<CopiesResponse>({
      method: "POST",
      path: `${input.sourceId}/${COPIES_EDGE}`,
      accessToken: account.accessToken,
      params,
    });

    const copiedId = copiedIdOf(data);
    if (!copiedId) {
      throw new Error("Meta /copies não retornou o id da cópia");
    }
    const childIds = (data.ad_object_ids ?? [])
      .map((p) => p.copied_ad_id)
      .filter((id): id is string => typeof id === "string");

    // escala: aplica o budget novo na cópia (o /copies herda o budget do original).
    if (input.newDailyBudgetMinor !== undefined) {
      await this.client.request({
        method: "POST",
        path: copiedId,
        accessToken: account.accessToken,
        params: { [BUDGET_FIELD_DAILY]: String(input.newDailyBudgetMinor) },
      });
    }

    return { copiedId, childIds };
  }
}

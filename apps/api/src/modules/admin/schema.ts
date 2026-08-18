import { z } from "zod";

/** Corpo de POST /admin/accounts — cola token + identifica a conta Meta. */
export const connectAccountInput = z.object({
  metaBusinessId: z.string().min(1),
  adAccountId: z.string().min(1),
  token: z.string().min(1),
});
export type ConnectAccountInput = z.infer<typeof connectAccountInput>;

/** Param :id de POST /admin/accounts/:id/run (linha em ad_accounts). */
export const runParams = z.object({ id: z.string().uuid() });

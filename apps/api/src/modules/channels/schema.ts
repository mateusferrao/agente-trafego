import { z } from "zod";

export const channelStateOutput = z.object({
  status: z.enum(["disconnected", "connecting", "connected"]),
  qrCode: z.string().optional(),
  phone: z.string().optional(),
});
export type ChannelStateOutput = z.infer<typeof channelStateOutput>;

// Verificação de contato (§8: opt-in — contato verificado manda a 1ª msg).
export const verifyContactInput = z.object({
  phone: z.string().regex(/^\+[1-9]\d{6,14}$/, "E.164 esperado"),
  userId: z.string(),
  role: z.enum(["owner", "member"]).default("member"),
});
export type VerifyContactInput = z.infer<typeof verifyContactInput>;

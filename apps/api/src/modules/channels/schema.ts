import { z } from "zod";

export const channelStateOutput = z.object({
  status: z.enum(["disconnected", "connecting", "connected"]),
  qrCode: z.string().optional(),
  phone: z.string().optional(),
});
export type ChannelStateOutput = z.infer<typeof channelStateOutput>;

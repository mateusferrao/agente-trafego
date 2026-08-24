import { z } from "zod";

export const groupSummary = z.object({
  jid: z.string(),
  name: z.string().nullable(),
  size: z.number().optional(),
});
export type GroupSummary = z.infer<typeof groupSummary>;

/** Grupos que o número já integra (Evolution) + qual está ativo (se algum) pra org. */
export const groupsListOutput = z.object({
  channelConnected: z.boolean(),
  groups: z.array(groupSummary),
  activeGroupJid: z.string().nullable(),
});
export type GroupsListOutput = z.infer<typeof groupsListOutput>;

export const setGroupInput = z.object({
  groupJid: z.string().min(1),
  name: z.string().min(1).max(200).optional(),
});
export type SetGroupInput = z.infer<typeof setGroupInput>;

/** Estado do grupo ativo da org — espelha `channelStateOutput` (canal/número). */
export const channelGroupStateOutput = z.object({
  active: z.boolean(),
  groupJid: z.string().nullable(),
  name: z.string().nullable(),
});
export type ChannelGroupStateOutput = z.infer<typeof channelGroupStateOutput>;

import { z } from "zod";

const phone = z.string().regex(/^\+[1-9]\d{6,14}$/, "Telefone no formato internacional (ex: +5511999999999)");

// Início do opt-in: envia código pelo WhatsApp p/ o telefone do dono.
export const startVerificationInput = z.object({
  phone,
  userId: z.string().optional(),
});
export type StartVerificationInput = z.infer<typeof startVerificationInput>;

export const startVerificationOutput = z.object({
  sent: z.boolean(),
  /** ISO — quando o código expira (fonte única no backend; a tela conta a partir daqui). */
  expiresAt: z.string(),
});
export type StartVerificationOutput = z.infer<typeof startVerificationOutput>;

/** Destinatário atual (verificado) da org — `recipient` null se ainda não há. */
export const recipientOutput = z.object({
  recipient: z.object({ phone: z.string(), verified: z.boolean() }).nullable(),
});
export type RecipientOutput = z.infer<typeof recipientOutput>;

export const removeRecipientOutput = z.object({ removed: z.boolean() });
export type RemoveRecipientOutput = z.infer<typeof removeRecipientOutput>;

// Confirmação: o dono digita o código recebido no WhatsApp.
export const confirmVerificationInput = z.object({
  phone,
  code: z.string().regex(/^\d{6}$/, "Código de 6 dígitos"),
});
export type ConfirmVerificationInput = z.infer<typeof confirmVerificationInput>;

export const confirmVerificationOutput = z.object({ verified: z.boolean() });
export type ConfirmVerificationOutput = z.infer<typeof confirmVerificationOutput>;

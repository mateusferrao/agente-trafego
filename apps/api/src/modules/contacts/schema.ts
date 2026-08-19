import { z } from "zod";

const phone = z.string().regex(/^\+[1-9]\d{6,14}$/, "Telefone no formato internacional (ex: +5511999999999)");

// Início do opt-in: envia código pelo WhatsApp p/ o telefone do dono.
export const startVerificationInput = z.object({
  phone,
  userId: z.string().optional(),
});
export type StartVerificationInput = z.infer<typeof startVerificationInput>;

export const startVerificationOutput = z.object({ sent: z.boolean() });
export type StartVerificationOutput = z.infer<typeof startVerificationOutput>;

// Confirmação: o dono digita o código recebido no WhatsApp.
export const confirmVerificationInput = z.object({
  phone,
  code: z.string().regex(/^\d{6}$/, "Código de 6 dígitos"),
});
export type ConfirmVerificationInput = z.infer<typeof confirmVerificationInput>;

export const confirmVerificationOutput = z.object({ verified: z.boolean() });
export type ConfirmVerificationOutput = z.infer<typeof confirmVerificationOutput>;

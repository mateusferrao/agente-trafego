import type { EmailMessage } from "@trafego/shared/ports";

const APP_NAME = "Agente de Tráfego";

/** Escapa HTML (defesa contra injeção no corpo do email). Puro. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Email de verificação (código OTP). Builder puro (testável). */
export function buildVerificationEmail(params: { to: string; from: string; code: string }): EmailMessage {
  const code = escapeHtml(params.code);
  return {
    to: params.to,
    from: params.from,
    subject: `${APP_NAME} — seu código de verificação`,
    text: `Seu código de verificação é ${params.code}. Ele expira em alguns minutos. Se você não criou uma conta, ignore este email.`,
    html: `<p>Seu código de verificação:</p><p style="font-size:24px;font-weight:bold;letter-spacing:3px">${code}</p><p>Ele expira em alguns minutos. Se você não criou uma conta, ignore este email.</p>`,
    category: "auth",
  };
}

/** Email de reset de senha (link com token opaco). Builder puro. */
export function buildPasswordResetEmail(params: { to: string; from: string; resetUrl: string }): EmailMessage {
  const safeUrl = escapeHtml(params.resetUrl);
  return {
    to: params.to,
    from: params.from,
    subject: `${APP_NAME} — redefinir sua senha`,
    text: `Você pediu para redefinir sua senha. Acesse ${params.resetUrl} para criar uma nova. O link expira em breve. Se não foi você, ignore este email — sua senha continua a mesma.`,
    html: `<p>Você pediu para redefinir sua senha.</p><p><a href="${safeUrl}">Criar uma nova senha</a></p><p>O link expira em breve. Se não foi você, ignore este email — sua senha continua a mesma.</p>`,
    category: "auth",
  };
}

/**
 * Email de "conta já existe" — enviado no signup de email já cadastrado. Só o dono
 * real recebe; a resposta HTTP do signup é idêntica (anti-enumeração).
 */
export function buildAccountExistsEmail(params: { to: string; from: string; appUrl: string }): EmailMessage {
  const login = `${params.appUrl}/login`;
  const safeLogin = escapeHtml(login);
  return {
    to: params.to,
    from: params.from,
    subject: `${APP_NAME} — você já tem uma conta`,
    text: `Alguém tentou criar uma conta com este email, mas você já tem uma. Para entrar, acesse ${login}. Se esqueceu a senha, use "Esqueci minha senha".`,
    html: `<p>Alguém tentou criar uma conta com este email, mas você já tem uma.</p><p>Para entrar, acesse <a href="${safeLogin}">${safeLogin}</a>. Se esqueceu a senha, use "Esqueci minha senha".</p>`,
    category: "auth",
  };
}

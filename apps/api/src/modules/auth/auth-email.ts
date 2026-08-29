import type { EmailMessage } from "@trafego/shared/ports";
import { AGENT_NAME } from "@trafego/shared";

const APP_NAME = "CaquiAI";

// Paleta de marca (subset seguro p/ e-mail — sem depender de fontes/offset).
const C_INK = "#0c1134";
const C_PAPER = "#fbf9f4";
const C_CAQUI = "#e8720d";
const C_MUTED = "#4a5070";
const C_LINE = "#e6e2d8";
const FONT = "Arial, Helvetica, sans-serif";

/** Escapa HTML (defesa contra injeção no corpo do email). Puro. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Layout de marca robusto (CSS inline + tabela; wordmark em texto, sem imagem/fonte
// externa). "Marca robusta" — renderiza bem em qualquer cliente de e-mail.
function wrapEmailHtml(inner: string): string {
  return `<div style="margin:0;padding:24px;background:${C_PAPER};font-family:${FONT};color:${C_INK}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;margin:0 auto">
<tr><td style="padding:0 0 16px 2px;font-size:20px;font-weight:bold;color:${C_INK}">Caqui<span style="color:${C_CAQUI}">AI</span></td></tr>
<tr><td style="background:#ffffff;border:1px solid ${C_LINE};border-radius:12px;padding:24px;font-size:15px;line-height:1.55">${inner}</td></tr>
<tr><td style="padding:16px 2px 0;font-size:12px;color:${C_MUTED}">${APP_NAME} — gestão de tráfego pago no WhatsApp.</td></tr>
</table></div>`;
}

function emailButton(href: string, label: string): string {
  return `<a href="${href}" style="display:inline-block;background:${C_INK};color:${C_PAPER};text-decoration:none;padding:11px 20px;border-radius:10px;font-weight:bold">${label}</a>`;
}

/** Email de verificação (código OTP). Builder puro (testável). Zona crítica: sóbrio. */
export function buildVerificationEmail(params: { to: string; from: string; code: string }): EmailMessage {
  const code = escapeHtml(params.code);
  return {
    to: params.to,
    from: params.from,
    subject: `${APP_NAME} — seu código de verificação`,
    text: `Seu código de verificação é ${params.code}. Ele expira em alguns minutos. Se você não criou uma conta, ignore este email.`,
    html: wrapEmailHtml(
      `<p style="margin:0 0 12px">Seu código de verificação:</p>` +
        `<p style="margin:0 0 12px;font-size:28px;font-weight:bold;letter-spacing:4px;color:${C_INK}">${code}</p>` +
        `<p style="margin:0;color:${C_MUTED}">Ele expira em alguns minutos. Se você não criou uma conta, ignore este email.</p>`,
    ),
    category: "auth",
  };
}

/**
 * Email de "acesso liberado" (6b) — disparado no `access:grant`. É o primeiro aperto
 * de mão: apresenta o Roy (zona de marca, tom caloroso, sem exclamação/confete).
 */
export function buildAccessGrantedEmail(params: { to: string; from: string; appUrl: string }): EmailMessage {
  const login = `${params.appUrl}/login`;
  const safeLogin = escapeHtml(login);
  return {
    to: params.to,
    from: params.from,
    subject: `${APP_NAME} — seu acesso foi liberado`,
    text: `Seu acesso ao ${APP_NAME} está liberado. Entre e conheça o ${AGENT_NAME}, seu agente de tráfego, em ${login}.`,
    html: wrapEmailHtml(
      `<p style="margin:0 0 16px">Seu acesso ao ${APP_NAME} está liberado. Entre e conheça o <strong>${AGENT_NAME}</strong>, seu agente de tráfego.</p>` +
        `<p style="margin:0">${emailButton(safeLogin, "Entrar agora")}</p>`,
    ),
    category: "auth",
  };
}

/** Email de reset de senha (link com token opaco). Builder puro. Zona crítica: sóbrio. */
export function buildPasswordResetEmail(params: { to: string; from: string; resetUrl: string }): EmailMessage {
  const safeUrl = escapeHtml(params.resetUrl);
  return {
    to: params.to,
    from: params.from,
    subject: `${APP_NAME} — redefinir sua senha`,
    text: `Você pediu para redefinir sua senha. Acesse ${params.resetUrl} para criar uma nova. O link expira em breve. Se não foi você, ignore este email. Sua senha continua a mesma.`,
    html: wrapEmailHtml(
      `<p style="margin:0 0 16px">Você pediu para redefinir sua senha.</p>` +
        `<p style="margin:0 0 16px">${emailButton(safeUrl, "Criar uma nova senha")}</p>` +
        `<p style="margin:0;color:${C_MUTED}">O link expira em breve. Se não foi você, ignore este email. Sua senha continua a mesma.</p>`,
    ),
    category: "auth",
  };
}

/**
 * Email de "conta já existe" — enviado no signup de email já cadastrado. Só o dono
 * real recebe; a resposta HTTP do signup é idêntica (anti-enumeração). Zona sóbria.
 */
export function buildAccountExistsEmail(params: { to: string; from: string; appUrl: string }): EmailMessage {
  const login = `${params.appUrl}/login`;
  const safeLogin = escapeHtml(login);
  return {
    to: params.to,
    from: params.from,
    subject: `${APP_NAME} — você já tem uma conta`,
    text: `Alguém tentou criar uma conta com este email, mas você já tem uma. Para entrar, acesse ${login}. Se esqueceu a senha, use "Esqueci minha senha".`,
    html: wrapEmailHtml(
      `<p style="margin:0 0 12px">Alguém tentou criar uma conta com este email, mas você já tem uma.</p>` +
        `<p style="margin:0">Para entrar, acesse <a href="${safeLogin}" style="color:${C_CAQUI}">${safeLogin}</a>. Se esqueceu a senha, use "Esqueci minha senha".</p>`,
    ),
    category: "auth",
  };
}

import { HttpContext, HttpContextToken, HttpErrorResponse } from '@angular/common/http';
import type { HttpEvent, HttpHandlerFn, HttpRequest } from '@angular/common/http';
import { catchError, throwError } from 'rxjs';
import type { Observable } from 'rxjs';
import { toast } from 'ngx-sonner';
import { environment } from '../../../environments/environment';

/**
 * Quando `true` no contexto da requisição, o interceptor NÃO dispara toast de
 * erro. Usado onde o erro é tratado inline (login/signup exibem mensagem no form,
 * o bootstrap de sessão trata 401 como "anônimo" silenciosamente).
 */
export const API_ERROR_TOAST_DISABLED = new HttpContextToken<boolean>(() => false);

/** Açúcar para montar o contexto silencioso numa chamada. */
export function silentApiContext(): HttpContext {
  return new HttpContext().set(API_ERROR_TOAST_DISABLED, true);
}

/**
 * Interceptor de borda: em resposta de erro de uma chamada à API, mostra um toast
 * com mensagem AMIGÁVEL (nunca vaza stack/`Error:`/código cru — uma frase: o que
 * aconteceu + o que fazer). Erros continuam propagando para quem chamou.
 */
export function apiRequestInterceptor(
  req: HttpRequest<unknown>,
  next: HttpHandlerFn,
): Observable<HttpEvent<unknown>> {
  return next(req).pipe(
    catchError((error: unknown) => {
      if (
        error instanceof HttpErrorResponse &&
        isApiUrl(req.url) &&
        !req.context.get(API_ERROR_TOAST_DISABLED)
      ) {
        const notification = friendlyError(error);
        toast.error(notification.title, { description: notification.description });
      }
      return throwError(() => error);
    }),
  );
}

interface FriendlyNotification {
  title: string;
  description: string;
}

function friendlyError(error: HttpErrorResponse): FriendlyNotification {
  const detail = readErrorDetail(error);

  if (error.status === 0) {
    return {
      title: 'Sem conexão com o servidor',
      description: 'Verifique sua internet e tente novamente em instantes.',
    };
  }

  if (error.status === 401) {
    return {
      title: 'Sessão expirada',
      description: 'Entre novamente para continuar.',
    };
  }

  if (error.status === 403) {
    return {
      title: 'Acesso negado',
      description: 'Você não tem permissão para esta ação.',
    };
  }

  if (error.status === 404) {
    return {
      title: 'Não encontramos esse recurso',
      description: 'Atualize a página e tente de novo.',
    };
  }

  if (error.status === 409 || error.status === 422) {
    return {
      title: 'Não foi possível concluir',
      description: detail ?? 'Revise os dados informados e tente novamente.',
    };
  }

  if (error.status >= 500) {
    return {
      title: 'Algo deu errado do nosso lado',
      description: 'Tente novamente em instantes. Se persistir, fale com o suporte.',
    };
  }

  return {
    title: 'Não foi possível concluir',
    description: detail ?? 'Tente novamente em instantes.',
  };
}

function isApiUrl(url: string): boolean {
  return url.startsWith(environment.apiBaseUrl);
}

/**
 * Extrai uma mensagem legível do corpo do erro, se houver. Só retorna algo que
 * pareça texto de gente — nunca stack traces ou objetos crus.
 */
function readErrorDetail(error: HttpErrorResponse): string | null {
  const body = error.error;
  if (typeof body === 'string') {
    const trimmed = body.trim();
    return trimmed && !looksTechnical(trimmed) ? trimmed : null;
  }
  if (!isRecord(body)) {
    return null;
  }
  const candidates = [body['message'], body['detail'], body['reason']];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim() && !looksTechnical(candidate)) {
      return candidate.trim();
    }
  }
  return null;
}

function looksTechnical(text: string): boolean {
  return /error:|exception|stack|\bat \w+\.|undefined|null pointer|<[^>]+>/i.test(text);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Barrel de core/auth — sessão do lado do cliente. App code importa daqui.
export { AuthStore } from './auth.store';
export { AuthApiService } from './auth-api.service';
export { authGuard, guestOnlyGuard } from './auth.guard';
export { authSessionInterceptor } from './auth-session.interceptor';

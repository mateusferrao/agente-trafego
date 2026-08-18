// Barrel público de core/api. App code importa daqui — nunca de arquivos gerados
// soltos. Reexporta os TIPOS do contrato (kubb) + a base HTTP e o interceptor.
export * from './generated';
export { BaseApiService } from './base-api.service';
export type { ApiRequestOptions, ApiPath, ApiPathSegment } from './base-api.service';
export {
  apiRequestInterceptor,
  silentApiContext,
  API_ERROR_TOAST_DISABLED,
} from './api-request.interceptor';

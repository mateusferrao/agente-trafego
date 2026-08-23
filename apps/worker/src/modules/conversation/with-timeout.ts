// Corrida contra um teto de tempo — nunca deixa o turno do chat esperar pra sempre
// se alguma chamada externa (Meta, LLM, DB) travar sem dar erro. `Promise.race` não
// cancela a operação original (ela segue rodando em background até resolver/rejeitar
// por conta própria — limitação do JS sem AbortController threado pelo grafo inteiro),
// mas garante que o CHAMADOR nunca fica pendurado além do teto.

export class TimeoutError extends Error {
  constructor(ms: number) {
    super(`operação excedeu ${ms}ms`);
    this.name = "TimeoutError";
  }
}

export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      setTimeout(() => reject(new TimeoutError(ms)), ms).unref?.();
    }),
  ]);
}

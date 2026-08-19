// Map com concorrência limitada (pool bounded) — orquestração pura de control-flow.
// Preserva a ordem dos resultados; roda no máximo `limit` tarefas ao mesmo tempo.
// Usado pelo map_units p/ analisar N campanhas em paralelo sem estourar o rate-limit.

/**
 * Aplica `fn` a cada item com no máximo `limit` execuções concorrentes. Retorna os
 * resultados NA ORDEM dos itens (não na ordem de conclusão). Se `fn` rejeitar, a
 * rejeição propaga (o chamador trata erros esperados dentro da própria `fn`).
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  const poolSize = Math.min(Math.max(1, Math.floor(limit)), items.length);
  let cursor = 0;

  async function runner(): Promise<void> {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index]!, index);
    }
  }

  await Promise.all(Array.from({ length: poolSize }, () => runner()));
  return results;
}

/** Pausa `ms` (injetável nos consumidores p/ teste determinístico, sem timer real). */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

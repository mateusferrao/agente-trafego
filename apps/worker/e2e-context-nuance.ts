/** Testa se o matcher é CONTEXTUAL de verdade (nuance) ou só por nicho: 3 criativos TODOS de
 *  estética, diferindo em ângulo/formato. Muda só a ORIENTAÇÃO e vê se a escolha ACOMPANHA. */
import { buildComposition } from "./src/composition.js";
import { pickLibraryCreativeByContext, type LibraryCandidate } from "./src/modules/creative/match-library.js";

const CANDS: LibraryCandidate[] = [
  { assetId: "antes_depois", description: "Antes/depois de harmonização facial numa clínica de estética · Ângulo: prova visual do resultado · Formato: antes-depois" },
  { assetId: "depoimento", description: "Depoimento em vídeo de paciente real elogiando o atendimento e a confiança · Ângulo: prova social · Formato: depoimento/UGC" },
  { assetId: "educativo", description: "Profissional explicando o procedimento passo a passo · Ângulo: autoridade/educação · Formato: talking-head" },
];

async function main() {
  const { ports, analysis } = await buildComposition();
  const model = analysis.messageModel;
  const biz = "Clínica de estética; foco em agendamentos de avaliação.";
  const run = async (label: string, guidance: string | null) => {
    const pick = await pickLibraryCreativeByContext(ports.llm, model, { goal: "lead", businessContext: biz, guidance }, CANDS);
    console.log(`  [${label}] guidance=${guidance ?? "(nenhuma)"} → escolha: ${pick}`);
    return pick;
  };

  console.log("▶ MESMO nicho (estética), muda só a orientação — a escolha deve ACOMPANHAR:");
  const provaSocial = await run("prova social", "Priorizar prova social e depoimentos reais de pacientes.");
  const resultado = await run("resultado visual", "Priorizar mostrar o resultado visual, antes e depois.");
  const autoridade = await run("autoridade", "Priorizar tom educativo e autoridade, explicando o procedimento.");
  const semSteer = await run("sem orientação", null);

  console.log("\n── veredito ──");
  console.log("  prova social → depoimento?", provaSocial === "depoimento" ? "✅" : `⚠️ (${provaSocial})`);
  console.log("  resultado visual → antes_depois?", resultado === "antes_depois" ? "✅" : `⚠️ (${resultado})`);
  console.log("  autoridade → educativo?", autoridade === "educativo" ? "✅" : `⚠️ (${autoridade})`);
  const shifts = new Set([provaSocial, resultado, autoridade]).size;
  console.log(`  a escolha MUDOU com a orientação? ${shifts >= 2 ? "✅ sim (contextual de verdade)" : "❌ não (raso/fixo)"} — ${shifts} escolhas distintas`);
  console.log("  sem orientação (só objetivo+nicho):", semSteer);
}
main().then(() => process.exit(0)).catch((e) => { console.error("ERRO:", String(e).split("\n").slice(0, 3).join(" | ")); process.exit(1); });

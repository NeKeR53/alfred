/**
 * Appel unique au modèle depuis une page ou une fonction : une consigne et un contexte entrent, un objet conforme à
 * un schéma JSON sort, en un tour. Il passe par le modèle réglé pour les pages (Réglages → Agent, « Dans les pages »,
 * par défaut celui de l’agent), dans une session sans outil qui n’est pas gardée dans l’historique du CLI. La réponse
 * est validée ; si elle est invalide, le modèle est relancé une fois avec la liste des écarts. Un modèle des pages qui
 * ne répond pas cède la place à celui de l’agent, et le journal le dit.
 */
import { extractJson, validateSchema } from "../../lib/jsonSchema";
import { AlfredError, invoke } from "../../lib/native";
import { useShell } from "../../shell/store";
import { createSession } from "./harness/native";
import type { HarnessEvent, HarnessSession, Provider } from "./harness/types";
import { modelSummary, type PageModel, resolvePageModel, sameModel } from "./pageModel";

export interface OneShotRequest {
  instruction: string;
  context?: unknown;
  schema: Record<string, unknown>;
}

const MAX_CONTEXT_CHARACTERS = 120_000;
const SCHEMA_ERROR = "La réponse du modèle ne respecte pas le schéma demandé.";
const TIMEOUT_MS = 180_000;

function prompt(request: OneShotRequest, correction?: string): string {
  const context =
    request.context === undefined || request.context === null
      ? ""
      : typeof request.context === "string"
        ? request.context
        : JSON.stringify(request.context, null, 2);
  return [
    "Tu réponds à un appel unique depuis une application. Réponds uniquement par un objet JSON conforme au schéma, sans aucun texte autour, sans bloc de code.",
    `Consigne :\n${request.instruction}`,
    context ? `Contexte :\n${context.slice(0, MAX_CONTEXT_CHARACTERS)}` : "",
    `Schéma JSON de la réponse :\n${JSON.stringify(request.schema)}`,
    correction ? `Ta réponse précédente était invalide :\n${correction}\nCorrige-la.` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * Un tour dans une session sans outil ; renvoie le texte de la réponse et, avec un schéma, le résultat structuré du
 * harnais.
 */
async function turn(
  provider: Provider,
  model: string | undefined,
  effort: string | undefined,
  cwd: string,
  schema: Record<string, unknown> | undefined,
  text: string,
  timeoutMs = TIMEOUT_MS,
): Promise<{ answer: string; structured: unknown }> {
  let answer = "";
  let structured: unknown;
  let failure: string | undefined;
  let finish: () => void = () => undefined;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const pieces = new Map<string, string>();
  const onEvent = (event: HarnessEvent) => {
    if (event.type === "message") {
      pieces.set(event.itemId, event.replace ? event.content : (pieces.get(event.itemId) ?? "") + event.content);
      answer = [...pieces.values()].join("");
    } else if (event.type === "error") failure = event.message;
    else if (event.type === "status" && (event.status === "idle" || event.status === "closed")) finish();
  };
  const common = { cwd, model, effort, autonomy: "strict" as const, onEvent };
  let session: HarnessSession | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    session = await createSession({
      ...common,
      provider,
      oneShot: true,
      ...(schema ? { outputSchema: schema } : {}),
      onStructuredResult: (value) => {
        structured = value;
      },
    });
    await session.send(text);
    await Promise.race([
      done,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new AlfredError({ message: "Le modèle n’a pas répondu à temps." })), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    await session?.close().catch(() => undefined);
  }
  if (failure) throw new AlfredError({ message: failure });
  return { answer, structured };
}

async function ask(
  provider: Provider,
  model: string | undefined,
  effort: string | undefined,
  cwd: string,
  request: OneShotRequest,
  text: string,
) {
  const { answer, structured } = await turn(provider, model, effort, cwd, request.schema, text);
  return structured !== undefined ? structured : extractJson(answer);
}

/**
 * Appel texte au modèle donné, sans outil ni historique : une consigne entre, la réponse sort telle quelle. Sert au
 * nommage des conversations.
 */
export async function complete(
  prompt: string,
  selection: { provider: Provider; model?: string; effort?: string },
  timeoutMs = TIMEOUT_MS,
): Promise<string> {
  const cwd = useShell.getState().snapshot?.path ?? "";
  const { answer } = await turn(
    selection.provider,
    selection.model,
    selection.effort,
    cwd,
    undefined,
    prompt,
    timeoutMs,
  );
  return answer;
}

/** Réponse validée du modèle donné, avec au plus une relance sur les écarts. */
async function structuredAnswer(selection: PageModel, cwd: string, request: OneShotRequest): Promise<unknown> {
  const { provider, model, effort } = selection;
  // Une réponse sans JSON lisible est un écart comme un autre : elle a droit à la même relance.
  const attempt = async (text: string): Promise<{ value: unknown; errors: string[] }> => {
    try {
      const answer = await ask(provider, model, effort, cwd, request, text);
      return { value: answer, errors: validateSchema(answer, request.schema) };
    } catch (error) {
      if (error instanceof Error && /JSON lisible/.test(error.message))
        return { value: undefined, errors: [error.message] };
      throw error;
    }
  };
  let { value, errors } = await attempt(prompt(request));
  if (errors.length) {
    // Une seule relance : au-delà, c’est le schéma ou la consigne qu’il faut revoir.
    ({ value, errors } = await attempt(prompt(request, errors.slice(0, 20).join("\n"))));
  }
  if (errors.length) throw new AlfredError({ message: SCHEMA_ERROR, detail: errors });
  return value;
}

export async function oneShot(request: OneShotRequest, caller: string): Promise<unknown> {
  if (typeof request.instruction !== "string" || !request.instruction.trim())
    throw new AlfredError({ message: "L’appel unique demande une consigne (`instruction`)." });
  if (!request.schema || typeof request.schema !== "object")
    throw new AlfredError({ message: "L’appel unique demande le schéma JSON de la réponse (`schema`)." });
  const { page, agent } = await resolvePageModel();
  let used: PageModel = page;
  let fallback = page.fallback;
  const cwd = useShell.getState().snapshot?.path ?? "";
  const started = performance.now();
  const record = (ok: boolean, summary: string) =>
    invoke("journal.record", {
      kind: "ai",
      subject: caller,
      ok,
      durationMs: Math.round(performance.now() - started),
      summary: fallback ? `${summary} (${fallback})` : summary,
      detail: {
        provider: used.provider,
        model: used.model ?? null,
        ...(used.effort ? { effort: used.effort } : {}),
        ...(fallback ? { fallback } : {}),
        instruction: request.instruction.slice(0, 500),
      },
    }).catch(() => undefined);
  try {
    let value: unknown;
    try {
      value = await structuredAnswer(page, cwd, request);
    } catch (error) {
      // Le modèle réglé pour les pages ne répond pas (CLI en échec, délai dépassé) : celui de l’agent prend le relais.
      // Une réponse hors schéma n’est pas un silence : elle ne change pas de modèle.
      const silent = !(error instanceof Error && error.message === SCHEMA_ERROR);
      if (!silent || page.fallback || sameModel(page, agent)) throw error;
      fallback = `${modelSummary(page)}, réglé pour les pages, n’a pas répondu (${error instanceof Error ? error.message : String(error)}) : ${modelSummary(agent)}, celui de l’agent, a pris le relais`;
      used = agent;
      value = await structuredAnswer(agent, cwd, request);
    }
    void record(true, `Appel unique via ${modelSummary(used)}`);
    return value;
  } catch (error) {
    void record(
      false,
      `Appel unique via ${modelSummary(used)} : ${error instanceof Error ? error.message : String(error)}`,
    );
    throw error;
  }
}

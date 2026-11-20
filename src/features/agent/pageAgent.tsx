/**
 * Agent lancé par une page (mode agentique) : une vraie conversation, affichée dans le panneau de droite de la page
 * et retrouvée dans la page Agent. La page reçoit le dernier message du premier tour et, si elle a fourni un schéma,
 * le résultat structuré que l’agent a rendu.
 */

import { IconButton } from "@alfred/ui";
import { ExternalLink } from "lucide-react";
import { useEffect } from "react";
import { extractJson, validateSchema } from "../../lib/jsonSchema";
import { AlfredError, invoke } from "../../lib/native";
import { declaredReference, type FrameIdentity, frameServices } from "../../shell/frameBridge";
import { PanelBar } from "../../shell/ResizablePanel";
import { useShell } from "../../shell/store";
import { Composer } from "./Composer";
import type { Autonomy, Provider } from "./harness";
import { type ConversationRuntime, lastAssistantText } from "./model";
import { oneShot } from "./oneShot";
import { modelSummary, resolvePageModel } from "./pageModel";
import { bindAgentQuestions, useAgents, waitForTurn } from "./store";
import { Transcript } from "./Transcript";
import "./agent.css";

const idle: ConversationRuntime = { status: "idle", approvals: [], questions: [], queued: [] };

function pageTitle(reference: string): string {
  const snapshot = useShell.getState().snapshot;
  const pages = [...(snapshot?.sections.flatMap((section) => section.pages) ?? []), ...(snapshot?.settingsPages ?? [])];
  return pages.find((page) => page.reference === reference)?.title ?? reference;
}

/** `ai.startAgent` : la conversation est inscrite au journal (type Agents), comme `ai.oneShot` l’est (type IA). */
async function startAgent(identity: FrameIdentity, options: Record<string, unknown>) {
  const instruction = typeof options.instruction === "string" ? options.instruction.trim() : "";
  if (!instruction) throw new AlfredError({ message: "Lancer un agent demande une consigne (`instruction`)." });
  const started = performance.now();
  // Le modèle réglé pour les pages (Réglages → Agent, « Dans les pages »), sinon celui de l’agent.
  const { page: model } = await resolvePageModel();
  const record = (ok: boolean, summary: string, conversation?: string) =>
    invoke("journal.record", {
      kind: "agent",
      subject: identity.reference,
      ok,
      durationMs: Math.round(performance.now() - started),
      summary: model.fallback ? `${summary} (${model.fallback})` : summary,
      detail: {
        conversation: conversation ?? null,
        provider: model.provider,
        model: model.model ?? null,
        ...(model.effort ? { effort: model.effort } : {}),
        ...(model.fallback ? { fallback: model.fallback } : {}),
        instruction: instruction.slice(0, 500),
      },
    }).catch(() => undefined);
  try {
    const result = await runAgent(identity, options, instruction, model);
    void record(true, `Conversation d’agent via ${modelSummary(model)}`, result.conversationId);
    return result.value;
  } catch (error) {
    void record(
      false,
      `Conversation d’agent via ${modelSummary(model)} : ${error instanceof Error ? error.message : String(error)}`,
    );
    throw error;
  }
}

async function runAgent(
  identity: FrameIdentity,
  options: Record<string, unknown>,
  instruction: string,
  model: { provider: Provider; model?: string; effort?: string },
) {
  bindAgentQuestions();
  const fromPage = identity.kind !== "function";
  const page = identity.host ?? identity.reference;
  const title = fromPage ? pageTitle(page) : identity.module;
  // Une fonction offerte est son nom, ou `{ name, input }` : ces entrées sont imposées, le modèle ne les change pas.
  const functions = Array.isArray(options.functions)
    ? options.functions.map((offered) => {
        const qualify = (name: string) => (name.includes("/") ? name : `${identity.module}/${name}`);
        if (offered && typeof offered === "object" && !Array.isArray(offered)) {
          const { name, input } = offered as { name?: unknown; input?: unknown };
          return { name: qualify(String(name ?? "")), input: input && typeof input === "object" ? input : {} };
        }
        return qualify(String(offered));
      })
    : [];
  const mode = options.mode === undefined ? undefined : String(options.mode);
  const folder =
    options.folder && typeof options.folder === "object"
      ? (options.folder as { id?: unknown; path?: unknown })
      : undefined;
  // Une page n’est pas l’utilisateur : la conversation ne touche qu’au module de la page, sauf fonctions d’autres
  // modules accordées par l’utilisateur. Elle travaille dans le dossier que Rust a vérifié, dans le mode demandé :
  // « complet » (aucune demande) ou « espace-de-travail » (seulement dans son dossier, par défaut).
  const conversation = useAgents.getState().create({
    title: typeof options.title === "string" && options.title.trim() ? options.title.trim() : `${title} · agent`,
    origin: { reference: page, title },
    autonomy: "workspace",
    provider: model.provider,
    model: model.model,
    effort: model.effort,
  });
  try {
    const granted = await invoke<{ cwd: string; autonomy: Autonomy }>("frame.agents.authorize", {
      // Les accords d’une page valent pour toutes ses copies par instance.
      subject: { kind: identity.kind, module: identity.module, reference: declaredReference(identity) },
      conversation: conversation.id,
      functions,
      ...(mode ? { mode } : {}),
      ...(folder
        ? { folder: { id: String(folder.id ?? ""), ...(folder.path ? { path: String(folder.path) } : {}) } }
        : {}),
    });
    useAgents.getState().update(conversation.id, { cwd: granted.cwd, autonomy: granted.autonomy });
    // Coordinatrice : elle reçoit les outils de délégation ; ses délégués ne dépassent pas son mode.
    if (options.coordinator === true) {
      await invoke("agents.coordinator.set", {
        conversation: conversation.id,
        on: true,
        cwd: granted.cwd,
        maxMode: granted.autonomy === "auto" ? "complet" : "espace-de-travail",
      });
      useAgents.getState().update(conversation.id, { coordinator: true });
    }
  } catch (error) {
    await useAgents.getState().remove(conversation.id);
    throw error;
  }
  if (fromPage) useShell.getState().showAgentPanel(page, conversation.id);
  const schema = options.resultSchema && typeof options.resultSchema === "object" ? options.resultSchema : undefined;
  const context = options.context;
  const done = waitForTurn(conversation.id);
  await useAgents.getState().send(conversation.id, {
    text: schema
      ? `${instruction}\n\nQuand tu as terminé, finis ta réponse par un bloc \`\`\`json conforme à ce schéma :\n${JSON.stringify(schema)}`
      : instruction,
    attachments: [],
    contexts:
      context === undefined || context === null
        ? []
        : [
            {
              id: crypto.randomUUID(),
              title: `Contexte de ${title}`,
              text: typeof context === "string" ? context : JSON.stringify(context, null, 2),
            },
          ],
  });
  const turn = await done;
  const message = lastAssistantText(turn);
  if (turn.status === "error") throw new AlfredError({ message: turn.error ?? "L’agent n’a pas pu répondre." });
  const finish = (value: { conversationId: string; message: string; result?: unknown }) => ({
    value,
    conversationId: conversation.id,
  });
  if (!schema) return finish({ conversationId: conversation.id, message });
  let result: unknown;
  try {
    result = extractJson(message);
  } catch {
    throw new AlfredError({ message: "L’agent n’a pas rendu le résultat structuré attendu." });
  }
  const errors = validateSchema(result, schema);
  if (errors.length)
    throw new AlfredError({ message: "Le résultat de l’agent ne respecte pas le schéma demandé.", detail: errors });
  return finish({ conversationId: conversation.id, message, result });
}

/** Branche l’IA des pages sur les harnais : à appeler une fois au démarrage de la coquille. */
export function bindPageAi() {
  frameServices.startAgent = startAgent;
  frameServices.sendToAgent = async (identity, options) => {
    const conversationId = String(options.conversationId ?? "");
    const text = typeof options.message === "string" ? options.message.trim() : "";
    if (!text) throw new AlfredError({ message: "Le message à l’agent est vide." });
    // Rust vérifie que la conversation a été lancée par ce module.
    await invoke("frame.agents.owns", {
      subject: { kind: identity.kind, module: identity.module, reference: declaredReference(identity) },
      conversationId,
    });
    await useAgents.getState().send(conversationId, { text, attachments: [], contexts: [] });
    return null;
  };
  frameServices.oneShot = (identity, request) =>
    oneShot(request as unknown as Parameters<typeof oneShot>[0], identity.reference);
}

/** Conversation d’agent dans le panneau de droite d’une page. */
export function AgentPanel({ conversationId, onClose }: { conversationId: string; onClose: () => void }) {
  const conversation = useAgents((state) => state.loaded[conversationId]);
  const runtime = useAgents((state) => state.runtime[conversationId]) ?? idle;
  const ensureLoaded = useAgents((state) => state.ensureLoaded);
  const open = useAgents((state) => state.open);
  const setView = useShell((state) => state.setView);

  useEffect(() => {
    void ensureLoaded(conversationId);
  }, [conversationId, ensureLoaded]);

  if (!conversation) return null;
  return (
    <div className="agent-panel">
      <PanelBar
        title={conversation.title}
        closeLabel="Fermer la conversation"
        onClose={onClose}
        actions={
          <IconButton
            label="Ouvrir dans la page Agent"
            onClick={() => {
              void open(conversationId);
              setView({ kind: "agent" });
            }}
          >
            <ExternalLink size={15} aria-hidden="true" />
          </IconButton>
        }
      />
      <Transcript conversation={conversation} runtime={runtime} />
      <div className="agents-page__footer">
        <Composer conversation={conversation} responding={runtime.status !== "idle"} compact />
      </div>
    </div>
  );
}

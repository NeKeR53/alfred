/**
 * Agent lancé par une page (mode agentique) : une vraie conversation, affichée dans le panneau de droite de la page
 * et retrouvée dans la page Agent. La page reçoit le dernier message du premier tour et, si elle a fourni un schéma,
 * le résultat structuré que l’agent a rendu.
 */

import { IconButton, PanelHeader } from "@alfred/ui";
import { ExternalLink, X } from "lucide-react";
import { useEffect } from "react";
import { extractJson, validateSchema } from "../../lib/jsonSchema";
import { AlfredError, invoke } from "../../lib/native";
import { type FrameIdentity, frameServices } from "../../shell/frameBridge";
import { useShell } from "../../shell/store";
import { Composer } from "./Composer";
import { PROVIDER_LABEL } from "./harness";
import { type ConversationRuntime, lastAssistantText } from "./model";
import { oneShot } from "./oneShot";
import { bindAgentQuestions, useAgents, waitForTurn } from "./store";
import { Transcript } from "./Transcript";
import "./agent.css";

const idle: ConversationRuntime = { status: "idle", approvals: [], questions: [] };

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
  const record = (ok: boolean, summary: string, conversation?: string) =>
    invoke("journal.record", {
      kind: "agent",
      subject: identity.reference,
      ok,
      durationMs: Math.round(performance.now() - started),
      summary,
      detail: { conversation: conversation ?? null, instruction: instruction.slice(0, 500) },
    }).catch(() => undefined);
  try {
    const result = await runAgent(identity, options, instruction);
    void record(true, `Conversation d’agent via ${PROVIDER_LABEL[result.provider]}`, result.conversationId);
    return result.value;
  } catch (error) {
    void record(false, error instanceof Error ? error.message : String(error));
    throw error;
  }
}

async function runAgent(identity: FrameIdentity, options: Record<string, unknown>, instruction: string) {
  bindAgentQuestions();
  if (!useAgents.getState().ready) await useAgents.getState().load();
  const fromPage = identity.kind !== "function";
  const page = identity.host ?? identity.reference;
  const title = fromPage ? pageTitle(page) : identity.module;
  const functions = Array.isArray(options.functions)
    ? options.functions.map(String).map((name) => (name.includes("/") ? name : `${identity.module}/${name}`))
    : [];
  // Une page n’est pas l’utilisateur : l’agent qu’elle lance demande chaque action (autonomie stricte), et la
  // conversation ne touche qu’au module de la page, sauf fonctions d’autres modules accordées par l’utilisateur.
  const conversation = useAgents.getState().create({
    title: typeof options.title === "string" && options.title.trim() ? options.title.trim() : `${title} · agent`,
    origin: { reference: page, title },
    autonomy: "strict",
  });
  try {
    await invoke("frame.agents.authorize", {
      subject: { kind: identity.kind, module: identity.module, reference: identity.reference },
      conversation: conversation.id,
      functions,
    });
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
    provider: conversation.provider,
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
      <PanelHeader
        compact
        level={2}
        title={conversation.title}
        trailing={
          <>
            <IconButton
              label="Ouvrir dans la page Agent"
              onClick={() => {
                void open(conversationId);
                setView({ kind: "agent" });
              }}
            >
              <ExternalLink size={15} aria-hidden="true" />
            </IconButton>
            <IconButton label="Fermer la conversation" onClick={onClose}>
              <X size={16} aria-hidden="true" />
            </IconButton>
          </>
        }
      />
      <Transcript conversation={conversation} runtime={runtime} />
      <div className="agents-page__footer">
        <Composer conversation={conversation} responding={runtime.status !== "idle"} compact />
      </div>
    </div>
  );
}

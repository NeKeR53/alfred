/**
 * Transition : services des anciens gabarits de `@alfred/ui`, branchés sur `@alfred/sdk` comme le faisait l’hôte du
 * cadre avant la migration vers socle-ui. Un échec d’appel n’interrompt jamais la page.
 */
import {
  declareTopBarActions,
  files,
  onShellEvent,
  type PageContext,
  request,
  shell,
} from "@alfred/sdk";
import type { FrameServices } from "./services";

const quiet = (call: () => Promise<unknown>) => {
  call().catch(() => undefined);
};

export function frameServices(): FrameServices {
  const params = new URLSearchParams(typeof window === "undefined" ? "" : window.location.search);
  const kind = params.get("kind");
  return {
    notify: (options) => quiet(() => shell.notify(options)),
    publish: (selection) => quiet(() => shell.publish(selection)),
    setPanelVisible: (visible) => quiet(() => shell.setPanelVisible(visible)),
    openExternal: (url) => quiet(() => shell.openExternal(url)),
    send: (message) => quiet(() => shell.send(message)),
    readFile: async (id) => {
      const { info, data } = await files.read(id);
      return { name: info.name, mime: info.mime, data };
    },
    openFile: (id) => files.open(id),
    onPeer: (handler) => onShellEvent("peer", handler),
    // Pas de `topBarSearch` : la barre du haut n’a plus de recherche, le gabarit garde son champ dans sa barre.
    // Les actions d’une page vont dans la barre du haut ; un panneau et une capture gardent les leurs.
    ...(kind === "panel" || params.get("capture") === "1"
      ? {}
      : { topBarActions: (descriptors, onActivate) => declareTopBarActions(descriptors, onActivate) }),
    onSelection: (handler) => {
      let active = true;
      void request<PageContext>("shell.context").then(
        (context) => active && handler(context.selection),
        () => undefined,
      );
      const stop = onShellEvent("context", (payload) => handler((payload as PageContext).selection));
      return () => {
        active = false;
        stop();
      };
    },
  };
}

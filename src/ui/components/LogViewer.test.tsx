import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseAnsi, stripAnsi } from "./ansi";
import { LogViewer } from "./LogViewer";

// jsdom ne dispose rien : la zone qui défile mesure 360 px, son contenu la hauteur que le composant lui donne.
const VIEWPORT = "ui-log-viewer__viewport";
const scrolled = new WeakMap<Element, number>();
beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains(VIEWPORT) ? 360 : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains(VIEWPORT)
        ? Number.parseFloat((this.firstElementChild as HTMLElement).style.height)
        : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "scrollTop", {
    configurable: true,
    get(this: HTMLElement) {
      return scrolled.get(this) ?? 0;
    },
    set(this: HTMLElement, value: number) {
      scrolled.set(this, Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight)));
    },
  });
});
afterEach(() => {
  for (const property of ["clientHeight", "scrollHeight", "scrollTop"] as const)
    delete (HTMLElement.prototype as Partial<Record<typeof property, number>>)[property];
});

const journal = (count: number) => Array.from({ length: count }, (_, index) => `ligne ${index + 1}`);
const rendered = (container: HTMLElement) =>
  [...container.querySelectorAll<HTMLElement>(".ui-log-viewer__line")].map((line) => Number(line.dataset.number));

describe("LogViewer", () => {
  it("suit la fin d’un journal de 100 000 lignes, se met en pause quand on remonte, puis revient à la fin", async () => {
    const lines = journal(100_000);
    const { container, rerender } = render(<LogViewer label="Journal du build" lines={lines} live />);
    const log = screen.getByRole("log", { name: /Journal du build, 100\s000 lignes/ });

    // Seules les lignes visibles et quelques-unes autour sont dans la page ; la dernière est en vue.
    expect(rendered(container).length).toBeLessThan(120);
    expect(rendered(container)).toContain(100_000);
    expect(screen.getByText("En direct")).toBeInTheDocument();
    expect(screen.queryByText(/Suivi en pause/)).not.toBeInTheDocument();

    // On remonte : le suivi s’arrête, les nouvelles lignes sont comptées sans déplacer la lecture.
    log.scrollTop = 18 * 500;
    fireEvent.scroll(log);
    expect(rendered(container)).toContain(510);
    rerender(
      <LogViewer label="Journal du build" lines={[...lines, ...journal(5).map((line) => `nouvelle ${line}`)]} live />,
    );
    expect(screen.getByText(/Suivi en pause · 5 nouvelles lignes/)).toBeInTheDocument();
    expect(rendered(container)).not.toContain(100_005);
    expect(log.scrollTop).toBe(9000);

    await userEvent.click(screen.getByRole("button", { name: "Revenir à la fin" }));
    expect(screen.queryByText(/Suivi en pause/)).not.toBeInTheDocument();
    expect(rendered(container)).toContain(100_005);
    expect(log.scrollTop).toBe(18 * 100_005 - 360);
  });

  it("cherche une ligne et passe à la précédente et à la suivante", async () => {
    const lines = journal(3000).map((line, index) => (index % 1000 === 500 ? `${line} : ERROR disque plein` : line));
    const { container } = render(<LogViewer label="Journal" lines={lines} />);
    const search = screen.getByRole("searchbox", { name: "Rechercher dans le journal" });

    // Le journal suit la fin : la recherche mène au plus récent résultat et met le suivi en pause.
    await userEvent.type(search, "error");
    expect(await screen.findByText("3 sur 3")).toBeInTheDocument();
    const current = () => container.querySelector<HTMLElement>(".ui-log-viewer__line.is-current");
    expect(current()?.dataset.number).toBe("2501");
    expect(within(current() as HTMLElement).getByText("ERROR")).toContainHTML("<mark>ERROR</mark>");
    expect(screen.getByText(/Suivi en pause/)).toBeInTheDocument();

    await userEvent.keyboard("{Enter}");
    expect(screen.getByText("1 sur 3")).toBeInTheDocument();
    expect(current()?.dataset.number).toBe("501");
    await userEvent.keyboard("{Enter}");
    expect(current()?.dataset.number).toBe("1501");
    await userEvent.click(screen.getByRole("button", { name: "Ligne précédente" }));
    expect(screen.getByText("1 sur 3")).toBeInTheDocument();
    await userEvent.keyboard("{Shift>}{Enter}{/Shift}");
    expect(screen.getByText("3 sur 3")).toBeInTheDocument();
    fireEvent.keyDown(search, { key: "F3" });
    expect(screen.getByText("1 sur 3")).toBeInTheDocument();
    expect(current()?.dataset.number).toBe("501");

    await userEvent.clear(search);
    await userEvent.type(search, "introuvable");
    expect(await screen.findByText("Aucune ligne")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ligne suivante" })).toBeDisabled();
  });

  it("affiche les couleurs ANSI sans jamais interpréter de HTML, avec l’horodatage et le retour à la ligne au choix", async () => {
    const { container } = render(
      <LogViewer
        label="Journal"
        lines={[
          "2026-11-20T10:15:30.250Z \u001b[31mrouge\u001b[0m \u001b[1;32mvert gras\u001b[0m <img src=x onerror=alert(1)>",
          { text: "\u001b]0;titre de fenêtre\u0007\u001b[2Kpanne \u001b[38;5;196msérieuse\u001b[m", stream: "stderr" },
        ]}
      />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText(/<img src=x onerror=alert\(1\)>/)).toBeInTheDocument();
    expect(screen.getByText("rouge")).toHaveClass("ui-ansi-fg-1");
    expect(screen.getByText("vert gras")).toHaveClass("ui-ansi-fg-10", "is-bold");
    expect(screen.getByText("sérieuse")).toHaveClass("ui-ansi-fg-9");
    expect(container.textContent).not.toContain("titre de fenêtre");
    expect(container.textContent).not.toContain("\u001b");
    // stderr est dit en texte, pas seulement par la couleur de la marge.
    expect(container.querySelector(".is-stderr")).toHaveTextContent("Erreur : panne sérieuse");

    const lines = container.querySelectorAll<HTMLElement>(".ui-log-viewer__line");
    expect(lines[0].dataset.time).toBeUndefined();
    await userEvent.click(screen.getByRole("button", { name: "Horodatage" }));
    expect(screen.getByRole("button", { name: "Horodatage" })).toHaveAttribute("aria-pressed", "true");
    expect(container.querySelector<HTMLElement>(".ui-log-viewer__line")?.dataset.time).toMatch(/^\d{2}:\d{2}:30,250$/);
    await userEvent.click(screen.getByRole("button", { name: "Retour à la ligne" }));
    expect(container.querySelector(".ui-log-viewer")).toHaveClass("ui-log-viewer--wrap");
  });

  it("s’alimente par un canal, lignes et morceaux bruts, et dit quand le flux est fini", () => {
    const encode = (text: string) => btoa(String.fromCharCode(...new TextEncoder().encode(text)));
    const events = [
      { seq: 1, type: "data" as const, data: "démarrage" },
      { seq: 2, type: "data" as const, data: encode("préparation…\nmorceau "), base64: true },
      { seq: 3, type: "data" as const, data: encode("complété\n"), base64: true },
      { seq: 4, type: "data" as const, data: "échec", stream: "stderr" as const },
    ];
    const { container, rerender } = render(
      <LogViewer label="Journal" channel={{ events: events.slice(0, 2), closed: false }} />,
    );
    expect(screen.getByText("En direct")).toBeInTheDocument();
    rerender(<LogViewer label="Journal" channel={{ events, closed: true, reason: "conteneur arrêté" }} />);
    expect([...container.querySelectorAll(".ui-log-viewer__text")].map((line) => line.textContent)).toEqual([
      "démarrage",
      "préparation…",
      "morceau complété",
      "Erreur : échec",
    ]);
    expect(screen.getByText("Flux terminé : conteneur arrêté")).toBeInTheDocument();
  });

  it("nettoie les séquences ANSI : 256 couleurs, vraie couleur, retour chariot", () => {
    expect(parseAnsi("\u001b[38;2;0;0;250mbleu\u001b[48;5;46m vert")).toEqual([
      { text: "bleu", style: { fg: 4 } },
      { text: " vert", style: { fg: 4, bg: 10 } },
    ]);
    expect(stripAnsi("10 %\r50 %\r100 %\r")).toBe("100 %");
    expect(stripAnsi("a\u001b[1Ab\u0007c\u001b]8;;https://exemple.fr\u001b\\lien\u001b]8;;\u001b\\")).toBe("abclien");
  });
});

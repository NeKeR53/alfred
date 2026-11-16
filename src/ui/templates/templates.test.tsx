import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Copy, Pencil, Share2, Trash2 } from "lucide-react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { installDialogPolyfill } from "../dialog.test-helper";
import { type Action, arrangeActions } from "./actions";
import { CollectionPage } from "./CollectionPage";
import { openForm } from "./dialogs";
import { SettingsPage } from "./SettingsPage";
import { type FrameServices, FrameServicesContext } from "./services";

beforeAll(installDialogPolyfill);

const noop = () => undefined;

function services(overrides: Partial<FrameServices> = {}): FrameServices {
  return {
    notify: vi.fn(),
    publish: vi.fn(),
    setPanelVisible: vi.fn(),
    openExternal: noop,
    send: vi.fn(),
    onPeer: () => noop,
    onSelection: () => noop,
    ...overrides,
  };
}

describe("arrangeActions", () => {
  const actions: Action[] = [
    { label: "Modifier", icon: Pencil, onClick: noop },
    { label: "Exporter", onClick: noop },
    { label: "Nouvelle tâche", primary: true, onClick: noop },
    { label: "Copier", icon: Copy, onClick: noop },
    { label: "Partager", icon: Share2, onClick: noop },
    { label: "Supprimer", icon: Trash2, danger: true, onClick: noop },
    { label: "Caché", icon: Pencil, hidden: true, onClick: noop },
  ];

  it("place la principale en texte, deux icônes dans une section, le reste et le danger dans « ⋯ »", () => {
    const placed = arrangeActions(actions, "section");
    expect(placed.primary?.label).toBe("Nouvelle tâche");
    expect(placed.icons.map((action) => action.label)).toEqual(["Modifier", "Copier"]);
    expect(placed.menu.map((action) => action.label)).toEqual(["Exporter", "Partager"]);
    expect(placed.dangerous.map((action) => action.label)).toEqual(["Supprimer"]);
  });

  it("n’a pas d’action principale dans une ligne", () => {
    expect(arrangeActions(actions, "row").primary).toBeUndefined();
  });
});

interface Tache {
  id: number;
  titre: string;
  etat: string;
}

describe("CollectionPage", () => {
  it("affiche l’état vide avec l’action principale, puis la liste filtrée", async () => {
    const user = userEvent.setup();
    const { unmount } = render(
      <CollectionPage<Tache>
        label="Tâches"
        load={async () => []}
        rowKey={(row) => row.id}
        columns={[{ key: "titre", header: "Titre" }]}
        emptyTitle="Aucune tâche"
        actions={[{ label: "Nouvelle tâche", primary: true, onClick: noop }]}
      />,
    );
    expect(await screen.findByText("Aucune tâche")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Nouvelle tâche" })).toBeInTheDocument();
    unmount();

    render(
      <CollectionPage<Tache>
        label="Tâches"
        load={async () => [
          { id: 1, titre: "Relancer le client", etat: "en_cours" },
          { id: 2, titre: "Préparer la revue", etat: "a_faire" },
        ]}
        rowKey={(row) => row.id}
        columns={[
          { key: "titre", header: "Titre" },
          {
            key: "etat",
            header: "État",
            type: "status",
            statuses: {
              en_cours: { label: "En cours", tone: "warning" },
              a_faire: { label: "À faire", tone: "neutral" },
            },
          },
        ]}
        emptyTitle="Aucune tâche"
        search={{ label: "Rechercher une tâche" }}
        filters={[
          {
            label: "État",
            all: "Tous les états",
            value: (row) => row.etat,
            options: [
              { value: "en_cours", label: "En cours" },
              { value: "a_faire", label: "À faire" },
            ],
          },
        ]}
      />,
    );
    const table = await screen.findByRole("table", { name: "Tâches" });
    expect(within(table).getByText("En cours")).toBeInTheDocument();
    await user.selectOptions(screen.getByRole("combobox", { name: "État" }), "a_faire");
    expect(within(table).queryByText("Relancer le client")).not.toBeInTheDocument();
    expect(within(table).getByText("Préparer la revue")).toBeInTheDocument();
  });
});

describe("openForm", () => {
  it("valide les champs obligatoires, enregistre et notifie", async () => {
    const user = userEvent.setup();
    const frame = services();
    const onSubmit = vi.fn();
    render(
      <FrameServicesContext.Provider value={frame}>
        <CollectionPage<Tache>
          label="Tâches"
          load={async () => []}
          rowKey={(row) => row.id}
          columns={[{ key: "titre", header: "Titre" }]}
          emptyTitle="Aucune tâche"
        />
      </FrameServicesContext.Provider>,
    );
    await screen.findByText("Aucune tâche");
    const saved = openForm({
      title: "Nouvelle tâche",
      fields: [
        { name: "titre", label: "Titre" },
        { name: "note", label: "Note", optional: true },
      ],
      submitLabel: "Créer",
      success: "Tâche créée",
      onSubmit,
    });
    const dialog = await screen.findByRole("dialog", { name: "Nouvelle tâche" });
    await user.click(within(dialog).getByRole("button", { name: "Créer" }));
    expect(within(dialog).getByText("Renseignez le champ « Titre ».")).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
    await user.type(within(dialog).getByRole("textbox", { name: "Titre" }), "  Appeler  ");
    await user.click(within(dialog).getByRole("button", { name: "Créer" }));
    await expect(saved).resolves.toBe(true);
    expect(onSubmit).toHaveBeenCalledWith({ titre: "Appeler", note: "" });
    expect(frame.notify).toHaveBeenCalledWith({ title: "Tâche créée", tone: "success" });
  });
});

describe("SettingsPage", () => {
  it("remet la valeur précédente et notifie quand l’enregistrement échoue", async () => {
    const user = userEvent.setup();
    const frame = services();
    render(
      <FrameServicesContext.Provider value={frame}>
        <SettingsPage
          load={async () => ({ actif: true })}
          sections={(values) => [
            {
              title: "Notifications",
              settings: [
                {
                  id: "actif",
                  type: "switch",
                  title: "Tâches en retard",
                  value: values.actif,
                  save: () => Promise.reject(new Error("Base verrouillée")),
                },
              ],
            },
          ]}
        />
      </FrameServicesContext.Provider>,
    );
    const toggle = await screen.findByRole("switch", { name: "Tâches en retard" });
    expect(toggle).toBeChecked();
    await user.click(toggle);
    await waitFor(() => expect(toggle).toBeChecked());
    expect(frame.notify).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Le réglage n’a pas été enregistré", description: "Base verrouillée" }),
    );
  });
});

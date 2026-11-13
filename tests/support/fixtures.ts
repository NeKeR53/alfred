import type { FakeModule } from "./fakeBackend";

/** Un espace déjà construit : une section à deux onglets dont l’un a un panneau, une page des Réglages, une fonction. */
export function builtModules(): FakeModule[] {
  return [
    {
      id: "suivi",
      name: "Suivi",
      sections: [{ id: "principal", label: "Suivi", icon: "list-checks", color: "blue" }],
      pages: [
        { id: "taches", title: "Tâches", placement: { kind: "tab", section: "principal" } },
        { id: "echeances", title: "Échéances", placement: { kind: "tab", section: "principal" }, missing: true },
        { id: "detail", title: "Détail", placement: { kind: "panel", page: "suivi/taches" } },
        { id: "preferences", title: "Préférences du suivi", placement: { kind: "settings" } },
      ],
      functions: [{ id: "synchroniser", description: "Synchronise les tâches avec Jira.", tool: true }],
    },
    {
      id: "notes",
      name: "Notes",
      sections: [{ id: "principal", label: "Notes", icon: "notebook", color: "green" }],
      pages: [{ id: "carnet", title: "Carnet", placement: { kind: "tab", section: "principal" } }],
      functions: [],
    },
  ];
}

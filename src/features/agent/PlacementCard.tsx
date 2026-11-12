import { Button, FormField, RadioControl, SelectControl, TextInput } from "@alfred/ui";
import { type FormEvent, useMemo, useState } from "react";
import { type PlaceTarget, SECTION_COLORS } from "../../lib/types";
import { useShell } from "../../shell/store";

type Kind = PlaceTarget["kind"];

const COLOR_LABEL: Record<(typeof SECTION_COLORS)[number], string> = {
  steel: "Acier",
  blue: "Bleu",
  violet: "Violet",
  pink: "Rose",
  red: "Rouge",
  orange: "Orange",
  green: "Vert",
  teal: "Sarcelle",
};

/**
 * Carte posée dans la conversation quand l’agent a une page à créer : l’utilisateur choisit où elle ira (menu,
 * onglet, panneau de droite, Réglages) et ajuste son nom. Rien n’est placé avant sa réponse.
 */
export function PlacementCard({
  payload,
  onSubmit,
  onCancel,
}: {
  payload: Record<string, unknown>;
  onSubmit: (result: { title: string; icon?: string; target: PlaceTarget }) => void;
  onCancel: () => void;
}) {
  const snapshot = useShell((state) => state.snapshot);
  const sections = useMemo(() => snapshot?.sections ?? [], [snapshot]);
  const hosts = useMemo(
    () => sections.flatMap((section) => section.pages.filter((page) => !page.panel).map((page) => ({ page, section }))),
    [sections],
  );
  const suggestion = (payload.suggestion ?? {}) as Partial<PlaceTarget> & Record<string, unknown>;
  const initialKind: Kind =
    suggestion.kind === "tab" && sections.length
      ? "tab"
      : suggestion.kind === "panel" && hosts.length
        ? "panel"
        : suggestion.kind === "settings"
          ? "settings"
          : "menu";
  const [kind, setKind] = useState<Kind>(initialKind);
  const [title, setTitle] = useState(String(payload.title ?? ""));
  const [label, setLabel] = useState(String(suggestion.label ?? payload.title ?? ""));
  const [icon, setIcon] = useState(String(suggestion.icon ?? payload.icon ?? ""));
  const [color, setColor] = useState(String(suggestion.color ?? "steel"));
  const [section, setSection] = useState(String(suggestion.section ?? sections[0]?.id ?? ""));
  const [host, setHost] = useState(String(suggestion.page ?? hosts[0]?.page.reference ?? ""));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const target: PlaceTarget =
      kind === "menu"
        ? { kind, label: label.trim() || title.trim(), ...(icon.trim() ? { icon: icon.trim() } : {}), color }
        : kind === "tab"
          ? { kind, section }
          : kind === "panel"
            ? { kind, page: host }
            : { kind: "settings" };
    onSubmit({ title: title.trim(), target });
  };

  return (
    <form className="agent-card agent-placement" aria-label="Emplacement de la nouvelle page" onSubmit={submit}>
      <strong>Où placer cette page ?</strong>
      {typeof payload.description === "string" && payload.description ? (
        <p className="agent-card__note">{payload.description}</p>
      ) : null}
      <FormField label="Titre de la page">
        <TextInput value={title} onChange={(event) => setTitle(event.target.value)} required />
      </FormField>
      <fieldset className="agent-placement__choices">
        <legend className="sr-only">Emplacement</legend>
        <RadioControl
          name="placement"
          checked={kind === "menu"}
          onChange={() => setKind("menu")}
          label="Nouvelle entrée du menu de gauche"
        />
        {kind === "menu" ? (
          <div className="agent-placement__details">
            <FormField label="Nom dans le menu">
              <TextInput value={label} onChange={(event) => setLabel(event.target.value)} required />
            </FormField>
            <FormField label="Icône" hint="Nom Lucide, par exemple list-checks.">
              <TextInput value={icon} onChange={(event) => setIcon(event.target.value)} spellCheck={false} />
            </FormField>
            <FormField label="Couleur">
              <SelectControl value={color} onChange={(event) => setColor(event.target.value)}>
                {SECTION_COLORS.map((name) => (
                  <option key={name} value={name}>
                    {COLOR_LABEL[name]}
                  </option>
                ))}
              </SelectControl>
            </FormField>
          </div>
        ) : null}
        <RadioControl
          name="placement"
          checked={kind === "tab"}
          disabled={!sections.length}
          onChange={() => setKind("tab")}
          label="Onglet d’une section existante"
        />
        {kind === "tab" ? (
          <div className="agent-placement__details">
            <FormField label="Section">
              <SelectControl value={section} onChange={(event) => setSection(event.target.value)}>
                {sections.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.label}
                  </option>
                ))}
              </SelectControl>
            </FormField>
          </div>
        ) : null}
        <RadioControl
          name="placement"
          checked={kind === "panel"}
          disabled={!hosts.length}
          onChange={() => setKind("panel")}
          label="Panneau de droite d’une page existante"
        />
        {kind === "panel" ? (
          <div className="agent-placement__details">
            <FormField label="Page">
              <SelectControl value={host} onChange={(event) => setHost(event.target.value)}>
                {hosts.map(({ page, section: owner }) => (
                  <option key={page.reference} value={page.reference}>
                    {owner.label} · {page.title}
                  </option>
                ))}
              </SelectControl>
            </FormField>
          </div>
        ) : null}
        <RadioControl
          name="placement"
          checked={kind === "settings"}
          onChange={() => setKind("settings")}
          label="Onglet des Réglages"
        />
      </fieldset>
      <div className="agent-card__actions">
        <Button type="submit" variant="primary" disabled={!title.trim()}>
          Placer la page
        </Button>
        <Button onClick={onCancel}>Annuler</Button>
      </div>
    </form>
  );
}

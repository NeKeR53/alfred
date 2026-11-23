import { type FormEvent, useMemo, useState } from "react";
import { Button, RadioGroup, Select, TextField } from "socle-ui";
import { Row, Stack } from "../../kit";
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
      <Stack gap="sm">
        <TextField label="Titre de la page" value={title} onChange={setTitle} isRequired />
        <RadioGroup label="Emplacement" value={kind} onChange={(value) => setKind(value as Kind)}>
          <RadioGroup.Option value="menu">Nouvelle entrée du menu de gauche</RadioGroup.Option>
          <RadioGroup.Option value="tab" isDisabled={!sections.length}>
            Onglet d’une section existante
          </RadioGroup.Option>
          <RadioGroup.Option value="panel" isDisabled={!hosts.length}>
            Panneau de droite d’une page existante
          </RadioGroup.Option>
          <RadioGroup.Option value="settings">Onglet des Réglages</RadioGroup.Option>
        </RadioGroup>
        {kind === "menu" ? (
          <>
            <TextField label="Nom dans le menu" value={label} onChange={setLabel} isRequired />
            <TextField
              label="Icône"
              description="Nom Lucide, par exemple list-checks."
              value={icon}
              onChange={setIcon}
            />
            <Select
              label="Couleur"
              value={color}
              onChange={(value) => value && setColor(value)}
              options={SECTION_COLORS.map((name) => ({ id: name, label: COLOR_LABEL[name] }))}
            />
          </>
        ) : kind === "tab" ? (
          <Select
            label="Section"
            value={section}
            onChange={(value) => value && setSection(value)}
            options={sections.map((candidate) => ({ id: candidate.id, label: candidate.label }))}
          />
        ) : kind === "panel" ? (
          <Select
            label="Page"
            value={host}
            onChange={(value) => value && setHost(value)}
            options={hosts.map(({ page, section: owner }) => ({
              id: page.reference,
              label: `${owner.label} · ${page.title}`,
            }))}
          />
        ) : null}
        <Row gap="sm" justify="end">
          <Button onPress={onCancel}>Annuler</Button>
          <Button type="submit" variant="primary" isDisabled={!title.trim()}>
            Placer la page
          </Button>
        </Row>
      </Stack>
    </form>
  );
}

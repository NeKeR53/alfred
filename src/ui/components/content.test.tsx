import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Button } from "./Button";
import { Code, Divider, Image } from "./Content";
import { Fieldset } from "./Fieldset";
import { CheckboxControl } from "./FormControls";
import { Link } from "./Link";
import { List, ListItem } from "./List";

describe("Link", () => {
  it("transmet l’adresse à onNavigate sans naviguer, et signale une adresse externe", async () => {
    const user = userEvent.setup();
    const navigate = vi.fn();
    render(
      <Link href="https://exemple.fr/aide" onNavigate={navigate}>
        Lire l’aide
      </Link>,
    );
    const link = screen.getByRole("link", { name: "Lire l’aide (s’ouvre hors d’Alfred)" });
    expect(link).toHaveAttribute("href", "https://exemple.fr/aide");
    await user.click(link);
    expect(navigate).toHaveBeenCalledWith("https://exemple.fr/aide");
  });

  it("devient un bouton d’apparence lien sans href", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<Link onClick={onClick}>Voir le détail</Link>);
    await user.click(screen.getByRole("button", { name: "Voir le détail" }));
    expect(onClick).toHaveBeenCalled();
  });
});

describe("Fieldset", () => {
  it("nomme le groupe par sa légende et lui relie l’erreur", () => {
    render(
      <Fieldset legend="Jours de rappel" error="Choisissez au moins un jour.">
        <CheckboxControl label="Lundi" />
        <CheckboxControl label="Mardi" />
      </Fieldset>,
    );
    const group = screen.getByRole("group", { name: "Jours de rappel" });
    expect(group).toHaveAccessibleDescription("Choisissez au moins un jour.");
    expect(group).toHaveAttribute("aria-invalid", "true");
    expect(screen.getAllByRole("checkbox")).toHaveLength(2);
  });
});

describe("List", () => {
  it("affiche titre, description et fin ; la variante cliquable garde ses actions de fin à part", async () => {
    const user = userEvent.setup();
    const open = vi.fn();
    const remove = vi.fn();
    render(
      <List label="Pièces jointes">
        <ListItem title="devis.pdf" description="120 Ko" trailing="12 nov." />
        <ListItem
          title="photo.png"
          description="2 Mo"
          selected
          onClick={open}
          trailing={<Button onClick={remove}>Retirer</Button>}
        />
      </List>,
    );
    const list = screen.getByRole("list", { name: "Pièces jointes" });
    expect(list.querySelectorAll("li")).toHaveLength(2);
    expect(screen.getByText("120 Ko")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retirer" }));
    expect(remove).toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    const main = screen.getByRole("button", { name: "photo.png" });
    expect(main).toHaveAccessibleDescription("2 Mo");
    expect(main).toHaveAttribute("aria-current", "true");
    await user.click(main);
    expect(open).toHaveBeenCalled();
  });
});

describe("Code, Divider, Image", () => {
  it("Code plain : chasse fixe sans fond, et en gras avec strong", () => {
    render(
      <p>
        <Code plain strong>
          2.4.1
        </Code>
      </p>,
    );
    const code = screen.getByText("2.4.1");
    expect(code).toHaveClass("ui-code", "ui-code--plain", "ui-code--strong");
  });

  it("rend le code en ligne et en bloc, joignable au clavier", async () => {
    const user = userEvent.setup();
    render(
      <>
        <Code>suivi_taches</Code>
        <Code block label="Requête">
          SELECT * FROM suivi_taches
        </Code>
        <Divider />
      </>,
    );
    expect(screen.getByText("suivi_taches").tagName).toBe("CODE");
    await user.tab();
    expect(screen.getByRole("region", { name: "Requête" })).toHaveFocus();
    expect(screen.getByRole("separator")).toBeInTheDocument();
  });

  it("affiche une image data: et remplace une adresse distante par son texte", () => {
    render(
      <>
        <Image src="data:image/png;base64,iVBORw0KGgo=" alt="Logo de l’équipe" />
        <Image src="https://exemple.fr/logo.png" alt="Logo distant" />
      </>,
    );
    expect(screen.getByRole("img", { name: "Logo de l’équipe" })).toHaveAttribute("src");
    const fallback = screen.getByRole("img", { name: "Logo distant" });
    expect(fallback.tagName).toBe("SPAN");
  });
});

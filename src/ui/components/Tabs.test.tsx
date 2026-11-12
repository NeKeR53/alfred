import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { Tabs } from "./Tabs";

function Example(props: { className?: string; tabClassName?: string }) {
  const [active, setActive] = useState<"resume" | "historique">("resume");
  return (
    <Tabs
      {...props}
      label="Rubriques de la tâche"
      activeId={active}
      onChange={setActive}
      items={[
        { id: "resume", label: "Résumé" },
        { id: "historique", label: "Historique" },
      ]}
    />
  );
}

describe("Tabs", () => {
  it("a l’apparence des onglets de la barre du haut sans classe fournie", async () => {
    const user = userEvent.setup();
    render(<Example />);
    expect(screen.getByRole("tablist", { name: "Rubriques de la tâche" })).toHaveClass("settings-editor-tabs");
    const first = screen.getByRole("tab", { name: "Résumé" });
    expect(first).toHaveClass("settings-editor-tab");
    expect(first).toHaveAttribute("aria-selected", "true");
    first.focus();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "Historique" })).toHaveFocus();
    expect(screen.getByRole("tab", { name: "Historique" })).toHaveAttribute("aria-selected", "true");
  });

  it("garde les classes fournies par la coquille", () => {
    render(<Example className="settings-editor-tabs shell-tabs" tabClassName="settings-editor-tab" />);
    expect(screen.getByRole("tablist")).toHaveClass("shell-tabs");
  });
});

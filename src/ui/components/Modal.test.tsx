import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeAll, describe, expect, it } from "vitest";
import { installDialogPolyfill, pressEscapeInDialog } from "../dialog.test-helper";
import { Button } from "./Button";
import { FormField, TextInput } from "./FormControls";
import { Modal } from "./Modal";

beforeAll(installDialogPolyfill);

function Example() {
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState("");
  const [name, setName] = useState("");
  return (
    <>
      <Button onClick={() => setOpen(true)}>Renommer</Button>
      <p>Nom : {saved}</p>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Renommer la liste"
        description="Le nouveau nom apparaît dans le menu."
        actions={
          <>
            <Button onClick={() => setOpen(false)}>Annuler</Button>
            <Button
              variant="primary"
              onClick={() => {
                setSaved(name);
                setOpen(false);
              }}
            >
              Enregistrer
            </Button>
          </>
        }
      >
        <FormField label="Nom">
          <TextInput value={name} onChange={(event) => setName(event.target.value)} />
        </FormField>
      </Modal>
    </>
  );
}

describe("Modal", () => {
  it("s’ouvre sur son premier champ, enregistre, puis rend le focus au déclencheur", async () => {
    const user = userEvent.setup();
    render(<Example />);
    const trigger = screen.getByRole("button", { name: "Renommer" });
    await user.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "Renommer la liste" });
    expect(dialog).toHaveAccessibleDescription("Le nouveau nom apparaît dans le menu.");
    expect(screen.getByRole("textbox", { name: "Nom" })).toHaveFocus();
    await user.keyboard("Courses");
    await user.click(screen.getByRole("button", { name: "Enregistrer" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByText("Nom : Courses")).toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("se ferme par le bouton Fermer et par Échap", async () => {
    const user = userEvent.setup();
    render(<Example />);
    await user.click(screen.getByRole("button", { name: "Renommer" }));
    await user.click(screen.getByRole("button", { name: "Fermer" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Renommer" }));
    pressEscapeInDialog(screen.getByRole("dialog") as HTMLDialogElement);
    expect(await screen.findByRole("button", { name: "Renommer" })).toHaveFocus();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

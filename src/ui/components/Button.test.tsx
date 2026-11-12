import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { IconButton } from "./Button";

describe("IconButton", () => {
  it('rend size="compact" exactement comme la taille par défaut', () => {
    render(
      <>
        <IconButton label="Par défaut">×</IconButton>
        <IconButton label="Compact" size="compact">
          ×
        </IconButton>
        <IconButton label="Petit" size="small">
          ×
        </IconButton>
      </>,
    );
    expect(screen.getByRole("button", { name: "Compact" }).className).toBe(
      screen.getByRole("button", { name: "Par défaut" }).className,
    );
    expect(screen.getByRole("button", { name: "Petit" })).toHaveClass("icon-button--small");
  });
});

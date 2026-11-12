import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FeedbackBanner } from "./FeedbackBanner";

describe("FeedbackBanner", () => {
  it("accepte danger comme error : même alerte, même apparence", () => {
    render(
      <>
        <FeedbackBanner tone="danger">Les tâches n’ont pas pu être chargées.</FeedbackBanner>
        <FeedbackBanner tone="error">Le coffre est illisible.</FeedbackBanner>
      </>,
    );
    const [danger, error] = screen.getAllByRole("alert");
    expect(danger).toHaveTextContent("Les tâches n’ont pas pu être chargées.");
    expect(danger.className).toBe(error.className);
    expect(danger).toHaveClass("feedback-banner--error", "feedback-banner--contained");
  });

  it("est encadré par défaut, et garde l’apparence bandeau sur demande", () => {
    render(
      <>
        <FeedbackBanner tone="info">Aucun marketplace n’est branché.</FeedbackBanner>
        <FeedbackBanner tone="warning" appearance="bar">
          Hors ligne.
        </FeedbackBanner>
      </>,
    );
    const [info, warning] = screen.getAllByRole("status");
    expect(info).toHaveClass("feedback-banner--contained");
    expect(warning).not.toHaveClass("feedback-banner--contained");
  });
});

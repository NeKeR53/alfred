import { act, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { overflowEdge, useOverflowEdges } from "./overflowEdges";

describe("overflowEdge", () => {
  it("dit de quel côté une rangée continue hors de vue", () => {
    expect(overflowEdge({ scrollLeft: 0, scrollWidth: 300, clientWidth: 300 })).toBeUndefined();
    expect(overflowEdge({ scrollLeft: 0, scrollWidth: 500, clientWidth: 300 })).toBe("end");
    expect(overflowEdge({ scrollLeft: 100, scrollWidth: 500, clientWidth: 300 })).toBe("both");
    expect(overflowEdge({ scrollLeft: 200, scrollWidth: 500, clientWidth: 300 })).toBe("start");
    // Un reste d’arrondi ne compte pas.
    expect(overflowEdge({ scrollLeft: 0.5, scrollWidth: 300.5, clientWidth: 300 })).toBeUndefined();
  });
});

function Row() {
  const ref = useOverflowEdges<HTMLDivElement>();
  return (
    <div ref={ref} data-testid="rangée">
      contenu
    </div>
  );
}

describe("useOverflowEdges", () => {
  it("pose data-overflow au défilement et le retire quand tout tient", () => {
    render(<Row />);
    const row = screen.getByTestId("rangée");
    expect(row.dataset.overflow).toBeUndefined();
    Object.defineProperty(row, "scrollWidth", { configurable: true, value: 500 });
    Object.defineProperty(row, "clientWidth", { configurable: true, value: 300 });
    act(() => {
      row.scrollLeft = 100;
      row.dispatchEvent(new Event("scroll"));
    });
    expect(row.dataset.overflow).toBe("both");
    act(() => {
      row.scrollLeft = 0;
      row.dispatchEvent(new Event("scroll"));
    });
    expect(row.dataset.overflow).toBe("end");
    Object.defineProperty(row, "scrollWidth", { configurable: true, value: 300 });
    act(() => {
      row.dispatchEvent(new Event("scroll"));
    });
    expect(row.dataset.overflow).toBeUndefined();
  });
});

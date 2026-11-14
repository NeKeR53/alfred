import { beforeEach, describe, expect, it } from "vitest";
import { addFrameConsole, addFrameErrorLog, addFrameLog, frameLogs, MAX_TEXT, readFrameLogs } from "./frameLogs";

describe("journal des pages", () => {
  beforeEach(() => frameLogs.clear());

  it("garde la console, les erreurs complètes et les requêtes, filtrables par page, module et niveau", () => {
    addFrameLog("perso/mails", "info", "Page chargée.");
    addFrameConsole("perso/mails", { level: "warn", text: "aucun mail" });
    addFrameErrorLog("perso/mails", {
      phase: "runtime",
      message: "mails is undefined",
      stack: "TypeError: mails is undefined\n    at Page (pages/mails:12:7)",
    });
    addFrameLog("perso/mails", "request", "clients.request gog-perso GET /messages → HTTP 401 (12 ms)");
    addFrameConsole("notes/liste", { level: "inventé", text: 42 });

    const mails = readFrameLogs({ page: "perso/mails" });
    expect(mails.map((entry) => entry.level)).toEqual(["info", "warn", "error", "request"]);
    expect(mails[2].text).toContain("[runtime] mails is undefined");
    expect(mails[2].text).toContain("pages/mails:12:7");
    expect(readFrameLogs({ module: "notes" })).toMatchObject([{ page: "notes/liste", level: "log", text: "" }]);
    expect(readFrameLogs({ levels: ["request"] })).toHaveLength(1);
    expect(readFrameLogs({ limit: 2 }).map((entry) => entry.page)).toEqual(["perso/mails", "notes/liste"]);
  });

  it("borne la longueur des lignes et le nombre de lignes par page", () => {
    addFrameConsole("a/b", { level: "log", text: "x".repeat(MAX_TEXT + 10) });
    expect(readFrameLogs({ page: "a/b" })[0].text).toContain("10 caractères coupés");
    for (let index = 0; index < 400; index++) addFrameLog("a/b", "log", String(index));
    const entries = readFrameLogs({ page: "a/b", limit: 300 });
    expect(entries).toHaveLength(300);
    expect(entries.at(-1)?.text).toBe("399");
  });
});

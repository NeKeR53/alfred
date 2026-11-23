import { expect, it } from "vitest";
import { accountName } from "./accountName";

it("prend le nom de la session du système dans le dossier personnel", () => {
  expect(accountName("/Users/alexandre")).toBe("Alexandre");
  expect(accountName("/home/marie/")).toBe("Marie");
  expect(accountName("C:\\Users\\jdupont")).toBe("Jdupont");
});

it("dit « Vous » quand le dossier personnel est inconnu", () => {
  expect(accountName(null)).toBe("Vous");
  expect(accountName(undefined)).toBe("Vous");
  expect(accountName("/")).toBe("Vous");
});

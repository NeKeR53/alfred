// Génère les entrées ES qui réexportent, nom par nom, les paquets CommonJS fournis aux pages par la carte d’imports.
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const out = new URL("../src/runtime/generated/", import.meta.url);
mkdirSync(out, { recursive: true });

const identifier = /^[A-Za-z_$][\w$]*$/;

function shim(file, specifier, { withDefault = true } = {}) {
  const names = Object.keys(require(specifier)).filter((name) => name !== "default" && identifier.test(name));
  const lines = [`import * as source from "${specifier}";`];
  if (withDefault) lines.push("export default source;");
  lines.push(`export const { ${names.join(", ")} } = source;`);
  writeFileSync(new URL(file, out), `${lines.join("\n")}\n`);
}

shim("react.js", "react");
shim("react-dom.js", "react-dom");
shim("react-dom-client.js", "react-dom/client");
shim("jsx-runtime.js", "react/jsx-runtime", { withDefault: false });
writeFileSync(new URL("lucide.js", out), 'export * from "lucide-react";\n');

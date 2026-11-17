#!/usr/bin/env node
/**
 * Réassemble le modèle de la recherche par le sens (multilingual-e5-small) dans `src-tauri/resources/models/`, d’où
 * Tauri le livre avec Alfred. Le modèle est dans le dépôt git : `config.json` et `tokenizer.json` tels quels, dans ce
 * dossier même, et `model.safetensors` (470 Mo, au-delà de ce que GitHub accepte par fichier) découpé en morceaux de
 * 45 Mo dans `src-tauri/model-parts/`, hors du dossier livré. Ce script recolle les morceaux, sans aucun appel réseau,
 * et vérifie les empreintes SHA-256 de la révision figée. Un fichier déjà présent et intact n’est pas refait.
 */
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createReadStream, createWriteStream, existsSync, readdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

// intfloat/multilingual-e5-small, révision 614241f622f53c4eeff9890bdc4f31cfecc418b3 de Hugging Face.
const FILES = {
  "config.json": "69137736cab8b8903a07fe8afaafdda25aac55415a12a55d1bffa9f581abf959",
  "tokenizer.json": "0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39",
  "model.safetensors": "1a55775f53449dac10a2bcbc312469fac40b96d53198c407081a831f81c98477",
};
const ASSEMBLED = "model.safetensors";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const target = join(root, "src-tauri", "resources", "models", "multilingual-e5-small");
const parts = join(root, "src-tauri", "model-parts", "multilingual-e5-small");

async function sha256(path) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

async function assemble(path) {
  const pieces = readdirSync(parts)
    .filter((name) => name.startsWith(`${ASSEMBLED}.part-`))
    .sort();
  if (pieces.length === 0) throw new Error(`${ASSEMBLED} : aucun morceau dans ${parts}.`);
  process.stdout.write(`Modèle de recherche : ${ASSEMBLED} à partir de ${pieces.length} morceaux… `);
  const partial = `${path}.partial`;
  const out = createWriteStream(partial);
  for (const piece of pieces) {
    for await (const chunk of createReadStream(join(parts, piece))) if (!out.write(chunk)) await once(out, "drain");
  }
  out.end();
  await once(out, "finish");
  const digest = await sha256(partial);
  if (digest !== FILES[ASSEMBLED]) {
    rmSync(partial, { force: true });
    throw new Error(`${ASSEMBLED} : empreinte inattendue (${digest}), fichier écarté.`);
  }
  renameSync(partial, path);
  process.stdout.write("prêt.\n");
}

for (const [file, expected] of Object.entries(FILES)) {
  const path = join(target, file);
  if (existsSync(path) && (await sha256(path)) === expected) continue;
  if (file !== ASSEMBLED) throw new Error(`${file} : absent ou modifié dans ${target} (il est versionné dans git).`);
  await assemble(path);
}

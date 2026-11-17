#!/usr/bin/env node
/**
 * Récupère le modèle de la recherche par le sens (multilingual-e5-small) dans `src-tauri/resources/models/`, d’où
 * Tauri le livre avec Alfred : l’utilisateur n’a rien à télécharger. Le dépôt git ne le contient pas (470 Mo, au-delà
 * de ce que GitHub accepte par fichier) : ce script le récupère une fois, à la construction, à une révision figée,
 * et écarte tout fichier dont l’empreinte SHA-256 diffère. Un fichier déjà présent et intact n’est pas repris.
 */
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const MODEL = "intfloat/multilingual-e5-small";
const REVISION = "614241f622f53c4eeff9890bdc4f31cfecc418b3";
const FILES = {
  "config.json": "69137736cab8b8903a07fe8afaafdda25aac55415a12a55d1bffa9f581abf959",
  "tokenizer.json": "0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39",
  "model.safetensors": "1a55775f53449dac10a2bcbc312469fac40b96d53198c407081a831f81c98477",
};

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const target = join(root, "src-tauri", "resources", "models", "multilingual-e5-small");

async function sha256(path) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

mkdirSync(target, { recursive: true });
for (const [file, expected] of Object.entries(FILES)) {
  const path = join(target, file);
  if (existsSync(path) && (await sha256(path)) === expected) continue;
  const url = `https://huggingface.co/${MODEL}/resolve/${REVISION}/${file}`;
  process.stdout.write(`Modèle de recherche : ${file}… `);
  const response = await fetch(url);
  if (!response.ok || !response.body) throw new Error(`${file} : réponse ${response.status} de ${url}`);
  const partial = `${path}.part`;
  await pipeline(Readable.fromWeb(response.body), createWriteStream(partial));
  const digest = await sha256(partial);
  if (digest !== expected) {
    rmSync(partial, { force: true });
    throw new Error(`${file} : empreinte inattendue (${digest}), fichier écarté.`);
  }
  renameSync(partial, path);
  process.stdout.write("reçu.\n");
}

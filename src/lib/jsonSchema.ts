/**
 * Validation d’une valeur contre un schéma JSON, pour le sous-ensemble utile aux réponses de modèle : types,
 * propriétés, champs requis, tableaux, énumérations, bornes. Renvoie la liste des écarts, vide si la valeur convient.
 */

type Schema = Record<string, unknown>;

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

function matchesType(value: unknown, type: string): boolean {
  const actual = typeOf(value);
  return actual === type || (type === "number" && actual === "integer");
}

export function validateSchema(value: unknown, schema: unknown, path = "$"): string[] {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return [];
  const rules = schema as Schema;
  const errors: string[] = [];

  if (Array.isArray(rules.enum) && !rules.enum.some((allowed) => JSON.stringify(allowed) === JSON.stringify(value)))
    errors.push(
      `${path} : valeur hors de la liste autorisée (${rules.enum.map((item) => JSON.stringify(item)).join(", ")}).`,
    );
  if ("const" in rules && JSON.stringify(rules.const) !== JSON.stringify(value))
    errors.push(`${path} : doit valoir ${JSON.stringify(rules.const)}.`);

  const types =
    rules.type === undefined ? [] : Array.isArray(rules.type) ? rules.type.map(String) : [String(rules.type)];
  if (types.length && !types.some((type) => matchesType(value, type))) {
    errors.push(`${path} : type attendu ${types.join(" ou ")}, reçu ${typeOf(value)}.`);
    return errors;
  }

  for (const key of ["anyOf", "oneOf"] as const) {
    const options = rules[key];
    if (Array.isArray(options) && options.length) {
      const passing = options.filter((option) => validateSchema(value, option, path).length === 0).length;
      if (passing === 0 || (key === "oneOf" && passing > 1))
        errors.push(`${path} : ne correspond à ${key === "oneOf" ? "exactement une" : "aucune"} des formes prévues.`);
    }
  }

  if (typeof value === "string") {
    if (typeof rules.minLength === "number" && value.length < rules.minLength)
      errors.push(`${path} : au moins ${rules.minLength} caractères attendus.`);
    if (typeof rules.maxLength === "number" && value.length > rules.maxLength)
      errors.push(`${path} : au plus ${rules.maxLength} caractères attendus.`);
    if (typeof rules.pattern === "string") {
      try {
        if (!new RegExp(rules.pattern).test(value))
          errors.push(`${path} : ne respecte pas le format ${rules.pattern}.`);
      } catch {
        // Un motif que le moteur ne comprend pas n’invalide pas la réponse.
      }
    }
  }
  if (typeof value === "number") {
    if (typeof rules.minimum === "number" && value < rules.minimum) errors.push(`${path} : minimum ${rules.minimum}.`);
    if (typeof rules.maximum === "number" && value > rules.maximum) errors.push(`${path} : maximum ${rules.maximum}.`);
  }
  if (Array.isArray(value)) {
    if (typeof rules.minItems === "number" && value.length < rules.minItems)
      errors.push(`${path} : au moins ${rules.minItems} éléments attendus.`);
    if (typeof rules.maxItems === "number" && value.length > rules.maxItems)
      errors.push(`${path} : au plus ${rules.maxItems} éléments attendus.`);
    if (rules.items)
      for (const [index, item] of value.entries())
        errors.push(...validateSchema(item, rules.items, `${path}[${index}]`));
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const object = value as Record<string, unknown>;
    const properties = (rules.properties ?? {}) as Record<string, unknown>;
    for (const name of Array.isArray(rules.required) ? rules.required.map(String) : [])
      if (!(name in object)) errors.push(`${path}.${name} : champ requis absent.`);
    for (const [name, child] of Object.entries(properties))
      if (name in object) errors.push(...validateSchema(object[name], child, `${path}.${name}`));
    if (rules.additionalProperties === false)
      for (const name of Object.keys(object))
        if (!(name in properties)) errors.push(`${path}.${name} : champ non prévu par le schéma.`);
  }
  return errors;
}

/** Extrait l’objet JSON d’une réponse de modèle : la réponse entière, un bloc ```json, ou le premier objet trouvé. */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const candidates = [trimmed];
  const fenced = [...trimmed.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map((match) => match[1].trim());
  candidates.push(...fenced.reverse());
  const first = trimmed.search(/[{[]/);
  const last = Math.max(trimmed.lastIndexOf("}"), trimmed.lastIndexOf("]"));
  if (first >= 0 && last > first) candidates.push(trimmed.slice(first, last + 1));
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Candidat suivant.
    }
  }
  throw new Error("La réponse du modèle ne contient pas de JSON lisible.");
}

/**
 * Description textuelle d’un document rendu, pour un modèle qui ne voit pas d’image : l’arbre accessible réduit à ce
 * que l’utilisateur perçoit (titres, textes, boutons, champs, listes, tableaux, onglets) et à leur état (coché,
 * désactivé, développé, sélectionné…). Les éléments cachés sont ignorés ; la sortie est bornée.
 */

export interface PageDescription {
  title: string;
  /** Une ligne par élément, indentée de deux espaces par niveau d’imbrication. */
  text: string;
  truncated: boolean;
}

const MAX_CHARS = 30_000;
const MAX_TEXT = 300;
const MAX_ROWS = 40;
const MAX_DEPTH = 40;

/** Éléments dont le nom (leur texte) suffit : on n’en décrit pas l’intérieur. */
const LEAF_ROLES = new Set([
  "button",
  "link",
  "heading",
  "textbox",
  "searchbox",
  "spinbutton",
  "checkbox",
  "radio",
  "switch",
  "slider",
  "combobox",
  "option",
  "tab",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "img",
  "progressbar",
  "meter",
  "cell",
  "columnheader",
  "rowheader",
  "treeitem",
]);

/** Conteneurs qui méritent une ligne à eux, avec leurs enfants indentés dessous. */
const CONTAINER_ROLES = new Set([
  "alert",
  "alertdialog",
  "dialog",
  "status",
  "list",
  "listitem",
  "listbox",
  "menu",
  "menubar",
  "navigation",
  "main",
  "form",
  "region",
  "group",
  "radiogroup",
  "tablist",
  "tabpanel",
  "toolbar",
  "tree",
  "grid",
  "table",
  "banner",
  "complementary",
  "contentinfo",
  "search",
  "article",
  "figure",
]);

const INTERACTIVE =
  "a[href],button,input,select,textarea,h1,h2,h3,h4,h5,h6,img,table,ul,ol,dialog,progress,meter,[role],[aria-label]";

function clean(value: string | null | undefined, limit = MAX_TEXT): string {
  const text = (value ?? "").replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function quote(value: string): string {
  return JSON.stringify(value);
}

function isHidden(element: Element): boolean {
  if (element.hasAttribute("hidden") || element.getAttribute("aria-hidden") === "true") return true;
  if (element instanceof HTMLInputElement && element.type === "hidden") return true;
  const tag = element.tagName;
  if (tag === "SCRIPT" || tag === "STYLE" || tag === "TEMPLATE" || tag === "NOSCRIPT") return true;
  const view = element.ownerDocument.defaultView;
  if (!view) return false;
  const style = view.getComputedStyle(element);
  return style.display === "none" || style.visibility === "hidden";
}

function implicitRole(element: Element): string | undefined {
  const tag = element.tagName.toLowerCase();
  switch (tag) {
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6":
      return "heading";
    case "button":
      return "button";
    case "a":
      return element.hasAttribute("href") ? "link" : undefined;
    case "textarea":
      return "textbox";
    case "select":
      return (element as HTMLSelectElement).multiple ? "listbox" : "combobox";
    case "option":
      return "option";
    case "img":
      return "img";
    case "progress":
      return "progressbar";
    case "meter":
      return "meter";
    case "ul":
    case "ol":
      return "list";
    case "li":
      return "listitem";
    case "table":
      return "table";
    case "th":
      return "columnheader";
    case "td":
      return "cell";
    case "dialog":
      return "dialog";
    case "nav":
      return "navigation";
    case "main":
      return "main";
    case "form":
      return "form";
    case "fieldset":
      return "group";
    case "input": {
      const type = (element as HTMLInputElement).type;
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "range") return "slider";
      if (type === "number") return "spinbutton";
      if (type === "search") return "searchbox";
      if (type === "button" || type === "submit" || type === "reset") return "button";
      return "textbox";
    }
    default:
      return undefined;
  }
}

function roleOf(element: Element): string | undefined {
  const explicit = element.getAttribute("role")?.split(/\s+/)[0];
  if (explicit && explicit !== "presentation" && explicit !== "none") return explicit;
  return implicitRole(element);
}

function textOf(element: Element): string {
  const parts: string[] = [];
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      parts.push(node.textContent ?? "");
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const child = node as Element;
    if (isHidden(child)) return;
    if (child instanceof HTMLImageElement) {
      parts.push(child.alt);
      return;
    }
    for (const next of (child.shadowRoot ?? child).childNodes) walk(next);
    // Les blocs séparent les mots : « Titre » et « Sous-titre » ne se collent pas.
    parts.push(" ");
  };
  walk(element);
  return clean(parts.join(""));
}

function nameOf(element: Element, role: string | undefined): string {
  const label = element.getAttribute("aria-label");
  if (label) return clean(label);
  const labelledBy = element.getAttribute("aria-labelledby");
  if (labelledBy) {
    const text = labelledBy
      .split(/\s+/)
      .map((id) => element.ownerDocument.getElementById(id))
      .filter((item): item is HTMLElement => item !== null)
      .map((item) => textOf(item))
      .join(" ");
    if (text) return clean(text);
  }
  if (element instanceof HTMLImageElement) return clean(element.alt);
  if (
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLSelectElement
  ) {
    const labels = element.labels ? [...element.labels].map((item) => textOf(item)).join(" ") : "";
    if (labels) return clean(labels);
    if (element instanceof HTMLInputElement && ["button", "submit", "reset"].includes(element.type)) {
      return clean(element.value);
    }
    const placeholder = element.getAttribute("placeholder");
    if (placeholder) return clean(placeholder);
    return clean(element.getAttribute("title"));
  }
  if (role && LEAF_ROLES.has(role)) return textOf(element) || clean(element.getAttribute("title"));
  return clean(element.getAttribute("title"));
}

function states(element: Element, role: string): string[] {
  const result: string[] = [];
  const aria = (name: string) => element.getAttribute(`aria-${name}`);
  const disabled =
    aria("disabled") === "true" || ((element as HTMLButtonElement).disabled === true && "disabled" in element);
  if (disabled) result.push("désactivé");
  if (element instanceof HTMLInputElement && (element.type === "checkbox" || element.type === "radio")) {
    if (element.indeterminate) result.push("indéterminé");
    else result.push(element.checked ? "coché" : "non coché");
  } else if (aria("checked") !== null) {
    const checked = aria("checked");
    result.push(checked === "mixed" ? "indéterminé" : checked === "true" ? "coché" : "non coché");
  } else if (element.getAttribute("data-state") === "checked" && (role === "switch" || role === "checkbox")) {
    result.push("coché");
  }
  if (aria("pressed") !== null) result.push(aria("pressed") === "true" ? "enfoncé" : "relâché");
  if (aria("expanded") !== null) result.push(aria("expanded") === "true" ? "développé" : "replié");
  if (aria("selected") === "true" || (element instanceof HTMLOptionElement && element.selected)) {
    result.push("sélectionné");
  }
  const current = aria("current");
  if (current && current !== "false") result.push("courant");
  if (aria("invalid") === "true") result.push("invalide");
  if (aria("required") === "true" || (element as HTMLInputElement).required === true) result.push("requis");
  if (aria("readonly") === "true" || (element as HTMLInputElement).readOnly === true) result.push("lecture seule");
  if (aria("busy") === "true") result.push("en cours");
  return result;
}

function currentValue(element: Element, role: string): string | undefined {
  if (element instanceof HTMLSelectElement) {
    return clean([...element.selectedOptions].map((option) => option.textContent).join(", "));
  }
  if (element instanceof HTMLInputElement) {
    if (["checkbox", "radio", "button", "submit", "reset"].includes(element.type)) return undefined;
    if (element.type === "password") return element.value ? "••••" : "";
    return clean(element.value);
  }
  if (element instanceof HTMLTextAreaElement) return clean(element.value);
  if (element instanceof HTMLProgressElement || element instanceof HTMLMeterElement) {
    return `${element.value}/${element.max}`;
  }
  const now = element.getAttribute("aria-valuetext") ?? element.getAttribute("aria-valuenow");
  if (now !== null) return clean(now);
  if (role === "combobox") {
    // Liste déroulante de Radix : le bouton affiche la valeur choisie.
    return undefined;
  }
  return undefined;
}

function line(role: string, element: Element, extra?: string): string {
  const parts: string[] = [role];
  if (role === "heading") {
    const level = element.getAttribute("aria-level") ?? element.tagName.match(/^H(\d)$/)?.[1];
    if (level) parts[0] = `heading ${level}`;
  }
  const name = nameOf(element, role);
  if (name) parts.push(quote(name));
  const value = currentValue(element, role);
  if (value !== undefined) parts.push(`valeur=${quote(value)}`);
  const flags = states(element, role);
  if (flags.length) parts.push(`(${flags.join(", ")})`);
  if (extra) parts.push(extra);
  return parts.join(" ");
}

function describeTable(table: Element, depth: number, out: string[]) {
  const rows = [...table.querySelectorAll("tr, [role=row]")].filter(
    (row) => row.closest("table, [role=table], [role=grid]") === table && !isHidden(row),
  );
  out.push(`${"  ".repeat(depth)}${line(roleOf(table) ?? "table", table, `(${rows.length} lignes)`)}`);
  for (const row of rows.slice(0, MAX_ROWS)) {
    const cells = [...row.children].filter((cell) => !isHidden(cell)).map((cell) => describeCell(cell));
    out.push(`${"  ".repeat(depth + 1)}row: ${cells.join(" | ")}`);
  }
  if (rows.length > MAX_ROWS) out.push(`${"  ".repeat(depth + 1)}… ${rows.length - MAX_ROWS} lignes de plus`);
}

function describeCell(cell: Element): string {
  // Une cellule peut porter une case ou un bouton : on en garde la nature, pas seulement le texte.
  const control = cell.querySelector("input, button, select, [role=checkbox], [role=switch], [role=button]");
  const text = textOf(cell);
  if (control && !isHidden(control)) {
    const role = roleOf(control) ?? "button";
    const described = line(role, control);
    return text && !described.includes(quote(text)) ? `${quote(text)} [${described}]` : `[${described}]`;
  }
  return quote(text);
}

function walk(element: Element, depth: number, out: string[]) {
  if (depth > MAX_DEPTH || isHidden(element)) return;
  // Détail d’une erreur, écrit par la page : Alfred ne le transmet pas à l’agent (voir frameErrors).
  if (element.getAttribute("data-alfred-withheld") === "true") {
    out.push(
      `${"  ".repeat(depth)}text "(détail de l’erreur non transmis : lire le code à l’emplacement donné par runtimeError)"`,
    );
    return;
  }
  const role = roleOf(element);
  if (role === "table" || role === "grid") {
    describeTable(element, depth, out);
    return;
  }
  if (role && LEAF_ROLES.has(role)) {
    out.push(`${"  ".repeat(depth)}${line(role, element)}`);
    return;
  }
  let childDepth = depth;
  if (role && CONTAINER_ROLES.has(role)) {
    out.push(`${"  ".repeat(depth)}${line(role, element)}`);
    childDepth = depth + 1;
  } else if (!element.querySelector(INTERACTIVE)) {
    // Conteneur sans rien d’interactif dedans : son texte, en une ligne.
    const text = textOf(element);
    if (text) out.push(`${"  ".repeat(depth)}text ${quote(text)}`);
    return;
  }
  for (const child of (element.shadowRoot ?? element).childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      const text = clean(child.textContent);
      if (text) out.push(`${"  ".repeat(childDepth)}text ${quote(text)}`);
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      walk(child as Element, childDepth, out);
    }
  }
}

/** Décrit `root` (par défaut le corps du document) tel que l’utilisateur le voit. */
export function describePage(root: Element = document.body): PageDescription {
  const lines: string[] = [];
  walk(root, 0, lines);
  // Le focus dit où en est l’utilisateur (un champ en cours de saisie, un dialogue ouvert).
  const focused = root.ownerDocument.activeElement;
  if (focused && focused !== root.ownerDocument.body && root.contains(focused)) {
    const role = roleOf(focused);
    if (role) lines.push(`focus: ${line(role, focused)}`);
  }
  let text = lines.join("\n");
  const truncated = text.length > MAX_CHARS;
  if (truncated) text = `${text.slice(0, MAX_CHARS)}\n…`;
  return { title: clean(root.ownerDocument.title), text, truncated };
}

export interface RegionRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RegionDescription {
  /** Ancêtres de l’élément ciblé, du plus large au plus précis : balise, rôle et classes des composants. */
  path: string[];
  /** L’élément ciblé décrit comme `describePage` décrit la page. */
  text: string;
  truncated: boolean;
}

const MAX_REGION_CHARS = 6000;
const MAX_REGION_ELEMENTS = 40;
/** Points sondés par côté du cadre : assez pour toucher chaque ligne ou colonne d’un cadre moyen. */
const SAMPLES = 7;

function tagOf(element: Element): string {
  const role = roleOf(element);
  const classes = [...element.classList]
    .slice(0, 3)
    .map((name) => `.${name}`)
    .join("");
  // Un dialogue, une région ou un formulaire se reconnaît à son nom : « dialog "Trier la boîte" ».
  const name = role && CONTAINER_ROLES.has(role) ? nameOf(element, role) : "";
  return `${element.localName}${classes}${role ? ` [${role}${name ? ` ${quote(name)}` : ""}]` : ""}`;
}

/** Élément qui a du sens pour l’utilisateur au-dessus d’un nœud touché : contrôle, cellule, titre, élément de liste. */
function meaningful(element: Element): Element {
  let current: Element | null = element;
  for (let depth = 0; current && depth < 6; depth += 1) {
    const role = roleOf(current);
    if (role && (LEAF_ROLES.has(role) || role === "listitem")) return current;
    current = current.parentElement;
  }
  return element;
}

function commonAncestor(elements: Element[]): Element {
  let common: Element | null = elements[0] ?? document.body;
  for (const element of elements.slice(1)) {
    while (common && !common.contains(element)) common = common.parentElement;
  }
  return common ?? document.body;
}

/**
 * Éléments que l’utilisateur a encadrés dans la fenêtre du cadre (coordonnées de la partie visible) : ceux du dessus
 * (un dialogue ouvert passe avant la page derrière lui), sondés sur une grille de points à l’intérieur du cadre.
 */
export function describeRegion(rect: RegionRect): RegionDescription {
  const touched = new Set<Element>();
  for (let column = 0; column < SAMPLES; column += 1) {
    for (let row = 0; row < SAMPLES; row += 1) {
      const x = rect.x + (rect.width * (column + 0.5)) / SAMPLES;
      const y = rect.y + (rect.height * (row + 0.5)) / SAMPLES;
      const top = document.elementFromPoint(x, y);
      if (!top || top === document.documentElement || top === document.body) continue;
      touched.add(meaningful(top));
    }
  }
  // Un contrôle désactivé ignore le pointeur (`pointer-events: none`) : on retient aussi ceux dont le centre est dans
  // le cadre, pris dans la couche du dessus (le dialogue ouvert s’il y en a un, sinon la page).
  const first = [...touched][0];
  const layer = first?.closest("dialog[open], [role=dialog], [role=alertdialog], [aria-modal=true]") ?? document.body;
  for (const candidate of layer.querySelectorAll("*")) {
    const role = roleOf(candidate);
    if (!role || !LEAF_ROLES.has(role) || isHidden(candidate)) continue;
    const box = candidate.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) continue;
    const centerX = box.left + box.width / 2;
    const centerY = box.top + box.height / 2;
    if (centerX >= rect.x && centerX <= rect.x + rect.width && centerY >= rect.y && centerY <= rect.y + rect.height)
      touched.add(candidate);
  }
  // Le plus précis l’emporte : un élément qui en contient un autre touché n’est pas répété.
  const hits = [...touched]
    .filter((element) => ![...touched].some((other) => other !== element && element.contains(other)))
    .sort((left, right) => (left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
  const container = hits.length ? commonAncestor(hits) : document.body;
  const path: string[] = [];
  for (let current: Element | null = container; current && current !== document.documentElement; ) {
    path.unshift(tagOf(current));
    current = current.parentElement;
  }
  const lines = hits.slice(0, MAX_REGION_ELEMENTS).map((element) => {
    const role = roleOf(element);
    if (role) return line(role, element);
    const text = textOf(element);
    return text ? `text ${quote(text)}` : tagOf(element);
  });
  if (hits.length > MAX_REGION_ELEMENTS) lines.push(`… ${hits.length - MAX_REGION_ELEMENTS} éléments de plus`);
  let text = lines.join("\n");
  const truncated = text.length > MAX_REGION_CHARS;
  if (truncated) text = `${text.slice(0, MAX_REGION_CHARS)}\n…`;
  return { path: path.slice(-12), text, truncated };
}

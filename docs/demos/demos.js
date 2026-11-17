/* Démos animées : la fenêtre d’Alfred reconstituée d’après l’application (menu à gauche avec Agent et Réglages en bas,
   barre du haut, panneau de droite), pilotée par des scénarios. Données fictives ; rien n’est enregistré ni envoyé.
   Partagé par docs/presentation.html et docs/architecture.html, avec demos.css.

   Usage dans une page :
     <div class="dm" data-demo="creer-page"></div>           une démo seule ;
     <div class="dm" data-demo="all"></div>                  les quatre, avec des onglets ;
     <div class="dm" data-demo="creer-page" data-video="videos/creer-page.mp4" data-poster="videos/creer-page.jpg"></div>
                                                             la vidéo enregistrée, à la place de la démo animée.
   Identifiants : creer-page, brancher-module, rechercher, corriger.

   Pilotage par la page hôte (le diaporama de presentation.html) : chaque élément .dm reçoit el.player,
   avec play() (lance depuis le début) et stop() (arrête et remet au début), pour une démo comme pour une vidéo. */
(() => {
  const W = 1120;
  const CANCEL = Symbol("cancel");
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));
  const html = (s) => { const t = document.createElement("template"); t.innerHTML = s.trim(); return t.content.firstElementChild; };

  const PATHS = {
    panelLeft: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
    panelRight: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
    target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3"/>',
    bell: '<path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4z"/><path d="M10 20a2 2 0 0 0 4 0"/>',
    plug: '<path d="M9 2v5M15 2v5M6 7h12v4a6 6 0 0 1-12 0zM12 17v5"/>',
    bot: '<rect x="4" y="8" width="16" height="12" rx="3"/><path d="M12 8V4M9 14h.01M15 14h.01"/>',
    sliders: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
    receipt: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6"/>',
    users: '<circle cx="9" cy="8" r="3.5"/><path d="M3 20c0-3.5 2.7-6 6-6s6 2.5 6 6"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14c2 .8 3 3 3 6"/>',
    ticket: '<path d="M3 8a2 2 0 0 0 0 4v4h18v-4a2 2 0 0 1 0-4V4H3z" transform="translate(0 2)"/><path d="M14 6v12" stroke-dasharray="2 2"/>',
    blocks: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
    store: '<path d="M4 9l1.5-5h13L20 9M4 9h16v11H4zM9 20v-6h6v6"/>',
    folder: '<path d="M3 6a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/>',
    palette: '<circle cx="12" cy="12" r="9"/><circle cx="8" cy="10" r="1"/><circle cx="12" cy="7" r="1"/><circle cx="16" cy="10" r="1"/>',
    list: '<path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/>',
    book: '<path d="M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3z"/><path d="M5 17a3 3 0 0 1 3-3h11"/>',
    mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
    volume: '<path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M17 9a4 4 0 0 1 0 6"/>',
    key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9M17 6l2 2"/>',
    check: '<path d="m5 12 5 5 9-10"/>',
    up: '<path d="M12 19V5M6 11l6-6 6 6"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    x: '<path d="M6 6l12 12M18 6 6 18"/>',
    down: '<path d="m6 9 6 6 6-6"/>',
    right: '<path d="m9 6 6 6-6 6"/>',
    left: '<path d="M19 12H5M11 6l-6 6 6 6"/>',
    diff: '<path d="M7 3h7l5 5v13H7z"/><path d="M11 11h4M13 9v4M11 17h4"/>',
    undo: '<path d="M4 4v6h6"/><path d="M4 10a8 8 0 1 1 2 7"/>',
    more: '<path d="M5 12h.01M12 12h.01M19 12h.01" stroke-width="3"/>',
    refresh: '<path d="M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5"/>',
    play: '<path d="M8 5v14l11-7z" fill="currentColor" stroke="none"/>',
  };
  const ic = (name, size = 16) => `<svg class="dm-ico" style="--s:${size}px" viewBox="0 0 24 24" aria-hidden="true">${PATHS[name]}</svg>`;
  const TONE = { "À payer": "warn", "Payée": "ok", "En retard": "bad", "Actif": "ok", "Inactif": "mute", "En cours": "warn", "À faire": "mute", "Terminé": "ok", "Prêt": "ok", "À configurer": "warn" };
  const badge = (s) => `<span class="dm-badge ${TONE[s] || "mute"}">${s}</span>`;
  const initials = (n) => n.split(" ").map((w) => w[0]).join("").slice(0, 2);
  const input = (ph, cls = "", icon = "") => `<div class="dm-input ${cls}">${icon ? ic(icon, 15) : ""}<span class="dm-txt" data-ph="${ph}"></span><span class="dm-caret"></span></div>`;

  /* ---------- Données fictives ---------- */
  const FACTURES = [
    { n: "F-2026-118", c: "Atelier Moreau", e: "30 nov. 2026", m: 1240, s: "À payer" },
    { n: "F-2026-117", c: "Brasserie du Port", e: "22 nov. 2026", m: 860.5, s: "Payée" },
    { n: "F-2026-116", c: "Studio Kerlan", e: "15 nov. 2026", m: 2300, s: "En retard" },
    { n: "F-2026-115", c: "Atelier Moreau", e: "2 nov. 2026", m: 415, s: "Payée" },
    { n: "F-2026-114", c: "Librairie Ortolan", e: "28 oct. 2026", m: 98.9, s: "Payée" },
    { n: "F-2026-113", c: "Garage Fabre", e: "21 oct. 2026", m: 1575, s: "Payée" },
    { n: "F-2026-112", c: "Brasserie du Port", e: "14 oct. 2026", m: 640, s: "Payée" },
  ];
  const euros = (v) => new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" }).format(v);
  const CONTACTS = [
    { n: "Léa Martin", soc: "Atelier Moreau", v: "Lyon", s: "Actif" },
    { n: "Hugo Bernard", soc: "Brasserie du Port", v: "Nantes", s: "Actif" },
    { n: "Chloé Petit", soc: "Studio Kerlan", v: "Lyon", s: "Inactif" },
    { n: "Nathan Roux", soc: "Librairie Ortolan", v: "Lyon", s: "Actif" },
    { n: "Inès Fabre", soc: "Garage Fabre", v: "Grenoble", s: "Actif" },
    { n: "Paul Girard", soc: "Lyonnaise de conseil", v: "Villeurbanne", s: "Actif" },
    { n: "Emma Laurent", soc: "Studio Kerlan", v: "Paris", s: "Actif" },
  ];
  const TICKETS = [
    { k: "ALF-231", t: "Erreur à l’export PDF", a: "Léa M.", s: "En cours" },
    { k: "ALF-229", t: "Ajouter le filtre par client", a: "Hugo B.", s: "À faire" },
    { k: "ALF-224", t: "Lenteur de la recherche", a: "Léa M.", s: "En cours" },
    { k: "ALF-220", t: "Traduire l’écran d’accueil", a: "Inès F.", s: "Terminé" },
    { k: "ALF-217", t: "Relances automatiques", a: "Nathan R.", s: "Terminé" },
  ];

  /* ---------- Écrans ---------- */
  function table(cols, rows, sel) {
    const head = cols.map((c) => `<div class="${c.cls || ""}" style="flex:${c.f || 1}">${c.h}</div>`).join("");
    const body = rows.map((r, i) => `<div class="dm-tr ${sel === i ? "sel" : ""}" data-row="${i}">${cols.map((c) => `<div class="${c.cls || ""}" style="flex:${c.f || 1}">${c.fn(r)}</div>`).join("")}</div>`).join("");
    return `<div class="dm-table"><div class="dm-tr dm-th">${head}</div>${body}</div>`;
  }
  const page = ({ bar, body, foot = "" }) => `<div class="dm-page"><div class="dm-bar">${bar}</div><div class="dm-pbody">${body}</div>${foot ? `<div class="dm-pfoot">${foot}</div>` : ""}</div>`;
  const empty = (title, text) => `<div class="dm-empty"><strong>${title}</strong><span>${text}</span></div>`;

  function facturesPage({ fmt = true, sel = -1 } = {}) {
    const cols = [
      { h: "Numéro", f: 1, cls: "mono", fn: (r) => r.n },
      { h: "Client", f: 1.5, fn: (r) => r.c },
      { h: "Échéance", f: 1.1, fn: (r) => r.e },
      { h: "Montant", f: 1, cls: `col-m ${fmt ? "end" : ""}`, fn: (r) => (fmt ? euros(r.m) : String(r.m)) },
      { h: "État", f: 0.8, fn: (r) => badge(r.s) },
    ];
    return page({
      bar: `${input("Rechercher…", "", "search").replace('class="dm-input "', 'class="dm-input" style="width:180px"')}<span class="dm-select">Tous les états ${ic("down", 14)}</span><span class="dm-btn primary dm-push">Nouvelle facture</span>`,
      body: table(cols, FACTURES, sel), foot: "7 factures",
    });
  }
  const facturePanel = (r) => `<div class="dm-pnh">${r.n}${ic("x", 15)}</div><div class="dm-pnb"><div>${badge(r.s)}</div><div class="dm-kv"><span>Client</span><span>${r.c}</span><span>Échéance</span><span>${r.e}</span><span>Montant</span><span>${euros(r.m)}</span><span>Pièce jointe</span><span>${r.n}.pdf</span></div><span class="dm-btn" style="align-self:flex-start">Marquer payée</span></div>`;

  const matchTag = (r, tag) => {
    const [k, v] = tag.split(" : ");
    if (k === "Ville") return r.v === v;
    if (k === "État") return r.s.toLowerCase() === v.toLowerCase();
    return true;
  };
  function contactsPage(st) {
    const rows = CONTACTS.filter((r) => st.tags.every((t) => matchTag(r, t)));
    const cols = [
      { h: "Nom", f: 1.4, fn: (r) => `<span class="dm-av">${initials(r.n)}</span>${r.n}` },
      { h: "Société", f: 1.5, fn: (r) => r.soc },
      { h: "Ville", f: 1, fn: (r) => r.v },
      { h: "État", f: 0.7, fn: (r) => badge(r.s) },
    ];
    const tags = st.tags.map((t) => `<span class="dm-tag">${t} ${ic("x", 11)}</span>`).join("");
    return page({
      bar: `<div class="dm-input dm-search" style="width:440px">${ic("search", 15)}${tags}<span class="dm-txt" data-ph="${st.tags.length ? "" : "Rechercher un contact…"}"></span><span class="dm-caret"></span></div><span class="dm-btn primary dm-push">Nouveau contact</span>`,
      body: table(cols, rows, rows.findIndex((r) => r.n === st.open)),
      foot: `${rows.length} contact${rows.length > 1 ? "s" : ""}`,
    });
  }
  function contactPanel(name) {
    const r = CONTACTS.find((c) => c.n === name);
    return `<div class="dm-pnh">${r.n}${ic("x", 15)}</div><div class="dm-pnb"><span class="dm-av" style="width:42px;height:42px;font-size:14px">${initials(r.n)}</span><div class="dm-kv"><span>Société</span><span>${r.soc}</span><span>Ville</span><span>${r.v}</span><span>État</span><span>${badge(r.s)}</span><span>Courriel</span><span>${r.n.split(" ")[0].toLowerCase()}@exemple.fr</span></div></div>`;
  }
  function ticketsPage(state) {
    const cols = [
      { h: "Clé", f: 0.7, cls: "mono", fn: (r) => r.k },
      { h: "Titre", f: 2.4, fn: (r) => r.t },
      { h: "Assigné", f: 0.9, fn: (r) => r.a },
      { h: "État", f: 0.8, fn: (r) => badge(r.s) },
    ];
    const body = state === "loading"
      ? `<div class="dm-table">${Array.from({ length: 5 }, () => `<div class="dm-tr"><div style="flex:.7"><div class="dm-skel"></div></div><div style="flex:2.4"><div class="dm-skel" style="width:70%"></div></div><div style="flex:.9"><div class="dm-skel"></div></div><div style="flex:.8"><div class="dm-skel"></div></div></div>`).join("")}</div>`
      : table(cols, TICKETS);
    return page({ bar: `${input("Rechercher…", "", "search").replace('class="dm-input "', 'class="dm-input" style="width:180px"')}<span class="dm-select">Projet : ALF ${ic("down", 14)}</span>`, body, foot: state === "ready" ? "5 tickets" : "" });
  }
  const agentHome = () => `<div class="dm-agent"><div class="dm-transcript"><div class="dm-hello"><strong>Que puis-je faire pour vous ?</strong><span>Dites-moi ce dont vous avez besoin : je le mets en place et je vous dis où le trouver.</span></div></div>
    <div class="dm-composer">${ic("plus", 16)}<div class="dm-in"><span class="dm-txt" data-ph="Que puis-je mettre en place pour vous ?"></span><span class="dm-caret"></span></div>${ic("volume", 16)}${ic("mic", 16)}<span class="dm-send">${ic("up", 14)}</span></div>
    <div class="dm-under"><span>Opus · élevé ⌄</span><span>Autonomie totale ⌄</span><span>Dossier de l’espace de travail</span></div></div>`;
  const tracking = (state = "idle") => `<div class="dm-track"><div><strong>À traiter ${ic("down", 13)}</strong><span>Aucune réponse attendue.</span></div><div><strong>En cours ${ic("down", 13)}</strong><span>${state === "running" ? "Page des factures" : "Aucune conversation en cours."}</span></div><div><strong>Terminées ${ic("down", 13)}</strong><span>${state === "done" ? "Page des factures" : "Aucune conversation terminée."}</span></div><div><strong>Modifications ${ic("down", 13)}</strong><span>${state === "done" ? "Enregistrées dans l’espace de travail" : "Aucune modification Git."}</span></div></div>`;
  const changes = (files) => `<div class="dm-changes"><div class="h">${ic("diff", 16)}<div><b>${files.length} fichiers de l’espace de travail modifiés</b><span class="dm-add">+${files.reduce((a, f) => a + f[1], 0)}</span> <span class="dm-del">−0</span></div><span class="undo">${ic("undo", 14)}Annuler cette modification</span></div>${files.map(([dir, add, name]) => `<div class="f"><span>${dir}<b>${name}</b></span><span class="dm-add">+${add} <span class="dm-del">−0</span></span></div>`).join("")}</div>`;

  /* ---------- La fenêtre ---------- */
  const SNAV = [["Modules", "blocks"], ["Marketplace", "store"], ["Général", "folder"], ["Apparence", "palette"], ["Ordre du menu", "list"]];
  class App {
    constructor(player) {
      this.P = player;
      this.el = html(`<div class="dm-app">
        <aside class="dm-side">
          <div class="dm-space">${ic("panelLeft", 16)}Mon espace</div>
          <div class="dm-find">${ic("search", 15)}Rechercher… · ⌘K</div>
          <div class="dm-group">Espace de travail</div>
          <div class="dm-secs" style="display:flex;flex-direction:column;gap:2px"></div>
          <div class="dm-bottom"><div class="dm-sec" data-s="agent">${ic("bot", 16)}<span>Agent</span></div><div class="dm-sec" data-s="settings">${ic("sliders", 16)}<span>Réglages</span></div></div>
        </aside>
        <div class="dm-wrap"><div class="dm-top"></div><div class="dm-body"><main class="dm-main"></main><aside class="dm-panel"></aside></div></div>
        <div class="dm-layer"></div>
        <div class="dm-cursor"><svg viewBox="0 0 24 24"><path d="M4 2l15 11-7 1-3 7z" fill="#fff" stroke="#111" stroke-width="1.4" stroke-linejoin="round"/></svg></div>
      </div>`);
      player.stage.replaceChildren(this.el);
      this.cursor = this.q(".dm-cursor");
      this.cx = 760; this.cy = 480;
      this.cursor.style.transform = `translate(${this.cx}px,${this.cy}px)`;
      this.secs = []; this.active = null;
    }
    q(s) { return this.el.querySelector(s); }
    qa(s) { return [...this.el.querySelectorAll(s)]; }
    sections(list, active) { this.secs = list; this.go(active); }
    addSection(s) { this.secs.push({ ...s, isNew: true }); this.renderSecs(); delete this.secs[this.secs.length - 1].isNew; }
    renderSecs() {
      this.q(".dm-secs").innerHTML = this.secs.map((s) => `<div class="dm-sec ${s.id === this.active ? "on" : ""} ${s.isNew ? "dm-new" : ""}" data-s="${s.id}" style="--c:var(--p-${s.color})">${ic(s.icon, 16)}<span>${s.label}</span><span class="dm-more">${ic("more", 15)}</span></div>`).join("");
      this.qa(".dm-bottom .dm-sec").forEach((e) => e.classList.toggle("on", e.dataset.s === this.active));
    }
    go(id) { this.active = id; this.renderSecs(); }
    sec(id) { return this.q(`[data-s="${id}"]`); }
    /** Barre du haut : titre, onglets en bouton segmenté, outils. */
    top({ title, sub = "", tabs = [], on = tabs[0], setup = false, agent = false }) {
      const seg = tabs.length > 1 ? `<span class="dm-seg">${tabs.map((t) => `<span class="${t === on ? "on" : ""}">${t}</span>`).join("")}</span>` : "";
      const tools = agent
        ? `<span class="dm-tool">${ic("plus", 16)}</span><span class="dm-tool">${ic("folder", 16)}</span><span class="dm-tool">${ic("more", 16)}</span>`
        : `${setup ? `<span class="dm-tool warn" data-t="setup">${ic("plug", 16)}</span>` : ""}<span class="dm-tool" data-t="fix">${ic("target", 16)}</span>`;
      this.q(".dm-top").innerHTML = `<span class="dm-title">${title}</span>${sub ? `<span class="dm-sub">${sub}</span>` : ""}<span class="dm-tools">${seg}${tools}<span class="dm-tool">${ic("bell", 16)}</span><span class="dm-tool" data-t="panel">${ic("panelRight", 16)}</span></span>`;
      this.syncPanelTool();
    }
    tool(name) { return this.q(`[data-t="${name}"]`); }
    main(s) { const m = this.q(".dm-main"); m.innerHTML = s; return m; }
    panel(s) { const p = this.q(".dm-panel"); if (s == null) p.classList.remove("open"); else { p.innerHTML = s; p.classList.add("open"); } this.syncPanelTool(); return p; }
    syncPanelTool() { this.tool("panel")?.classList.toggle("on", this.q(".dm-panel").classList.contains("open")); }
    layer(s) { const l = this.q(".dm-layer"); l.innerHTML = s || ""; l.classList.toggle("on", Boolean(s)); return l.firstElementChild; }
    toast(title, desc) { const t = html(`<div class="dm-toast"><strong>${title}</strong><span>${desc}</span></div>`); this.el.append(t); setTimeout(() => t.remove(), 3200 / this.P.speed); }
    pos(el, dx = 0, dy = 0, anchor = "center") {
      // L’échelle réelle se lit sur la scène : elle tient compte d’une page hôte elle-même mise à l’échelle.
      const r = el.getBoundingClientRect(), s = this.P.stage.getBoundingClientRect(), k = s.width / W || this.P.scale;
      const x = (r.left - s.left) / k + (anchor === "left" ? 16 : r.width / k / 2);
      const y = (r.top - s.top) / k + r.height / k / 2;
      return { x: x + dx, y: y + dy };
    }
    async moveXY(x, y, ms = 650) {
      this.cx = x; this.cy = y;
      this.cursor.style.transition = `transform ${ms / this.P.speed}ms cubic-bezier(.4,.1,.2,1)`;
      this.cursor.style.transform = `translate(${x}px,${y}px)`;
      await this.P.sleep(ms + 40);
    }
    async move(el, o = {}) { const p = this.pos(el, o.dx, o.dy, o.anchor); await this.moveXY(p.x, p.y, o.ms); }
    async click(el, o = {}) {
      await this.move(el, o);
      const r = html(`<div class="dm-ripple" style="left:${this.cx}px;top:${this.cy}px"></div>`);
      this.el.append(r); setTimeout(() => r.remove(), 600);
      el.classList.add("dm-press"); await this.P.sleep(170); el.classList.remove("dm-press"); await this.P.sleep(110);
    }
    focus(el) { this.qa(".dm-focus").forEach((x) => x.classList.remove("dm-focus")); if (el) el.classList.add("dm-focus"); }
    async type(box, text, cps = 26) {
      this.focus(box);
      const t = box.querySelector(".dm-txt");
      for (const ch of text) { t.textContent += ch; box.classList.add("dm-ready"); await this.P.sleep(1000 / cps + (ch === " " ? 30 : 0)); }
    }
    async key(near, label) {
      const p = this.pos(near);
      const k = html(`<div class="dm-kbd" style="left:${p.x + 10}px;top:${p.y + 22}px">${label}</div>`);
      this.el.append(k); await this.P.sleep(650); k.remove();
    }
    settings(active, content) {
      const nav = (name, icon) => `<div class="it ${name === active ? "on" : ""}" data-n="${name}">${ic(icon, 15)}${name}</div>`;
      return this.layer(`<div class="dm-settings"><header>Réglages${ic("x", 16)}</header><div class="dm-sgrid"><nav class="dm-snav">${input("Rechercher", "", "search")}<small>Espace de travail</small>${SNAV.map(([n, i]) => nav(n, i)).join("")}<hr>${nav("Journal", "book")}<small>Alfred</small>${nav("Agent", "bot")}${nav("Voix", "mic")}${nav("Mots de passe et clés", "key")}</nav><section class="dm-scontent">${content}</section></div></div>`);
    }
  }

  /* ---------- Agent ---------- */
  const transcript = (app, scope = "") => app.q(`${scope} .dm-transcript`);
  function userSays(box, text) { box.querySelector(".dm-hello")?.remove(); box.append(html(`<div class="dm-msg me">${text}</div>`)); }
  async function activity(app, box, tool, what, ms = 900) {
    const row = html(`<div class="dm-act"><span class="st"><span class="dm-spin"></span></span><code>${tool}</code><span>${what}</span></div>`);
    box.append(row);
    await app.P.sleep(ms);
    row.querySelector(".st").innerHTML = ic("check", 14);
    await app.P.sleep(160);
  }
  function settle(box, summary) {
    const acts = [...box.querySelectorAll(".dm-act")];
    acts.forEach((a) => a.remove());
    box.append(html(`<div class="dm-worked">${summary} ${ic("right", 13)}</div>`));
  }
  const aiSays = (box, text) => box.append(html(`<div class="dm-msg ai">${text}</div>`));

  /* ---------- Scénarios ---------- */
  const SECTIONS = () => [
    { id: "contacts", label: "Contacts", icon: "users", color: "green" },
    { id: "factures", label: "Factures", icon: "receipt", color: "blue" },
  ];
  const showFactures = (app, opts) => { app.go("factures"); app.top({ title: "Factures" }); app.main(facturesPage(opts)); };
  const showContacts = (app) => { app.go("contacts"); app.top({ title: "Contacts", tabs: ["Carnet", "Sociétés"] }); app.main(contactsPage(app.st)); };

  const SCENARIOS = [
    {
      id: "creer-page", title: "Créer une page", length: "≈ 50 s",
      setup(app) {
        app.sections([SECTIONS()[0]], "contacts");
        app.st = { tags: [], open: null }; showContacts(app);
        app.panel(empty("Aucun contact sélectionné", "Sélectionnez une ligne de la liste pour afficher son détail."));
      },
      chapters: [
        { say: "Vous ouvrez l’Agent, en bas du menu, et décrivez avec vos mots la page que vous voulez.", async run(app) {
          await app.click(app.sec("agent"), { anchor: "left" });
          app.go("agent"); app.top({ title: "Nouvelle conversation", sub: "Claude Code", agent: true });
          app.main(agentHome()); app.panel(tracking());
          await app.P.sleep(400);
          const comp = app.q(".dm-composer");
          await app.click(comp, { dx: -150 });
          await app.type(comp, "Fais-moi une page pour suivre mes factures : numéro, client, échéance, montant et état.", 34);
          await app.P.sleep(250);
          await app.click(app.q(".dm-send"));
        } },
        { say: "L’agent regarde l’espace, puis place la page : une entrée « Factures » apparaît dans le menu.", async run(app) {
          const box = transcript(app);
          app.top({ title: "Page des factures", sub: "Claude Code", agent: true }); app.panel(tracking("running"));
          userSays(box, "Fais-moi une page pour suivre mes factures : numéro, client, échéance, montant et état.");
          const comp = app.q(".dm-composer"); comp.querySelector(".dm-txt").textContent = ""; comp.classList.remove("dm-ready"); app.focus(null);
          comp.querySelector(".dm-txt").dataset.ph = "Ajouter un message à la file…";
          await app.P.sleep(400);
          await activity(app, box, "space_overview", "1 section, 1 module");
          await activity(app, box, "place_page", "« Factures », nouvelle entrée du menu");
          app.addSection(SECTIONS()[1]);
          await app.P.sleep(900);
        } },
        { say: "Il écrit la table, la page et son panneau comme des fichiers du module.", async run(app) {
          const box = transcript(app);
          await activity(app, box, "Écrit", "factures/migrations/0001_factures.sql", 700);
          await activity(app, box, "Écrit", "factures/pages/liste.tsx", 800);
          await activity(app, box, "Écrit", "factures/pages/detail.tsx", 700);
        } },
        { say: "Il vérifie tout, regarde la page en capture, puis vous dit ce qu’il a fait. La modification s’annule d’un clic.", async run(app) {
          const box = transcript(app);
          await activity(app, box, "check", "rien à signaler", 1000);
          await activity(app, box, "page_screenshot", "la page s’affiche comme prévu", 900);
          settle(box, "A travaillé pendant 1 min 12 s · 7 outils appelés");
          aiSays(box, "La page <b>Factures</b> est en place dans le menu de gauche : la liste avec la recherche et le filtre par état, et le détail d’une facture dans le panneau de droite.");
          await app.P.sleep(400);
          box.append(html(changes([["modules/factures/", 42, "module.json"], ["modules/factures/migrations/", 12, "0001_factures.sql"], ["modules/factures/pages/", 96, "liste.tsx"], ["modules/factures/pages/", 58, "detail.tsx"]])));
          app.q(".dm-composer .dm-txt").dataset.ph = "Répondre à l’agent…";
          app.panel(tracking("done"));
          await app.P.sleep(1500);
        } },
        { say: "La page est là, avec vos données ; une facture s’ouvre dans le panneau de droite.", async run(app) {
          await app.click(app.sec("factures"), { anchor: "left" });
          showFactures(app); app.panel(empty("Aucune facture sélectionnée", "Sélectionnez une ligne de la liste pour afficher son détail."));
          await app.P.sleep(800);
          await app.click(app.q('[data-row="0"]'), { dx: -140 });
          app.main(facturesPage({ sel: 0 })); app.panel(facturePanel(FACTURES[0]));
          await app.P.sleep(1800);
        } },
      ],
    },
    {
      id: "brancher-module", title: "Importer et configurer un module", length: "≈ 60 s",
      setup(app) {
        app.sections(SECTIONS(), "factures"); showFactures(app);
        app.panel(empty("Aucune facture sélectionnée", "Sélectionnez une ligne de la liste pour afficher son détail."));
      },
      chapters: [
        { say: "Dans Réglages, en bas du menu, la rubrique Marketplace montre les modules partagés par votre équipe.", async run(app) {
          await app.click(app.sec("settings"), { anchor: "left" });
          app.go("settings");
          app.settings("Modules", `<div class="dm-shead"><div><strong>Modules installés</strong><span>Ouvrez un module pour voir tout ce qu’il contient et connecter ses services.</span></div><span class="dm-btn">Parcourir le marketplace</span></div>
            <div class="dm-mrow"><span class="dm-tile" style="--c:var(--p-green)">${ic("users", 16)}</span><div><strong>Contacts</strong><span>Vos contacts et leurs sociétés.</span></div><span>Local</span></div>
            <div class="dm-mrow"><span class="dm-tile" style="--c:var(--p-blue)">${ic("receipt", 16)}</span><div><strong>Factures</strong><span>Factures émises et leur échéance.</span></div><span>Local</span></div>`);
          await app.P.sleep(900);
          await app.click(app.q('[data-n="Marketplace"]'));
          app.settings("Marketplace", `<div class="dm-shead"><div><strong>Modules disponibles</strong><span>Tous les modules des marketplaces branchés. Ouvrez-en un pour voir ce qu’il fait avant de l’importer.</span></div><span class="dm-btn ghost">Marketplaces branchés (1)</span></div>
            ${input("Rechercher un module…", "", "search")}
            <div class="dm-mrow"><span class="dm-tile" style="--c:var(--p-violet)">${ic("ticket", 16)}</span><div><strong>Tickets Jira</strong><span>Vos tickets Jira, par projet. Services nécessaires : Jira</span></div><span class="dm-btn" data-imp>Importer</span></div>
            <div class="dm-mrow"><span class="dm-tile" style="--c:var(--p-pink)">${ic("bell", 16)}</span><div><strong>Boîte</strong><span>Vos mails importants. Services nécessaires : Gmail</span></div><span class="dm-btn">Importer</span></div>
            <div class="dm-mrow"><span class="dm-tile" style="--c:var(--p-orange)">${ic("users", 16)}</span><div><strong>Agenda d’équipe</strong><span>Les absences et les rendez-vous de l’équipe.</span></div><span class="dm-btn">Importer</span></div>`);
          await app.P.sleep(1000);
        } },
        { say: "Vous importez « Tickets Jira » : sa page arrive dans le menu.", async run(app) {
          await app.click(app.q("[data-imp]"));
          app.q(".dm-scontent").append(html(`<div class="dm-dialog"><div><strong>Importer Tickets Jira ?</strong><span class="dm-muted">Le module ajoute la page « Tickets » et a besoin d’un compte Jira.</span><div class="acts"><span class="dm-btn">Annuler</span><span class="dm-btn primary" data-ok>Importer</span></div></div></div>`));
          await app.P.sleep(600);
          await app.click(app.q("[data-ok]"));
          app.layer(null); app.go("factures");
          app.addSection({ id: "tickets", label: "Tickets", icon: "ticket", color: "violet" });
          await app.P.sleep(700);
        } },
        { say: "La configuration s’ouvre d’elle-même : le module se présente et dit ce dont il a besoin.", async run(app) {
          app.layer(setup(0, `<div class="t">Bienvenue dans Tickets Jira</div><p>Vos tickets Jira, par projet, avec leur état.</p><p>Vous allez d’abord nommer sa page dans le menu de gauche, puis connecter vos comptes.</p><p>Pour fonctionner, il a besoin de ces services :</p><p>• <b>Jira</b> <span class="dm-muted">— à configurer</span></p><p class="dm-muted">Comptez quelques minutes. Gardez sous la main vos identifiants de ces services.</p>`, `<span></span><span class="dm-btn primary" data-next>Commencer</span>`));
          await app.P.sleep(1600);
          await app.click(app.q("[data-next]"));
        } },
        { say: "Vous donnez à sa page le nom qui vous parle.", async run(app) {
          app.layer(setup(1, `<div class="t">Vos pages</div><p>Tickets Jira ajoute une entrée au menu de gauche. Donnez-lui le nom qui vous parle : vous pourrez le changer plus tard.</p><div class="dm-card"><span class="dm-tile" style="--c:var(--p-violet)">${ic("ticket", 16)}</span><div class="dm-field" style="flex:1"><label>Nom dans le menu</label>${input("", "dm-name").replace('class="dm-input dm-name"', 'class="dm-input dm-name" style="width:320px"')}<span class="dm-muted" style="font-size:12px">Page « Tickets » · utilise Jira</span></div></div>`, `<span class="dm-btn ghost">Précédent</span><span class="dm-btn primary" data-next>Suivant</span>`));
          const name = app.q(".dm-name"); name.querySelector(".dm-txt").textContent = "Tickets";
          await app.click(name, { dx: 60 });
          name.querySelector(".dm-txt").textContent = "";
          await app.type(name, "Mes tickets", 16);
          await app.P.sleep(300);
          await app.click(app.q("[data-next]"));
          app.secs.find((x) => x.id === "tickets").label = "Mes tickets"; app.renderSecs();
        } },
        { say: "Pour Jira, vous n’ajoutez que votre compte : la façon de s’y connecter, le module la connaît déjà.", async run(app) {
          app.layer(setup(2, `<div class="t">Jira ${badge("À configurer")}</div><p>Tickets Jira se connecte à Jira en votre nom.</p><p class="dm-muted">Créez un jeton d’API dans votre profil Atlassian.</p><div class="dm-acc"><div><b>Votre compte</b><br><span class="dm-muted">Aucun compte pour l’instant.</span></div><span class="dm-btn primary" data-add>Ajouter votre compte</span></div><div class="dm-form" style="display:flex;flex-direction:column;gap:10px"></div>`, `<span class="dm-btn ghost">Précédent</span><span class="dm-btn primary" data-next style="opacity:.45">Suivant</span>`));
          await app.P.sleep(1000);
          await app.click(app.q("[data-add]"));
          app.q(".dm-form").innerHTML = `<div class="dm-field"><label>Adresse de votre compte</label>${input("https://…", "f-url")}</div><div class="dm-field"><label>Jeton d’accès</label>${input("", "f-tok")}</div><span class="dm-btn primary" data-save style="align-self:flex-end">Enregistrer</span>`;
          await app.click(app.q(".f-url")); await app.type(app.q(".f-url"), "https://atelier.atlassian.net", 30);
          await app.click(app.q(".f-tok")); await app.type(app.q(".f-tok"), "••••••••••••••••••••", 30);
          await app.click(app.q("[data-save]"));
        } },
        { say: "Alfred range le jeton dans le trousseau du système, puis teste la connexion.", async run(app) {
          app.q(".dm-form").innerHTML = "";
          const acc = app.q(".dm-acc");
          acc.innerHTML = `<div><b>Votre compte</b><br><span class="dm-muted">Prêt à être testé.</span></div><span class="dm-btn" data-test>Tester</span>`;
          await app.P.sleep(700);
          await app.click(app.q("[data-test]"));
          acc.innerHTML = `<div><b>Votre compte</b><br><span class="dm-muted">Test de la connexion…</span></div><span class="dm-spin"></span>`;
          await app.P.sleep(1400);
          acc.innerHTML = `<div><b>Votre compte</b><br><span class="ok">Connexion réussie. Le service répond (200).</span></div><span class="dm-btn ghost">Tester à nouveau</span>`;
          app.q(".dm-sbody .t").innerHTML = `Jira ${badge("Prêt")}`;
          app.q("[data-next]").style.opacity = 1;
          await app.P.sleep(1000);
          await app.click(app.q("[data-next]"));
        } },
        { say: "Tickets Jira est prêt : sa page se charge d’elle-même avec vos tickets.", async run(app) {
          app.layer(setup(3, `<div class="t">Tickets Jira est prêt</div><p>Tout ce dont il a besoin est renseigné et testé.</p>`, `<span></span><span style="display:flex;gap:8px"><span class="dm-btn" data-open>Ouvrir le module</span><span class="dm-btn primary">Terminer</span></span>`));
          await app.P.sleep(1100);
          await app.click(app.q("[data-open]"));
          app.layer(null);
          app.go("tickets"); app.top({ title: "Mes tickets" }); app.panel(empty("Aucun ticket sélectionné", "Sélectionnez une ligne de la liste pour afficher son détail."));
          app.main(ticketsPage("loading"));
          await app.P.sleep(1100);
          app.main(ticketsPage("ready"));
          await app.P.sleep(1800);
        } },
      ],
    },
    {
      id: "rechercher", title: "Rechercher et retrouver", length: "≈ 35 s",
      setup(app) {
        app.sections(SECTIONS(), "contacts");
        app.st = { tags: [], open: null }; showContacts(app);
        app.panel(empty("Aucun contact sélectionné", "Sélectionnez une ligne de la liste pour afficher son détail."));
      },
      chapters: [
        { say: "La recherche propose des critères pendant la frappe ; Entrée prend la première suggestion.", async run(app) {
          const field = app.q(".dm-search");
          await app.click(field, { dx: -150 });
          await app.type(field, "lyo", 8);
          app.q(".dm-bar").append(html(`<div class="dm-sugg"><div class="on">Ville : Lyon</div><div>Société : Lyonnaise de conseil</div></div>`));
          await app.P.sleep(900);
          await app.key(field, "Entrée");
          app.st.tags.push("Ville : Lyon"); app.main(contactsPage(app.st)); app.focus(app.q(".dm-search"));
          await app.P.sleep(900);
        } },
        { say: "Un deuxième critère affine la liste ; vous ouvrez une fiche dans le panneau de droite.", async run(app) {
          const field = app.q(".dm-search");
          await app.type(field, "act", 8);
          app.q(".dm-bar").append(html(`<div class="dm-sugg" style="left:150px"><div class="on">État : actif</div></div>`));
          await app.P.sleep(800);
          await app.key(field, "Entrée");
          app.st.tags.push("État : actif"); app.main(contactsPage(app.st));
          await app.P.sleep(800);
          await app.click(app.q('[data-row="1"]'), { dx: -150 });
          app.st.open = "Nathan Roux"; app.main(contactsPage(app.st)); app.panel(contactPanel("Nathan Roux"));
          await app.P.sleep(1000);
        } },
        { say: "Vous partez sur une autre page : celle-ci est fermée…", async run(app) {
          await app.click(app.sec("factures"), { anchor: "left" });
          showFactures(app); app.panel(empty("Aucune facture sélectionnée", "Sélectionnez une ligne de la liste pour afficher son détail."));
          await app.P.sleep(1500);
        } },
        { say: "…et quand vous revenez, la recherche, les critères et la fiche ouverte sont restés.", async run(app) {
          await app.click(app.sec("contacts"), { anchor: "left" });
          showContacts(app); app.panel(contactPanel("Nathan Roux"));
          app.q(".dm-search").classList.add("dm-flash");
          await app.P.sleep(2200);
        } },
      ],
    },
    {
      id: "corriger", title: "Corriger un élément", length: "≈ 45 s",
      setup(app) {
        app.sections(SECTIONS(), "factures"); showFactures(app, { fmt: false });
        app.panel(empty("Aucune facture sélectionnée", "Sélectionnez une ligne de la liste pour afficher son détail."));
      },
      chapters: [
        { say: "Un détail vous gêne : les montants sont bruts et mal alignés. Vous prenez la cible, dans la barre du haut.", async run(app) {
          await app.move(app.qa(".col-m")[3], { ms: 800 });
          await app.P.sleep(500);
          await app.click(app.tool("fix"));
        } },
        { say: "Alfred capture la fenêtre ; vous encadrez l’élément à corriger.", async run(app) {
          const fix = html(`<div class="dm-fix"><div class="dm-fixbar"><span>Encadrez l’élément à corriger</span><span class="dm-btn">Toute la fenêtre</span><span class="dm-btn">Annuler</span></div></div>`);
          app.el.append(fix);
          await app.P.sleep(800);
          const cols = app.qa(".col-m");
          const a = app.pos(cols[0]), b = app.pos(cols[cols.length - 1]);
          const w0 = cols[0].getBoundingClientRect().width / app.P.scale;
          const x0 = a.x - w0 / 2 - 8, y0 = a.y - 18, x1 = a.x + w0 / 2 + 8, y1 = b.y + 22;
          await app.moveXY(x0, y0, 600);
          const rect = html(`<div class="dm-rect" style="left:${x0}px;top:${y0}px;width:0;height:0"></div>`);
          fix.append(rect);
          await app.P.sleep(60);
          rect.style.transitionDuration = `${900 / app.P.speed}ms`;
          rect.style.width = `${x1 - x0}px`; rect.style.height = `${y1 - y0}px`;
          await app.moveXY(x1, y1, 900);
          await app.P.sleep(500);
          fix.remove();
        } },
        { say: "Une conversation s’ouvre dans le panneau de droite, la capture annotée déjà jointe. Vous dites ce que vous voulez.", async run(app) {
          app.panel(`<div class="dm-pnh">Corriger · Factures${ic("x", 15)}</div><div class="dm-agent" style="height:auto;flex:1;min-height:0"><div class="dm-transcript" style="width:auto;max-width:none;padding:12px 16px 8px;align-self:stretch"></div>
            <div style="align-self:stretch;padding:0 12px 12px;display:flex;flex-direction:column;gap:8px"><div class="dm-attach"><span class="dm-chip"><span class="dm-thumb"></span>capture-factures.png</span><span class="dm-chip">Élément à corriger · Factures</span></div>
            <div class="dm-composer" style="width:auto;max-width:none">${ic("plus", 16)}<div class="dm-in"><span class="dm-txt" data-ph="Que puis-je mettre en place pour vous ?"></span><span class="dm-caret"></span></div><span class="dm-send">${ic("up", 14)}</span></div></div></div>`);
          await app.P.sleep(900);
          const comp = app.q(".dm-panel .dm-composer");
          await app.click(comp, { dx: -60 });
          await app.type(comp, "Aligne les montants à droite, en euros.", 28);
          await app.click(app.q(".dm-panel .dm-send"));
        } },
        { say: "L’agent corrige la page, la vérifie, et elle se met à jour sous vos yeux.", async run(app) {
          const box = app.q(".dm-panel .dm-transcript");
          const comp = app.q(".dm-panel .dm-composer");
          comp.querySelector(".dm-txt").textContent = ""; comp.querySelector(".dm-txt").dataset.ph = "Répondre à l’agent…"; comp.classList.remove("dm-ready"); app.focus(null);
          app.q(".dm-panel .dm-attach").remove();
          userSays(box, "Aligne les montants à droite, en euros.");
          await app.P.sleep(400);
          await activity(app, box, "Écrit", "factures/pages/liste.tsx", 900);
          await activity(app, box, "check", "rien à signaler", 900);
          app.main(facturesPage({ fmt: true }));
          app.qa(".col-m").forEach((c) => c.classList.add("dm-flash"));
          await activity(app, box, "page_screenshot", "montants alignés", 700);
          settle(box, "A travaillé pendant 38 s · 3 outils appelés");
          aiSays(box, "C’est fait : les montants sont en euros, alignés à droite.");
          await app.P.sleep(2200);
        } },
      ],
    },
  ];

  function setup(step, body, foot) {
    const steps = [["Présentation", ""], ["Vos pages", "Les nommer"], ["Jira", step > 2 ? "Prêt" : "À configurer"], ["Terminé", ""]];
    const cards = steps.map(([n, sub], i) => `<div class="dm-step ${i === step ? "on" : ""} ${i < step ? "ok" : ""}"><i>${i < step ? ic("check", 13) : i + 1}</i><div><b>${n}</b>${sub ? `<span>${sub}</span>` : ""}</div></div>`).join("");
    const lead = step === 0 ? "2 étapes. Vous pouvez vous arrêter et reprendre plus tard." : step === 3 ? "Terminé" : `Étape ${step} sur 2`;
    return `<div class="dm-setup"><span class="back">${ic("left", 15)}Terminer plus tard</span><h6>Configurer Tickets Jira</h6><span class="lead2">${lead}</span><div class="dm-steps">${cards}</div><div class="dm-sbody">${body}</div><div class="dm-sfoot">${foot}</div></div>`;
  }


  /* ---------- Le lecteur ---------- */
  const SKELETON = `<div class="dm-choices" role="tablist" aria-label="Choisir une démo"></div>
    <div class="dm-viewport"><div class="dm-stage" aria-hidden="true"></div><button type="button" class="dm-start"></button></div>
    <div class="dm-controls">
      <button type="button" class="dm-play">Lecture</button>
      <button type="button" class="dm-restart">Rejouer</button>
      <div class="dm-segs" aria-hidden="true"></div>
      <button type="button" class="dm-speed" title="Vitesse">1×</button>
    </div>
    <div class="dm-caption" aria-live="polite"></div>`;

  class Player {
    constructor(el, list) {
      this.root = el; this.list = list; this.multi = list.length > 1;
      if (!el.querySelector(".dm-viewport")) el.innerHTML = SKELETON;
      this.viewport = el.querySelector(".dm-viewport");
      this.stage = el.querySelector(".dm-stage");
      this.caption = el.querySelector(".dm-caption");
      this.segs = el.querySelector(".dm-segs");
      this.start = el.querySelector(".dm-start");
      this.btnPlay = el.querySelector(".dm-play");
      this.btnSpeed = el.querySelector(".dm-speed");
      this.token = 0; this.paused = false; this.speed = 1; this.running = false;
      const choices = el.querySelector(".dm-choices");
      if (this.multi) {
        choices.innerHTML = list.map((s, i) => `<button type="button" role="tab" data-i="${i}">${i + 1}. ${s.title}</button>`).join("");
        choices.addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) this.select(Number(b.dataset.i)); });
      } else choices.remove();
      this.start.addEventListener("click", () => (this.ended && this.multi ? this.next() : this.play()));
      el.querySelector(".dm-restart").addEventListener("click", () => this.play());
      this.btnPlay.addEventListener("click", () => {
        if (!this.running) return this.play();
        this.paused = !this.paused; this.btnPlay.textContent = this.paused ? "Lecture" : "Pause";
      });
      this.btnSpeed.addEventListener("click", () => {
        this.speed = this.speed === 1 ? 2 : 1; this.btnSpeed.textContent = `${this.speed}×`;
        this.stage.style.setProperty("--sp", this.speed);
      });
      new ResizeObserver(() => this.fit()).observe(this.viewport);
      this.fit();
      this.select(0);
    }
    fit() { this.scale = this.viewport.clientWidth / W; this.stage.style.transform = `scale(${this.scale})`; }
    async sleep(ms) {
      const tk = this.token;
      let left = ms;
      while (left > 0) {
        if (tk !== this.token) throw CANCEL;
        await pause(30);
        if (!this.paused) left -= 30 * this.speed;
      }
      if (tk !== this.token) throw CANCEL;
    }
    label(i) { return this.multi ? `${i + 1}. ${this.list[i].title}` : this.list[i].title; }
    select(i) {
      this.token++; this.running = false; this.ended = false; this.paused = false;
      this.index = i; this.sc = this.list[i];
      this.root.querySelectorAll(".dm-choices button").forEach((b, j) => b.setAttribute("aria-selected", String(j === i)));
      this.app = new App(this); this.sc.setup(this.app);
      this.segs.innerHTML = this.sc.chapters.map((c) => `<span title="${c.say.replace(/"/g, "&quot;")}"></span>`).join("");
      this.caption.innerHTML = `<b>${this.label(i)}</b>${this.sc.chapters.length} étapes, ${this.sc.length}. Lancez la démo.`;
      this.start.innerHTML = `<span class="dm-round">${ic("play", 26)}</span>${this.sc.title}<small>${this.sc.length} · reconstitution animée</small>`;
      this.start.hidden = false; this.btnPlay.textContent = "Lecture";
      this.root.dataset.state = "ready";
    }
    async play() {
      this.select(this.index);
      const tk = this.token;
      this.start.hidden = true; this.running = true; this.btnPlay.textContent = "Pause";
      this.root.dataset.state = "playing";
      const spans = [...this.segs.children];
      try {
        await this.sleep(400);
        for (const [i, ch] of this.sc.chapters.entries()) {
          spans.forEach((s, j) => { s.className = j < i ? "done" : j === i ? "now" : ""; });
          this.caption.innerHTML = `<b>${i + 1}/${spans.length}</b>${ch.say}`;
          await ch.run(this.app);
        }
        spans.forEach((s) => { s.className = "done"; });
        await this.sleep(600);
        if (tk !== this.token) return;
        this.running = false; this.ended = true; this.btnPlay.textContent = "Lecture";
        this.root.dataset.state = "ended";
        if (this.multi) {
          const nxt = this.list[(this.index + 1) % this.list.length];
          this.start.innerHTML = `<span class="dm-round">${ic("play", 26)}</span>Démo suivante : ${nxt.title}<small>ou « Rejouer » sous la vidéo</small>`;
        } else {
          this.start.innerHTML = `<span class="dm-round">${ic("refresh", 24)}</span>Revoir la démo<small>${this.sc.title}</small>`;
        }
        this.start.hidden = false;
      } catch (e) {
        if (e !== CANCEL) console.error(e);
      }
    }
    next() { this.select((this.index + 1) % this.list.length); this.play(); }
    /** Arrête la démo et la remet au début, bouton de lecture affiché. */
    stop() { this.select(this.index); }
  }

  /** Vidéo enregistrée : lecture au clic, sans son, avec l’affiche si elle est déclarée. */
  function mountVideo(el, sc) {
    const src = el.dataset.video;
    const type = /\.webm$/i.test(src) ? "video/webm" : "video/mp4";
    const poster = el.dataset.poster ? ` poster="${el.dataset.poster}"` : "";
    el.classList.add("dm-has-video");
    el.innerHTML = `<div class="dm-viewport dm-video"><video muted playsinline preload="metadata"${poster}><source src="${src}" type="${type}"></video><button type="button" class="dm-start"><span class="dm-round">${ic("play", 26)}</span>${sc ? sc.title : "Lire la vidéo"}<small>Vidéo, sans le son</small></button></div>`;
    const video = el.querySelector("video");
    const start = el.querySelector(".dm-start");
    start.addEventListener("click", () => { start.hidden = true; video.controls = true; video.play(); });
    video.addEventListener("ended", () => { el.dataset.state = "ended"; });
    el.dataset.state = "ready";
    el.player = {
      play() { start.hidden = true; video.controls = true; el.dataset.state = "playing"; video.currentTime = 0; return video.play().catch(() => { start.hidden = false; }); },
      stop() { video.pause(); video.currentTime = 0; video.controls = false; start.hidden = false; el.dataset.state = "ready"; },
    };
  }

  const byId = Object.fromEntries(SCENARIOS.map((s) => [s.id, s]));
  for (const el of document.querySelectorAll(".dm[data-demo]")) {
    const id = el.dataset.demo;
    if (el.dataset.video) { mountVideo(el, byId[id]); continue; }
    const list = id === "all" ? SCENARIOS : byId[id] ? [byId[id]] : null;
    if (!list) { console.error(`Démo inconnue : ${id}`); continue; }
    el.player = new Player(el, list);
  }
})();

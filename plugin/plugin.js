// Atelier Sync — prototype. Runs inside Penpot's plugin sandbox.
//
// Flow:
//   ORIGINAL file   "Take offline"   → save version, tag every shape (id + fingerprint), download .penpot
//   OFFLINE copy    "Export changes" → download a JSON dump of every shape (ids survive import)
//   ORIGINAL file   "Bring back"     → compare dump with tags + current state, show conflicts, apply as one undo step
//
// Tags live in SHARED plugin data (namespace "atelier") so they don't depend on the plugin's URL.
// Scope (prototype): board, rectangle, ellipse, text, path. Components, groups, booleans,
// images, interactions and tokens are reported as "not synced", never touched.

const NS = "atelier";
const SUPPORTED = new Set(["board", "rectangle", "ellipse", "text", "path"]);
const ROOT = "00000000-0000-0000-0000-000000000000";

penpot.ui.open("Atelier Sync", "ui.html", { width: 380, height: 600 });

// ---------- Reading ----------

const r2 = (n) => (typeof n === "number" ? Math.round(n * 100) / 100 : n);
const plain = (v) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));

/** The properties we sync. Same function on both sides, so fingerprints compare. */
function props(s) {
  const p = {
    type: s.type, name: s.name,
    x: r2(s.x), y: r2(s.y), width: r2(s.width), height: r2(s.height),
    rotation: r2(s.rotation), opacity: r2(s.opacity), hidden: !!s.hidden,
    fills: plain(s.fills), strokes: plain(s.strokes), shadows: plain(s.shadows),
    parentId: s.parent ? s.parent.id : null, parentIndex: s.parentIndex,
  };
  if (s.type === "rectangle" || s.type === "board") p.borderRadius = r2(s.borderRadius);
  if (s.type === "board") {
    p.clipContent = s.clipContent;
    const f = s.flex;
    p.flex = f ? {
      dir: f.dir, wrap: f.wrap ?? null, alignItems: f.alignItems ?? null, justifyContent: f.justifyContent ?? null,
      rowGap: f.rowGap, columnGap: f.columnGap,
      topPadding: f.topPadding, rightPadding: f.rightPadding, bottomPadding: f.bottomPadding, leftPadding: f.leftPadding,
    } : null;
  }
  if (s.type === "text") {
    Object.assign(p, {
      characters: s.characters, growType: s.growType,
      fontFamily: s.fontFamily, fontSize: s.fontSize, fontWeight: s.fontWeight, fontStyle: s.fontStyle ?? null,
      lineHeight: s.lineHeight, letterSpacing: s.letterSpacing, align: s.align ?? null, verticalAlign: s.verticalAlign ?? null,
      textTransform: s.textTransform ?? null, textDecoration: s.textDecoration ?? null,
    });
  }
  if (s.type === "path") p.d = s.d;
  return p;
}

function hash(obj) {
  const str = JSON.stringify(obj);
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
}

/** Fingerprint excludes parentIndex: z-order shifts whenever a sibling is added/removed. */
function fingerprint(s) {
  const { parentIndex, ...rest } = props(s);
  return hash(rest);
}

const shapesOf = (page) => page.findShapes().filter((s) => s.id !== ROOT);
const tag = (s, k) => s.getSharedPluginData(NS, k) || null;
const rootOf = (page) => page.getShapeById(ROOT);

function marker() {
  const first = penpot.currentFile.pages[0];
  const root = first && rootOf(first);
  if (!root) return null;
  const raw = root.getSharedPluginData(NS, "offline");
  return raw ? JSON.parse(raw) : null;
}

// ---------- Commands ----------

const handlers = {
  async status() {
    const m = marker();
    const role = !m ? "none" : m.fileId === penpot.currentFile.id ? "original" : "copy";
    return { role, marker: m, file: penpot.currentFile.name };
  },

  async takeOffline() {
    const file = penpot.currentFile;
    const takenAt = new Date().toISOString();
    await file.saveVersion(`Atelier: taken offline ${takenAt.slice(0, 16).replace("T", " ")}`);
    let n = 0;
    for (const page of file.pages) {
      await penpot.openPage(page);
      for (const s of shapesOf(page)) {
        s.setSharedPluginData(NS, "id", s.id);
        s.setSharedPluginData(NS, "hash", fingerprint(s));
        n++;
      }
    }
    const m = { fileId: file.id, fileName: file.name, takenAt };
    await penpot.openPage(file.pages[0]);
    rootOf(file.pages[0]).setSharedPluginData(NS, "offline", JSON.stringify(m));
    // Give Penpot a moment to persist the tags before exporting.
    await new Promise((r) => setTimeout(r, 1500));
    // Penpot 2.18.3 bug: File.export() rejects with "No matching clause" (unhandled worker message type
    // in frontend/src/app/plugins/file.cljs). Fall back to the user's File › Download.
    let download = null;
    try {
      const bytes = await file.export("penpot");
      download = { name: `${file.name} (offline).penpot`, bytes: Array.from(bytes) };
    } catch (e) {
      console.log("[atelier-sync] export from plugin failed, manual download needed:", String(e));
    }
    return { tagged: n, marker: m, download };
  },

  async exportChanges() {
    const file = penpot.currentFile;
    const m = marker();
    if (!m) throw new Error("This file was not taken offline with Atelier.");
    if (m.fileId === file.id) throw new Error("This is the original file. Open the offline copy to export changes.");
    const pages = [];
    for (const page of file.pages) {
      await penpot.openPage(page);
      pages.push({
        id: page.id, name: page.name,
        shapes: shapesOf(page).map((s) => ({
          id: s.id, tagId: tag(s, "id"), tagHash: tag(s, "hash"),
          hash: fingerprint(s), props: props(s), supported: SUPPORTED.has(s.type),
        })),
      });
    }
    const dump = { kind: "atelier-offline-changes", version: 1, marker: m, exportedAt: new Date().toISOString(), pages };
    const stamp = dump.exportedAt.slice(0, 16).replace(/[T:]/g, "-");
    return { download: { name: `${m.fileName} changes ${stamp}.json`, text: JSON.stringify(dump) } };
  },

  async plan(msg) {
    return makePlan(msg.dump);
  },

  async apply(msg) {
    return applyPlan(msg.dump, msg.choices || {});
  },

  async cancelOffline() {
    const file = penpot.currentFile;
    for (const page of file.pages) {
      await penpot.openPage(page);
      for (const s of shapesOf(page)) {
        s.setSharedPluginData(NS, "id", "");
        s.setSharedPluginData(NS, "hash", "");
      }
    }
    await penpot.openPage(file.pages[0]);
    rootOf(file.pages[0]).setSharedPluginData(NS, "offline", "");
    return "Offline mode cleared for this file.";
  },
};

// ---------- Dev helpers (scripted test edits; shown under "Developer" in the UI) ----------

const byName = (name) => penpot.currentPage.findShapes({ name })[0];
Object.assign(handlers, {
  async devDemo() {
    const board = penpot.createBoard();
    board.name = "Sync test board"; board.resize(400, 300); board.x = 100; board.y = 100;
    board.fills = [{ fillColor: "#FFFFFF", fillOpacity: 1 }];
    const r = penpot.createRectangle();
    board.appendChild(r);
    r.name = "Red box"; r.resize(120, 80); r.x = 140; r.y = 140; r.fills = [{ fillColor: "#C8102E", fillOpacity: 1 }];
    const t = penpot.createText("Hello offline");
    board.appendChild(t);
    t.name = "Greeting"; t.x = 140; t.y = 260;
    const e = penpot.createEllipse();
    e.name = "Circle"; e.resize(60, 60); e.x = 600; e.y = 120;
    const k = penpot.createRectangle();
    k.name = "Keep me"; k.resize(50, 50); k.x = 600; k.y = 260;
    return "demo shapes created";
  },
  async devEditOffline() {
    const box = byName("Red box"); box.x = box.x + 50;
    byName("Greeting").characters = "Edited on the plane";
    byName("Circle").remove();
    const n = penpot.createRectangle();
    byName("Sync test board").appendChild(n);
    n.name = "New offline box"; n.resize(60, 40); n.x = 320; n.y = 140; n.fills = [{ fillColor: "#1F7A3D", fillOpacity: 1 }];
    byName("Keep me").fills = [{ fillColor: "#000000", fillOpacity: 1 }];
    return "offline edits: moved Red box, edited Greeting, removed Circle, added New offline box, recoloured Keep me";
  },
  async devEditCloud() {
    byName("Keep me").fills = [{ fillColor: "#FFB000", fillOpacity: 1 }];
    const c = penpot.createEllipse(); c.name = "Cloud-only dot"; c.resize(20, 20); c.x = 700; c.y = 300;
    return "cloud edits: recoloured Keep me (conflict), added Cloud-only dot";
  },
  async devEditOffline2() {
    byName("Keep me").fills = [{ fillColor: "#7F77DD", fillOpacity: 1 }];
    byName("Red box").resize(200, 60);
    const a = penpot.createEllipse(); a.name = "Group member A"; a.x = 800; a.y = 100;
    const b = penpot.createEllipse(); b.name = "Group member B"; b.x = 900; b.y = 100;
    penpot.group([a, b]).name = "Offline group";
    return "offline2: Keep me purple, Red box resized, created a group (unsupported)";
  },
  async devEditCloud2() {
    byName("Red box").remove();
    byName("Keep me").fills = [{ fillColor: "#E24B4A", fillOpacity: 1 }];
    return "cloud2: removed Red box, Keep me red";
  },
  async devReport() {
    return shapesOf(penpot.currentPage).map((s) => `${s.name} [${s.type}] x=${r2(s.x)} parent=${s.parent && s.parent.name}${s.type === "text" ? ` "${s.characters}"` : ""} fill=${s.fills && s.fills[0] && s.fills[0].fillColor}`);
  },
});

// ---------- Plan ----------

/**
 * Classifies every shape. Pure reading — nothing is changed here.
 * offline side: dump shape (tagId/tagHash = state at take-off, hash = state now)
 * cloud side:   current shape in this file (tag = state at take-off)
 */
function makePlan(dump) {
  const m = marker();
  if (!dump || dump.kind !== "atelier-offline-changes") throw new Error("That is not an Atelier changes file.");
  if (!m || m.fileId !== penpot.currentFile.id) throw new Error("This file is not the original that was taken offline.");
  if (dump.marker.fileId !== m.fileId || dump.marker.takenAt !== m.takenAt)
    throw new Error("These changes belong to a different take-offline session of this file.");

  const steps = []; // {kind, pageId, id, name, conflict, reason}
  const skipped = [];
  for (const dp of dump.pages) {
    const page = penpot.currentFile.pages.find((p) => p.id === dp.id);
    if (!page) { skipped.push(`Page "${dp.name}" (new pages are not synced yet)`); continue; }
    const offlineIds = new Set(dp.shapes.map((s) => s.id));
    const dumpById = new Map(dp.shapes.map((s) => [s.id, s]));
    // Inside an unsupported container (group, component…)? Then it travels with that container: skip.
    const insideUnsupported = (ds) => {
      for (let p = dumpById.get(ds.props.parentId); p; p = dumpById.get(p.props.parentId)) if (!p.supported) return p;
      return null;
    };

    for (const ds of dp.shapes) {
      const cloud = page.getShapeById(ds.id);
      const changedOffline = !ds.tagId || ds.hash !== ds.tagHash;
      if (!changedOffline) continue;
      if (!ds.supported) { skipped.push(`${ds.props.name} (${ds.props.type})`); continue; }
      const container = insideUnsupported(ds);
      if (container) { skipped.push(`${ds.props.name} (inside ${container.props.name})`); continue; }
      if (!ds.tagId) {
        steps.push({ kind: "create", pageId: dp.id, id: ds.id, name: ds.props.name });
      } else if (!cloud) {
        steps.push({ kind: "update", pageId: dp.id, id: ds.id, name: ds.props.name, conflict: true, reason: "deleted in the cloud, changed offline" });
      } else {
        const changedCloud = fingerprint(cloud) !== tag(cloud, "hash");
        steps.push({ kind: "update", pageId: dp.id, id: ds.id, name: ds.props.name, conflict: changedCloud, reason: changedCloud ? "changed in both places" : "" });
      }
    }
    // Tagged in the cloud but gone from the offline copy → deleted offline.
    for (const s of shapesOf(page)) {
      if (!tag(s, "id") || offlineIds.has(s.id)) continue;
      const changedCloud = fingerprint(s) !== tag(s, "hash");
      steps.push({ kind: "delete", pageId: dp.id, id: s.id, name: s.name, conflict: changedCloud, reason: changedCloud ? "deleted offline, changed in the cloud" : "" });
    }
  }
  return { steps, skipped, marker: m };
}

// ---------- Apply ----------

function setProps(s, p) {
  s.name = p.name;
  if (s.type === "text") {
    if (s.characters !== p.characters) s.characters = p.characters;
    for (const k of ["growType", "fontFamily", "fontSize", "fontWeight", "fontStyle", "lineHeight", "letterSpacing", "align", "verticalAlign", "textTransform", "textDecoration"])
      if (p[k] !== null && p[k] !== undefined && p[k] !== "mixed") s[k] = p[k];
  }
  if (s.type === "path" && p.d) s.d = p.d;
  if (p.width !== s.width || p.height !== s.height) s.resize(p.width, p.height);
  s.x = p.x; s.y = p.y;
  if (p.rotation != null && p.rotation !== s.rotation) s.rotation = p.rotation;
  if (p.opacity != null) s.opacity = p.opacity;
  s.hidden = p.hidden;
  if (Array.isArray(p.fills)) s.fills = p.fills;
  if (Array.isArray(p.strokes)) s.strokes = p.strokes;
  if (Array.isArray(p.shadows)) s.shadows = p.shadows;
  if (p.borderRadius !== undefined && p.borderRadius !== null) s.borderRadius = p.borderRadius;
  if (s.type === "board") {
    s.clipContent = p.clipContent;
    if (p.flex) {
      const f = s.flex || s.addFlexLayout();
      for (const [k, v] of Object.entries(p.flex)) if (v !== null) f[k] = v;
    } else if (s.flex) {
      s.flex.remove();
    }
  }
}

function create(p) {
  switch (p.type) {
    case "board": return penpot.createBoard();
    case "rectangle": return penpot.createRectangle();
    case "ellipse": return penpot.createEllipse();
    case "text": return penpot.createText(p.characters || " ");
    case "path": return penpot.createPath();
  }
  throw new Error(`Cannot create ${p.type}`);
}

async function applyPlan(dump, choices) {
  const { steps } = makePlan(dump);
  const byId = new Map(dump.pages.flatMap((p) => p.shapes.map((s) => [s.id, s])));
  const idMap = new Map(); // offline id → new cloud id (shapes created offline)
  const done = { created: 0, updated: 0, deleted: 0, keptCloud: 0 };
  const take = (st) => !st.conflict || choices[st.id] === "offline";

  const block = penpot.history.undoBlockBegin();
  try {
    for (const page of penpot.currentFile.pages) {
      const pageSteps = steps.filter((s) => s.pageId === page.id);
      if (!pageSteps.length) continue;
      await penpot.openPage(page);
      const resolve = (id) => (id ? page.getShapeById(idMap.get(id) || id) : null);

      // 1. Create new shapes, parents before children (sort by depth in the offline tree).
      const depth = (id) => { let d = 0; for (let s = byId.get(id); s && s.props.parentId && byId.has(s.props.parentId); s = byId.get(s.props.parentId)) d++; return d; };
      for (const st of pageSteps.filter((s) => s.kind === "create").sort((a, b) => depth(a.id) - depth(b.id))) {
        const p = byId.get(st.id).props;
        const shape = create(p);
        idMap.set(st.id, shape.id);
        const parent = resolve(p.parentId);
        if (parent && parent.id !== ROOT && "appendChild" in parent) parent.appendChild(shape);
        setProps(shape, p);
        done.created++;
      }
      // 2. Update changed shapes (incl. moves between parents).
      for (const st of pageSteps.filter((s) => s.kind === "update")) {
        if (!take(st)) { done.keptCloud++; continue; }
        const p = byId.get(st.id).props;
        let shape = page.getShapeById(st.id);
        if (!shape) { shape = create(p); idMap.set(st.id, shape.id); } // deleted in cloud, user chose offline
        const parent = resolve(p.parentId);
        if (parent && shape.parent && parent.id !== shape.parent.id && "appendChild" in parent) parent.appendChild(shape);
        setProps(shape, p);
        done.updated++;
      }
      // 3. Delete shapes removed offline.
      for (const st of pageSteps.filter((s) => s.kind === "delete")) {
        if (!take(st)) { done.keptCloud++; continue; }
        const shape = page.getShapeById(st.id);
        if (shape) { shape.remove(); done.deleted++; }
      }
      // 4. Restore stacking order from the offline copy.
      for (const st of pageSteps.filter((s) => s.kind !== "delete" && take(s))) {
        const p = byId.get(st.id).props;
        const shape = resolve(st.id);
        if (shape && typeof p.parentIndex === "number") {
          try { shape.setParentIndex(p.parentIndex); } catch (_) { /* ponytail: best effort; order only */ }
        }
      }
    }
  } finally {
    penpot.history.undoBlockFinish(block);
  }

  await handlers.cancelOffline();
  await penpot.currentFile.saveVersion(`Atelier: brought back offline edits (${done.created} new, ${done.updated} changed, ${done.deleted} removed)`);
  return done;
}

// ---------- Messaging ----------

penpot.ui.onMessage(async (msg) => {
  if (!msg || !handlers[msg.cmd]) return; // Penpot also posts its own messages (theme etc.)
  try {
    const result = await handlers[msg.cmd](msg);
    console.log("[atelier-sync]", msg.cmd, JSON.stringify(result, (k, v) => (k === "bytes" || k === "text" ? `<${v.length}>` : v)).slice(0, 3000));
    penpot.ui.sendMessage({ cmd: msg.cmd, ok: true, result });
  } catch (e) {
    console.log("[atelier-sync] ERROR", msg.cmd, String(e && e.stack || e));
    penpot.ui.sendMessage({ cmd: msg.cmd, ok: false, error: String(e && e.message || e) });
  }
});

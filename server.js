const http = require("http");
const { readFile, writeFile, mkdir } = require("fs/promises");
const path = require("path");

const PORT = Number(process.env.PORT || 3020);
const DB_FILE = path.join(__dirname, "data", "db.json");

const initialData = {
  rubbings: [
    {
      id: "rubbing_demo",
      code: "TP-清-014",
      source: "地方碑刻残页",
      paperSize: "42x68cm",
      note: "边缘有旧折痕",
      createdAt: new Date().toISOString()
    }
  ],
  damages: [
    {
      id: "damage_demo_1",
      rubbingId: "rubbing_demo",
      position: "左上角第3列题字旁",
      type: "虫蛀孔",
      beforePhotoUrl: "https://example.local/before-014-1.jpg",
      afterPhotoUrl: "",
      status: "pending",
      repairNote: "",
      batchId: null,
      createdAt: new Date().toISOString(),
      repairedAt: null
    },
    {
      id: "damage_demo_2",
      rubbingId: "rubbing_demo",
      position: "下边缘中央",
      type: "撕裂",
      beforePhotoUrl: "https://example.local/before-014-2.jpg",
      afterPhotoUrl: "",
      status: "pending",
      repairNote: "",
      batchId: null,
      createdAt: new Date().toISOString(),
      repairedAt: null
    }
  ],
  batches: []
};

const routes = [
  "GET /health",
  "GET /rubbings",
  "POST /rubbings",
  "GET /rubbings/:id/damages",
  "POST /rubbings/:id/damages",
  "GET /damages?status=&type=",
  "PATCH /damages/:id",
  "GET /batches",
  "POST /batches",
  "GET /batches/:id",
  "POST /batches/:id/complete"
];

async function ensureDb() {
  await mkdir(path.dirname(DB_FILE), { recursive: true });
  try {
    JSON.parse(await readFile(DB_FILE, "utf8"));
  } catch {
    await writeFile(DB_FILE, JSON.stringify(initialData, null, 2));
  }
}

async function readDb() {
  await ensureDb();
  return JSON.parse(await readFile(DB_FILE, "utf8"));
}

async function writeDb(data) {
  await writeFile(DB_FILE, JSON.stringify(data, null, 2));
}

// 串行化批次创建/完成，避免并发请求把同一缺损放进两个批次
let mutationQueue = Promise.resolve();
function withMutationLock(fn) {
  const run = mutationQueue.then(fn);
  mutationQueue = run.catch(() => {});
  return run;
}

function isBlank(value) {
  return value === undefined || value === null || String(value).trim() === "";
}

function firstNonBlank(...values) {
  return values.find((value) => !isBlank(value));
}

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body, null, 2));
}

async function parseBody(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error("请求体必须是合法JSON");
    error.status = 400;
    throw error;
  }
}

function makeId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function required(body, fields) {
  const missing = fields.filter((field) => body[field] === undefined || body[field] === "");
  if (missing.length) {
    const error = new Error(`缺少字段：${missing.join(", ")}`);
    error.status = 400;
    throw error;
  }
}

function findRubbing(db, rubbingId) {
  const rubbing = db.rubbings.find((item) => item.id === rubbingId);
  if (!rubbing) {
    const error = new Error("拓片不存在");
    error.status = 404;
    throw error;
  }
  return rubbing;
}

function enrichBatch(db, batch) {
  const damages = db.damages.filter((item) => batch.damageIds.includes(item.id));
  return {
    ...batch,
    damages,
    total: damages.length,
    repaired: damages.filter((item) => item.status === "repaired").length,
    pending: damages.filter((item) => item.status !== "repaired").length
  };
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;
  const db = await readDb();

  if (req.method === "GET" && pathname === "/health") {
    return send(res, 200, { ok: true, service: "rubbing-repair-api", routes });
  }

  if (req.method === "GET" && pathname === "/rubbings") {
    const data = db.rubbings.map((rubbing) => {
      const damages = db.damages.filter((item) => item.rubbingId === rubbing.id);
      return {
        ...rubbing,
        damageCount: damages.length,
        pendingDamages: damages.filter((item) => item.status !== "repaired").length
      };
    });
    return send(res, 200, { data });
  }

  if (req.method === "POST" && pathname === "/rubbings") {
    const body = await parseBody(req);
    required(body, ["code", "source", "paperSize"]);
    const rubbing = {
      id: makeId("rubbing"),
      code: body.code,
      source: body.source,
      paperSize: body.paperSize,
      note: body.note || "",
      createdAt: new Date().toISOString()
    };
    db.rubbings.push(rubbing);
    await writeDb(db);
    return send(res, 201, { data: rubbing });
  }

  const rubbingDamagesMatch = pathname.match(/^\/rubbings\/([^/]+)\/damages$/);
  if (rubbingDamagesMatch && req.method === "GET") {
    const rubbingId = rubbingDamagesMatch[1];
    findRubbing(db, rubbingId);
    return send(res, 200, { data: db.damages.filter((item) => item.rubbingId === rubbingId) });
  }

  if (rubbingDamagesMatch && req.method === "POST") {
    const rubbingId = rubbingDamagesMatch[1];
    findRubbing(db, rubbingId);
    const body = await parseBody(req);
    required(body, ["position", "type", "beforePhotoUrl"]);
    const damage = {
      id: makeId("damage"),
      rubbingId,
      position: body.position,
      type: body.type,
      beforePhotoUrl: body.beforePhotoUrl,
      afterPhotoUrl: "",
      status: "pending",
      repairNote: "",
      batchId: null,
      createdAt: new Date().toISOString(),
      repairedAt: null
    };
    db.damages.push(damage);
    await writeDb(db);
    return send(res, 201, { data: damage });
  }

  if (req.method === "GET" && pathname === "/damages") {
    const status = url.searchParams.get("status");
    const type = url.searchParams.get("type");
    const data = db.damages.filter((item) => (!status || item.status === status) && (!type || item.type === type));
    return send(res, 200, { data });
  }

  const damagePatchMatch = pathname.match(/^\/damages\/([^/]+)$/);
  if (damagePatchMatch && req.method === "PATCH") {
    const damage = db.damages.find((item) => item.id === damagePatchMatch[1]);
    if (!damage) return send(res, 404, { error: "缺损项不存在" });
    const body = await parseBody(req);
    Object.assign(damage, {
      position: body.position ?? damage.position,
      type: body.type ?? damage.type,
      beforePhotoUrl: body.beforePhotoUrl ?? damage.beforePhotoUrl,
      afterPhotoUrl: body.afterPhotoUrl ?? damage.afterPhotoUrl,
      status: body.status ?? damage.status,
      repairNote: body.repairNote ?? damage.repairNote
    });
    damage.repairedAt = damage.status === "repaired" ? new Date().toISOString() : damage.repairedAt;
    await writeDb(db);
    return send(res, 200, { data: damage });
  }

  if (req.method === "GET" && pathname === "/batches") {
    return send(res, 200, { data: db.batches.map((batch) => enrichBatch(db, batch)) });
  }

  if (req.method === "POST" && pathname === "/batches") {
    const body = await parseBody(req);
    required(body, ["name", "damageIds"]);
    if (!Array.isArray(body.damageIds) || body.damageIds.length === 0) return send(res, 400, { error: "damageIds必须是非空数组" });
    return withMutationLock(async () => {
      const freshDb = await readDb();
      const invalid = body.damageIds.filter((id) => !freshDb.damages.find((damage) => damage.id === id));
      if (invalid.length) return send(res, 400, { error: `缺损项不存在：${invalid.join(", ")}` });
      const openBatchIds = new Set(freshDb.batches.filter((batch) => batch.status !== "completed").map((batch) => batch.id));
      const repaired = [];
      const missingBeforePhoto = [];
      const inOpenBatch = [];
      body.damageIds.forEach((id) => {
        const damage = freshDb.damages.find((item) => item.id === id);
        if (damage.status === "repaired") repaired.push(id);
        else if (isBlank(damage.beforePhotoUrl)) missingBeforePhoto.push(id);
        else if (damage.batchId && openBatchIds.has(damage.batchId)) inOpenBatch.push(id);
      });
      if (repaired.length || missingBeforePhoto.length || inOpenBatch.length) {
        const problems = [];
        if (repaired.length) problems.push(`已修复：${repaired.join(", ")}`);
        if (missingBeforePhoto.length) problems.push(`缺少修复前照片：${missingBeforePhoto.join(", ")}`);
        if (inOpenBatch.length) problems.push(`已属于未完成批次：${inOpenBatch.join(", ")}`);
        return send(res, 409, { error: `缺损项不可入批（${problems.join("；")}）` });
      }
      const batch = {
        id: makeId("batch"),
        name: body.name,
        status: "open",
        damageIds: body.damageIds,
        note: body.note || "",
        createdAt: new Date().toISOString(),
        completedAt: null
      };
      freshDb.batches.push(batch);
      freshDb.damages.forEach((damage) => {
        if (body.damageIds.includes(damage.id)) {
          damage.batchId = batch.id;
          damage.status = "in_repair";
        }
      });
      await writeDb(freshDb);
      return send(res, 201, { data: enrichBatch(freshDb, batch) });
    });
  }

  const batchMatch = pathname.match(/^\/batches\/([^/]+)$/);
  if (batchMatch && req.method === "GET") {
    const batch = db.batches.find((item) => item.id === batchMatch[1]);
    if (!batch) return send(res, 404, { error: "修补批次不存在" });
    return send(res, 200, { data: enrichBatch(db, batch) });
  }

  const completeMatch = pathname.match(/^\/batches\/([^/]+)\/complete$/);
  if (completeMatch && req.method === "POST") {
    const body = await parseBody(req);
    return withMutationLock(async () => {
      const freshDb = await readDb();
      const batch = freshDb.batches.find((item) => item.id === completeMatch[1]);
      if (!batch) return send(res, 404, { error: "修补批次不存在" });
      const results = Array.isArray(body.results) ? body.results : [];
      const updates = batch.damageIds
        .map((damageId) => {
          const damage = freshDb.damages.find((item) => item.id === damageId);
          if (!damage) return null;
          const result = results.find((item) => item && item.damageId === damageId) || {};
          return {
            damage,
            afterPhotoUrl: firstNonBlank(result.afterPhotoUrl, body.defaultAfterPhotoUrl, damage.afterPhotoUrl),
            repairNote: firstNonBlank(result.repairNote, body.defaultRepairNote, damage.repairNote)
          };
        })
        .filter(Boolean);
      const incomplete = updates.filter((item) => isBlank(item.afterPhotoUrl) || isBlank(item.repairNote));
      if (incomplete.length) {
        const details = incomplete.map((item) => {
          const missing = [];
          if (isBlank(item.afterPhotoUrl)) missing.push("修复后照片");
          if (isBlank(item.repairNote)) missing.push("修复说明");
          return `${item.damage.id}（缺${missing.join("、")}）`;
        });
        return send(res, 422, { error: `每个缺损都必须有非空修复后照片和修复说明，批次状态未变更：${details.join(", ")}` });
      }
      const now = new Date().toISOString();
      batch.status = "completed";
      batch.completedAt = now;
      batch.note = body.note ?? batch.note;
      updates.forEach(({ damage, afterPhotoUrl, repairNote }) => {
        damage.status = "repaired";
        damage.afterPhotoUrl = afterPhotoUrl;
        damage.repairNote = repairNote;
        damage.repairedAt = now;
      });
      await writeDb(freshDb);
      return send(res, 200, { data: enrichBatch(freshDb, batch) });
    });
  }

  return send(res, 404, { error: "接口不存在", routes });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((error) => send(res, error.status || 500, { error: error.message || "服务器错误" }));
});

server.listen(PORT, () => {
  console.log(`Rubbing repair API running at http://127.0.0.1:${PORT}`);
});

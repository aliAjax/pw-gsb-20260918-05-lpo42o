const assert = require("assert");

const BASE = `http://127.0.0.1:${process.env.PORT || 3020}`;

async function api(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: res.status, body: await res.json() };
}

async function main() {
  // ---------- 场景1：正常创建批次 ----------
  let r = await api("POST", "/batches", { name: "批次A", damageIds: ["damage_demo_1", "damage_demo_2"] });
  assert.strictEqual(r.status, 201, `创建批次应201: ${JSON.stringify(r.body)}`);
  const batchA = r.body.data.id;
  assert.strictEqual(r.body.data.status, "open");
  assert.ok(Array.isArray(r.body.data.damages), "响应需保留damages字段");
  assert.strictEqual(r.body.data.total, 2);
  r = await api("GET", "/damages?status=in_repair");
  assert.strictEqual(r.body.data.length, 2, "入批后缺损应为in_repair");
  console.log("✔ 场景1 创建批次成功，缺损置为in_repair");

  // ---------- 场景2：重复入批（未完成批次）→ 409 且不产生新批次 ----------
  r = await api("POST", "/batches", { name: "批次B", damageIds: ["damage_demo_1"] });
  assert.strictEqual(r.status, 409, `重复入批应409: ${JSON.stringify(r.body)}`);
  r = await api("GET", "/batches");
  assert.strictEqual(r.body.data.length, 1, "409时不应产生新批次");
  console.log("✔ 场景2 已属未完成批次 → 409 且未创建批次");

  // ---------- 场景3：完成批次缺修复后照片/说明 → 422 且整批状态不改 ----------
  r = await api("POST", `/batches/${batchA}/complete`, {});
  assert.strictEqual(r.status, 422, `缺结果应422: ${JSON.stringify(r.body)}`);
  r = await api("POST", `/batches/${batchA}/complete`, {
    results: [{ damageId: "damage_demo_1", afterPhotoUrl: "https://x/after1.jpg", repairNote: "补纸" }]
  });
  assert.strictEqual(r.status, 422, `部分缺项应422: ${JSON.stringify(r.body)}`);
  r = await api("GET", `/batches/${batchA}`);
  assert.strictEqual(r.body.data.status, "open", "422后批次状态必须保持open");
  assert.strictEqual(r.body.data.completedAt, null, "422后completedAt必须为空");
  r = await api("GET", "/damages?status=in_repair");
  assert.strictEqual(r.body.data.length, 2, "422后缺损状态必须保持in_repair");
  r = await api("GET", "/rubbings/rubbing_demo/damages");
  assert.ok(r.body.data.every((d) => d.afterPhotoUrl === "" && d.repairNote === ""), "422后缺损字段不得被部分写入");
  console.log("✔ 场景3 完成校验失败 → 422 且批次/缺损状态完全未变");

  // ---------- 场景4：完整结果完成批次 → 全部repaired ----------
  r = await api("POST", `/batches/${batchA}/complete`, {
    results: [
      { damageId: "damage_demo_1", afterPhotoUrl: "https://x/after1.jpg", repairNote: "补纸加固" },
      { damageId: "damage_demo_2", afterPhotoUrl: "https://x/after2.jpg", repairNote: "撕裂处托裱" }
    ],
    note: "六月批完成"
  });
  assert.strictEqual(r.status, 200, `完成应200: ${JSON.stringify(r.body)}`);
  assert.strictEqual(r.body.data.status, "completed");
  assert.strictEqual(r.body.data.repaired, 2);
  assert.strictEqual(r.body.data.pending, 0);
  r = await api("GET", "/damages?status=repaired");
  assert.strictEqual(r.body.data.length, 2, "完成后缺损应全部repaired");
  assert.ok(r.body.data.every((d) => d.repairedAt), "repairedAt应被设置");
  console.log("✔ 场景4 完成批次成功，全部置为repaired");

  // ---------- 场景5：已修复缺损再次入批 → 409 ----------
  r = await api("POST", "/batches", { name: "批次C", damageIds: ["damage_demo_1"] });
  assert.strictEqual(r.status, 409, `已修复入批应409: ${JSON.stringify(r.body)}`);
  r = await api("GET", "/batches");
  assert.strictEqual(r.body.data.length, 1, "409时不应产生新批次");
  console.log("✔ 场景5 已修复缺损禁止再次入批 → 409");

  // ---------- 场景6：缺修复前照片 → 409 ----------
  r = await api("POST", "/rubbings/rubbing_demo/damages", { position: "中部", type: "霉斑", beforePhotoUrl: "https://x/b3.jpg" });
  const d3 = r.body.data.id;
  await api("PATCH", `/damages/${d3}`, { beforePhotoUrl: "" });
  r = await api("POST", "/batches", { name: "批次D", damageIds: [d3] });
  assert.strictEqual(r.status, 409, `缺修复前照片应409: ${JSON.stringify(r.body)}`);
  r = await api("GET", "/batches");
  assert.strictEqual(r.body.data.length, 1, "409时不应产生新批次");
  console.log("✔ 场景6 缺修复前照片 → 409 且未创建批次");

  // ---------- 场景7：已完成批次不能重复完成 ----------
  r = await api("POST", `/batches/${batchA}/complete`, {});
  assert.strictEqual(r.status, 409, `重复完成应409: ${JSON.stringify(r.body)}`);
  console.log("✔ 场景7 已完成批次重复完成 → 409");

  // ---------- 场景8：并发创建，同一缺损不得进入两个批次 ----------
  await api("PATCH", `/damages/${d3}`, { beforePhotoUrl: "https://x/b3.jpg" });
  r = await api("POST", "/rubbings/rubbing_demo/damages", { position: "右下角", type: "水渍", beforePhotoUrl: "https://x/b4.jpg" });
  const d4 = r.body.data.id;
  const settled = await Promise.all([
    api("POST", "/batches", { name: "并发1", damageIds: [d3, d4] }),
    api("POST", "/batches", { name: "并发2", damageIds: [d3, d4] }),
    api("POST", "/batches", { name: "并发3", damageIds: [d3] }),
    api("POST", "/batches", { name: "并发4", damageIds: [d4] })
  ]);
  const created = settled.filter((x) => x.status === 201);
  const rejected = settled.filter((x) => x.status === 409);
  assert.ok(created.length >= 1, "并发中至少一个应成功");
  assert.ok(created.length + rejected.length === 4, "并发结果只能是201或409");
  r = await api("GET", "/batches");
  const openBatches = r.body.data.filter((b) => b.status === "open");
  const d3Count = openBatches.filter((b) => b.damageIds.includes(d3)).length;
  const d4Count = openBatches.filter((b) => b.damageIds.includes(d4)).length;
  assert.strictEqual(d3Count, 1, `缺损${d3}只能出现在一个未完成批次，实际${d3Count}`);
  assert.strictEqual(d4Count, 1, `缺损${d4}只能出现在一个未完成批次，实际${d4Count}`);
  console.log(`✔ 场景8 并发4个创建：${created.length}个201、${rejected.length}个409，同一缺损仅入一个批次`);

  // ---------- 场景9：默认字段兜底 + 响应兼容 ----------
  const openBatch = openBatches.find((b) => b.damageIds.includes(d3));
  r = await api("POST", `/batches/${openBatch.id}/complete`, {
    defaultAfterPhotoUrl: "https://x/after-default.jpg",
    defaultRepairNote: "统一修补"
  });
  assert.strictEqual(r.status, 200, `默认值兜底完成应200: ${JSON.stringify(r.body)}`);
  assert.deepStrictEqual(
    Object.keys(r.body.data).sort(),
    ["completedAt", "createdAt", "damageIds", "damages", "id", "name", "note", "pending", "repaired", "status", "total"].sort(),
    "批次响应字段需保持兼容"
  );
  console.log("✔ 场景9 default*字段兜底生效，响应字段保持兼容");

  console.log("\n全部场景通过 ✅");
}

main().catch((error) => {
  console.error("测试失败:", error.message);
  process.exit(1);
});

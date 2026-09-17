# 古籍拓片缺损修补API

纯后端零依赖Node服务，使用 `data/db.json` 持久化拓片、缺损项和修补批次。

## 启动

```bash
PORT=3020 node server.js
```

## 主要接口

- `GET /health`
- `GET /rubbings`
- `POST /rubbings`
- `GET /rubbings/:id/damages`
- `POST /rubbings/:id/damages`
- `GET /damages?status=&type=`
- `PATCH /damages/:id`
- `GET /batches`
- `POST /batches`
- `GET /batches/:id`
- `POST /batches/:id/complete`

## 闭环示例

```bash
curl http://127.0.0.1:3020/damages?status=pending
curl -X POST http://127.0.0.1:3020/batches \
  -H 'Content-Type: application/json' \
  -d '{"name":"六月小批修补","damageIds":["damage_demo_1","damage_demo_2"]}'
```

## 批次状态闭环

- `POST /batches`：缺损已修复、缺少修复前照片、或已属于未完成批次时返回 `409`，且不产生新批次；并发创建时同一缺损只会进入一个批次。
- `POST /batches/:id/complete`：批内每个缺损都必须有非空修复后照片和修复说明（可取 `results[i]`、`defaultAfterPhotoUrl`/`defaultRepairNote` 或缺损已有值），否则返回 `422` 且整批状态不变；成功后全部缺损统一置为 `repaired`，并禁止再次入批。

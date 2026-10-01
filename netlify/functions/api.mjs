import { getStore } from "@netlify/blobs";
const LIMIT = 600; // seconds per player per round
export const config = { path: "/api/*" };

export default async (req) => {
  const s = getStore({ name: "quiz2", consistency: "strong" });
  const url = new URL(req.url), m = req.method;
  const p = url.pathname.replace(/^\/api\//, "");
  const J = (d, c = 200) => Response.json(d, { status: c });
  const get = async (k, d) => (await s.get(k, { type: "json" })) ?? d;
  const body = m === "POST" ? await req.json().catch(() => ({})) : {};
  const quizzes = await get("quizzes", []);
  const live = quizzes.find((q) => q.status === "live");
  const pub = ({ correct, ...q }) => q;
  const saveQ = (l) => s.setJSON("quizzes", l);
  const players = async (prefix) => {
    const { blobs } = await s.list({ prefix });
    return (await Promise.all(blobs.map(async (b) => { const r = await get(b.key, null); return r && { ...r, _k: b.key }; }))).filter(Boolean);
  };

  if (m === "GET" && p.startsWith("media/")) {
    const r = await s.getWithMetadata("m:" + p.slice(6), { type: "arrayBuffer" });
    if (!r) return J({ error: "Not found" }, 404);
    return new Response(r.data, { headers: { "content-type": r.metadata.type, "cache-control": "public,max-age=86400" } });
  }
  if (p === "status") return J({ live: live ? { id: live.id, name: live.name } : null });

  if (p === "join" && m === "POST") {
    if (!live) return J({ error: "No quiz is live right now." }, 403);
    const f = ["name", "cluster", "building", "flat"].map((k) => String(body[k] || "").trim().slice(0, 60));
    if (f.some((x) => !x)) return J({ error: "Fill in all fields." }, 400);
    const pk = f.map((x) => x.toLowerCase()).join("|");
    const key = "p:" + live.id + ":" + encodeURIComponent(pk);
    let rec = await get(key, null);
    if (!rec) { rec = { name: f[0], cluster: f[1], building: f[2], flat: f[3], pk, qid: live.id, start: Date.now() }; await s.setJSON(key, rec); }
    if (rec.done) return J({ error: "You have already submitted this quiz." }, 409);
    const remaining = Math.max(0, LIMIT - Math.floor((Date.now() - rec.start) / 1000));
    return J({ key, remaining, name: live.name, questions: (await get("qs:" + live.id, [])).map(pub) });
  }
  if (p === "submit" && m === "POST") {
    const rec = await get(body.key, null);
    if (!rec) return J({ error: "Unknown player" }, 404);
    if (rec.done) return J({ ok: true });
    if (!live || live.id !== rec.qid) return J({ error: "This quiz was closed by the admin." }, 403);
    const qs = await get("qs:" + rec.qid, []), a = body.answers || {};
    rec.score = qs.filter((q) => a[q.id] === q.correct).length;
    rec.time = Math.min(LIMIT, Math.round((Date.now() - rec.start) / 1000));
    rec.done = true;
    await s.setJSON(body.key, rec);
    return J({ ok: true });
  }

  // ---- admin ----
  if (!p.startsWith("admin/")) return J({ error: "Not found" }, 404);
  if (req.headers.get("x-admin") !== (process.env.ADMIN_PASSWORD || "admin123")) return J({ error: "Wrong password" }, 401);
  const a = p.slice(6);

  if (a === "overview") {
    const qid = url.searchParams.get("quiz") || (live || quizzes[quizzes.length - 1])?.id;
    const recs = await players("p:");
    const mine = recs.filter((r) => r.qid === qid);
    const done = mine.filter((r) => r.done).sort((x, y) => y.score - x.score || x.time - y.time);
    const agg = new Map();
    for (const r of recs.filter((r) => r.done)) {
      const o = agg.get(r.pk) || { name: r.name, cluster: r.cluster, building: r.building, flat: r.flat, total: 0, time: 0, by: {} };
      o.total += r.score; o.time += r.time; o.by[r.qid] = r.score; agg.set(r.pk, o);
    }
    const overall = [...agg.values()].sort((x, y) => y.total - x.total || x.time - y.time);
    return J({ quizzes, qid, questions: qid ? await get("qs:" + qid, []) : [], done, pending: mine.filter((r) => !r.done), overall });
  }
  if (a === "quiz" && m === "POST") {
    const id = crypto.randomUUID().slice(0, 8);
    await saveQ([...quizzes, { id, name: String(body.name || "Round").slice(0, 40), status: "draft", count: 0 }]);
    return J({ id });
  }
  if (a === "status") {
    await saveQ(quizzes.map((q) => q.id === body.id ? { ...q, status: body.status } : body.status === "live" && q.status === "live" ? { ...q, status: "closed" } : q));
    return J({ ok: true });
  }
  if (a === "question" && m === "POST") {
    const qs = await get("qs:" + body.quiz, []), id = crypto.randomUUID().slice(0, 8);
    const q = { id, text: body.text || "", options: body.options, correct: body.correct };
    if (body.media) {
      await s.set("m:" + id, Buffer.from(body.media.data, "base64"), { metadata: { type: body.media.type } });
      q.mediaId = id; q.mediaType = body.media.type.startsWith("video") ? "video" : "image";
    }
    const n = [...qs, q];
    await s.setJSON("qs:" + body.quiz, n);
    await saveQ(quizzes.map((x) => x.id === body.quiz ? { ...x, count: n.length } : x));
    return J({ ok: true });
  }
  if (a === "question" && m === "DELETE") {
    const qz = url.searchParams.get("quiz"), id = url.searchParams.get("id");
    const n = (await get("qs:" + qz, [])).filter((q) => q.id !== id);
    await s.setJSON("qs:" + qz, n);
    await s.delete("m:" + id).catch(() => {});
    await saveQ(quizzes.map((x) => x.id === qz ? { ...x, count: n.length } : x));
    return J({ ok: true });
  }
  if (a === "reset" || a === "deletequiz") {
    const id = body.quiz || body.id;
    await Promise.all((await players("p:" + id + ":")).map((r) => s.delete(r._k)));
    if (a === "reset") await saveQ(quizzes.map((q) => q.id === id ? { ...q, status: "draft" } : q));
    else {
      for (const q of await get("qs:" + id, [])) await s.delete("m:" + q.id).catch(() => {});
      await s.delete("qs:" + id).catch(() => {});
      await saveQ(quizzes.filter((q) => q.id !== id));
    }
    return J({ ok: true });
  }
  return J({ error: "Not found" }, 404);
};

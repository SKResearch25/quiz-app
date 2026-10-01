import { getStore } from "@netlify/blobs";
const LIMIT = 600; // seconds per player
export const config = { path: "/api/*" };

export default async (req) => {
  const s = getStore({ name: "quiz", consistency: "strong" });
  const p = new URL(req.url).pathname.replace(/^\/api\//, "");
  const m = req.method;
  const J = (d, c = 200) => Response.json(d, { status: c });
  const get = async (k, d) => (await s.get(k, { type: "json" })) ?? d;
  const isAdmin = req.headers.get("x-admin") === (process.env.ADMIN_PASSWORD || "admin123");
  const body = m === "POST" ? await req.json().catch(() => ({})) : {};
  const cfg = await get("cfg", { status: "draft" });
  const qs = await get("questions", []);
  const pub = ({ correct, ...q }) => q;

  // media
  if (m === "GET" && p.startsWith("media/")) {
    const r = await s.getWithMetadata("m:" + p.slice(6), { type: "arrayBuffer" });
    if (!r) return J({ error: "Not found" }, 404);
    return new Response(r.data, { headers: { "content-type": r.metadata.type, "cache-control": "public,max-age=86400" } });
  }
  // player join / resume
  if (p === "join" && m === "POST") {
    if (cfg.status !== "live") return J({ error: cfg.status === "closed" ? "This quiz is closed." : "Quiz is not live yet." }, 403);
    const f = ["name", "cluster", "building", "flat"].map((k) => String(body[k] || "").trim().slice(0, 60));
    if (f.some((x) => !x)) return J({ error: "Fill in all fields." }, 400);
    const key = "p:" + encodeURIComponent(f.map((x) => x.toLowerCase()).join("|"));
    let rec = await get(key, null);
    if (!rec) { rec = { name: f[0], cluster: f[1], building: f[2], flat: f[3], start: Date.now() }; await s.setJSON(key, rec); }
    if (rec.done) return J({ error: "You have already submitted this quiz." }, 409);
    const remaining = Math.max(0, LIMIT - Math.floor((Date.now() - rec.start) / 1000));
    return J({ key, remaining, questions: qs.map(pub) });
  }
  // player submit
  if (p === "submit" && m === "POST") {
    if (cfg.status !== "live") return J({ error: "Quiz was closed by the admin." }, 403);
    const rec = await get(body.key, null);
    if (!rec) return J({ error: "Unknown player" }, 404);
    if (rec.done) return J({ ok: true });
    const a = body.answers || {};
    rec.score = qs.filter((q) => a[q.id] === q.correct).length;
    rec.time = Math.min(LIMIT, Math.round((Date.now() - rec.start) / 1000));
    rec.done = true;
    await s.setJSON(body.key, rec);
    return J({ ok: true });
  }
  if (p === "status") return J({ status: cfg.status });

  // admin
  if (!p.startsWith("admin/")) return J({ error: "Not found" }, 404);
  if (!isAdmin) return J({ error: "Wrong password" }, 401);
  const a = p.slice(6);
  if (a === "overview") {
    const { blobs } = await s.list({ prefix: "p:" });
    const players = await Promise.all(blobs.map((b) => get(b.key, null)));
    const done = players.filter((x) => x?.done).sort((x, y) => y.score - x.score || x.time - y.time);
    const pending = players.filter((x) => x && !x.done);
    return J({ status: cfg.status, questions: qs, done, pending });
  }
  if (a === "status") { await s.setJSON("cfg", { status: body.status }); return J({ ok: true }); }
  if (a === "question" && m === "POST") {
    const id = crypto.randomUUID().slice(0, 8);
    const q = { id, text: body.text || "", options: body.options, correct: body.correct };
    if (body.media) {
      await s.set("m:" + id, Buffer.from(body.media.data, "base64"), { metadata: { type: body.media.type } });
      q.mediaId = id; q.mediaType = body.media.type.startsWith("video") ? "video" : "image";
    }
    await s.setJSON("questions", [...qs, q]);
    return J({ ok: true });
  }
  if (a === "question" && m === "DELETE") {
    const id = new URL(req.url).searchParams.get("id");
    await s.setJSON("questions", qs.filter((q) => q.id !== id));
    await s.delete("m:" + id).catch(() => {});
    return J({ ok: true });
  }
  if (a === "reset") {
    const { blobs } = await s.list({ prefix: "p:" });
    await Promise.all(blobs.map((b) => s.delete(b.key)));
    await s.setJSON("cfg", { status: "draft" });
    return J({ ok: true });
  }
  return J({ error: "Not found" }, 404);
};

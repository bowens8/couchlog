import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, onAuthStateChanged, signOut }
  from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { getFirestore, collection, doc, getDoc, getDocs, setDoc, deleteDoc, query, where,
  orderBy, limit, serverTimestamp, writeBatch, Timestamp, updateDoc, deleteField } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { firebaseConfig, TMDB_KEY } from "./config.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

const $ = (s, r = document) => r.querySelector(s);
const view = $("#view");
const IMG = "https://image.tmdb.org/t/p/";
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

let me = null;          // firebase user
let users = {};         // uid -> {name, photo}
let myEntries = {};     // key -> entry (for the signed-in user)
const metaCache = new Map(); // key -> {type,tmdbId,key,title,year,poster} for cards on screen
let browseToken = 0;
let browseObserver = null;
let hideLogged = false;

/* ---------- helpers ---------- */
function toast(msg) {
  const t = $("#toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), 2400);
}
function starsText(r) {
  if (r == null) return "";
  const full = Math.floor(r), half = r - full >= 0.5;
  return "★".repeat(full) + (half ? "½" : "");
}
function fmtDate(s) {
  if (!s) return "";
  const d = new Date(s + "T12:00:00");
  return isNaN(d) ? "" : d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}
function posterUrl(p, size = "w342") { return p ? IMG + size + p : ""; }
function posterImg(p, alt = "") {
  return p ? `<img class="poster" loading="lazy" src="${posterUrl(p)}" alt="${esc(alt)}">`
           : `<div class="poster" style="display:flex;align-items:center;justify-content:center;padding:8px;text-align:center;color:var(--muted);font-size:12px">${esc(alt)}</div>`;
}
function userName(uid) { return users[uid]?.name || "Someone"; }
function avatar(uid) {
  const u = users[uid]; return u?.photo ? `<img class="avatar" src="${esc(u.photo)}" referrerpolicy="no-referrer" alt="">` : `<span class="avatar" style="display:inline-block"></span>`;
}
function timeAgo(ts) {
  const d = ts?.toDate ? ts.toDate() : null; if (!d) return "just now";
  const s = (Date.now() - d) / 1000;
  if (s < 60) return "just now"; if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago"; if (s < 604800) return Math.floor(s / 86400) + "d ago";
  return d.toLocaleDateString();
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function tmdb(path, params = {}, tries = 3) {
  const u = new URL("https://api.themoviedb.org/3" + path);
  u.searchParams.set("api_key", TMDB_KEY);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  const r = await fetch(u);
  if (r.status === 429 && tries > 1) { await sleep(1200); return tmdb(path, params, tries - 1); }
  if (!r.ok) throw new Error("TMDB " + r.status);
  return r.json();
}
const entryId = (uid, key) => `${uid}_${key}`;
const metaOf = (r, type) => ({
  type, tmdbId: r.id, key: `${type}_${r.id}`, title: r.title || r.name || "",
  year: (r.release_date || r.first_air_date || "").slice(0, 4), poster: r.poster_path || "",
  genres: r.genre_ids || (r.genres ? r.genres.map(g => g.id) : [])
});

/* ---------- poster cards with quick-add buttons ---------- */
function quickBar(key) {
  const s = myEntries[key]?.status;
  return `<div class="quick">
    <button class="q ${s === "watched" ? "on" : ""}" data-act="watched" title="Mark as watched">✓ Seen</button>
    <button class="q ${s === "watchlist" ? "on" : ""}" data-act="watchlist" title="Add to watchlist">＋ List</button></div>`;
}
function mediaCard(m) {
  metaCache.set(m.key, m);
  return `<div class="card" data-key="${m.key}">
    <a href="#/title/${m.type}/${m.tmdbId}">${posterImg(m.poster, m.title)}</a>
    <span class="badge">${m.type === "tv" ? "TV" : "Film"}</span>
    <div class="cap">${esc(m.title)}${m.year ? ` (${esc(m.year)})` : ""}</div>
    ${quickBar(m.key)}</div>`;
}
function syncQuickBars() {
  view.querySelectorAll(".card[data-key]").forEach(c => {
    const q = c.querySelector(".quick"); if (q) q.outerHTML = quickBar(c.dataset.key);
  });
}
async function quickLog(m, act) {
  const ex = myEntries[m.key];
  const ref = doc(db, "entries", entryId(me.uid, m.key));
  try {
    if (ex && ex.status === act) {
      if (ex.rating != null || ex.review) { openLog(m, syncQuickBars); return; } // don't silently delete a rated/reviewed entry
      await deleteDoc(ref); delete myEntries[m.key]; toast("Removed"); return;
    }
    if (ex && ex.status === "watched" && act === "watchlist") { openLog(m, syncQuickBars); return; }
    const data = {
      ...m, genres: m.genres || ex?.genres || [], uid: me.uid, status: act,
      rating: null, review: "", watchedOn: "", season: "",
      updatedAt: serverTimestamp()
    };
    await setDoc(ref, data);
    myEntries[m.key] = { ...data, updatedAt: { toDate: () => new Date() } };
    toast(act === "watched" ? "Marked as watched" : "Added to watchlist");
  } catch (e) { toast("Couldn't save: " + e.message); }
}
view.addEventListener("click", async ev => {
  const b = ev.target.closest(".q"); if (!b) return;
  ev.preventDefault();
  const card = b.closest(".card"); const m = metaCache.get(card?.dataset.key); if (!m) return;
  await quickLog(m, b.dataset.act);
  const q = card.querySelector(".quick"); if (q) q.outerHTML = quickBar(m.key);
});

/* ---------- auth ---------- */
const topbar = $("#topbar");
$("#signout").onclick = () => signOut(auth);

function renderLogin(msg = "") {
  topbar.hidden = true;
  view.innerHTML = `<div class="hero">
    <h1>🎬 Couchlog</h1>
    <p class="muted">Movies &amp; TV, just us. No ads, no algorithm.</p>
    <button id="login">Sign in with Google</button>
    ${msg ? `<p style="color:var(--danger);margin-top:16px">${msg}</p>` : ""}
  </div>`;
  $("#login").onclick = () => signInWithPopup(auth, new GoogleAuthProvider()).catch(e => renderLogin(esc(e.message)));
}

onAuthStateChanged(auth, async user => {
  if (!user) { me = null; return renderLogin(); }
  try {
    const ok = await getDoc(doc(db, "allowed", user.email.toLowerCase()));
    if (!ok.exists()) throw new Error("not-allowed");
    await setDoc(doc(db, "users", user.uid), { name: user.displayName || user.email.split("@")[0], photo: user.photoURL || "", email: user.email.toLowerCase() }, { merge: true });
    me = user;
    await loadUsers();
    await loadMine();
    syncShared().catch(() => {});
    topbar.hidden = false;
    route();
  } catch (e) {
    await signOut(auth);
    renderLogin(e.message === "not-allowed"
      ? `${esc(user.email)} isn't on the guest list. Ask Ben to add you.`
      : esc(e.message));
  }
});

async function loadUsers() {
  users = {};
  (await getDocs(collection(db, "users"))).forEach(d => (users[d.id] = d.data()));
}
async function loadMine() {
  myEntries = {};
  (await getDocs(query(collection(db, "entries"), where("uid", "==", me.uid)))).forEach(d => (myEntries[d.data().key] = d.data()));
}

/* ---------- router ---------- */
window.addEventListener("hashchange", () => me && route());
function route() {
  browseToken++; browseObserver?.disconnect();
  const h = location.hash.slice(2) || "feed";
  const [page, a, b] = h.split("/");
  document.querySelectorAll("#topbar nav a").forEach(l => l.classList.toggle("active", l.getAttribute("href") === "#/" + page));
  window.scrollTo(0, 0);
  if (page === "feed") return pageFeed();
  if (page === "browse") return pageBrowse(a);
  if (page === "reviews") return pageReviews();
  if (page !== "list") editing = false;
  if (page === "lists") return pageLists(a);
  if (page === "list") return pageList(a);
  if (page === "search") return pageSearch(decodeURIComponent(a || ""));
  if (page === "title") return pageTitle(a, b);
  if (page === "me") return pageUser(me.uid);
  if (page === "user") return pageUser(a);
  if (page === "people") return pagePeople();
  if (page === "import") return pageImport();
  location.hash = "#/feed";
}

/* ---------- feed ---------- */
/* ---------- shared: modal + title picker ---------- */
function modalOpen(html) {
  $("#modal-card").innerHTML = html;
  $("#modal").hidden = false;
  $("#modal").onclick = e => { if (e.target.id === "modal") modalClose(); };
}
function modalClose() { $("#modal").hidden = true; }

function titlePicker(root, onPick) {
  root.innerHTML = `<input class="tp-q" placeholder="Search for a movie or show…"><div class="tp-res"></div>`;
  const q = $(".tp-q", root), res = $(".tp-res", root);
  let t;
  q.oninput = () => {
    clearTimeout(t);
    t = setTimeout(async () => {
      const term = q.value.trim();
      if (!term) { res.innerHTML = ""; return; }
      try {
        const d = await tmdb("/search/multi", { query: term, include_adult: "false" });
        const rs = d.results.filter(r => r.media_type === "movie" || r.media_type === "tv").slice(0, 8).map(r => metaOf(r, r.media_type));
        rs.forEach(m => metaCache.set(m.key, m));
        res.innerHTML = rs.map(m => `<div class="pick" data-key="${m.key}">${posterImg(m.poster, m.title)}
          <div><b>${esc(m.title)}</b> <span class="muted">${esc(m.year)} · ${m.type === "tv" ? "TV" : "Film"}</span></div></div>`).join("") || `<p class="muted">No results.</p>`;
      } catch (e) { res.innerHTML = `<p style="color:var(--danger)">${esc(e.message)}</p>`; }
    }, 300);
  };
  res.onclick = ev => {
    const p = ev.target.closest(".pick"); if (!p) return;
    const m = metaCache.get(p.dataset.key); if (m) onPick(m);
  };
}

/* ---------- feed (activity + posts) ---------- */
function postItem(p, id) {
  const t = p.title;
  return `<div class="feed-item post">
    <div style="flex:1">
      <div class="who">${avatar(p.uid)} <a href="#/user/${p.uid}"><b>${esc(userName(p.uid))}</b></a> posted · ${timeAgo(p.createdAt)}
        ${p.uid === me.uid ? `<button class="ghost small" data-delpost="${id}" style="float:right">Delete</button>` : ""}</div>
      ${p.text ? `<div class="review" style="font-size:16px">${esc(p.text)}</div>` : ""}
      ${t ? `<a class="attach" href="#/title/${t.type}/${t.tmdbId}">${posterImg(t.poster, t.title)}
        <span><b>${esc(t.title)}</b><br><span class="muted">${esc(t.year)} · ${t.type === "tv" ? "TV" : "Film"}</span></span></a>` : ""}
    </div></div>`;
}

async function pageFeed(filter = "all") {
  let attached = null;
  view.innerHTML = `<h1>Friends' activity</h1>
    <div class="composer">
      <textarea id="ptext" maxlength="1000" placeholder="Share a thought, a recommendation, a hot take…"></textarea>
      <div id="pchosen" class="muted" style="margin-top:6px"></div>
      <div class="row" style="margin-top:8px;justify-content:space-between">
        <button class="ghost small" id="pattach">＋ Attach a title</button>
        <button id="ppost">Post</button>
      </div>
      <div id="ppicker" class="picker" hidden></div>
    </div>
    <div class="tabs">${[["all", "All"], ["movie", "Movies"], ["tv", "TV"], ["posts", "Posts"]].map(([f, l]) => `<span class="tab ${f === filter ? "on" : ""}" data-f="${f}">${l}</span>`).join("")}</div>
    <div id="list"><p class="muted">Loading…</p></div>`;
  view.querySelectorAll(".tabs .tab").forEach(t => (t.onclick = () => pageFeed(t.dataset.f)));

  const picker = $("#ppicker");
  titlePicker(picker, m => {
    attached = m; picker.hidden = true;
    $("#pchosen").innerHTML = `Attached: <b>${esc(m.title)}</b> ${esc(m.year)} · <a href="#" id="pdetach" style="color:var(--accent2)">remove</a>`;
    $("#pdetach").onclick = ev => { ev.preventDefault(); attached = null; $("#pchosen").textContent = ""; };
  });
  $("#pattach").onclick = () => { picker.hidden = !picker.hidden; if (!picker.hidden) $(".tp-q", picker).focus(); };
  $("#ppost").onclick = async () => {
    const text = $("#ptext").value.trim();
    if (!text && !attached) { toast("Write something first"); return; }
    try {
      await setDoc(doc(collection(db, "posts")), {
        uid: me.uid, text,
        title: attached ? { key: attached.key, type: attached.type, tmdbId: attached.tmdbId, title: attached.title, year: attached.year || "", poster: attached.poster || "" } : null,
        createdAt: serverTimestamp()
      });
      toast("Posted"); pageFeed(filter);
    } catch (e) { toast("Couldn't post: " + e.message + " (did you publish the new Firestore rules?)"); }
  };

  const [es, ps] = await Promise.all([
    getDocs(query(collection(db, "entries"), orderBy("updatedAt", "desc"), limit(120))),
    getDocs(query(collection(db, "posts"), orderBy("createdAt", "desc"), limit(60))).catch(() => ({ docs: [] }))
  ]);
  const items = [];
  if (filter !== "posts") es.docs.forEach(d => { const e = d.data(); if (filter === "all" || e.type === filter) items.push({ t: e.updatedAt?.seconds || 0, html: feedItem(e) }); });
  if (filter === "all" || filter === "posts") ps.docs.forEach(d => { const p = d.data(); items.push({ t: p.createdAt?.seconds || Math.floor(Date.now() / 1000), html: postItem(p, d.id) }); });
  items.sort((a, b) => b.t - a.t);
  $("#list").innerHTML = items.length ? items.map(i => i.html).join("") :
    `<p class="muted">Nothing here yet. <a href="#/browse" style="color:var(--accent2)">Browse something to log.</a></p>`;
  $("#list").onclick = async ev => {
    const b = ev.target.closest("[data-delpost]"); if (!b) return;
    if (!confirm("Delete this post?")) return;
    await deleteDoc(doc(db, "posts", b.dataset.delpost)); pageFeed(filter);
  };
}

function feedItem(e) {
  const verb = e.status === "watchlist" ? "added to watchlist" : "watched";
  const when = e.status === "watched" && e.watchedOn ? ` on ${fmtDate(e.watchedOn)}` : "";
  return `<div class="feed-item">
    <a href="#/title/${e.type}/${e.tmdbId}">${posterImg(e.poster, e.title)}</a>
    <div>
      <div class="who">${avatar(e.uid)} <a href="#/user/${e.uid}"><b>${esc(userName(e.uid))}</b></a> ${verb}${when} · ${timeAgo(e.updatedAt)}</div>
      <div class="title"><a href="#/title/${e.type}/${e.tmdbId}">${esc(e.title)}</a> <span class="muted" style="font-weight:400">${esc(e.year || "")}${e.season ? " · " + esc(e.season) : ""}</span></div>
      ${e.rating != null ? `<div class="stars">${starsText(e.rating)}</div>` : ""}
      ${e.review ? `<div class="review">${esc(e.review)}</div>` : ""}
    </div></div>`;
}

/* ---------- browse (scrollable lists) ---------- */
const SOURCES = {
  "trending-movie": { label: "Trending films", path: "/trending/movie/week", type: "movie" },
  "trending-tv":    { label: "Trending TV", path: "/trending/tv/week", type: "tv" },
  "popular-movie":  { label: "Popular films", path: "/movie/popular", type: "movie" },
  "top-movie":      { label: "Top rated films", path: "/movie/top_rated", type: "movie" },
  "theaters":       { label: "In theaters", path: "/movie/now_playing", type: "movie" },
  "popular-tv":     { label: "Popular TV", path: "/tv/popular", type: "tv" },
  "top-tv":         { label: "Top rated TV", path: "/tv/top_rated", type: "tv" },
  "airing":         { label: "Airing now", path: "/tv/on_the_air", type: "tv" },
  "friends":        { label: "Friends' picks" }
};
function pageBrowse(src) {
  if (!SOURCES[src]) src = "trending-movie";
  const token = ++browseToken;
  browseObserver?.disconnect();
  view.innerHTML = `<h1>Browse</h1>
    <div class="chips">${Object.entries(SOURCES).map(([k, s]) => `<span class="tab ${k === src ? "on" : ""}" data-src="${k}">${s.label}</span>`).join("")}</div>
    <label class="chk" style="margin-bottom:14px"><input type="checkbox" id="hide" ${hideLogged ? "checked" : ""}> Hide ones I've already logged</label>
    <div class="grid" id="bgrid"></div>
    <div id="sentinel" class="center muted" style="padding:28px">Loading…</div>`;
  view.querySelectorAll("[data-src]").forEach(t => (t.onclick = () => (location.hash = "#/browse/" + t.dataset.src)));
  $("#hide").onchange = e => { hideLogged = e.target.checked; pageBrowse(src); };

  const cfg = SOURCES[src];
  let page = 0, done = false, loading = false, friends = null;
  const seen = new Set();
  const sentinel = $("#sentinel"), grid = $("#bgrid");

  async function nextPage() {
    if (loading || done || token !== browseToken) return;
    loading = true; page++;
    try {
      let items;
      if (src === "friends") {
        if (!friends) {
          const snap = await getDocs(query(collection(db, "entries"), orderBy("updatedAt", "desc"), limit(400)));
          const byKey = new Map();
          snap.docs.forEach(d => { const e = d.data(); if (e.uid !== me.uid && !byKey.has(e.key)) byKey.set(e.key, e); });
          friends = [...byKey.values()].map(e => ({ type: e.type, tmdbId: e.tmdbId, key: e.key, title: e.title, year: e.year, poster: e.poster, genres: e.genres || [] }));
        }
        items = friends.slice((page - 1) * 40, page * 40);
        if (page * 40 >= friends.length) done = true;
      } else {
        const d = await tmdb(cfg.path, { page });
        items = d.results.map(r => metaOf(r, r.media_type || cfg.type));
        if (page >= Math.min(d.total_pages || 1, 25)) done = true;
      }
      if (token !== browseToken) return;
      items = items.filter(m => m.poster && !seen.has(m.key));
      items.forEach(m => seen.add(m.key));
      if (hideLogged) items = items.filter(m => !myEntries[m.key]);
      grid.insertAdjacentHTML("beforeend", items.map(mediaCard).join(""));
      sentinel.textContent = done ? (seen.size ? "That's the end of the list." : "Nothing here yet.") : "Loading more…";
    } catch (e) {
      if (token !== browseToken) return;
      sentinel.textContent = e.message + (src === "friends" ? "" : " — check your TMDB key in config.js"); done = true;
    }
    loading = false;
    // if everything loaded was filtered out the sentinel may still be on screen; keep going
    if (!done && token === browseToken && sentinel.getBoundingClientRect().top < innerHeight + 600) nextPage();
  }
  browseObserver = new IntersectionObserver(es => { if (es.some(e => e.isIntersecting)) nextPage(); }, { rootMargin: "700px" });
  browseObserver.observe(sentinel);
  nextPage();
}

/* ---------- reviews ---------- */
function reviewCard(e, i) {
  const when = e.watchedOn ? ` · watched ${fmtDate(e.watchedOn)}` : "";
  return `<article class="feed-item rev">
    <a href="#/title/${e.type}/${e.tmdbId}">${posterImg(e.poster, e.title)}</a>
    <div style="flex:1">
      <div class="title"><a href="#/title/${e.type}/${e.tmdbId}">${esc(e.title)}</a> <span class="muted" style="font-weight:400">${esc(e.year || "")}</span> <span class="stars">${starsText(e.rating)}</span></div>
      <div class="who">${avatar(e.uid)} <a href="#/user/${e.uid}"><b>${esc(userName(e.uid))}</b></a>${when} · ${timeAgo(e.updatedAt)}</div>
      <div class="review">${esc(e.review)}</div>
      ${e.uid === me.uid ? `<button class="ghost small" data-edit="${i}" style="margin-top:8px">Edit</button>` : ""}
    </div></article>`;
}
async function pageReviews() {
  view.innerHTML = `<div class="row" style="justify-content:space-between"><h1 style="margin:0">Reviews</h1><button id="write">✍️ Write a review</button></div>
    <div id="picker" class="picker" hidden><input id="pq" placeholder="Search for a movie or show to review…"><div id="pres"></div></div>
    <div id="list" style="margin-top:14px"><p class="muted">Loading…</p></div>`;
  $("#write").onclick = () => { const p = $("#picker"); p.hidden = !p.hidden; if (!p.hidden) $("#pq").focus(); };
  let t;
  $("#pq").oninput = () => {
    clearTimeout(t);
    t = setTimeout(async () => {
      const term = $("#pq").value.trim();
      if (!term) { $("#pres").innerHTML = ""; return; }
      try {
        const d = await tmdb("/search/multi", { query: term, include_adult: "false" });
        const rs = d.results.filter(r => r.media_type === "movie" || r.media_type === "tv").slice(0, 6).map(r => metaOf(r, r.media_type));
        rs.forEach(m => metaCache.set(m.key, m));
        $("#pres").innerHTML = rs.map(m => `<div class="pick" data-key="${m.key}">${posterImg(m.poster, m.title)}
          <div><b>${esc(m.title)}</b> <span class="muted">${esc(m.year)} · ${m.type === "tv" ? "TV" : "Film"}</span></div></div>`).join("") || `<p class="muted">No results.</p>`;
      } catch (e) { $("#pres").innerHTML = `<p style="color:var(--danger)">${esc(e.message)}</p>`; }
    }, 300);
  };
  $("#pres").onclick = ev => {
    const p = ev.target.closest(".pick"); if (!p) return;
    openLog(metaCache.get(p.dataset.key), () => pageReviews(), { focusReview: true });
  };
  const snap = await getDocs(query(collection(db, "entries"), orderBy("updatedAt", "desc"), limit(250)));
  const rows = snap.docs.map(d => d.data()).filter(e => (e.review || "").trim());
  $("#list").innerHTML = rows.length ? rows.map(reviewCard).join("") : `<p class="muted">No reviews yet. Be the first!</p>`;
  $("#list").onclick = ev => {
    const b = ev.target.closest("[data-edit]"); if (!b) return;
    const e = rows[+b.dataset.edit];
    openLog({ type: e.type, tmdbId: e.tmdbId, key: e.key, title: e.title, year: e.year, poster: e.poster }, () => pageReviews(), { focusReview: true });
  };
}

/* ---------- search ---------- */
function pageSearch(q = "") {
  view.innerHTML = `<h1>Search</h1>
    <input id="q" placeholder="Search movies and TV shows…" value="${esc(q)}" autofocus>
    <div id="results" style="margin-top:16px"></div>`;
  const input = $("#q");
  let timer;
  const run = async () => {
    const term = input.value.trim();
    if (!term) { $("#results").innerHTML = ""; return; }
    try {
      const data = await tmdb("/search/multi", { query: term, include_adult: "false" });
      const rs = data.results.filter(r => r.media_type === "movie" || r.media_type === "tv");
      $("#results").innerHTML = rs.length ? `<div class="grid">${rs.map(r => mediaCard(metaOf(r, r.media_type))).join("")}</div>` : `<p class="muted">No results.</p>`;
    } catch (e) { $("#results").innerHTML = `<p style="color:var(--danger)">${esc(e.message)} — check your TMDB key in config.js</p>`; }
  };
  input.oninput = () => { clearTimeout(timer); timer = setTimeout(run, 300); };
  if (q) run();
}

/* ---------- title page ---------- */
async function pageTitle(type, id) {
  view.innerHTML = `<p class="muted">Loading…</p>`;
  let d;
  try { d = await tmdb(`/${type}/${id}`); } catch (e) { view.innerHTML = `<p style="color:var(--danger)">${esc(e.message)}</p>`; return; }
  const title = d.title || d.name, year = (d.release_date || d.first_air_date || "").slice(0, 4);
  const key = `${type}_${id}`;
  const meta = { type, tmdbId: +id, key, title, year, poster: d.poster_path || "", genres: (d.genres || []).map(g => g.id) };
  const sub = type === "tv"
    ? `${d.number_of_seasons || "?"} season${d.number_of_seasons === 1 ? "" : "s"} · ${d.status || ""}`
    : `${d.runtime ? d.runtime + " min" : ""}`;

  const snap = await getDocs(query(collection(db, "entries"), where("key", "==", key)));
  const all = snap.docs.map(x => x.data()).sort((a, b) => (b.updatedAt?.seconds || 0) - (a.updatedAt?.seconds || 0));
  const rated = all.filter(e => e.rating != null);
  const avg = rated.length ? (rated.reduce((s, e) => s + e.rating, 0) / rated.length).toFixed(1) : "–";
  const mine = myEntries[key];

  view.innerHTML = `<div class="detail">
    <div>${posterImg(d.poster_path, title)}</div>
    <div class="info">
      <h1 style="margin-bottom:2px">${esc(title)}</h1>
      <div class="muted">${esc(year)} · ${type === "tv" ? "TV series" : "Film"} · ${esc(sub)}</div>
      ${(d.genres || []).length ? `<div class="muted" style="margin-top:2px">${esc(d.genres.map(g => g.name).join(" · "))}</div>` : ""}
      ${d.tagline ? `<p class="muted"><i>${esc(d.tagline)}</i></p>` : ""}
      <p>${esc(d.overview || "")}</p>
      <div class="row" style="margin:14px 0">
        <div class="stat"><b>${avg}</b><span>Group avg</span></div>
        <div class="stat"><b>${all.filter(e => e.status === "watched").length}</b><span>Watched</span></div>
        <div class="stat"><b>${all.filter(e => e.status === "watchlist").length}</b><span>Want to</span></div>
      </div>
      <button id="log">${mine ? (mine.status === "watchlist" ? "On your watchlist — log it" : "Edit your entry") : "Log or add to watchlist"}</button>
      <button class="ghost" id="addlist">＋ Add to list</button>
    </div></div>
    <h2>Friends</h2>
    ${all.length ? all.map(feedItem).join("") : `<p class="muted">Nobody's logged this yet.</p>`}`;
  $("#log").onclick = () => openLog(meta, () => pageTitle(type, id));
  $("#addlist").onclick = () => openAddToList(meta);
}

/* ---------- log modal ---------- */
function starPicker(initial, onChange) {
  const el = document.createElement("div");
  el.className = "starpick";
  let val = initial;
  const paint = () => {
    el.innerHTML = [1, 2, 3, 4, 5].map(i => `<span class="s ${val >= i ? "full" : val >= i - 0.5 ? "half" : ""}" data-i="${i}">★</span>`).join("");
  };
  el.onclick = ev => {
    const s = ev.target.closest(".s"); if (!s) return;
    const i = +s.dataset.i, rect = s.getBoundingClientRect();
    const v = ev.clientX - rect.left < rect.width / 2 ? i - 0.5 : i;
    val = val === v ? null : v; paint(); onChange(val);
  };
  paint(); return el;
}

function openLog(meta, done, opts = {}) {
  const ex = myEntries[meta.key] || {};
  const st = { status: opts.focusReview ? "watched" : (ex.status || "watched"), rating: ex.rating ?? null };
  const today = new Date().toISOString().slice(0, 10);
  const hadDate = ex.status === "watched" ? !!ex.watchedOn : true; // new/watchlist entries default to today; previously undated stays undated
  const card = $("#modal-card");
  card.innerHTML = `
    <div class="modal-head">${posterImg(meta.poster, meta.title)}
      <div><b style="font-size:17px">${esc(meta.title)}</b><div class="muted">${esc(meta.year)}</div></div></div>
    <div class="seg" style="margin-top:10px">
      <button data-s="watched">Watched</button><button data-s="watchlist">Watchlist</button></div>
    <div id="watchedFields">
      <label>Rating <span class="muted" style="text-transform:none">(tap a star's left half for ½)</span></label>
      <div id="stars"></div>
      <label>Date watched</label>
      <div class="row">
        <input type="date" id="date" value="${esc(ex.watchedOn || today)}" style="flex:1;width:auto">
        <label class="chk"><input type="checkbox" id="nodate" ${hadDate ? "" : "checked"}> No date</label>
      </div>
      ${meta.type === "tv" ? `<label>Season / episodes <span class="muted" style="text-transform:none">(optional)</span></label>
        <input id="season" placeholder="e.g. Season 2, or Whole series" value="${esc(ex.season || "")}">` : ""}
      <label>Review</label><textarea id="review" placeholder="Write your review…">${esc(ex.review || "")}</textarea>
    </div>
    <div class="row" style="margin-top:16px;justify-content:space-between">
      <div>${myEntries[meta.key] ? `<button class="danger" id="del">Remove</button>` : ""}</div>
      <div class="row"><button class="ghost" id="cancel">Cancel</button><button id="save">Save</button></div>
    </div>`;
  const sp = starPicker(st.rating, v => (st.rating = v));
  $("#stars").appendChild(sp);
  const syncDate = () => ($("#date").disabled = $("#nodate").checked);
  $("#nodate").onchange = syncDate; syncDate();
  const sync = () => {
    card.querySelectorAll(".seg button").forEach(b => b.classList.toggle("on", b.dataset.s === st.status));
    $("#watchedFields").hidden = st.status === "watchlist";
  };
  card.querySelectorAll(".seg button").forEach(b => (b.onclick = () => { st.status = b.dataset.s; sync(); }));
  sync();
  const close = () => ($("#modal").hidden = true);
  $("#cancel").onclick = close;
  $("#modal").onclick = e => { if (e.target.id === "modal") close(); };
  if ($("#del")) $("#del").onclick = async () => {
    if (!confirm("Remove this from your log?")) return;
    await deleteDoc(doc(db, "entries", entryId(me.uid, meta.key)));
    delete myEntries[meta.key]; close(); toast("Removed"); done();
  };
  $("#save").onclick = async () => {
    const watched = st.status === "watched";
    const data = {
      ...meta, genres: meta.genres || ex.genres || [], uid: me.uid, status: st.status,
      rating: watched ? st.rating : null,
      review: watched ? $("#review").value.trim() : "",
      watchedOn: watched ? ($("#nodate").checked ? "" : $("#date").value || today) : "",
      season: watched && $("#season") ? $("#season").value.trim() : "",
      updatedAt: serverTimestamp()
    };
    try {
      await setDoc(doc(db, "entries", entryId(me.uid, meta.key)), data);
      myEntries[meta.key] = { ...data, updatedAt: { toDate: () => new Date() } };
      close(); toast("Saved"); done();
    } catch (e) { toast("Couldn't save: " + e.message); }
  };
  $("#modal").hidden = false;
  if (opts.focusReview && st.status === "watched") $("#review").focus();
}

/* ---------- genres ---------- */
const GENRES = {
  28: "Action", 12: "Adventure", 16: "Animation", 35: "Comedy", 80: "Crime", 99: "Documentary", 18: "Drama",
  10751: "Family", 14: "Fantasy", 36: "History", 27: "Horror", 10402: "Music", 9648: "Mystery", 10749: "Romance",
  878: "Sci-Fi", 10770: "TV Movie", 53: "Thriller", 10752: "War", 37: "Western",
  10759: "Action & Adventure", 10762: "Kids", 10763: "News", 10764: "Reality", 10765: "Sci-Fi & Fantasy",
  10766: "Soap", 10767: "Talk", 10768: "War & Politics"
};
const genreNames = e => { const n = (e.genres || []).map(i => GENRES[i]).filter(Boolean); return n.length ? n : ["Other"]; };
const genreOf = e => genreNames(e)[0];

let backfilling = false;
async function backfillGenres(entries) {
  if (backfilling) return false;
  backfilling = true;
  let changed = false;
  try {
    const todo = entries.filter(e => e.genres === undefined);
    let i = 0;
    await Promise.all(Array.from({ length: 4 }, async () => {
      while (i < todo.length) {
        const e = todo[i++];
        try {
          const d = await tmdb(`/${e.type}/${e.tmdbId}`);
          const genres = (d.genres || []).map(g => g.id);
          await updateDoc(doc(db, "entries", entryId(me.uid, e.key)), { genres });
          e.genres = genres; if (myEntries[e.key]) myEntries[e.key].genres = genres;
          changed = true;
        } catch { /* try again next visit */ }
      }
    }));
  } finally { backfilling = false; }
  return changed;
}

/* ---------- profile (sorting, genre filter) ---------- */
const DEFAULT_VIEW = { tab: "diary", filter: "all", sort: "recent", genre: "all" };
const profileView = { ...DEFAULT_VIEW };
const SORT_LABELS = {
  recent: "Recently logged", watched: "Watch date (newest)", watched_old: "Watch date (oldest)",
  rating_high: "Rating (high → low)", rating_low: "Rating (low → high)", title: "Title (A–Z)",
  year_new: "Release year (newest)", year_old: "Release year (oldest)", genre: "Genre (grouped)"
};
const WATCHLIST_SORTS = ["recent", "title", "year_new", "year_old", "genre"];
const byRecent = (a, b) => (b.updatedAt?.seconds || 0) - (a.updatedAt?.seconds || 0);
const byTitle = (a, b) => (a.title || "").localeCompare(b.title || "");
const SORT_FNS = {
  recent: byRecent,
  watched: (a, b) => (b.watchedOn || "").localeCompare(a.watchedOn || "") || byRecent(a, b),
  watched_old: (a, b) => (!a.watchedOn && !b.watchedOn) ? byRecent(a, b) : !a.watchedOn ? 1 : !b.watchedOn ? -1 : a.watchedOn.localeCompare(b.watchedOn),
  rating_high: (a, b) => (b.rating ?? -1) - (a.rating ?? -1) || byRecent(a, b),
  rating_low: (a, b) => (a.rating ?? 99) - (b.rating ?? 99) || byRecent(a, b),
  title: byTitle,
  year_new: (a, b) => (+b.year || 0) - (+a.year || 0) || byTitle(a, b),
  year_old: (a, b) => (+a.year || 9999) - (+b.year || 9999) || byTitle(a, b),
  genre: byTitle
};
const profCard = e => `<a class="card" href="#/title/${e.type}/${e.tmdbId}">
  ${posterImg(e.poster, e.title)}
  ${e.type === "tv" ? `<span class="badge">TV</span>` : ""}
  <div class="cap"><span class="stars">${starsText(e.rating)}</span> ${esc(e.title)}</div></a>`;

async function pageUser(uid, patch) {
  Object.assign(profileView, patch || DEFAULT_VIEW);
  const u = users[uid]; if (!u) { view.innerHTML = `<p class="muted">Unknown user.</p>`; return; }
  const snap = await getDocs(query(collection(db, "entries"), where("uid", "==", uid)));
  const all = snap.docs.map(d => d.data());
  const watched = all.filter(e => e.status === "watched");
  const rated = watched.filter(e => e.rating != null);
  const avg = rated.length ? (rated.reduce((s, e) => s + e.rating, 0) / rated.length).toFixed(2) : "–";
  const { tab, filter } = profileView;
  let { sort, genre } = profileView;
  if (tab === "watchlist" && !WATCHLIST_SORTS.includes(sort)) sort = profileView.sort = "recent";
  const missing = uid === me.uid ? all.filter(e => e.genres === undefined) : [];

  let controls = "", body = "";
  if (tab === "lists") {
    let ls = [];
    try {
      ls = (await getDocs(query(collection(db, "lists"), where("owner", "==", uid), where("shared", "==", false))))
        .docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (b.updatedAt?.seconds || 0) - (a.updatedAt?.seconds || 0));
    } catch { /* rules not published yet */ }
    body = ls.length ? `<div class="lgrid">${ls.map(listCard).join("")}</div>` : `<p class="muted">No lists yet.</p>`;
  } else {
    const base = (tab === "diary" ? watched : all.filter(e => e.status === "watchlist")).filter(e => filter === "all" || e.type === filter);
    const gc = new Map();
    base.forEach(e => genreNames(e).forEach(n => gc.set(n, (gc.get(n) || 0) + 1)));
    if (genre !== "all" && !gc.has(genre)) genre = profileView.genre = "all";
    const sortKeys = tab === "diary" ? Object.keys(SORT_LABELS) : WATCHLIST_SORTS;
    controls = `<div class="sortbar">
      <select id="sortSel">${sortKeys.map(k => `<option value="${k}" ${k === sort ? "selected" : ""}>Sort: ${SORT_LABELS[k]}</option>`).join("")}</select>
      <select id="genreSel"><option value="all">All genres</option>${[...gc.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([n, c]) => `<option value="${esc(n)}" ${n === genre ? "selected" : ""}>${esc(n)} (${c})</option>`).join("")}</select>
    </div>`;
    const list = base.filter(e => genre === "all" || genreNames(e).includes(genre)).sort(SORT_FNS[sort]);
    if (!list.length) body = `<p class="muted">Nothing here yet.</p>`;
    else if (sort === "genre") {
      const groups = new Map();
      list.forEach(e => { const g = genreOf(e); if (!groups.has(g)) groups.set(g, []); groups.get(g).push(e); });
      const keys = [...groups.keys()].sort((a, b) => a === "Other" ? 1 : b === "Other" ? -1 : a.localeCompare(b));
      body = keys.map(g => `<h2>${esc(g)} <span style="text-transform:none;letter-spacing:0">· ${groups.get(g).length}</span></h2><div class="grid">${groups.get(g).map(profCard).join("")}</div>`).join("");
    } else body = `<div class="grid">${list.map(profCard).join("")}</div>`;
  }

  view.innerHTML = `<div class="row" style="margin-bottom:14px">
      ${u.photo ? `<img class="avatar" style="width:56px;height:56px" src="${esc(u.photo)}" referrerpolicy="no-referrer" alt="">` : ""}
      <h1 style="margin:0;flex:1">${esc(u.name)}</h1>
      ${uid === me.uid ? `<a class="btnlink" href="#/import">Import from Letterboxd</a>` : ""}</div>
    <div class="row">
      <div class="stat"><b>${watched.filter(e => e.type === "movie").length}</b><span>Films</span></div>
      <div class="stat"><b>${watched.filter(e => e.type === "tv").length}</b><span>Shows</span></div>
      <div class="stat"><b>${avg}</b><span>Avg rating</span></div>
      <div class="stat"><b>${all.filter(e => e.status === "watchlist").length}</b><span>Watchlist</span></div>
    </div>
    <div class="tabs" style="margin-top:18px">
      ${[["diary", "Diary"], ["watchlist", "Watchlist"], ["lists", "Lists"]].map(([t, l]) => `<span class="tab ${tab === t ? "on" : ""}" data-t="${t}">${l}</span>`).join("")}
      <span style="flex:1"></span>
      ${tab === "lists" ? "" : ["all", "movie", "tv"].map(f => `<span class="tab ${f === filter ? "on" : ""}" data-f="${f}">${{ all: "All", movie: "Films", tv: "TV" }[f]}</span>`).join("")}
    </div>
    ${controls}
    <p id="gnote" class="muted" style="font-size:12px;margin:0 0 10px"></p>
    ${body}`;
  view.querySelectorAll("[data-t]").forEach(t => (t.onclick = () => pageUser(uid, { tab: t.dataset.t })));
  view.querySelectorAll("[data-f]").forEach(t => (t.onclick = () => pageUser(uid, { filter: t.dataset.f })));
  if ($("#sortSel")) $("#sortSel").onchange = e => pageUser(uid, { sort: e.target.value });
  if ($("#genreSel")) $("#genreSel").onchange = e => pageUser(uid, { genre: e.target.value });

  if (missing.length && tab !== "lists") {
    $("#gnote").textContent = "Fetching genre info for older entries…";
    backfillGenres(missing).then(ch => { if (ch && location.hash.startsWith("#/me")) pageUser(uid, {}); });
  }
}

/* ---------- lists (regular, numbered, shared watchlists) ---------- */
const listItemOf = m => ({
  key: m.key, type: m.type, tmdbId: m.tmdbId, title: m.title || "", year: m.year || "",
  poster: m.poster || "", genres: m.genres || [], label: "", addedBy: me.uid
});

async function fetchLists() {
  const [pub, mine] = await Promise.all([
    getDocs(query(collection(db, "lists"), where("shared", "==", false))),
    getDocs(query(collection(db, "lists"), where("members", "array-contains", me.uid)))
  ]);
  const map = new Map();
  [...pub.docs, ...mine.docs].forEach(d => map.set(d.id, { id: d.id, ...d.data() }));
  return [...map.values()].sort((a, b) => (b.updatedAt?.seconds || 0) - (a.updatedAt?.seconds || 0));
}

function listCard(l) {
  const items = l.items || [];
  const collage = items.slice(0, 4).map(i => posterImg(i.poster, i.title)).join("") || `<div class="poster" style="height:96px"></div>`;
  return `<a class="lcard" href="#/list/${l.id}">
    <div class="collage">${collage}</div>
    <b>${esc(l.title)}</b>
    <div class="muted" style="font-size:13px">${items.length} title${items.length === 1 ? "" : "s"} · by ${esc(userName(l.owner))}</div>
    ${l.ranked ? `<span class="tag">Numbered</span>` : ""}${l.shared ? `<span class="tag">Shared · ${(l.members || []).length} people</span>` : ""}
  </a>`;
}

async function pageLists(tab = "all") {
  if (!["all", "mine", "shared"].includes(tab)) tab = "all";
  view.innerHTML = `<div class="row" style="justify-content:space-between"><h1 style="margin:0">Lists</h1><button id="newlist">＋ New list</button></div>
    <div class="tabs" style="margin-top:14px">${[["all", "Everyone's lists"], ["mine", "My lists"], ["shared", "Shared watchlists"]].map(([k, l]) => `<span class="tab ${k === tab ? "on" : ""}" data-tab="${k}">${l}</span>`).join("")}</div>
    <div id="lgrid"><p class="muted">Loading…</p></div>`;
  $("#newlist").onclick = () => openListForm(null);
  view.querySelectorAll("[data-tab]").forEach(t => (t.onclick = () => (location.hash = "#/lists/" + t.dataset.tab)));
  let ls;
  try { ls = await fetchLists(); }
  catch (e) { $("#lgrid").innerHTML = `<p style="color:var(--danger)">${esc(e.message)}<br>Did you publish the new Firestore rules?</p>`; return; }
  const shown = ls.filter(l => tab === "mine" ? l.owner === me.uid : tab === "shared" ? l.shared && l.members.includes(me.uid) : !l.shared);
  const empty = { all: "No lists yet. Make the first one!", mine: "You haven't made any lists yet.", shared: "No shared watchlists yet. Make one and pick a friend to watch through it with." }[tab];
  $("#lgrid").innerHTML = shown.length ? `<div class="lgrid">${shown.map(listCard).join("")}</div>` : `<p class="muted">${empty}</p>`;
}

function openListForm(list) {
  const isNew = !list;
  const l = list || { title: "", description: "", ranked: false, shared: false, members: [me.uid] };
  const others = Object.entries(users).filter(([uid]) => uid !== me.uid);
  const memberBox = `<div id="lm" ${(isNew || !l.shared) ? "hidden" : ""}>
    <label>Who's in it</label>
    ${others.map(([uid, u]) => `<label class="chk" style="margin:8px 0"><input type="checkbox" class="mem" value="${uid}" ${l.members.includes(uid) ? "checked" : ""}> ${avatar(uid)} ${esc(u.name)}</label>`).join("") || `<p class="muted">No friends have signed in yet.</p>`}
  </div>`;
  modalOpen(`<h2 style="margin-top:0;border:0">${isNew ? "New list" : "List settings"}</h2>
    <label>Title</label><input id="lt" maxlength="100" value="${esc(l.title)}" placeholder="e.g. Best horror of the 80s">
    <label>Description <span class="muted" style="text-transform:none">(optional)</span></label><textarea id="ld" maxlength="500">${esc(l.description || "")}</textarea>
    <label class="chk" style="margin-top:12px"><input type="checkbox" id="lr" ${l.ranked ? "checked" : ""}> Numbered list (1, 2, 3…)</label>
    ${isNew ? `<label class="chk" style="margin-top:8px"><input type="checkbox" id="ls"> Shared watchlist — check things off together</label>` : ""}
    ${memberBox}
    <div class="row" style="margin-top:18px;justify-content:space-between">
      <div>${!isNew ? `<button class="danger" id="ldel">Delete list</button>` : ""}</div>
      <div class="row"><button class="ghost" id="lcancel">Cancel</button><button id="lsave">${isNew ? "Create" : "Save"}</button></div>
    </div>`);
  if (isNew) $("#ls").onchange = () => ($("#lm").hidden = !$("#ls").checked);
  $("#lcancel").onclick = modalClose;
  if ($("#ldel")) $("#ldel").onclick = async () => {
    if (!confirm("Delete this list for good?")) return;
    await deleteDoc(doc(db, "lists", l.id)); modalClose(); toast("List deleted"); location.hash = "#/lists";
  };
  $("#lsave").onclick = async () => {
    const title = $("#lt").value.trim();
    if (!title) { toast("Give it a title"); return; }
    const shared = isNew ? $("#ls").checked : l.shared;
    const picked = [...document.querySelectorAll(".mem:checked")].map(c => c.value);
    if (shared && !picked.length) { toast("Pick at least one friend to share with"); return; }
    const members = shared ? [me.uid, ...picked] : [me.uid];
    try {
      if (isNew) {
        const ref = doc(collection(db, "lists"));
        await setDoc(ref, {
          owner: me.uid, title, description: $("#ld").value.trim(), ranked: $("#lr").checked, shared, members,
          items: [], watched: {}, createdAt: serverTimestamp(), updatedAt: serverTimestamp()
        });
        modalClose(); editing = true; listView = null; location.hash = "#/list/" + ref.id;
      } else {
        await updateDoc(doc(db, "lists", l.id), { title, description: $("#ld").value.trim(), ranked: $("#lr").checked, members, updatedAt: serverTimestamp() });
        modalClose(); toast("Saved"); await reloadList();
      }
    } catch (e) { toast("Couldn't save: " + e.message + " (did you publish the new Firestore rules?)"); }
  };
}

let curList = null, editing = false, listView = null;

async function reloadList() {
  const s = await getDoc(doc(db, "lists", curList.id));
  renderList({ id: curList.id, ...s.data() });
}
async function mutateList(id, fn) {
  const ref = doc(db, "lists", id);
  const data = (await getDoc(ref)).data();
  const items = fn([...(data.items || [])]);
  await updateDoc(ref, { items, updatedAt: serverTimestamp() });
  return { id, ...data, items };
}

async function writeDiaryFromList(it, on) {
  const ex = myEntries[it.key];
  if (ex && ex.status === "watched") return false;
  const data = {
    type: it.type, tmdbId: it.tmdbId, key: it.key, title: it.title, year: it.year || "", poster: it.poster || "",
    genres: it.genres || ex?.genres || [], uid: me.uid, status: "watched",
    rating: ex?.rating ?? null, review: ex?.review || "", watchedOn: on || "", season: ex?.season || "",
    updatedAt: serverTimestamp()
  };
  await setDoc(doc(db, "entries", entryId(me.uid, it.key)), data);
  myEntries[it.key] = { ...data, updatedAt: { toDate: () => new Date() } };
  return true;
}
// make sure everything a shared list has checked off is in MY diary too
async function syncSharedList(l) {
  let n = 0;
  for (const [key, w] of Object.entries(l.watched || {})) {
    const it = (l.items || []).find(i => i.key === key);
    if (it && (await writeDiaryFromList(it, w.on))) n++;
  }
  return n;
}
async function syncShared() {
  const snap = await getDocs(query(collection(db, "lists"), where("members", "array-contains", me.uid)));
  let n = 0;
  for (const d of snap.docs) { const l = { id: d.id, ...d.data() }; if (l.shared) n += await syncSharedList(l); }
  if (n) toast(`Added ${n} shared title${n === 1 ? "" : "s"} to your diary`);
}

function openWatched(l, it) {
  const today = new Date().toISOString().slice(0, 10);
  modalOpen(`<div class="modal-head">${posterImg(it.poster, it.title)}
      <div><b style="font-size:17px">${esc(it.title)}</b><div class="muted">${esc(it.year)}</div></div></div>
    <p>Mark as watched together? It goes into everyone's diary on this list.</p>
    <label>Date watched</label>
    <div class="row"><input type="date" id="wd" value="${today}" style="flex:1;width:auto">
      <label class="chk"><input type="checkbox" id="wn"> No date</label></div>
    <div class="row" style="margin-top:16px;justify-content:flex-end"><button class="ghost" id="wc">Cancel</button><button id="ws">Mark watched</button></div>`);
  $("#wn").onchange = () => ($("#wd").disabled = $("#wn").checked);
  $("#wc").onclick = modalClose;
  $("#ws").onclick = async () => {
    const on = $("#wn").checked ? "" : $("#wd").value || today;
    try {
      await updateDoc(doc(db, "lists", l.id), { [`watched.${it.key}`]: { on, by: me.uid }, updatedAt: serverTimestamp() });
      await writeDiaryFromList(it, on);
      modalClose(); toast("Watched together ✓"); await reloadList();
    } catch (e) { toast("Couldn't save: " + e.message); }
  };
}

async function pageList(id) {
  view.innerHTML = `<p class="muted">Loading…</p>`;
  editing = editing && location.hash.includes(id); // a freshly created list opens in edit mode
  let l;
  try {
    const s = await getDoc(doc(db, "lists", id));
    if (!s.exists()) throw new Error("missing");
    l = { id, ...s.data() };
  } catch { view.innerHTML = `<p class="muted">That list doesn't exist, or it's private.</p>`; return; }
  listView = null;
  if (l.shared) { try { const n = await syncSharedList(l); if (n) toast(`Added ${n} shared title${n === 1 ? "" : "s"} to your diary`); } catch { /* ignore */ } }
  renderList(l);
}

function renderList(l) {
  curList = l;
  const isOwner = l.owner === me.uid;
  const canEdit = isOwner || (l.shared && l.members.includes(me.uid));
  if (!canEdit) editing = false;
  const asRows = editing || (listView ? listView === "rows" : !!l.ranked);
  view.innerHTML = `<div class="row" style="justify-content:space-between;align-items:flex-start">
      <div style="flex:1;min-width:220px">
        <h1 style="margin-bottom:4px">${esc(l.title)}</h1>
        <div class="muted">by <a href="#/user/${l.owner}"><b>${esc(userName(l.owner))}</b></a> · <span id="lcount"></span>${l.ranked ? " · numbered" : ""}</div>
        ${l.shared ? `<div class="muted" style="margin-top:4px">Shared with ${l.members.filter(m => m !== l.owner).map(m => esc(userName(m))).join(", ")}</div>` : ""}
        ${l.description ? `<p style="white-space:pre-wrap">${esc(l.description)}</p>` : ""}
      </div>
      <div class="row">
        ${canEdit ? `<button class="small ${editing ? "" : "ghost"}" id="ledit">${editing ? "Done" : "Edit"}</button>` : ""}
        ${isOwner ? `<button class="ghost small" id="lset">Settings</button>` : ""}
        ${editing ? "" : `<button class="ghost small" id="lview">${asRows ? "Grid view" : "List view"}</button>`}
      </div>
    </div>
    ${editing ? `<div id="ladd" class="picker"></div>` : ""}
    <div id="litems" style="margin-top:14px"></div>`;
  if ($("#ledit")) $("#ledit").onclick = () => { editing = !editing; renderList(curList); };
  if ($("#lset")) $("#lset").onclick = () => openListForm(curList);
  if ($("#lview")) $("#lview").onclick = () => { listView = asRows ? "grid" : "rows"; renderList(curList); };
  if (editing) {
    titlePicker($("#ladd"), async m => {
      if (curList.items.some(i => i.key === m.key)) { toast("Already in this list"); return; }
      try { curList = await mutateList(curList.id, items => [...items, listItemOf(m)]); renderItems(); toast("Added"); }
      catch (e) { toast("Couldn't add: " + e.message); }
    });
  }
  $("#litems").onclick = async ev => {
    const cur = curList;
    const chk = ev.target.closest("[data-chk]");
    if (chk) {
      const it = cur.items.find(i => i.key === chk.dataset.chk); if (!it) return;
      if (cur.watched?.[it.key]) {
        if (!confirm("Uncheck this? It stays in everyone's diaries.")) return;
        await updateDoc(doc(db, "lists", cur.id), { [`watched.${it.key}`]: deleteField() });
        await reloadList();
      } else openWatched(cur, it);
      return;
    }
    const up = ev.target.closest("[data-up]"), down = ev.target.closest("[data-down]"), rm = ev.target.closest("[data-rm]");
    const btn = up || down || rm; const k = btn && (btn.dataset.up || btn.dataset.down || btn.dataset.rm);
    if (!k) return;
    try {
      curList = await mutateList(cur.id, items => {
        const i = items.findIndex(x => x.key === k); if (i < 0) return items;
        if (rm) items.splice(i, 1);
        else if (up && i > 0) [items[i - 1], items[i]] = [items[i], items[i - 1]];
        else if (down && i < items.length - 1) [items[i + 1], items[i]] = [items[i], items[i + 1]];
        return items;
      });
      renderItems();
    } catch (e) { toast("Couldn't update: " + e.message); }
  };
  $("#litems").onchange = async ev => {
    const inp = ev.target.closest(".lbl"); if (!inp) return;
    try {
      curList = await mutateList(curList.id, items => { const x = items.find(z => z.key === inp.dataset.k); if (x) x.label = inp.value.trim(); return items; });
      toast("Saved");
    } catch (e) { toast("Couldn't save: " + e.message); }
  };
  renderItems();
}

function renderItems() {
  const l = curList, items = l.items || [], watched = l.watched || {};
  const asRows = editing || (listView ? listView === "rows" : !!l.ranked);
  const doneN = items.filter(i => watched[i.key]).length;
  $("#lcount").textContent = `${items.length} title${items.length === 1 ? "" : "s"}` + (l.shared ? ` · ${doneN} watched together` : "");
  if (!items.length) { $("#litems").innerHTML = `<p class="muted">${editing ? "Search above to add titles." : "Nothing in this list yet."}</p>`; return; }
  const chkBtn = (it, w) => l.shared ? `<button class="small ${w ? "" : "ghost"}" data-chk="${esc(it.key)}">${w ? "✓ Watched" : "Mark watched"}</button>` : "";
  if (asRows) {
    $("#litems").innerHTML = items.map((it, i) => {
      const w = watched[it.key];
      return `<div class="lrow ${w ? "done" : ""}">
        ${l.ranked ? `<div class="rank">${i + 1}</div>` : ""}
        <div class="pw"><a href="#/title/${it.type}/${it.tmdbId}">${posterImg(it.poster, it.title)}</a>${w ? `<span class="tick">✓</span>` : ""}</div>
        <div class="linfo">
          <div class="title"><a href="#/title/${it.type}/${it.tmdbId}">${esc(it.title)}</a> <span class="muted" style="font-weight:400">${esc(it.year)}</span></div>
          ${editing ? `<input class="lbl" data-k="${esc(it.key)}" maxlength="120" placeholder="Add a label or note…" value="${esc(it.label || "")}">`
                    : (it.label ? `<div class="lbl-text">${esc(it.label)}</div>` : "")}
          ${w ? `<div class="muted" style="font-size:12px">Watched together${w.on ? " on " + fmtDate(w.on) : ""}</div>` : ""}
          ${editing ? "" : chkBtn(it, w)}
        </div>
        ${editing ? `<div class="ctrl"><button class="ghost small" data-up="${esc(it.key)}">↑</button><button class="ghost small" data-down="${esc(it.key)}">↓</button><button class="danger small" data-rm="${esc(it.key)}">✕</button></div>` : ""}
      </div>`;
    }).join("");
  } else {
    $("#litems").innerHTML = `<div class="grid">${items.map((it, i) => {
      const w = watched[it.key];
      return `<div class="lcell ${w ? "done" : ""}">
        <div class="pw"><a href="#/title/${it.type}/${it.tmdbId}">${posterImg(it.poster, it.title)}</a>
          ${l.ranked ? `<span class="badge">${i + 1}</span>` : ""}${w ? `<span class="tick">✓</span>` : ""}</div>
        <div class="cap" style="font-size:12px;color:var(--muted)">${esc(it.title)}</div>
        ${it.label ? `<div class="lbl-text">${esc(it.label)}</div>` : ""}
        ${chkBtn(it, w)}</div>`;
    }).join("")}</div>`;
  }
}

async function openAddToList(meta) {
  modalOpen(`<h2 style="margin-top:0;border:0">Add to a list</h2><div id="atl"><p class="muted">Loading…</p></div>
    <div class="row" style="margin-top:14px;justify-content:space-between"><button class="ghost small" id="atn">＋ New list</button><button class="ghost" id="atc">Close</button></div>`);
  $("#atc").onclick = modalClose;
  $("#atn").onclick = () => openListForm(null);
  try {
    const mine = (await fetchLists()).filter(l => l.owner === me.uid || (l.shared && l.members.includes(me.uid)));
    $("#atl").innerHTML = mine.length ? mine.map(l => `<div class="pick" data-id="${l.id}"><div><b>${esc(l.title)}</b>
        <span class="muted">${l.shared ? "shared · " : ""}${(l.items || []).length} titles</span> ${(l.items || []).some(i => i.key === meta.key) ? "✓ already in" : ""}</div></div>`).join("")
      : `<p class="muted">You don't have any lists yet.</p>`;
    $("#atl").onclick = async ev => {
      const p = ev.target.closest(".pick"); if (!p) return;
      try {
        await mutateList(p.dataset.id, items => items.some(i => i.key === meta.key) ? items : [...items, listItemOf(meta)]);
        modalClose(); toast("Added to list");
      } catch (e) { toast("Couldn't add: " + e.message); }
    };
  } catch (e) { $("#atl").innerHTML = `<p style="color:var(--danger)">${esc(e.message)}</p>`; }
}

/* ---------- friends ---------- */
async function pagePeople() {
  await loadUsers();
  view.innerHTML = `<h1>Friends</h1>` + Object.entries(users).map(([uid, u]) =>
    `<a class="person" href="#/${uid === me.uid ? "me" : "user/" + uid}">${avatar(uid)}<b>${esc(u.name)}</b>${uid === me.uid ? ` <span class="muted">(you)</span>` : ""}</a>`).join("");
}

/* ---------- Letterboxd import ---------- */
function parseCSV(text) {
  text = text.replace(/^﻿/, "");
  const rows = []; let row = [], f = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; }
      else f += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(f); f = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(f); f = ""; rows.push(row); row = [];
    } else f += c;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  const head = (rows.shift() || []).map(h => h.trim());
  return rows.filter(r => r.length > 1 || r[0]).map(r => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ""])));
}
function loadScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement("script"); s.src = src; s.onload = res;
    s.onerror = () => rej(new Error("Couldn't load the zip reader. Check your connection, or upload the CSV files directly."));
    document.head.appendChild(s);
  });
}
const LB_FILES = ["watched.csv", "ratings.csv", "diary.csv", "reviews.csv", "watchlist.csv"];
const LB_SKIP_DIRS = ["deleted", "likes", "lists", "comments", "orphaned"];
function lbName(path) {
  const parts = path.toLowerCase().split("/"); const base = parts.pop();
  if (parts.some(p => LB_SKIP_DIRS.includes(p))) return null;
  return LB_FILES.includes(base) ? base : null;
}
async function readLetterboxdFiles(fileList) {
  const out = {};
  for (const file of fileList) {
    const rel = file.webkitRelativePath || file.name;
    if (rel.toLowerCase().endsWith(".zip")) {
      if (!window.JSZip) await loadScript("https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js");
      const zip = await window.JSZip.loadAsync(file);
      for (const [path, entry] of Object.entries(zip.files)) {
        if (entry.dir) continue;
        const n = lbName(path);
        if (n) out[n] = await entry.async("string");
      }
    } else {
      const n = lbName(rel);
      if (n) out[n] = await file.text();
    }
  }
  return out;
}
async function matchFilm(f) {
  const q = { query: f.name, include_adult: "false" };
  let d = await tmdb("/search/movie", f.year ? { ...q, year: f.year } : q);
  let r = d.results[0];
  if (!r && f.year) {
    d = await tmdb("/search/movie", q);
    r = d.results.find(x => Math.abs(+((x.release_date || "").slice(0, 4)) - +f.year) <= 1);
  }
  return r || null;
}
async function commitChunk(chunk) {
  try {
    const batch = writeBatch(db);
    chunk.forEach(d => batch.set(doc(db, "entries", entryId(me.uid, d.key)), d));
    await batch.commit();
  } catch (e) { // if a batch is rejected, write the docs individually
    let i = 0, firstErr = null;
    await Promise.all(Array.from({ length: 8 }, async () => {
      while (i < chunk.length) {
        const d = chunk[i++];
        try { await setDoc(doc(db, "entries", entryId(me.uid, d.key)), d); } catch (err) { firstErr ||= err; }
      }
    }));
    if (firstErr) throw firstErr;
  }
}

function pageImport() {
  view.innerHTML = `<h1>Import from Letterboxd</h1>
    <ol class="muted" style="line-height:1.7">
      <li>On letterboxd.com go to <b>Settings → Data → Export your data</b> and download the zip.</li>
      <li>Pick the zip below. If your computer already unzipped it into a folder, pick that folder instead.</li>
    </ol>
    <label>Zip file (or the CSVs from inside it)</label>
    <input type="file" id="files" accept=".zip,.csv" multiple>
    <label>Or the unzipped folder</label>
    <input type="file" id="folder" webkitdirectory>
    <p class="muted" id="picked" style="margin:8px 0 0"></p>
    <label class="chk" style="margin-top:14px"><input type="checkbox" id="skip" checked> Skip films I've already logged here</label>
    <label class="chk" style="margin-top:6px"><input type="checkbox" id="usedates" checked> Keep watched dates from my diary (uncheck to import without any dates)</label>
    <button id="go" style="margin-top:16px" disabled>Import</button>
    <div id="prog" style="margin-top:18px"></div>
    <p class="muted" style="margin-top:24px;font-size:13px">Letterboxd only exports films, so no TV comes over. Films are matched to TMDB by title and year; anything that can't be matched is listed so you can add it by hand.</p>`;
  const files = $("#files"), folder = $("#folder"), go = $("#go"), prog = $("#prog");
  let chosen = [];
  const pick = el => {
    chosen = [...el.files];
    $("#picked").textContent = chosen.length ? `${chosen.length} file${chosen.length === 1 ? "" : "s"} selected` : "";
    go.disabled = !chosen.length;
  };
  files.onchange = () => pick(files);
  folder.onchange = () => pick(folder);
  go.onclick = async () => {
    const lock = on => { go.disabled = on; files.disabled = on; folder.disabled = on; };
    const fail = msg => { prog.innerHTML = `<p style="color:var(--danger)">${esc(msg)}</p>`; lock(false); };
    lock(true);
    const skip = $("#skip").checked, useDates = $("#usedates").checked;
    try {
      prog.innerHTML = `<p class="muted">Reading files…</p>`;
      const texts = await readLetterboxdFiles(chosen);
      const found = LB_FILES.filter(n => texts[n]);
      if (!found.length) return fail(`Couldn't find watched.csv, ratings.csv, diary.csv, reviews.csv or watchlist.csv in the ${chosen.length} file(s) you picked.`);
      const P = n => (texts[n] ? parseCSV(texts[n]) : []);
      const counts = found.map(n => `${n.replace(".csv", "")} ${P(n).length}`).join(", ");
      const films = new Map();
      const get = r => {
        const name = (r["Name"] || "").trim(), year = (r["Year"] || "").trim(); if (!name) return null;
        const k = name.toLowerCase() + "|" + year;
        if (!films.has(k)) films.set(k, { name, year, status: null, rating: null, review: "", watchedOn: "", logged: "" });
        return films.get(k);
      };
      for (const r of P("watched.csv"))  { const f = get(r); if (f) { f.status = "watched"; f.logged ||= r["Date"]; } }
      for (const r of P("ratings.csv"))  { const f = get(r); if (f) { f.status = "watched"; if (r["Rating"]) f.rating = +r["Rating"]; f.logged ||= r["Date"]; } }
      for (const r of P("diary.csv"))    { const f = get(r); if (f) { f.status = "watched"; if (r["Rating"]) f.rating = +r["Rating"]; const w = r["Watched Date"]; if (w && w > f.watchedOn) f.watchedOn = w; f.logged ||= r["Date"]; } }
      for (const r of P("reviews.csv"))  { const f = get(r); if (f) { f.status = "watched"; if (r["Rating"]) f.rating = +r["Rating"]; if (r["Review"]) f.review = r["Review"].trim(); const w = r["Watched Date"]; if (w && w > f.watchedOn) f.watchedOn = w; f.logged ||= r["Date"]; } }
      for (const r of P("watchlist.csv")) { const f = get(r); if (f && !f.status) { f.status = "watchlist"; f.logged ||= r["Date"]; } }
      const list = [...films.values()].filter(f => f.status);
      if (!list.length) return fail(`Read ${counts} rows, but found no films. Columns seen: ${Object.keys(P(found[0])[0] || {}).join(", ") || "none"}.`);

      // match to TMDB (a few at a time)
      const matched = [], unmatched = [];
      let n = 0, errs = 0, firstErr = "";
      const bar = () => (prog.innerHTML = `<p class="muted">Read ${esc(counts)}. Matching films… ${n} / ${list.length}</p><progress max="${list.length}" value="${n}"></progress>`);
      bar();
      let idx = 0;
      await Promise.all(Array.from({ length: 4 }, async () => {
        while (idx < list.length) {
          const f = list[idx++];
          try { const r = await matchFilm(f); r ? matched.push({ f, r }) : unmatched.push(f); }
          catch (e) { errs++; firstErr ||= e.message; unmatched.push(f); }
          n++; if (n % 5 === 0 || n === list.length) bar();
        }
      }));
      if (!matched.length) return fail(errs ? `Couldn't reach TMDB (${firstErr}). Check the TMDB key in config.js and try again.` : "None of the films could be matched to TMDB.");

      // build entries
      const seenKeys = new Set(), docs = []; let skipped = 0;
      for (const { f, r } of matched) {
        const m = metaOf(r, "movie");
        if (seenKeys.has(m.key)) continue; seenKeys.add(m.key);
        if (skip && myEntries[m.key]) { skipped++; continue; }
        const watched = f.status === "watched";
        let when = new Date((f.watchedOn || f.logged || "2000-01-01") + "T12:00:00"); if (isNaN(when)) when = new Date("2000-01-01T12:00:00");
        docs.push({
          ...m, uid: me.uid, status: f.status,
          rating: watched ? f.rating : null, review: watched ? f.review : "",
          watchedOn: watched && useDates ? f.watchedOn : "", season: "",
          updatedAt: Timestamp.fromDate(when)   // dated to when you watched/logged it, so imports don't flood the feed
        });
      }
      const CH = 20;
      for (let i = 0; i < docs.length; i += CH) {
        await commitChunk(docs.slice(i, i + CH));
        const saved = Math.min(i + CH, docs.length);
        prog.innerHTML = `<p class="muted">Saving… ${saved} / ${docs.length}</p><progress max="${docs.length}" value="${saved}"></progress>`;
      }
      docs.forEach(d => (myEntries[d.key] = d));
      prog.innerHTML = `<h2 style="margin-top:0">Done</h2>
        <p>Read ${esc(counts)}. Imported <b>${docs.length}</b> titles${skipped ? `, skipped ${skipped} you'd already logged` : ""}${unmatched.length ? `, couldn't match ${unmatched.length}` : ""}.</p>
        ${errs ? `<p style="color:var(--danger)">${errs} lookups failed (${esc(firstErr)}). Run the import again to retry those; films you've already imported will be skipped.</p>` : ""}
        ${unmatched.length ? `<details><summary class="muted">Couldn't match these</summary><ul class="muted">${unmatched.map(f => `<li>${esc(f.name)}${f.year ? ` (${esc(f.year)})` : ""}</li>`).join("")}</ul></details>` : ""}
        <a class="btnlink solid" href="#/me" style="margin-top:12px">Go to my diary</a>`;
    } catch (e) {
      fail(`${e.code ? e.code + ": " : ""}${e.message}`);
    }
  };
}

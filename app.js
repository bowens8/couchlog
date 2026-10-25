import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, onAuthStateChanged, signOut }
  from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { getFirestore, collection, doc, getDoc, getDocs, setDoc, deleteDoc, query, where,
  orderBy, limit, serverTimestamp, writeBatch, Timestamp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
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
  year: (r.release_date || r.first_air_date || "").slice(0, 4), poster: r.poster_path || ""
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
      ...m, uid: me.uid, status: act,
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
  if (page === "search") return pageSearch(decodeURIComponent(a || ""));
  if (page === "title") return pageTitle(a, b);
  if (page === "me") return pageUser(me.uid);
  if (page === "user") return pageUser(a);
  if (page === "people") return pagePeople();
  if (page === "import") return pageImport();
  location.hash = "#/feed";
}

/* ---------- feed ---------- */
async function pageFeed(filter = "all") {
  view.innerHTML = `<h1>Friends' activity</h1>
    <div class="tabs">${["all", "movie", "tv"].map(f => `<span class="tab ${f === filter ? "on" : ""}" data-f="${f}">${{ all: "All", movie: "Movies", tv: "TV" }[f]}</span>`).join("")}</div>
    <div id="list"><p class="muted">Loading…</p></div>`;
  view.querySelectorAll(".tab").forEach(t => (t.onclick = () => pageFeed(t.dataset.f)));
  const snap = await getDocs(query(collection(db, "entries"), orderBy("updatedAt", "desc"), limit(120)));
  let items = snap.docs.map(d => d.data()).filter(e => filter === "all" || e.type === filter);
  $("#list").innerHTML = items.length ? items.map(feedItem).join("") :
    `<p class="muted">Nothing here yet. <a href="#/browse" style="color:var(--accent2)">Browse something to log.</a></p>`;
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
          friends = [...byKey.values()].map(e => ({ type: e.type, tmdbId: e.tmdbId, key: e.key, title: e.title, year: e.year, poster: e.poster }));
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
  const meta = { type, tmdbId: +id, key, title, year, poster: d.poster_path || "" };
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
      ${d.tagline ? `<p class="muted"><i>${esc(d.tagline)}</i></p>` : ""}
      <p>${esc(d.overview || "")}</p>
      <div class="row" style="margin:14px 0">
        <div class="stat"><b>${avg}</b><span>Group avg</span></div>
        <div class="stat"><b>${all.filter(e => e.status === "watched").length}</b><span>Watched</span></div>
        <div class="stat"><b>${all.filter(e => e.status === "watchlist").length}</b><span>Want to</span></div>
      </div>
      <button id="log">${mine ? (mine.status === "watchlist" ? "On your watchlist — log it" : "Edit your entry") : "Log or add to watchlist"}</button>
    </div></div>
    <h2>Friends</h2>
    ${all.length ? all.map(feedItem).join("") : `<p class="muted">Nobody's logged this yet.</p>`}`;
  $("#log").onclick = () => openLog(meta, () => pageTitle(type, id));
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
      ...meta, uid: me.uid, status: st.status,
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

/* ---------- profile ---------- */
async function pageUser(uid, tab = "diary", filter = "all") {
  const u = users[uid]; if (!u) { view.innerHTML = `<p class="muted">Unknown user.</p>`; return; }
  const snap = await getDocs(query(collection(db, "entries"), where("uid", "==", uid)));
  const all = snap.docs.map(d => d.data());
  const watched = all.filter(e => e.status === "watched");
  const rated = watched.filter(e => e.rating != null);
  const avg = rated.length ? (rated.reduce((s, e) => s + e.rating, 0) / rated.length).toFixed(2) : "–";
  const list = (tab === "diary" ? watched : all.filter(e => e.status === "watchlist"))
    .filter(e => filter === "all" || e.type === filter)
    .sort((a, b) => tab === "diary"
      ? (b.watchedOn || "").localeCompare(a.watchedOn || "") || (b.updatedAt?.seconds || 0) - (a.updatedAt?.seconds || 0)
      : (b.updatedAt?.seconds || 0) - (a.updatedAt?.seconds || 0));

  view.innerHTML = `<div class="row" style="margin-bottom:14px">
      ${u.photo ? `<img class="avatar" style="width:56px;height:56px" src="${esc(u.photo)}" referrerpolicy="no-referrer" alt="">` : ""}
      <h1 style="margin:0;flex:1">${esc(u.name)}</h1>
      ${uid === me.uid ? `<a href="#/import"><button class="ghost">Import from Letterboxd</button></a>` : ""}</div>
    <div class="row">
      <div class="stat"><b>${watched.filter(e => e.type === "movie").length}</b><span>Films</span></div>
      <div class="stat"><b>${watched.filter(e => e.type === "tv").length}</b><span>Shows</span></div>
      <div class="stat"><b>${avg}</b><span>Avg rating</span></div>
      <div class="stat"><b>${all.filter(e => e.status === "watchlist").length}</b><span>Watchlist</span></div>
    </div>
    <div class="tabs" style="margin-top:18px">
      <span class="tab ${tab === "diary" ? "on" : ""}" data-t="diary">Diary</span>
      <span class="tab ${tab === "watchlist" ? "on" : ""}" data-t="watchlist">Watchlist</span>
      <span style="flex:1"></span>
      ${["all", "movie", "tv"].map(f => `<span class="tab ${f === filter ? "on" : ""}" data-f="${f}">${{ all: "All", movie: "Films", tv: "TV" }[f]}</span>`).join("")}
    </div>
    ${list.length ? `<div class="grid">${list.map(e => `<a class="card" href="#/title/${e.type}/${e.tmdbId}">
        ${posterImg(e.poster, e.title)}
        ${e.type === "tv" ? `<span class="badge">TV</span>` : ""}
        <div class="cap"><span class="stars">${starsText(e.rating)}</span> ${esc(e.title)}</div></a>`).join("")}</div>`
      : `<p class="muted">Nothing here yet.</p>`}`;
  view.querySelectorAll("[data-t]").forEach(t => (t.onclick = () => pageUser(uid, t.dataset.t, filter)));
  view.querySelectorAll("[data-f]").forEach(t => (t.onclick = () => pageUser(uid, tab, t.dataset.f)));
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
async function readLetterboxdFiles(fileList) {
  const out = {};
  for (const file of fileList) {
    const name = file.name.toLowerCase();
    if (name.endsWith(".zip")) {
      if (!window.JSZip) await loadScript("https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js");
      const zip = await window.JSZip.loadAsync(file);
      for (const [path, entry] of Object.entries(zip.files)) {
        if (entry.dir) continue;
        const parts = path.toLowerCase().split("/"); const base = parts.pop();
        if (parts.some(p => ["deleted", "likes", "lists", "comments", "orphaned"].includes(p))) continue;
        if (LB_FILES.includes(base)) out[base] = await entry.async("string");
      }
    } else if (LB_FILES.includes(name)) out[name] = await file.text();
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
  } catch (e) { // fall back to one-by-one if a batch is rejected
    for (const d of chunk) await setDoc(doc(db, "entries", entryId(me.uid, d.key)), d);
  }
}

function pageImport() {
  view.innerHTML = `<h1>Import from Letterboxd</h1>
    <ol class="muted" style="line-height:1.7">
      <li>On letterboxd.com go to <b>Settings → Data → Export your data</b> and download the zip.</li>
      <li>Choose the zip below. (Or pick the CSVs inside it: watched, ratings, diary, reviews, watchlist.)</li>
    </ol>
    <input type="file" id="files" accept=".zip,.csv" multiple>
    <label class="chk" style="margin-top:14px"><input type="checkbox" id="skip" checked> Skip films I've already logged here</label>
    <label class="chk" style="margin-top:6px"><input type="checkbox" id="usedates" checked> Keep watched dates from my diary (uncheck to import without any dates)</label>
    <button id="go" style="margin-top:16px" disabled>Import</button>
    <div id="prog" style="margin-top:18px"></div>
    <p class="muted" style="margin-top:24px;font-size:13px">Letterboxd only exports films, so no TV comes over. Films are matched to TMDB by title and year; anything that can't be matched is listed so you can add it by hand.</p>`;
  const files = $("#files"), go = $("#go"), prog = $("#prog");
  files.onchange = () => (go.disabled = !files.files.length);
  go.onclick = async () => {
    go.disabled = true; files.disabled = true;
    const skip = $("#skip").checked, useDates = $("#usedates").checked;
    try {
      prog.innerHTML = `<p class="muted">Reading files…</p>`;
      const texts = await readLetterboxdFiles(files.files);
      if (!Object.keys(texts).length) throw new Error("Couldn't find watched.csv, ratings.csv, diary.csv, reviews.csv or watchlist.csv in what you picked.");
      const P = n => (texts[n] ? parseCSV(texts[n]) : []);
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

      // match to TMDB (a few at a time)
      const matched = [], unmatched = [];
      let n = 0;
      const bar = () => (prog.innerHTML = `<p class="muted">Matching films… ${n} / ${list.length}</p><progress max="${list.length}" value="${n}"></progress>`);
      bar();
      let idx = 0;
      await Promise.all(Array.from({ length: 6 }, async () => {
        while (idx < list.length) {
          const f = list[idx++];
          try { const r = await matchFilm(f); r ? matched.push({ f, r }) : unmatched.push(f); } catch { unmatched.push(f); }
          n++; if (n % 5 === 0 || n === list.length) bar();
        }
      }));

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
      let saved = 0;
      for (let i = 0; i < docs.length; i += 300) {
        await commitChunk(docs.slice(i, i + 300));
        saved = Math.min(i + 300, docs.length);
        prog.innerHTML = `<p class="muted">Saving… ${saved} / ${docs.length}</p><progress max="${docs.length}" value="${saved}"></progress>`;
      }
      docs.forEach(d => (myEntries[d.key] = d));
      prog.innerHTML = `<h2 style="margin-top:0">Done</h2>
        <p>Imported <b>${docs.length}</b> titles${skipped ? `, skipped ${skipped} you'd already logged` : ""}${unmatched.length ? `, couldn't match ${unmatched.length}` : ""}.</p>
        ${unmatched.length ? `<details><summary class="muted">Couldn't match these</summary><ul class="muted">${unmatched.map(f => `<li>${esc(f.name)}${f.year ? ` (${esc(f.year)})` : ""}</li>`).join("")}</ul></details>` : ""}
        <a href="#/me"><button style="margin-top:12px">Go to my diary</button></a>`;
    } catch (e) {
      prog.innerHTML = `<p style="color:var(--danger)">${esc(e.message)}</p>`;
      go.disabled = false; files.disabled = false;
    }
  };
}

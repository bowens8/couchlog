import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, onAuthStateChanged, signOut }
  from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { getFirestore, collection, doc, getDoc, getDocs, setDoc, deleteDoc, query, where,
  orderBy, limit, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
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

/* ---------- helpers ---------- */
function toast(msg) {
  const t = $("#toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), 2200);
}
function starsText(r) {
  if (r == null) return "";
  const full = Math.floor(r), half = r - full >= 0.5;
  return "★".repeat(full) + (half ? "½" : "");
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
async function tmdb(path, params = {}) {
  const u = new URL("https://api.themoviedb.org/3" + path);
  u.searchParams.set("api_key", TMDB_KEY);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  const r = await fetch(u); if (!r.ok) throw new Error("TMDB " + r.status); return r.json();
}
const entryId = (uid, key) => `${uid}_${key}`;

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
  const h = location.hash.slice(2) || "feed";
  const [page, a, b] = h.split("/");
  document.querySelectorAll("#topbar nav a").forEach(l => l.classList.toggle("active", l.getAttribute("href") === "#/" + page));
  window.scrollTo(0, 0);
  if (page === "feed") return pageFeed();
  if (page === "search") return pageSearch(decodeURIComponent(a || ""));
  if (page === "title") return pageTitle(a, b);
  if (page === "me") return pageUser(me.uid);
  if (page === "user") return pageUser(a);
  if (page === "people") return pagePeople();
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
    `<p class="muted">Nothing here yet. <a href="#/search" style="color:var(--accent2)">Search for something to log.</a></p>`;
}
function feedItem(e) {
  const verb = e.status === "watchlist" ? "added to watchlist" : "watched";
  return `<div class="feed-item">
    <a href="#/title/${e.type}/${e.tmdbId}">${posterImg(e.poster, e.title)}</a>
    <div>
      <div class="who">${avatar(e.uid)} <a href="#/user/${e.uid}"><b>${esc(userName(e.uid))}</b></a> ${verb} · ${timeAgo(e.updatedAt)}</div>
      <div class="title"><a href="#/title/${e.type}/${e.tmdbId}">${esc(e.title)}</a> <span class="muted" style="font-weight:400">${esc(e.year || "")}${e.season ? " · " + esc(e.season) : ""}</span></div>
      ${e.rating != null ? `<div class="stars">${starsText(e.rating)}</div>` : ""}
      ${e.review ? `<div class="review">${esc(e.review)}</div>` : ""}
    </div></div>`;
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
      $("#results").innerHTML = rs.length ? `<div class="grid">${rs.map(r => {
        const t = r.title || r.name, y = (r.release_date || r.first_air_date || "").slice(0, 4);
        const mine = myEntries[`${r.media_type}_${r.id}`];
        return `<a class="card" href="#/title/${r.media_type}/${r.id}">
          ${posterImg(r.poster_path, t)}
          <span class="badge">${r.media_type === "tv" ? "TV" : "Film"}${mine?.status === "watched" ? " ✓" : ""}</span>
          <div class="cap">${esc(t)} ${y ? `(${y})` : ""}</div></a>`;
      }).join("")}</div>` : `<p class="muted">No results.</p>`;
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

function openLog(meta, done) {
  const ex = myEntries[meta.key] || {};
  const st = { status: ex.status || "watched", rating: ex.rating ?? null };
  const today = new Date().toISOString().slice(0, 10);
  const card = $("#modal-card");
  card.innerHTML = `
    <div class="modal-head">${posterImg(meta.poster, meta.title)}
      <div><b style="font-size:17px">${esc(meta.title)}</b><div class="muted">${esc(meta.year)}</div></div></div>
    <div class="seg" style="margin-top:10px">
      <button data-s="watched">Watched</button><button data-s="watchlist">Watchlist</button></div>
    <div id="watchedFields">
      <label>Rating <span class="muted" style="text-transform:none">(tap a star's left half for ½)</span></label>
      <div id="stars"></div>
      <label>Date watched</label><input type="date" id="date" value="${esc(ex.watchedOn || today)}">
      ${meta.type === "tv" ? `<label>Season / episodes <span class="muted" style="text-transform:none">(optional)</span></label>
        <input id="season" placeholder="e.g. Season 2, or Whole series" value="${esc(ex.season || "")}">` : ""}
      <label>Review</label><textarea id="review" placeholder="Thoughts…">${esc(ex.review || "")}</textarea>
    </div>
    <div class="row" style="margin-top:16px;justify-content:space-between">
      <div>${myEntries[meta.key] ? `<button class="danger" id="del">Remove</button>` : ""}</div>
      <div class="row"><button class="ghost" id="cancel">Cancel</button><button id="save">Save</button></div>
    </div>`;
  const sp = starPicker(st.rating, v => (st.rating = v));
  $("#stars").appendChild(sp);
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
      watchedOn: watched ? $("#date").value || today : "",
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
      <h1 style="margin:0">${esc(u.name)}</h1></div>
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

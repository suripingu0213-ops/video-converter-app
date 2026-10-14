'use strict';
// 動画変換アプリ（スマホ版）
// 変換は非公開リポジトリの GitHub Actions、保存先はそのリポジトリの media/〜 ブランチ。
// 端末に保存した動画は IndexedDB に入れ、オフラインで再生する。

const APP_VERSION = 'v1'; // sw.js の VERSION と合わせる
const DEFAULT_REPO = 'suripingu0213-ops/video-converter';
const WORKFLOW = 'convert.yml';
const PART_SIZE = 45 * 1024 * 1024; // publish.py と同じ分割サイズ
const LS = { token: 'vc.token', repo: 'vc.repo', metas: 'vc.metas', pos: 'vc.pos.', fmt: 'vc.fmt', q: 'vc.q' };

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---- localStorage（使えない環境でも落ちないように） ----
function lsGet(k, d = null) { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch { return d; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch { /* 無視 */ } }
function lsDel(k) { try { localStorage.removeItem(k); } catch { /* 無視 */ } }
const repo = () => lsGet(LS.repo, DEFAULT_REPO).trim();

// ---- IndexedDB ----
let dbPromise;
function db() {
  return dbPromise ||= new Promise((res, rej) => {
    const r = indexedDB.open('video-converter', 1);
    r.onupgradeneeded = () => { for (const s of ['parts', 'thumbs', 'saved']) r.result.createObjectStore(s); };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function idb(store, mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const tx = d.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    tx.oncomplete = () => res(req ? req.result : undefined);
    tx.onerror = () => rej(tx.error);
    tx.onabort = () => rej(tx.error);
  });
}
const idbGet = (s, k) => idb(s, 'readonly', (o) => o.get(k));
const idbPut = (s, k, v) => idb(s, 'readwrite', (o) => o.put(v, k));
const idbDel = (s, k) => idb(s, 'readwrite', (o) => o.delete(k));
const idbAll = (s) => idb(s, 'readonly', (o) => o.getAll());
const idbKeys = (s) => idb(s, 'readonly', (o) => o.getAllKeys());

// Blob をそのまま保存できない古い Safari 向けに ArrayBuffer で保存し直す
async function putBlob(store, key, blob) {
  try { await idbPut(store, key, blob); }
  catch { await idbPut(store, key, await blob.arrayBuffer()); }
}

// ---- GitHub API ----
class ApiError extends Error {
  constructor(status, msg) { super(msg); this.status = status; }
}
async function gh(path, { method = 'GET', body, accept = 'application/vnd.github+json' } = {}) {
  const token = lsGet(LS.token);
  if (!token) throw new ApiError(0, '「設定」で GitHub のトークンを入力してください');
  let res;
  try {
    res = await fetch(`https://api.github.com/repos/${repo()}${path}`, {
      method, cache: 'no-store',
      headers: { Authorization: `Bearer ${token}`, Accept: accept, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(-1, '通信できません（圏外かもしれません）');
  }
  if (!res.ok) {
    const msg = res.status === 401 ? 'トークンが無効か期限切れです。「設定」で入れ直してください'
      : res.status === 403 ? 'トークンの権限が足りません（Actions と Contents の読み書きが必要です）'
      : res.status === 404 ? 'リポジトリが見つからないか、トークンの対象外です'
      : `GitHub エラー (${res.status})`;
    throw new ApiError(res.status, msg);
  }
  return res;
}
const ghJson = async (path, opts) => (await gh(path, opts)).json();
const rawPath = (branch, file) => `/contents/${encodeURIComponent(file)}?ref=${encodeURIComponent(branch)}`;
const ghRaw = (branch, file) => gh(rawPath(branch, file), { accept: 'application/vnd.github.raw' });

// ---- 共通 UI ----
let toastTimer;
function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}
function sheet(title, text, buttons) {
  // buttons: [{label, cls, value}] → 押されたものの value を返す（背景タップは null）
  return new Promise((resolve) => {
    const bg = $('#sheet');
    $('#sheet-inner').innerHTML = `<h3>${esc(title)}</h3>${text ? `<p class="muted">${esc(text)}</p>` : ''}`
      + buttons.map((b, i) => `<button data-i="${i}" class="${b.cls || ''}">${esc(b.label)}</button>`).join('')
      + '<button data-i="-1">キャンセル</button>';
    bg.hidden = false;
    const done = (v) => { bg.hidden = true; bg.onclick = null; resolve(v); };
    bg.onclick = (e) => {
      if (e.target === bg) return done(null);
      const i = e.target.closest('button')?.dataset.i;
      if (i !== undefined) done(i === '-1' ? null : buttons[+i].value);
    };
  });
}
const fmtSize = (n) => n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n > 0 ? `${Math.max(1, Math.round(n / 1e3))} KB` : "0 KB";
const fmtDur = (s) => {
  if (!s) return '';
  s = Math.round(s);
  const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
};
const fmtDate = (iso) => {
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
};
const FORMAT_LABEL = { mp4: '動画', m4a: 'M4A', mp3: 'MP3' };

// ---- タブ ----
const TITLES = { library: 'ライブラリ', convert: '変換', settings: '設定' };
let currentTab = 'library';
function showTab(name) {
  currentTab = name;
  for (const b of document.querySelectorAll('nav button')) b.classList.toggle('on', b.dataset.tab === name);
  for (const t of Object.keys(TITLES)) $(`#tab-${t}`).hidden = t !== name;
  $('#h-title').textContent = TITLES[name];
  $('#btn-refresh').hidden = name === 'settings';
  if (name === 'library') loadLibrary();
  if (name === 'convert') loadRuns();
  if (name === 'settings') showSettings();
}

// ================= ライブラリ =================
let items = []; // {branch, meta, saved, remote}
const downloading = new Map(); // branch → 進捗(0〜1)
const thumbUrls = new Map();

function metaCache() { try { return JSON.parse(lsGet(LS.metas, '{}')); } catch { return {}; } }

async function loadLibrary() {
  const notice = $('#lib-notice');
  const saved = new Map((await idbKeys('saved')).map((k) => [k, true]));
  const savedMetas = await idbAll('saved');
  const savedKeys = await idbKeys('saved');
  const local = new Map(savedKeys.map((k, i) => [k, savedMetas[i]]));

  let remote = null;
  notice.hidden = true;
  try {
    const refs = await ghJson('/git/matching-refs/heads/media/');
    remote = refs.map((r) => r.ref.replace('refs/heads/', ''));
  } catch (e) {
    notice.textContent = e.status === -1 ? '圏外のため、この端末に保存した動画だけを表示しています' : e.message;
    notice.hidden = false;
  }

  const cache = metaCache();
  if (remote) {
    // 新しく増えたものだけ meta.json を取りに行く
    const missing = remote.filter((b) => !cache[b] && !local.has(b));
    await Promise.all(missing.map(async (b) => {
      try { cache[b] = await (await ghRaw(b, 'meta.json')).json(); } catch { /* 次回また取る */ }
    }));
    for (const b of Object.keys(cache)) if (!remote.includes(b)) delete cache[b];
    lsSet(LS.metas, JSON.stringify(cache));
  }

  const branches = new Set([...(remote || Object.keys(cache)), ...local.keys()]);
  items = [...branches].map((b) => ({
    branch: b, meta: local.get(b) || cache[b], saved: saved.has(b), remote: remote ? remote.includes(b) : true,
  })).filter((it) => it.meta);
  items.sort((a, b) => (b.meta.created || '').localeCompare(a.meta.created || ''));
  renderLibrary();
}

function renderLibrary() {
  const list = $('#lib-list');
  if (!items.length) {
    list.innerHTML = `<div class="empty">まだ動画がありません。<br>「変換」から URL を送ってください。</div>`;
    return;
  }
  list.innerHTML = items.map((it) => {
    const m = it.meta;
    const p = downloading.get(it.branch);
    const badges = [
      it.saved ? '<span class="badge saved">端末に保存済み</span>' : '',
      `<span class="badge">${FORMAT_LABEL[m.format] || m.format}${m.format === 'mp4' ? ` ${m.quality === 'best' ? '最高' : m.quality + 'p'}` : ''}</span>`,
      `<span class="badge">${fmtSize(m.size)}</span>`,
      `<span class="badge">${fmtDate(m.created)}</span>`,
      it.remote ? '' : '<span class="badge">GitHubから削除済み</span>',
    ].join('');
    const main = it.saved ? '<button class="primary" data-act="play">再生</button>'
      : p !== undefined ? '<button disabled>保存中…</button>'
      : '<button class="primary" data-act="save">保存</button>';
    return `<div class="card" data-branch="${esc(it.branch)}">
      <div class="item" data-act="${it.saved ? 'play' : 'save'}">
        <div class="thumb" data-thumb="${esc(it.branch)}">${m.duration ? `<span class="dur">${fmtDur(m.duration)}</span>` : ''}</div>
        <div class="info"><div class="title">${esc(m.title)}</div>
          <div class="muted">${esc(m.uploader)}</div><div class="badges">${badges}</div></div>
      </div>
      ${p !== undefined ? `<div class="bar"><div style="width:${Math.round(p * 100)}%"></div></div>` : ''}
      <div class="actions">${main}<button class="danger" data-act="delete">削除</button></div>
    </div>`;
  }).join('');
  for (const el of list.querySelectorAll('[data-thumb]')) loadThumb(el.dataset.thumb, el);
}

async function loadThumb(branch, el) {
  const it = items.find((i) => i.branch === branch);
  if (!it?.meta.thumb) return;
  let url = thumbUrls.get(branch);
  if (!url) {
    let blob = await idbGet('thumbs', branch).catch(() => null);
    if (!blob && it.remote) {
      try {
        blob = await (await ghRaw(branch, it.meta.thumb)).blob();
        await putBlob('thumbs', branch, blob);
      } catch { return; }
    }
    if (!blob) return;
    if (!(blob instanceof Blob)) blob = new Blob([blob]);
    url = URL.createObjectURL(blob);
    thumbUrls.set(branch, url);
  }
  el.style.backgroundImage = `url("${url}")`;
}

$('#lib-list').addEventListener('click', (e) => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  const card = e.target.closest('[data-branch]');
  if (!act || !card) return;
  const it = items.find((i) => i.branch === card.dataset.branch);
  if (!it) return;
  if (act === 'play') play(it);
  else if (act === 'save' && !downloading.has(it.branch)) saveItem(it);
  else if (act === 'delete') deleteItem(it);
});

// ---- 端末に保存 ----
let wakeLock = null;
async function keepAwake(on) {
  try {
    if (on && !wakeLock && 'wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
    if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch { /* 非対応なら何もしない */ }
}

function updateProgress(branch) {
  const bar = document.querySelector(`[data-branch="${CSS.escape(branch)}"] .bar > div`);
  if (bar) bar.style.width = `${Math.round(downloading.get(branch) * 100)}%`;
  else renderLibrary();
}

async function saveItem(it) {
  if (!it.remote) return toast('GitHub から削除済みのため保存できません');
  const m = it.meta;
  downloading.set(it.branch, 0);
  renderLibrary();
  keepAwake(true);
  try { await navigator.storage?.persist?.(); } catch { /* 無視 */ }
  try {
    let doneBytes = 0;
    for (let i = 0; i < m.parts.length; i++) {
      const key = `${it.branch}/${i}`;
      const partSize = Math.min(PART_SIZE, m.size - i * PART_SIZE);
      if (await idbGet('parts', key)) { doneBytes += partSize; continue; } // 途中まで保存済みなら続きから
      const res = await ghRaw(it.branch, m.parts[i]);
      const reader = res.body.getReader();
      const chunks = [];
      let got = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value); got += value.length;
        downloading.set(it.branch, (doneBytes + got) / m.size);
        updateProgress(it.branch);
      }
      await putBlob('parts', key, new Blob(chunks));
      doneBytes += partSize;
    }
    await idbPut('saved', it.branch, m);
    it.saved = true;
    toast('保存しました。オフラインでも再生できます');
  } catch (e) {
    toast(e instanceof ApiError ? e.message : `保存に失敗しました（${e.message || e}）。もう一度押すと続きから再開します`, 4000);
  } finally {
    downloading.delete(it.branch);
    if (!downloading.size) keepAwake(false);
    renderLibrary();
  }
}

async function localBlob(it) {
  const parts = [];
  for (let i = 0; i < it.meta.parts.length; i++) {
    const p = await idbGet('parts', `${it.branch}/${i}`);
    if (!p) throw new Error('保存データが欠けています');
    parts.push(p);
  }
  return new Blob(parts, { type: it.meta.mime });
}

async function deleteLocal(it) {
  for (let i = 0; i < it.meta.parts.length; i++) await idbDel('parts', `${it.branch}/${i}`);
  await idbDel('saved', it.branch);
  lsDel(LS.pos + it.branch);
}

async function deleteItem(it) {
  const buttons = [];
  if (it.saved) buttons.push({ label: 'この端末から削除（GitHub には残す）', value: 'local' });
  if (it.remote) buttons.push({ label: it.saved ? '完全に削除（端末と GitHub の両方）' : 'GitHub から削除', cls: 'danger', value: 'all' });
  if (!it.remote && it.saved) buttons[0] = { label: 'この端末から削除', cls: 'danger', value: 'local' };
  const v = await sheet(it.meta.title, '削除すると元に戻せません。', buttons);
  if (!v) return;
  try {
    if (v === 'all' && it.remote) await gh(`/git/refs/heads/${it.branch}`, { method: 'DELETE' });
    if (it.saved) await deleteLocal(it);
    if (v === 'all') { await idbDel('thumbs', it.branch); const c = metaCache(); delete c[it.branch]; lsSet(LS.metas, JSON.stringify(c)); }
    toast('削除しました');
  } catch (e) {
    toast(e.message, 4000);
  }
  loadLibrary();
}

// ---- 再生 ----
let playerUrl = null, playerBlob = null, playerItem = null;
async function play(it) {
  let blob;
  try { blob = await localBlob(it); } catch (e) { return toast(e.message); }
  closePlayer();
  playerBlob = blob; playerItem = it;
  playerUrl = URL.createObjectURL(blob);
  const isVideo = it.meta.mime.startsWith('video');
  const body = $('#player-body');
  const thumb = thumbUrls.get(it.branch);
  body.innerHTML = isVideo
    ? `<video id="media" controls playsinline autoplay ${thumb ? `poster="${thumb}"` : ''}></video>`
    : `${thumb ? `<img src="${thumb}" alt="">` : ''}<audio id="media" controls autoplay></audio>`;
  const media = $('#media');
  media.src = playerUrl;
  $('#player-title').textContent = it.meta.title;
  $('#player').hidden = false;

  // 前回の続きから
  const pos = parseFloat(lsGet(LS.pos + it.branch, '0'));
  media.addEventListener('loadedmetadata', () => {
    if (pos > 5 && pos < media.duration - 10) media.currentTime = pos;
  }, { once: true });
  let last = 0;
  media.addEventListener('timeupdate', () => {
    if (Math.abs(media.currentTime - last) > 3) { last = media.currentTime; lsSet(LS.pos + it.branch, String(last)); }
  });
  media.addEventListener('ended', () => lsDel(LS.pos + it.branch));

  if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: it.meta.title, artist: it.meta.uploader,
      artwork: thumb ? [{ src: thumb, sizes: '480x360' }] : [],
    });
  }
}
function closePlayer() {
  const media = $('#media');
  if (media) { media.pause(); media.removeAttribute('src'); media.load(); }
  $('#player-body').innerHTML = '';
  $('#player').hidden = true;
  if (playerUrl) URL.revokeObjectURL(playerUrl);
  playerUrl = playerBlob = playerItem = null;
}
$('#btn-close-player').onclick = closePlayer;
$('#btn-share').onclick = async () => {
  if (!playerBlob) return;
  const name = playerItem.meta.title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 80) + playerItem.meta.ext;
  const file = new File([playerBlob], name, { type: playerItem.meta.mime });
  if (!navigator.canShare?.({ files: [file] })) return toast('この端末では共有できません');
  try { await navigator.share({ files: [file], title: playerItem.meta.title }); } catch { /* キャンセル */ }
};

// ================= 変換 =================
const seg = (id, key, def) => {
  const el = $(id);
  const set = (v) => { for (const b of el.children) b.classList.toggle('on', b.dataset.v === v); lsSet(key, v); };
  el.addEventListener('click', (e) => { const v = e.target.closest('button')?.dataset.v; if (v) { set(v); updateFormatUi(); } });
  set(lsGet(key, def));
  return () => el.querySelector('.on')?.dataset.v || def;
};
const getFormat = seg('#seg-format', LS.fmt, 'mp4');
const getQuality = seg('#seg-quality', LS.q, '720');
function updateFormatUi() {
  const f = getFormat();
  $('#quality-wrap').hidden = f !== 'mp4';
  $('#fmt-hint').textContent = f === 'mp4' ? '通信量を抑えるなら 720p 以下がおすすめです（10分の動画でおよそ 50〜80MB）'
    : f === 'm4a' ? '元の音質のまま保存します（劣化なし）'
    : 'MP3 に変換します（他のアプリで使いたいとき向け）';
}
updateFormatUi();

$('#btn-paste').onclick = async () => {
  try {
    const t = (await navigator.clipboard.readText()).trim();
    if (!t) return toast('クリップボードが空です');
    const ta = $('#url');
    ta.value = (ta.value.trim() ? ta.value.trim() + '\n' : '') + t;
  } catch { toast('貼り付けできませんでした。入力欄を長押しして貼り付けてください'); }
};
$('#btn-clear').onclick = () => { $('#url').value = ''; };

const isYouTube = (s) => /youtube\.com|youtu\.be/.test(s);
$('#btn-convert').onclick = async () => {
  const urls = $('#url').value.split(/[\s,、]+/).filter((u) => /^https?:\/\//.test(u));
  if (!urls.length) return toast('URL を入力してください');
  const btn = $('#btn-convert');
  btn.disabled = true;
  try {
    await gh(`/actions/workflows/${WORKFLOW}/dispatches`, {
      method: 'POST',
      body: { ref: 'main', inputs: { url: urls.join(' '), format: getFormat(), quality: getQuality() } },
    });
    $('#url').value = '';
    toast(urls.some(isYouTube) ? '依頼しました。YouTube は自宅 PC で変換します' : '依頼しました。数分で完了します');
    setTimeout(loadRuns, 2500);
  } catch (e) {
    toast(e.message, 4000);
  } finally {
    btn.disabled = false;
  }
};

let runsTimer = null, knownDone = new Set();
async function loadRuns() {
  clearTimeout(runsTimer);
  const box = $('#runs');
  let data;
  try { data = await ghJson(`/actions/workflows/${WORKFLOW}/runs?per_page=15`); }
  catch (e) { box.innerHTML = `<p class="muted">${esc(e.message)}</p>`; return; }
  const runs = data.workflow_runs || [];
  if (!runs.length) { box.innerHTML = '<p class="muted">まだ変換していません</p>'; return; }
  let active = false, newlyDone = false;
  box.innerHTML = runs.map((r) => {
    // run-name は「形式 画質 | URL」
    const [head, url = ''] = (r.display_title || '').split(' | ');
    const [fmt, q] = head.split(' ');
    let st, cls;
    if (r.status === 'completed') {
      if (r.conclusion === 'success') { st = '完了'; cls = 'ok'; } else if (r.conclusion === 'cancelled') { st = '中止'; cls = 'bad'; } else { st = '失敗'; cls = 'bad'; }
      if (!knownDone.has(r.id)) { if (knownDone.size) newlyDone = true; knownDone.add(r.id); }
    } else {
      active = true;
      st = r.status === 'in_progress' ? '変換中' : isYouTube(url) ? 'PC待ち' : '待機中';
      cls = 'wait';
    }
    const label = `${FORMAT_LABEL[fmt] || fmt || ''}${fmt === 'mp4' ? ` ${q === 'best' ? '最高' : q + 'p'}` : ''}`;
    return `<div class="run"><span class="st ${cls}">${st}</span>
      <div style="flex:1;min-width:0"><div class="u">${esc(url)}</div>
      <div class="muted">${esc(label)} ・ ${fmtDate(r.created_at)}${cls === 'bad' ? ` ・ <a href="${esc(r.html_url)}" target="_blank" rel="noopener">詳細</a>` : ''}</div></div></div>`;
  }).join('');
  if (runs.some((r) => r.status !== 'completed' && isYouTube((r.display_title || '').split(' | ')[1] || '') && r.status === 'queued')) {
    box.insertAdjacentHTML('beforeend', '<p class="muted">「PC待ち」は自宅 PC が起動すると自動で変換されます。</p>');
  }
  $('#runs-updated').textContent = `${new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit' })} 更新`;
  if (newlyDone) toast('変換が完了しました。「ライブラリ」から保存できます');
  if (active && currentTab === 'convert' && document.visibilityState === 'visible') runsTimer = setTimeout(loadRuns, 8000);
}

// ================= 設定 =================
async function showSettings() {
  $('#token').value = lsGet(LS.token, '');
  $('#repo').value = repo();
  const lines = [];
  try {
    const est = await navigator.storage?.estimate?.();
    if (est) lines.push(`この端末: ${fmtSize(est.usage || 0)} 使用中（上限の目安 ${fmtSize(est.quota || 0)}）`);
  } catch { /* 無視 */ }
  const total = Object.values(metaCache()).reduce((s, m) => s + (m.size || 0), 0);
  lines.push(`GitHub: ${fmtSize(total)}（1GB を超えたら古いものの削除がおすすめです）`);
  $('#usage').textContent = lines.join(' / ');
}
$('#btn-save-settings').onclick = async () => {
  lsSet(LS.token, $('#token').value.trim());
  lsSet(LS.repo, $('#repo').value.trim() || DEFAULT_REPO);
  const st = $('#conn-status');
  st.textContent = '確認中…';
  try {
    const r = await ghJson('');
    st.textContent = `接続できました（${r.full_name}${r.private ? '・非公開' : '・⚠ 公開になっています。非公開にしてください'}）`;
    lsSet(LS.metas, '{}');
  } catch (e) {
    st.textContent = e.message;
  }
};
$('#btn-wipe').onclick = async () => {
  const v = await sheet('端末の動画をすべて削除', 'GitHub に残っている動画は、あとでまた保存できます。', [{ label: 'すべて削除', cls: 'danger', value: 'yes' }]);
  if (v !== 'yes') return;
  for (const s of ['parts', 'thumbs', 'saved']) await idb(s, 'readwrite', (o) => o.clear());
  for (const it of items) lsDel(LS.pos + it.branch);
  toast('削除しました');
  showSettings();
};

// ================= 起動 =================
for (const b of document.querySelectorAll('nav button')) b.onclick = () => showTab(b.dataset.tab);
$('#btn-refresh').onclick = () => (currentTab === 'convert' ? loadRuns() : loadLibrary());
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && currentTab === 'convert') loadRuns();
});
$('#ver').textContent = APP_VERSION;
showTab(lsGet(LS.token) ? 'library' : 'settings');

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').then((reg) => reg.update()).catch(() => {});
}

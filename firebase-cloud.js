import { initializeApp }
  from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getAuth, signOut, onAuthStateChanged,
         createUserWithEmailAndPassword, signInWithEmailAndPassword,
         sendPasswordResetEmail, updateProfile }
  from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { getDatabase, ref, set, get, update, query, orderByChild, limitToLast }
  from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js';

/* ── CONFIG ── */
const firebaseConfig = {
  apiKey:            "AIzaSyDl7zwV_Ob4re6P_UauwRfgwcxxpPcFyoc",
  authDomain:        "circleio-17791.firebaseapp.com",
  // ⚠️ ВАЖНО: найди свой databaseURL в Firebase Console →
  //   Realtime Database → Data → скопируй URL вида
  //   https://circleio-17791-default-rtdb.REGION.firebasedatabase.app
  databaseURL:       "https://circleio-17791-default-rtdb.europe-west1.firebasedatabase.app",
  projectId:         "circleio-17791",
  storageBucket:     "circleio-17791.firebasestorage.app",
  messagingSenderId: "415983443352",
  appId:             "1:415983443352:web:e8e9273fb6604a854b1fed",
};

let app, auth, db;
let currentUser = null;
let _lbTab      = 'xp';
let _totalWins  = 0;
let _totalKills = 0;
// Этот модуль подключается только вне хостов Яндекса (см. index.html).
const IS_YANDEX_BUILD = false;

// Try to init Firebase, but don't crash the game if it fails
try {
  app      = initializeApp(firebaseConfig);
  auth     = getAuth(app);
  db       = getDatabase(app);
  setupAuth();
  console.log('🔥 Firebase инициализирован');
} catch(e) {
  console.warn('Firebase init failed:', e.message);
  setAuthStatus('error', '⚠️ Firebase unavailable');
}

function setupAuth() {
  onAuthStateChanged(auth, async (user) => {
    currentUser = user;
    window._isLoggedIn = !!user;
    if (user) {
      showAuthLoggedIn(user);
      setAuthStatus('syncing', '🔄 Syncing...');
      await loadFromCloud(user.uid);
      setAuthStatus('synced', '☁️ Synced');
      // Generate/restore player ID
      window._playerId = getOrCreatePlayerId();
      // Show player ID block, hide guest warning
      const gw = document.getElementById('guest-warning');
      if (gw) gw.style.display = 'none';
      updateHomeScreen();
    } else {
      showAuthLoggedOut();
      window._isLoggedIn = false;
      window._playerId   = null;
      // Hide player ID, show guest warning
      const pidBlock = document.getElementById('home-pid-block');
      if (pidBlock) pidBlock.style.display = 'none';
      const gw = document.getElementById('guest-warning');
      if (gw) gw.style.display = 'flex';
    }
  });
}

/* ══ AUTH FUNCTIONS ══ */
window.signOutUser = async () => {
  if (IS_YANDEX_BUILD) return;
  if (auth) await signOut(auth);
};

/* ══ EMAIL AUTH ══ */
let _authMode = 'login';

window.switchAuthTab = (mode) => {
  _authMode = mode;
  document.getElementById('tab-login')?.classList.toggle('active',    mode === 'login');
  document.getElementById('tab-register')?.classList.toggle('active', mode === 'register');
  const pass2  = document.getElementById('auth-pass2');
  const forgot = document.getElementById('auth-forgot');
  const btn    = document.getElementById('auth-submit-btn');
  if (pass2)  pass2.style.display  = mode === 'register' ? 'block' : 'none';
  if (forgot) forgot.style.display = mode === 'login'    ? 'block' : 'none';
  if (btn)    btn.textContent      = mode === 'register' ? 'Create account' : 'Sign in';
  setAuthErr('');
};

window.submitEmailAuth = async () => {
  if (IS_YANDEX_BUILD) { setAuthErr('Yandex build mode: email auth disabled'); return; }
  if (!auth) { setAuthErr('Firebase unavailable — open via localhost'); return; }
  const email = document.getElementById('auth-email')?.value.trim();
  const pass  = document.getElementById('auth-pass')?.value;
  const pass2 = document.getElementById('auth-pass2')?.value;
  const btn   = document.getElementById('auth-submit-btn');

  if (!email || !pass) { setAuthErr('Forполни все поля'); return; }
  if (!email.includes('@')) { setAuthErr('Invalid email'); return; }
  if (_authMode === 'register') {
    if (pass.length < 6)  { setAuthErr('Password must be at least 6 characters'); return; }
    if (pass !== pass2)   { setAuthErr('Passwords do not match'); return; }
  }

  if (btn) { btn.textContent = '...'; btn.disabled = true; }
  setAuthErr('');

  try {
    if (_authMode === 'register') {
      const cred = await createUserWithEmailAndPassword(auth, email, pass);
      const name = (typeof playerName !== 'undefined' && playerName && playerName !== 'Player')
        ? playerName : email.split('@')[0].slice(0, 14);
      await updateProfile(cred.user, { displayName: name });
    } else {
      await signInWithEmailAndPassword(auth, email, pass);
    }
  } catch(e) {
    const msgs = {
      'auth/user-not-found':       'Account не найден',
      'auth/wrong-password':       'Wrong password',
      'auth/email-already-in-use': 'Email already in use',
      'auth/weak-password':        'Password too weak',
      'auth/invalid-email':        'Invalid email format',
      'auth/invalid-credential':   'Invalid email or пароль',
      'auth/too-many-requests':    'Too many attempts, wait',
      'auth/unauthorized-domain':  'Open via localhost (not file://)',
    };
    setAuthErr(msgs[e.code] || e.message);
  } finally {
    if (btn) { btn.textContent = _authMode === 'register' ? 'Create account' : 'Sign in'; btn.disabled = false; }
  }
};

window.sendPasswordReset = async () => {
  if (IS_YANDEX_BUILD) { setAuthErr('Yandex build mode: email auth disabled'); return; }
  if (!auth) return;
  const email = document.getElementById('auth-email')?.value.trim();
  if (!email || !email.includes('@')) { setAuthErr('Enter email to reset'); return; }
  try {
    await sendPasswordResetEmail(auth, email);
    setAuthErr('');
    const msg = document.getElementById('auth-status-msg');
    if (msg) { msg.textContent = '📧 Email sent!'; msg.className = 'auth-sync-status synced'; }
  } catch(e) { setAuthErr(e.code === 'auth/user-not-found' ? 'Email not found' : e.message); }
};

function setAuthErr(msg) {
  const el = document.getElementById('auth-err');
  if (el) el.textContent = msg;
}

/* ══ SHOW AUTH STATE ══ */
function showAuthLoggedIn(user) {
  if (IS_YANDEX_BUILD) { applyYandexBuildMode(); return; }
  document.getElementById('auth-bar-loggedout').style.display = 'none';
  document.getElementById('auth-bar-loggedin').style.display  = 'block';
  const nameEl   = document.getElementById('auth-display-name');
  const avatarEl = document.getElementById('auth-avatar');
  if (nameEl)   nameEl.textContent = user.displayName || user.email?.split('@')[0] || 'Игрок';
  if (avatarEl) {
    avatarEl.innerHTML = user.photoURL
      ? `<img src="${user.photoURL}" alt="avatar">`
      : (user.displayName || 'U')[0].toUpperCase();
  }
  if (user.displayName && (!playerName || playerName === 'Player')) {
    playerName = user.displayName.split(' ')[0].slice(0, 14);
    const inp = document.getElementById('player-name');
    if (inp) inp.value = playerName;
    saveData();
  }
}

function showAuthLoggedOut() {
  if (IS_YANDEX_BUILD) { applyYandexBuildMode(); return; }
  document.getElementById('auth-bar-loggedout').style.display = 'block';
  document.getElementById('auth-bar-loggedin').style.display  = 'none';
}

function setAuthStatus(type, msg) {
  const label = document.getElementById('auth-sync-label');
  const dot   = document.getElementById('auth-dot');
  const msgEl = document.getElementById('auth-status-msg');
  if (label) label.textContent = msg;
  if (msgEl) { msgEl.textContent = msg; msgEl.className = 'auth-sync-status ' + type; }
  if (dot)   dot.className = 'auth-sync-dot' + (type === 'synced' ? '' : ' offline');
}

/* ══ CLOUD SAVE / LOAD ══ */
async function loadFromCloud(uid) {
  if (!db) return;
  try {
    const snap = await get(ref(db, `users/${uid}`));
    if (!snap.exists()) { await saveToCloud(uid); return; }
    const cloud = snap.val();
    playerXp   = Math.max(playerXp   || 0, cloud.xp    || 0);
    coins      = Math.max(coins      || 0, cloud.coins  || 0);
    streakDays = Math.max(streakDays || 0, cloud.streak || 0);
    if (cloud.name)       { playerName = cloud.name; const i=document.getElementById('player-name'); if(i) i.value=playerName; }
    if (cloud.skin  != null) selectedSkin  = cloud.skin;
    if (cloud.owned)         ownedSkins    = new Set(cloud.owned);
    if (cloud.wins  != null) _totalWins    = cloud.wins  || 0;
    if (cloud.kills != null) _totalKills   = cloud.kills || 0;
    saveData(); updateXpUI(); updateStreakUI(); updateHomeScreen();
  } catch(e) {
    setAuthStatus('error', '⚠️ Load error — check databaseURL');
    console.error('loadFromCloud error:', e.code, e.message);
  }
}

async function saveToCloud(uid) {
  if (!db || !uid) return;
  try {
    const lvl = typeof getLevelFromXp === 'function' ? getLevelFromXp(playerXp) : 1;
    const userData = {
      name: playerName, xp: playerXp||0, coins: coins||0, streak: streakDays||0,
      skin: selectedSkin||0, owned: [...ownedSkins],
      wins: _totalWins||0, kills: _totalKills||0, level: lvl, updatedAt: Date.now(),
      pid: window._playerId || '',
    };
    // Use update not set — preserves friends subpath
    await update(ref(db, `users/${uid}`), userData);
    await update(ref(db, `leaderboard/${uid}`), {
      name: playerName, xp: playerXp||0, level: lvl,
      wins: _totalWins||0, kills: _totalKills||0, uid,
      pid: window._playerId || '',
    });
    setAuthStatus('synced', '☁️ Synced');
  } catch(e) {
    console.error('saveToCloud error:', e.code, e.message);
    // Retry once after 3s
    setTimeout(() => {
      if (currentUser && currentUser.uid === uid) {
        update(ref(db, `leaderboard/${uid}`), {
          name: playerName, xp: playerXp||0,
          level: typeof getLevelFromXp==='function'?getLevelFromXp(playerXp):1,
          wins: _totalWins||0, kills: _totalKills||0, uid,
          pid: window._playerId || '',
        }).catch(()=>{});
      }
    }, 3000);
  }
}

window.addXp = function(amount, reason) {
  if (!amount) return;
  const oldLevel = typeof getLevelFromXp==='function' ? getLevelFromXp(playerXp) : 1;
  playerXp += amount; saveData(); updateXpUI();
  const newLevel = typeof getLevelFromXp==='function' ? getLevelFromXp(playerXp) : 1;
  if (newLevel > oldLevel) {
    if (typeof showXpToast==='function') showXpToast(`⭐ Level ${newLevel}! +${100+newLevel*20}🪙`);
    coins += 100 + newLevel * 20; saveData();
  }
  if (currentUser) setTimeout(() => saveToCloud(currentUser.uid), 1000);
};

window.fbSaveToCloud = () => { if (currentUser) saveToCloud(currentUser.uid); };

/* ══ LEADERBOARD ══ */
window._firebaseSwitchLbMainTab = (tab) => {
  if (IS_YANDEX_BUILD && tab === 'fr') tab = 'lb';
  const lbEl = document.getElementById('lb-tab-leaderboard');
  const frEl = document.getElementById('lb-tab-friends');
  const btnLb = document.getElementById('lb-main-tab-lb');
  const btnFr = document.getElementById('lb-main-tab-fr');
  if (lbEl) lbEl.style.display = tab==='lb' ? 'block' : 'none';
  if (frEl) frEl.style.display = tab==='fr' ? 'flex'  : 'none';
  if (btnLb) { btnLb.style.background=tab==='lb'?'rgba(96,165,250,.15)':'var(--surface)'; btnLb.style.color=tab==='lb'?'var(--accent)':'var(--muted)'; btnLb.style.borderColor=tab==='lb'?'rgba(96,165,250,.4)':'var(--border)'; }
  if (btnFr) { btnFr.style.background=tab==='fr'?'rgba(96,165,250,.15)':'var(--surface)'; btnFr.style.color=tab==='fr'?'var(--accent)':'var(--muted)'; btnFr.style.borderColor=tab==='fr'?'rgba(96,165,250,.4)':'var(--border)'; }
  // Update my ID display
  const myIdEl = document.getElementById('fr-my-id');
  if (myIdEl) myIdEl.textContent = window._playerId || '—';
  if (tab==='fr' && !IS_YANDEX_BUILD) loadFriendsList();
};

/* ══ FRIENDS ══ */
let _friends = []; // [{uid, name, xp, level, pid}]

async function addFriendById() {
  if (!currentUser || !db) { setFriendStatus('Sign in first'); return; }
  const inp = document.getElementById('friend-id-input');
  const pid = inp?.value.trim().toUpperCase();
  if (!pid || pid.length !== 7) { setFriendStatus('Enter a valid 7-character ID'); return; }
  if (pid === window._playerId) { setFriendStatus("That's your own ID!"); return; }
  setFriendStatus('Searching...');
  try {
    // Search leaderboard for this pid
    const snap = await get(ref(db, 'leaderboard'));
    if (!snap.exists()) { setFriendStatus('Player not found'); return; }
    let found = null;
    snap.forEach(c => { const v=c.val(); if(v.pid===pid) found={uid:c.key,...v}; });
    if (!found) { setFriendStatus('Player not found. Make sure they are registered.'); return; }

    // Save to my friends list in Firebase
    await set(ref(db, `users/${currentUser.uid}/friends/${found.uid}`), {
      uid: found.uid, name: found.name, pid: found.pid,
      xp: found.xp||0, level: found.level||1, addedAt: Date.now(),
    });
    setFriendStatus(`✓ ${found.name} added!`);
    if (inp) inp.value = '';
    loadFriendsList();
  } catch(e) {
    setFriendStatus('Error: ' + e.message);
    console.error(e);
  }
}

async function loadFriendsList() {
  if (!currentUser || !db) return;
  const listEl = document.getElementById('friends-list');
  if (!listEl) return;
  listEl.innerHTML = '<div style="text-align:center;padding:16px;color:var(--muted);font-size:.8rem">Loading...</div>';
  try {
    const snap = await get(ref(db, `users/${currentUser.uid}/friends`));
    if (!snap.exists()) {
      listEl.innerHTML = '<div style="text-align:center;padding:24px;color:var(--muted);font-size:.82rem">No friends yet — add by ID 👆</div>';
      return;
    }
    const friends = [];
    snap.forEach(c => friends.push(c.val()));
    friends.sort((a,b)=>(b.xp||0)-(a.xp||0));
    listEl.innerHTML = friends.map(f => `
      <div style="display:flex;align-items:center;gap:10px;
        background:var(--surface);border:1px solid var(--border);
        border-radius:12px;padding:10px 14px;margin-bottom:6px;">
        <div style="width:36px;height:36px;border-radius:50%;
          background:linear-gradient(135deg,#60a5fa,#a78bfa);
          display:flex;align-items:center;justify-content:center;
          font-size:.9rem;font-weight:900;flex-shrink:0">
          ${(f.name||'?')[0].toUpperCase()}
        </div>
        <div style="flex:1;min-width:0">
          <div style="font-size:.88rem;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(f.name||'Player')}</div>
          <div style="font-size:.68rem;color:var(--muted)">⭐ Lv.${f.level||1} · ${(f.xp||0).toLocaleString()} XP · ID: ${f.pid||'—'}</div>
        </div>
        <button onclick="removeFriend('${f.uid}')" style="
          background:rgba(248,113,113,.12);border:1px solid rgba(248,113,113,.2);
          border-radius:8px;color:#f87171;font-size:.7rem;padding:4px 8px;cursor:pointer;">✕</button>
      </div>`).join('');
  } catch(e) {
    listEl.innerHTML = '<div style="text-align:center;padding:16px;color:#f87171;font-size:.8rem">Error loading friends</div>';
  }
}

async function removeFriend(uid) {
  if (!currentUser || !db) return;
  try {
    const { remove } = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js');
    await remove(ref(db, `users/${currentUser.uid}/friends/${uid}`));
    loadFriendsList();
  } catch(e) { console.error(e); }
}

function setFriendStatus(msg) {
  const el = document.getElementById('friend-add-status');
  if (el) el.textContent = msg;
}

window._firebaseSwitchLbTab = (tab) => {
  _lbTab = tab;
  ['xp','wins','kills'].forEach(t => {
    document.getElementById('lb-tab-'+t)?.classList.toggle('active', t===tab);
  });
  loadLeaderboard();
};

window._firebaseRefreshLeaderboard = async () => {
  const btn = document.getElementById('lb-refresh-btn');
  if (btn) {
    btn.textContent = '↻ Loading...';
    btn.style.opacity = '0.6';
    btn.disabled = true;
  }
  await loadLeaderboard();
  if (btn) {
    btn.textContent = '↻ Refresh';
    btn.style.opacity = '1';
    btn.disabled = false;
  }
};

async function loadLeaderboard() {
  const loadEl = document.getElementById('lb-loading');
  const noEl   = document.getElementById('lb-noauth');
  const podEl  = document.getElementById('lb-podium');
  const lstEl  = document.getElementById('lb-list');

  if (!currentUser && !IS_YANDEX_BUILD) {
    if (loadEl) loadEl.style.display = 'none';
    if (noEl)   noEl.style.display   = 'block';
    if (podEl)  podEl.innerHTML      = '';
    if (lstEl)  lstEl.innerHTML      = '';
    return;
  }
  if (!db) {
    if (loadEl) loadEl.textContent = '⚠️ Firebase not connected';
    return;
  }
  if (loadEl) { loadEl.style.display = 'block'; loadEl.textContent = '🔄 Loading...'; }
  if (noEl)   noEl.style.display     = 'none';
  if (podEl)  podEl.innerHTML        = '';
  if (lstEl)  lstEl.innerHTML        = '';

  try {
    const field = _lbTab==='xp' ? 'xp' : _lbTab==='wins' ? 'wins' : 'kills';
    let entries = [];

    const parseEntry = (uid, raw = {}) => ({
      uid,
      name: raw.name || 'Player',
      xp: Number(raw.xp) || 0,
      wins: Number(raw.wins) || 0,
      kills: Number(raw.kills) || 0,
      level: Number(raw.level) || 1,
      pid: raw.pid || '',
    });

    try {
      // limitToLast(200) — Firebase returns in ASCENDING order, we reverse below
      const q = query(ref(db,'leaderboard'), orderByChild(field), limitToLast(200));
      const snap = await get(q);
      if (snap.exists()) {
        snap.forEach(c => entries.push(parseEntry(c.key, c.val())));
      }
    } catch(indexErr) {
      if (indexErr.message && indexErr.message.includes('Index not defined')) {
        if (loadEl) loadEl.textContent = '⚠️ Add .indexOn to Firebase Rules!';
        const hint = document.createElement('div');
        hint.style.cssText = 'font-size:.72rem;color:rgba(255,255,255,.5);padding:10px 14px;line-height:1.8';
        hint.innerHTML = `<b style="color:#fbbf24">Fix in Firebase Console → Realtime Database → Rules:</b>
<pre style="font-size:.65rem;background:rgba(0,0,0,.4);padding:8px;border-radius:8px;margin-top:6px;overflow-x:auto">{
  "rules": {
    "users": {
      "$uid": {
        ".read": "$uid === auth.uid",
        ".write": "$uid === auth.uid"
      }
    },
    "leaderboard": {
      ".read": true,
      ".write": "auth !== null",
      ".indexOn": ["xp", "wins", "kills"]
    }
  }
}</pre>`;
        if (lstEl) { lstEl.innerHTML=''; lstEl.appendChild(hint); }
        if (loadEl) loadEl.style.display='none';
        return;
      } else {
        throw indexErr;
      }
    }

    // Fallback: if ordered query returned too little data, load full leaderboard
    if (entries.length <= 1) {
      const fullSnap = await get(ref(db, 'leaderboard'));
      if (fullSnap.exists()) {
        entries = [];
        fullSnap.forEach(c => entries.push(parseEntry(c.key, c.val())));
      }
    }

    if (!entries.length) {
      if (loadEl) loadEl.textContent = 'No players yet. Be first! 🚀';
      return;
    }

    // Sort descending by field (highest first)
    entries.sort((a,b)=>(b[field]||0)-(a[field]||0));

    const myUid  = currentUser ? currentUser.uid : null;
    const myRank = myUid ? (entries.findIndex(e=>e.uid===myUid)+1) : 0;
    const rankEl = document.getElementById('lb-my-rank');
    if (rankEl) rankEl.textContent = myRank>0 ? `#${myRank} / ${entries.length}` : (IS_YANDEX_BUILD ? `Guest / ${entries.length}` : 'Not ranked');
    if (loadEl) loadEl.style.display = 'none';

    const medals  = ['🥇','🥈','🥉'];
    const sfx     = _lbTab==='xp'?'XP':_lbTab==='wins'?'wins':'kills';
    const rankIcons = ['🥇','🥈','🥉'];

    // Show podium only if 3+ entries
    if (podEl) {
      if (entries.length >= 3) {
        // Classic podium: 2nd left, 1st center, 3rd right
        const order = [1,0,2]; // indices: left=2nd, center=1st, right=3rd
        podEl.style.display = '';
        podEl.innerHTML = order.map((idx,pos)=>{
          const e = entries[idx];
          if(!e) return '';
          const cls = ['second','first','third'][pos];
          return `<div class="lb-podium-item ${cls}">
            <div class="lb-pod-medal">${medals[idx]}</div>
            <div class="lb-pod-name">${esc(e.name||'Player')}</div>
            <div class="lb-pod-val">${(e[field]||0).toLocaleString()} ${sfx}</div>
          </div>`;
        }).join('');
      } else {
        podEl.style.display = 'none';
      }
    }

    // Full list — ALL entries (including top 3 when <3 total)
    if (lstEl) {
      const listStart = entries.length >= 3 ? 3 : 0;
      if (entries.length === 0) {
        lstEl.innerHTML = '<div style="text-align:center;padding:20px;color:var(--muted);font-size:.85rem">No players yet — play a match to appear here! 🚀</div>';
      } else {
        lstEl.innerHTML = entries.slice(listStart).map((e,i)=>{
          const rank = listStart + i + 1;
          const icon = rankIcons[rank-1] || '';
          const isMe = myUid ? (e.uid === myUid) : false;
          return `<div class="lb-list-item${isMe?' me':''}">
            <div class="lb-rank">${icon || rank}</div>
            <div class="lb-list-name">${esc(e.name||'Player')}${isMe?' <span style="font-size:.65rem;color:var(--accent)">(You)</span>':''}</div>
            <div class="lb-list-val">${(e[field]||0).toLocaleString()} ${sfx}</div>
          </div>`;
        }).join('');

        // If < 3 entries, show empty slots for motivation
        if (entries.length < 3) {
          const emptySlots = 3 - entries.length;
          for(let i=0;i<emptySlots;i++){
            lstEl.innerHTML += `<div class="lb-list-item" style="opacity:.3">
              <div class="lb-rank">${medals[entries.length+i]}</div>
              <div class="lb-list-name" style="font-style:italic">Could be you...</div>
              <div class="lb-list-val">—</div>
            </div>`;
          }
        }
      }
    }
  } catch(err) {
    if (loadEl) loadEl.textContent = '⚠️ Error: ' + err.message;
    console.error('Leaderboard error:', err);
  }
}

window._firebaseLoadLeaderboard = loadLeaderboard;

function esc(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

/* ══ HOOK navTo ══ */
const _origNavTo = window.navTo;
window.navTo = function(name) {
  if (typeof SCREENS !== 'undefined') {
    SCREENS['leaderboard'] = 'screen-leaderboard';
    SCREENS['world']       = 'screen-world';
    SCREENS['cases']       = 'screen-cases';
  }
  if (_origNavTo) _origNavTo(name);
  if (name === 'leaderboard') {
    if (typeof switchLbMainTab === 'function') switchLbMainTab('lb');
    loadLeaderboard();
  }
  ['home','cases','leaderboard','settings'].forEach(id => {
    document.getElementById('nav-'+id)?.classList.toggle('active', id===name);
  });
};

setInterval(() => { if (currentUser) saveToCloud(currentUser.uid); }, 3*60*1000);
console.log('🔥 Firebase module loaded');

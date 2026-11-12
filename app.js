// 早押しクイズ盤 (Firebase Realtime Database 版)
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, signInAnonymously, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getDatabase, ref, onValue, set, update, push, remove, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";
import { firebaseConfig } from "./firebase-config.js";

const $ = s => document.querySelector(s);
const DEFAULT_LABELS = ['はい','いいえ','どちらかといえばはい','どちらかといえばいいえ','場合による','関係ない'];
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_RE = /^[A-Z0-9]{4,10}$/;

// ---------- 状態 ----------
let db, auth;
let uid = null, room = null, hostUid = null;
let state = null, players = {}, questions = {}, problems = {};
let winner = null, lockKey = null, lockOff = null, offset = 0;
let busy = false, hostBusy = false, autoKey = null, loaded = false, flashTimer = null, audioCtx = null;
const offs = [];

const isHost = () => !!uid && hostUid === uid;
const R = p => ref(db, `rooms/${room}/${p}`);
const now = () => Date.now() + offset;
const keysOf = o => Object.keys(o || {});

function fatal(msg){ const f = $('#fatal'); f.textContent = msg; f.hidden = false; }
function foot(msg){ $('#foot').textContent = msg; }
function flash(msg){ const f=$('#flash'); f.textContent=msg; clearTimeout(flashTimer); flashTimer=setTimeout(()=>f.textContent='',2500); }
function nameOf(id){ return (players[id] && players[id].name) || '名無し'; }
function errMsg(e){
  const c = e && (e.code || e.message || '');
  if(String(c).includes('PERMISSION_DENIED') || String(c).includes('permission')) return '操作が許可されませんでした(タイミングがずれた可能性があります)';
  return '通信に失敗しました。もう一度試してください';
}
function beep(high){
  try{
    audioCtx = audioCtx || new (window.AudioContext||window.webkitAudioContext)();
    const o=audioCtx.createOscillator(), g=audioCtx.createGain();
    o.type='square'; o.frequency.value = high ? 1046 : 660;
    g.gain.setValueAtTime(.12,audioCtx.currentTime); g.gain.exponentialRampToValueAtTime(.001,audioCtx.currentTime+.45);
    o.connect(g).connect(audioCtx.destination); o.start(); o.stop(audioCtx.currentTime+.45);
  }catch(e){}
}
document.addEventListener('pointerdown',()=>{ try{ audioCtx = audioCtx || new (window.AudioContext||window.webkitAudioContext)(); }catch(e){} },{once:true});

const settings = () => ({ duration:10, labels:DEFAULT_LABELS, penalty:false, ...((state && state.settings) || {}) });
const labels = () => { const l = settings().labels; return Array.isArray(l) && l.length >= 2 ? l : DEFAULT_LABELS; };
const base = () => ({ round:0, attempt:0, phase:'idle', open:false, lockKey:null, excluded:null, scores:null,
  result:null, reveal:null, endsAt:null, problemId:null, used:null, settings:settings(), ...(state || {}) });
const clean = o => JSON.parse(JSON.stringify(o)); // undefined を取り除く(Firebase は undefined を保存できない)

// ---------- 起動 ----------
function start(){
  if(!firebaseConfig || !firebaseConfig.apiKey || String(firebaseConfig.apiKey).includes('ここに')){
    fatal('firebase-config.js に Firebase の設定値がまだ入っていません。手順書の「設定値を書き込む」を見てください');
    return;
  }
  const app = initializeApp(firebaseConfig);
  auth = getAuth(app); db = getDatabase(app);
  onValue(ref(db, '.info/serverTimeOffset'), s => { offset = s.val() || 0; });
  onAuthStateChanged(auth, user => {
    if(!user) return;
    if(uid) return;            // 2回目以降は無視
    uid = user.uid;
    const code = (new URLSearchParams(location.search).get('room') || '').toUpperCase();
    if(CODE_RE.test(code)) enterRoom(code); else $('#landing').hidden = false;
  });
  signInAnonymously(auth).catch(e => fatal('匿名ログインに失敗しました。Firebase で「匿名」ログインが有効になっているか確認してください (' + (e.code||'') + ')'));
}

function genCode(){ let s=''; const a=new Uint32Array(6); crypto.getRandomValues(a); a.forEach(n=>s+=CODE_CHARS[n%CODE_CHARS.length]); return s; }

$('#createBtn').addEventListener('click', async () => {
  $('#createBtn').disabled = true;
  for(let i=0;i<5;i++){
    const code = genCode();
    try{
      await set(ref(db, `rooms/${code}/host`), uid);
      await set(ref(db, `rooms/${code}/state`), clean({ round:0, attempt:0, phase:'idle', open:false,
        settings:{ duration:10, labels:DEFAULT_LABELS, penalty:false }, createdAt: serverTimestamp() }));
      history.replaceState(null, '', `?room=${code}`);
      enterRoom(code);
      return;
    }catch(e){ /* コードが使用中なら別のコードで再挑戦 */ }
  }
  $('#createBtn').disabled = false;
  fatal('部屋を作れませんでした。データベースのルールが正しく設定されているか確認してください');
});

$('#enterForm').addEventListener('submit', e => {
  e.preventDefault();
  const code = $('#roomCodeInput').value.trim().toUpperCase();
  if(!CODE_RE.test(code)){ $('#roomCodeInput').focus(); return; }
  history.replaceState(null, '', `?room=${code}`);
  enterRoom(code);
});

function enterRoom(code){
  room = code;
  $('#landing').hidden = true;
  $('#roomView').hidden = false;
  $('#roomCode').textContent = code;

  let problemsOff = null;
  offs.push(onValue(R('host'), s => {
    hostUid = s.val();
    if(!hostUid){ fatal('この部屋は見つかりませんでした。部屋コードを確認してください'); $('#roomView').hidden = true; $('#landing').hidden = false; return; }
    if(isHost() && !problemsOff){
      problemsOff = onValue(ref(db, `hosts/${uid}/problems`), ps => { problems = ps.val() || {}; render(); });
    }
    render();
  }, e => fatal('部屋を読み込めませんでした (' + (e.code||'') + ')')));
  offs.push(onValue(R('state'), s => { loaded = true; state = s.val(); watchLock(); if(isHost()) fillSettings(); render(); }));
  offs.push(onValue(R('players'), s => { players = s.val() || {}; render(); }));
  offs.push(onValue(R('questions'), s => { questions = s.val() || {}; render(); }));
}

$('#copyBtn').addEventListener('click', async () => {
  const url = `${location.origin}${location.pathname}?room=${room}`;
  try{ await navigator.clipboard.writeText(url); flashFoot('招待リンクをコピーしました'); }
  catch(e){ const b=$('#linkBox'); b.value=url; b.hidden=false; b.select(); flashFoot('リンクを選択しました。コピーして送ってください'); }
});
function flashFoot(m){ foot(m); setTimeout(()=>{ if($('#foot').textContent===m) foot(''); }, 3000); }

// ---------- 表示 ----------
function canBuzz(){
  return !!(uid && players[uid] && state && state.phase==='buzz' && state.open && state.lockKey && !winner && !busy
    && !(state.excluded && state.excluded[uid]));
}
function roundQuestions(){
  if(!state) return [];
  return Object.entries(questions).map(([id,q])=>({id,...q}))
    .filter(q => q.round === state.round)
    .sort((a,b)=>(a.at||0)-(b.at||0));
}
function remaining(){ return state && state.endsAt ? Math.max(0, state.endsAt - now()) : 0; }
function fmt(ms){ const t=Math.ceil(ms/1000); return `${Math.floor(t/60)}:${String(t%60).padStart(2,'0')}`; }
function chipClass(l){ const L=labels(); return l===L[0]?'yes':l===L[1]?'no':''; }

function renderBoard(){
  const ex = keysOf(state && state.excluded);
  $('#round').textContent = state && state.round ? `第 ${state.round} 問` : '';
  const b=$('#board'), ph=$('#boardPhase'), pr=$('#boardPrompt'), tm=$('#boardTimer'), big=$('#boardBig'), sub=$('#boardSub');
  b.classList.toggle('open', !!(state && state.phase==='buzz' && state.open && !winner));
  b.classList.toggle('won', !!winner);
  const rv = state && state.phase==='done' && state.reveal;
  pr.hidden = !(rv && rv.prompt); pr.textContent = rv ? (rv.prompt||'') : '';
  tm.hidden = true; big.hidden = false;
  if(!loaded) return;
  if(!state || state.phase==='idle' || !state.round){ ph.textContent='準備中'; big.textContent='司会の出題を待っています'; sub.textContent='司会が問題を選ぶと質問タイムが始まります'; return; }
  if(state.phase==='question'){
    const r=remaining();
    ph.textContent='質問タイム'; tm.hidden=false; tm.textContent=fmt(r); tm.classList.toggle('low', r<=60000);
    big.hidden=true; sub.textContent = r>0 ? 'ヒントを出しすぎないように、慎重に質問しましょう' : '時間切れ!まもなく早押しタイムです';
    return;
  }
  if(state.phase==='buzz'){
    ph.textContent='早押しタイム';
    if(winner){ big.textContent=`${nameOf(winner)} さんが押しました!`; sub.textContent = winner===uid ? 'あなたの回答です' : '回答を聞きましょう'; }
    else if(state.open){ big.textContent='早押し受付中!'; sub.textContent = ex.includes(uid) ? 'この問題はもう回答済みです' : (ex.length ? `回答済み: ${ex.map(nameOf).join('、')}` : '答えがわかったら押してください'); }
    else { big.textContent='受付を止めています'; sub.textContent=''; }
    return;
  }
  ph.textContent='結果';
  big.textContent = rv && rv.answer ? `答えは「${rv.answer}」` : 'この問題は終了です';
  const r=state.result; sub.textContent = r && r.ok ? `${nameOf(r.uid)} さん 正解!` : '正解者なし';
}

function render(){
  if(!room) return;
  renderBoard();
  const ex = keysOf(state && state.excluded);
  const joined = !!(uid && players[uid]);
  $('#joinPanel').hidden = !loaded || joined;
  $('#stage').hidden = !joined;
  $('#buzzer').disabled = !canBuzz();
  $('#askForm').hidden = !(joined && state && state.phase==='question');
  $('#copyBtn').hidden = !isHost();

  // 質問ログ
  const qs = roundQuestions(), log=$('#log'), L=labels();
  if(!qs.length){
    const li=document.createElement('li'); li.className='empty';
    li.textContent = state && state.phase==='question' ? 'まだ質問はありません' : '質問タイムに出た質問と答えがここに並びます';
    log.replaceChildren(li);
  } else {
    log.replaceChildren(...qs.map(q=>{
      const li=document.createElement('li');
      const row=document.createElement('div'); row.className='q';
      const by=document.createElement('span'); by.className='by'; by.textContent=nameOf(q.by);
      const tx=document.createElement('span'); tx.className='tx'; tx.textContent=q.text;
      const a=q.answer;
      const chip=document.createElement('span'); chip.className='chip '+(a?chipClass(a):'wait'); chip.textContent=a||'回答待ち';
      row.append(by,tx,chip); li.append(row);
      if(isHost()){
        const box=document.createElement('div'); box.className='ans';
        L.forEach(l=>{ const bt=document.createElement('button'); bt.type='button'; bt.className='btn sm'+(a===l?' on':''); bt.textContent=l;
          bt.onclick=()=>update(R(`questions/${q.id}`),{answer:l}).catch(e=>foot(errMsg(e))); box.append(bt); });
        li.append(box);
      }
      return li;
    }));
  }

  // 回答者ランプ
  const ids=keysOf(players), lamps=$('#lamps');
  if(!ids.length){ lamps.innerHTML='<div class="empty">まだ誰も参加していません。名前を入れて参加してください</div>'; }
  else{
    const sc=(state && state.scores)||{}, qc={};
    qs.forEach(q=>{ qc[q.by]=(qc[q.by]||0)+1; });
    ids.sort((a,b)=>(sc[b]||0)-(sc[a]||0) || nameOf(a).localeCompare(nameOf(b),'ja'));
    lamps.replaceChildren(...ids.map(id=>{
      const el=document.createElement('div');
      el.className='lamp'+(id===winner?' lit':'')+(ex.includes(id)&&state&&state.phase==='buzz'?' out':'');
      const dot=document.createElement('span'); dot.className='dot';
      const who=document.createElement('span'); who.className='who';
      const nm=document.createElement('span'); nm.className='nm'; nm.textContent=nameOf(id)+(id===uid?'(あなた)':'');
      const c=document.createElement('span'); c.className='qc'; c.textContent=`この問題の質問 ${qc[id]||0} 回`;
      who.append(nm,c);
      const pt=document.createElement('span'); pt.className='pt'; pt.textContent=(sc[id]||0);
      el.append(dot,who,pt); return el;
    }));
  }

  // 司会パネル
  $('#hostPanel').hidden = !isHost();
  if(isHost()){
    const ph = state ? state.phase : 'idle';
    $('#hBuzz').disabled = hostBusy || ph!=='question';
    $('#hPlus').disabled = hostBusy || ph!=='question';
    $('#hOk').disabled = $('#hNg').disabled = hostBusy || !winner || ph!=='buzz';
    $('#hRetry').disabled = hostBusy || ph!=='buzz';
    $('#hReveal').disabled = hostBusy || !(ph==='question'||ph==='buzz');
    $('#hReset').disabled = hostBusy || !state;
    const sel=$('#hAskWho'), cur=sel.value;
    sel.replaceChildren(...ids.map(id=>{ const o=document.createElement('option'); o.value=id; o.textContent=nameOf(id); return o; }));
    if(ids.includes(cur)) sel.value=cur;
    $('#hAskForm').querySelector('button').disabled = !ids.length || ph!=='question';
    const used=(state && state.used)||{};
    const list=Object.entries(problems).map(([id,p])=>({id,...p})).sort((a,b)=>(a.createdAt||0)-(b.createdAt||0));
    const pl=$('#plist');
    if(!list.length){ pl.innerHTML='<li class="empty">まだ問題がありません。上の欄から登録してください</li>'; }
    else pl.replaceChildren(...list.map(p=>{
      const li=document.createElement('li'); if(used[p.id]) li.className='used';
      const t=document.createElement('div'); t.className='pp';
      const a=document.createElement('div'); a.textContent=p.prompt||'(問題文なし)';
      const b=document.createElement('div'); b.className='pa'; b.textContent='答え:'+p.answer+(used[p.id]?'(出題済み)':'');
      t.append(a,b);
      const go=document.createElement('button'); go.type='button'; go.className='btn sm primary'; go.textContent='この問題で開始';
      go.disabled = hostBusy || ph==='question' || ph==='buzz'; go.onclick=()=>startProblem(p);
      const del=document.createElement('button'); del.type='button'; del.className='btn sm'; del.textContent='削除';
      del.onclick=()=>remove(ref(db,`hosts/${uid}/problems/${p.id}`)).catch(e=>foot(errMsg(e)));
      li.append(t,go,del); return li;
    }));
  }
}

// タイマー表示(書き込みはしない。司会の画面だけが時間切れで1回だけ進行させる)
setInterval(()=>{
  if(!state || state.phase!=='question') return;
  renderBoard();
  if(isHost() && remaining()<=0){ const k='r'+state.round; if(autoKey!==k && !hostBusy){ autoKey=k; toBuzz(); } }
},250);

// ---------- 早押し ----------
function watchLock(){
  const key = state && (state.phase==='buzz' || state.phase==='done') ? (state.lockKey || null) : null;
  if(key===lockKey) return;
  lockKey=key; if(lockOff){ lockOff(); lockOff=null; }
  winner=null;
  if(!key) return;
  let prev=null;
  lockOff = onValue(R(`buzz/${key}`), s => {
    const d=s.val();
    winner = d && d.uid ? d.uid : null;
    if(winner && winner!==prev && state && state.phase==='buzz'){ beep(winner===uid); if(winner===uid && navigator.vibrate) try{navigator.vibrate(120)}catch(e){} }
    prev=winner; render();
  });
}
async function buzz(){
  if(!canBuzz()) return;
  busy=true; render();
  try{ await set(R(`buzz/${state.lockKey}`), { uid, at: serverTimestamp() }); flash('一番乗り!'); }
  catch(e){ flash('タッチの差でした…'); }   // 先に誰かが押していればルールで拒否される
  busy=false; render();
}
$('#buzzer').addEventListener('click', buzz);
document.addEventListener('keydown', e=>{
  if(e.code!=='Space' || e.repeat) return;
  const t=e.target; if(t && /^(INPUT|BUTTON|TEXTAREA|SELECT)$/.test(t.tagName)) return;
  e.preventDefault(); buzz();
});

// ---------- 参加・質問 ----------
$('#joinForm').addEventListener('submit', async e=>{
  e.preventDefault();
  const name=$('#nameInput').value.trim().slice(0,16);
  if(!name){ $('#nameInput').focus(); return; }
  $('#joinBtn').disabled=true;
  try{ await set(R(`players/${uid}`), { name }); }catch(err){ foot(errMsg(err)); }
  $('#joinBtn').disabled=false;
});
async function addQuestion(text, by){
  if(!state) return false;
  try{ await push(R('questions'), { text, by, author:uid, round:state.round, at:serverTimestamp() }); return true; }
  catch(e){ foot(errMsg(e)); return false; }
}
$('#askForm').addEventListener('submit', async e=>{
  e.preventDefault();
  const t=$('#askInput').value.trim(); if(!t) return;
  $('#askBtn').disabled=true;
  if(await addQuestion(t, uid)) $('#askInput').value='';
  $('#askBtn').disabled=false;
});
$('#hAskForm').addEventListener('submit', async e=>{
  e.preventDefault();
  const t=$('#hAskInput').value.trim(), who=$('#hAskWho').value; if(!t||!who) return;
  if(await addQuestion(t, who)) $('#hAskInput').value='';
});

// ---------- 司会 ----------
async function hostSet(next){
  if(hostBusy) return; hostBusy=true; render();
  try{ await set(R('state'), clean(next)); }catch(e){ foot(errMsg(e)); }
  hostBusy=false; render();
}
function current(){ return state && state.problemId ? problems[state.problemId] : null; }
function startProblem(p){
  const s=base(), dur=Math.max(1,Math.min(60,Number(settings().duration)||10));
  hostSet({ ...s, round:(s.round||0)+1, attempt:0, phase:'question', open:false, lockKey:null, excluded:null, result:null,
    reveal:null, endsAt: now()+dur*60000, problemId:p.id, used:{ ...(s.used||{}), [p.id]:true } });
}
function toBuzz(){ const s=base(), a=(s.attempt||0)+1; hostSet({ ...s, phase:'buzz', open:true, attempt:a, lockKey:`r${s.round}a${a}`, endsAt:null }); }
function revealObj(){ const p=current(); return p ? { prompt:p.prompt||'', answer:p.answer||'' } : null; }
$('#hBuzz').onclick = toBuzz;
$('#hPlus').onclick = () => { const s=base(); hostSet({ ...s, endsAt: Math.max(s.endsAt||0, now())+60000 }); };
$('#hOk').onclick = () => { if(!winner) return; const s=base(), sc={...(s.scores||{})}; sc[winner]=(sc[winner]||0)+1;
  hostSet({ ...s, scores:sc, phase:'done', open:false, reveal:revealObj(), result:{ uid:winner, ok:true } }); };
$('#hNg').onclick = () => { if(!winner) return; const s=base(), sc={...(s.scores||{})};
  if(settings().penalty) sc[winner]=(sc[winner]||0)-1;
  const a=(s.attempt||0)+1;
  hostSet({ ...s, scores:sc, excluded:{ ...(s.excluded||{}), [winner]:true }, attempt:a, lockKey:`r${s.round}a${a}`, open:true, result:{ uid:winner, ok:false } }); };
$('#hRetry').onclick = () => { const s=base(), a=(s.attempt||0)+1; hostSet({ ...s, attempt:a, lockKey:`r${s.round}a${a}`, open:true }); };
$('#hReveal').onclick = () => hostSet({ ...base(), phase:'done', open:false, endsAt:null, reveal:revealObj(), result:null });
$('#hReset').onclick = () => { $('#hReset').hidden=true; $('#hResetYes').hidden=false; $('#hResetNo').hidden=false; };
$('#hResetNo').onclick = () => { $('#hReset').hidden=false; $('#hResetYes').hidden=true; $('#hResetNo').hidden=true; };
$('#hResetYes').onclick = () => { $('#hResetNo').onclick(); hostSet({ ...base(), scores:null }); };
$('#sSave').onclick = () => {
  const dur=Math.max(1,Math.min(60,Number($('#sDur').value)||10));
  const ls=$('#sLabels').value.split(/[、,]/).map(x=>x.trim()).filter(Boolean).slice(0,8);
  hostSet({ ...base(), settings:{ duration:dur, labels: ls.length>=2 ? ls : DEFAULT_LABELS, penalty:$('#sPenalty').checked } });
  flashFoot('設定を保存しました');
};
$('#pForm').addEventListener('submit', e=>{
  e.preventDefault();
  const prompt=$('#pPrompt').value.trim(), answer=$('#pAnswer').value.trim();
  if(!answer){ $('#pAnswer').focus(); return; }
  push(ref(db,`hosts/${uid}/problems`), { prompt, answer, createdAt: Date.now() }).catch(err=>foot(errMsg(err)));
  $('#pPrompt').value=''; $('#pAnswer').value='';
});
function fillSettings(){
  const s=settings();
  if(document.activeElement!==$('#sDur')) $('#sDur').value=s.duration||10;
  if(document.activeElement!==$('#sLabels')) $('#sLabels').value=labels().join('、');
  $('#sPenalty').checked=!!s.penalty;
}

start();

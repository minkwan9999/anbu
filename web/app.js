(function () {
  const cfg = window.HYODO_CONFIG;
  const sb = window.supabase.createClient(cfg.url, cfg.key, { auth: { persistSession: false } });
  const $app = document.getElementById('app');
  const $toast = document.getElementById('toast');
  const photoInput = document.getElementById('photo-input');
  const contactPhotoInput = document.getElementById('contact-photo-input');

  /* ---------- 저장소 · 서버 ---------- */
  const store = {
    get(k) { try { return localStorage.getItem('hyodo.' + k); } catch (e) { return null; } },
    set(k, v) { try { v == null ? localStorage.removeItem('hyodo.' + k) : localStorage.setItem('hyodo.' + k, v); } catch (e) { /* 저장 불가 */ } }
  };

  async function rpc(name, args) {
    const { data, error } = await sb.rpc(name, args);
    if (error) {
      if (error.message === 'invalid_token') { forget(); }
      throw new Error(error.message);
    }
    return data;
  }

  let token = store.get('token');
  let role = store.get('role');
  let S = null;              // 서버 상태 (hyodo_state)
  const ui = { route: 'home', ctx: {}, alarm: null, heard: '' };

  function forget() {
    token = null; role = null; S = null;
    store.set('token', null); store.set('role', null);
    if (chan) { sb.removeChannel(chan); chan = null; }
  }

  /* ---------- 실시간: 바뀌면 서로 알려 주고 각자 다시 불러온다 ---------- */
  let chan = null;
  let pendingPaired = false;
  function joinChannel(name) {
    if (chan && chan._hyodo === name) return;
    if (chan) sb.removeChannel(chan);
    chan = sb.channel('hyodo-' + name, { config: { broadcast: { self: false } } });
    chan._hyodo = name;
    chan.on('broadcast', { event: 'changed' }, () => refresh())
        .on('broadcast', { event: 'paired' }, () => {
          if (role === 'senior') { toast('보호자 폰과 연결됐어요'); if (ui.route === 'pair') go('home'); }
          refresh();
        })
        .subscribe(status => {
          if (status === 'SUBSCRIBED' && pendingPaired) { pendingPaired = false; ping('paired'); }
        });
  }
  function ping(event) { if (chan) chan.send({ type: 'broadcast', event: event || 'changed', payload: {} }); }

  async function refresh() {
    if (!token) return render();
    try {
      S = await rpc('hyodo_state', { p_token: token });
      joinChannel(S.channel);
      document.documentElement.style.setProperty('--scale', role === 'senior' ? S.scale : 1);
    } catch (e) {
      if (!token) return render();
      toast('인터넷 연결을 확인해 주세요');
      return;
    }
    if (role === 'senior') { checkAlarm(); if (['home', 'medinfo', 'pair'].includes(ui.route)) render(); }
    else renderGuardianSafe();
  }

  /* ---------- 작은 도구 ---------- */
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pad = n => String(n).padStart(2, '0');
  const nowHM = () => { const d = new Date(); return pad(d.getHours()) + ':' + pad(d.getMinutes()); };
  // 어르신들이 실제로 쓰는 말로 시간대를 부른다 (0시 = 밤 12시, 12시 = 낮 12시)
  const period = h => h === 0 ? '밤' : h < 5 ? '새벽' : h < 9 ? '아침' : h < 12 ? '오전' : h === 12 ? '낮' : h < 18 ? '오후' : h < 21 ? '저녁' : '밤';
  const sayTime = hm => { const [h, m] = hm.split(':').map(Number); return period(h) + ' ' + (h % 12 || 12) + '시' + (m ? ' ' + m + '분' : ''); };
  const initial = name => { const p = String(name).trim().split(/\s+/); return (p[p.length - 1] || '?').charAt(0); };
  const COLORS = ['var(--call)', 'var(--photo)', 'var(--pill)'];
  const faceHTML = (c, cls) => c.photo
    ? '<img class="' + cls + '" src="' + esc(c.photo) + '" alt="">'
    : '<span class="' + cls + '" style="background:' + COLORS[c.slot % 3] + '">' + esc(initial(c.name)) + '</span>';

  let toastTimer;
  function toast(msg) {
    $toast.textContent = msg; $toast.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { $toast.hidden = true; }, 3000);
  }

  function resizeImage(file, max, quality, square) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        let sx = 0, sy = 0, sw = img.width, sh = img.height;
        if (square) { const s = Math.min(sw, sh); sx = (sw - s) / 2; sy = (sh - s) / 2; sw = sh = s; }
        const k = Math.min(1, max / Math.max(sw, sh));
        const c = document.createElement('canvas');
        c.width = Math.round(sw * k); c.height = Math.round(sh * k);
        c.getContext('2d').drawImage(img, sx, sy, sw, sh, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        resolve(c.toDataURL('image/jpeg', quality));
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('사진을 읽지 못했어요')); };
      img.src = url;
    });
  }

  const ICON = {
    call: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.1.4 2.3.6 3.6.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1A17 17 0 0 1 3 4c0-.6.4-1 1-1h3.5c.6 0 1 .4 1 1 0 1.3.2 2.5.6 3.6.1.3 0 .7-.2 1z"/></svg>',
    photo: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M9 3 7.2 5H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-3.2L15 3H9zm3 15a5 5 0 1 1 0-10 5 5 0 0 1 0 10zm0-2a3 3 0 1 0 0-6 3 3 0 0 0 0 6z"/></svg>',
    pill: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M4.2 13.4a5 5 0 0 1 0-7.1l2.1-2.1a5 5 0 0 1 7.1 0l6.4 6.4a5 5 0 0 1 0 7.1l-2.1 2.1a5 5 0 0 1-7.1 0zm1.4-5.7a3 3 0 0 0 0 4.3l3.2 3.2 5.6-5.6-3.2-3.2a3 3 0 0 0-4.3 0z"/></svg>',
    mic: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 15a4 4 0 0 0 4-4V5a4 4 0 0 0-8 0v6a4 4 0 0 0 4 4zm7-4a1 1 0 1 0-2 0 5 5 0 0 1-10 0 1 1 0 1 0-2 0 7 7 0 0 0 6 6.9V21h-3a1 1 0 1 0 0 2h8a1 1 0 1 0 0-2h-3v-3.1a7 7 0 0 0 6-6.9z"/></svg>'
  };

  /* ---------- 라우팅 ---------- */
  function go(route, ctx) {
    ui.route = route;
    ui.ctx = ctx || {};
    if (route === 'home') ui.heard = '';
    render();
  }

  function render() {
    if (!token) return renderStart();
    if (!S) { $app.innerHTML = '<div class="center"><p>불러오는 중…</p></div>'; return; }
    if (role === 'senior') return renderSenior();
    return renderGuardian();
  }

  /* ---------- 처음 시작 ---------- */
  function renderStart() {
    const join = (location.hash.match(/^#\/join\/(\d{6})$/) || [])[1];
    const step = ui.route === 'start-senior' || ui.route === 'start-guardian' ? ui.route : (join ? 'start-guardian' : 'start');
    if (step === 'start') {
      $app.innerHTML = '<div class="start"><h1>효도비서</h1><p>이 폰은 누가 쓰나요?</p>' +
        '<button class="role-btn" data-start="senior"><b>👵 어르신 폰</b><span>큰 버튼 3개와 말로 하기. 설정은 보호자 폰에서 합니다.</span></button>' +
        '<button class="role-btn" data-start="guardian"><b>👨‍👩‍👧 보호자 폰</b><span>자녀나 요양보호사가 약 시간·연락처를 설정하고 소식을 받습니다.</span></button></div>';
    } else if (step === 'start-senior') {
      $app.innerHTML = '<form class="start" id="f-senior"><h1>어르신 폰</h1>' +
        '<div class="field"><label for="elder-name">어르신 성함 (보호자 화면에 표시)</label><input id="elder-name" maxlength="20" placeholder="예: 김순자" autocomplete="off"></div>' +
        '<div class="err" id="err"></div>' +
        '<button class="wide-btn" style="background:var(--ink);color:var(--surface)" type="submit">시작하기</button>' +
        '<button class="small-link" type="button" data-start="back">← 뒤로</button></form>';
    } else {
      $app.innerHTML = '<form class="start" id="f-guardian"><h1>보호자 폰</h1>' +
        '<p>어르신 폰에 보이는 숫자 6자리를 넣거나, 어르신 폰의 QR을 이 폰 카메라로 찍어 주세요.</p>' +
        '<div class="field"><label for="pair-code">연결 코드</label><input id="pair-code" class="code-input" inputmode="numeric" maxlength="6" autocomplete="one-time-code" value="' + esc(join || '') + '"></div>' +
        '<div class="err" id="err"></div>' +
        '<button class="wide-btn" style="background:var(--ink);color:var(--surface)" type="submit">연결하기</button>' +
        '<button class="small-link" type="button" data-start="back">← 뒤로</button></form>';
      if (join) setTimeout(() => document.getElementById('f-guardian').requestSubmit(), 0);
    }
  }

  async function startSenior(name) {
    const r = await rpc('hyodo_create_household', { p_elder_name: name });
    token = r.token; role = 'senior'; store.set('token', token); store.set('role', role);
    ui.route = 'pair'; ui.ctx = {};
    await refresh(); render();
  }

  async function startGuardian(code) {
    const r = await rpc('hyodo_pair', { p_code: code });
    token = r.token; role = 'guardian'; store.set('token', token); store.set('role', role);
    history.replaceState(null, '', location.pathname);
    pendingPaired = true;
    ui.route = 'home';
    await refresh();
    toast('어르신 폰과 연결됐어요');
  }

  /* ---------- 어르신 화면 ---------- */
  const contacts = () => (S && S.contacts) || [];
  const nextMed = () => S.meds.find(m => m.status !== 'ok');

  function renderSenior() {
    const r = ui.route;
    const d = new Date();
    const days = ['일', '월', '화', '수', '목', '금', '토'];
    let html = '<div class="senior">';

    if (r === 'pair') {
      html += '<div class="center s-center"><h2>보호자 폰과 연결하기</h2>' +
        '<p>보호자 폰 카메라로 이 QR을 찍거나,<br>아래 숫자를 보호자 폰에 넣어 주세요</p>' +
        (S.pair_code
          ? '<div class="pair-box"><div class="qr-wrap" id="qr"></div><div class="pair-code">' + esc(S.pair_code) + '</div><div class="hint">30분 동안 쓸 수 있어요</div></div>'
          : '<div class="pair-box"><p>연결 코드 시간이 지났어요</p><button class="ghost-btn" data-act="new-code">새 코드 받기</button></div>') +
        '<button class="ghost-btn" data-go="home">다 했어요</button></div>';
    } else if (r === 'home') {
      const nm = nextMed();
      html += '<div><div class="s-date">' + (d.getMonth() + 1) + '월 ' + d.getDate() + '일 ' + days[d.getDay()] + '요일</div>' +
        '<div class="s-time">' + sayTime(nowHM()) + '</div></div>' +
        (S.meds.length === 0 ? '' : nm
          ? '<div class="s-next">💊 <span>다음 약 <b>' + sayTime(nm.time) + '</b><br>' + esc(nm.label) + '</span></div>'
          : '<div class="s-next">✅ <span>오늘 약 다 드셨어요</span></div>') +
        '<div class="big-grid">' +
          '<button class="big b-call" data-go="call">' + ICON.call + '전화하기</button>' +
          '<button class="big b-photo" data-go="photo-who">' + ICON.photo + '사진 보내기</button>' +
          '<button class="big b-pill" data-act="took">' + ICON.pill + '약 먹었어</button>' +
        '</div>' +
        '<button class="mic" data-act="voice">' + ICON.mic + '말로 하기</button>' +
        '<button class="small-link" data-act="show-pair">보호자 폰 연결</button>';
    } else if (r === 'call' || r === 'photo-who') {
      const isCall = r === 'call';
      html += '<div class="s-head"><button class="back" data-go="home">← 처음으로</button></div>' +
        '<div class="s-title">' + (isCall ? '누구에게 전화할까요?' : '누구에게 보낼까요?') + '</div>';
      html += contacts().length
        ? '<div class="s-list">' + contacts().map(c =>
            '<button class="person" data-pick="' + c.slot + '">' + faceHTML(c, 'face') +
            '<span>' + esc(c.name) + '<small>' + (isCall ? '누르면 전화가 걸려요' : '누르면 사진을 찍어요') + '</small></span></button>').join('') + '</div>'
        : '<div class="center s-center"><p>아직 연락처가 없어요.<br>보호자 폰에서 넣어 주세요.</p></div>';
    } else if (r === 'calling') {
      const c = ui.ctx.who;
      html += '<div class="center s-center">' + faceHTML(c, 'face face-xl pulse') +
        '<h2>' + esc(c.name) + '에게<br>전화를 걸어요</h2>' +
        (c.phone ? '<a class="wide-btn" style="background:var(--call);text-decoration:none" href="tel:' + esc(c.phone.replace(/[^0-9+]/g, '')) + '">전화 걸기</a>'
                 : '<p>전화번호가 없어요.<br>보호자 폰에서 넣어 주세요.</p>') +
        '<button class="ghost-btn" data-go="home">처음으로</button></div>';
    } else if (r === 'photo-send') {
      const c = ui.ctx.who;
      html += '<div class="s-head"><button class="back" data-go="photo-who">← 뒤로</button></div>' +
        '<div class="s-title">' + esc(c.name) + '에게 보낼 사진</div>' +
        (ui.ctx.img
          ? '<img class="preview-img" src="' + ui.ctx.img + '" alt="보낼 사진">' +
            '<button class="wide-btn" style="background:var(--photo)" data-act="send"' + (ui.ctx.sending ? ' disabled' : '') + '>' + (ui.ctx.sending ? '보내는 중…' : '이 사진 보내기') + '</button>' +
            '<button class="ghost-btn" data-act="shoot">다시 찍기</button>'
          : '<div class="center"><button class="wide-btn" style="background:var(--photo)" data-act="shoot">📷 사진 찍기</button></div>');
    } else if (r === 'sent') {
      html += '<div class="center s-center"><div class="ring" style="background:var(--photo)">✓</div>' +
        '<h2>' + esc(ui.ctx.who.name) + '에게<br>사진을 보냈어요</h2><button class="ghost-btn" data-go="home">처음으로</button></div>';
    } else if (r === 'took') {
      html += '<div class="center s-center"><div class="ring" style="background:var(--pill)">✓</div>' +
        '<h2>잘하셨어요!</h2><p>' + esc(ui.ctx.label) + ' 드신 것을<br>보호자에게 알렸어요</p>' +
        '<button class="wide-btn" style="background:var(--ink);color:var(--surface)" data-go="home">처음으로</button>' +
        '<button class="ghost-btn" data-act="undo">↩ 잘못 눌렀어요<br><small>아직 안 먹었어요</small></button></div>';
    } else if (r === 'undone') {
      html += '<div class="center s-center"><div class="ring" style="background:var(--wait-fg)">↩</div>' +
        '<h2>되돌렸어요</h2><p>' + esc(ui.ctx.label) + '은 아직 안 드신 걸로 할게요.<br>드신 다음에 다시 눌러 주세요</p>' +
        '<button class="ghost-btn" data-go="home">처음으로</button></div>';
    } else if (r === 'medinfo' || r === 'nomed') {
      const left = S.meds.filter(m => m.status !== 'ok');
      html += '<div class="center s-center"><div class="ring" style="background:var(--pill)">💊</div>' +
        (r === 'nomed' ? '<h2>지금 드실 약은 없어요</h2>' : '') +
        (left.length ? '<p>' + left.map(m => sayTime(m.time) + ' ' + esc(m.label)).join('<br>') + '</p>'
                     : '<h2>오늘 약은<br>다 드셨어요</h2>') +
        '<button class="ghost-btn" data-go="home">처음으로</button></div>';
    }
    html += '</div>';

    if (ui.voiceOpen) html += voiceHTML();
    if (ui.alarm) {
      const m = ui.alarm;
      html += '<div class="overlay alarm"><div class="center"><div class="ring pulse" style="background:rgba(255,255,255,.2)">💊</div>' +
        '<h2>약 드실 시간이에요</h2><div class="med-name">' + esc(m.label) + '</div><p>' + sayTime(m.time) + '</p></div>' +
        '<button class="wide-btn" data-act="alarm-took">먹었어요</button>' +
        '<button class="ghost-btn" data-act="alarm-snooze">10분 뒤에 다시 알려줘</button></div>';
    }
    $app.innerHTML = html;

    const qr = document.getElementById('qr');
    if (qr && window.QRCode) {
      new window.QRCode(qr, { text: location.origin + location.pathname + '#/join/' + S.pair_code, width: 200, height: 200, correctLevel: window.QRCode.CorrectLevel.M });
    }
    const f = document.getElementById('say-form');
    if (f) f.addEventListener('submit', e => { e.preventDefault(); const v = document.getElementById('say-input').value.trim(); if (v) handleUtterance([v]); });
  }

  async function takeMed() {
    stopAlarm();
    try {
      const r = await rpc('hyodo_take_med', { p_token: token });
      if (r.none) { await refresh(); return go('nomed'); }
      // 새로 불러오기 전에 알람이 다시 울리지 않도록 바로 표시해 둔다
      const m = S.meds.find(x => x.label === r.label && x.status !== 'ok');
      if (m) m.status = 'ok';
      ping();
      go('took', { log_id: r.log_id, label: r.label });
      refresh();
    } catch (e) { toast('기록하지 못했어요. 다시 눌러 주세요'); }
  }

  async function undoMed() {
    try {
      await rpc('hyodo_undo_med', { p_token: token, p_log_id: ui.ctx.log_id });
      // 아직 안 드셨다고 하셨으니 알람은 10분 뒤에 다시
      const m = S.meds.find(x => x.label === ui.ctx.label);
      if (m) { const sn = snoozes(); sn[m.id] = Date.now() + 10 * 60000; store.set('snooze', JSON.stringify(sn)); }
      ping();
      go('undone', { label: ui.ctx.label });
      refresh();
    } catch (e) { toast('되돌리지 못했어요. 다시 눌러 주세요'); }
  }

  function startCall(c) {
    rpc('hyodo_log', { p_token: token, p_msg: c.name + '에게 전화를 거셨어요' }).then(() => ping()).catch(() => {});
    go('calling', { who: c });
    if (c.phone) location.href = 'tel:' + c.phone.replace(/[^0-9+]/g, '');
  }

  /* ---------- 말로 하기 ---------- */
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  let rec = null;

  function voiceHTML() {
    const examples = ['딸한테 사진 보내줘', '아들한테 전화해줘', '약 먹었어', '오늘 약 뭐 남았어?'];
    return '<div class="overlay voice"><div class="s-head"><button class="back" data-act="voice-close">← 닫기</button></div>' +
      '<div class="center" style="flex:none;padding:8px 0">' +
        '<button class="ring' + (ui.listening ? ' pulse' : '') + '" style="background:' + (ui.listening ? 'var(--alert)' : 'var(--ink)') + ';color:var(--surface);border:0" data-act="listen" aria-label="다시 듣기">' + ICON.mic.replace('<svg', '<svg width="48" height="48"') + '</button>' +
        '<h2 style="font-size:calc(26px * var(--scale))">' + (Recognition ? (ui.listening ? '듣고 있어요. 말씀하세요' : '마이크를 누르고 말씀하세요') : '이 폰은 음성 인식이 안 돼요') + '</h2></div>' +
      '<div class="heard" id="heard">' + esc(ui.heard) + '</div>' +
      '<div class="hint">이렇게 말해 보세요 (눌러도 돼요)</div>' +
      '<div class="chips">' + examples.map(t => '<button class="chip" data-say="' + esc(t) + '">"' + esc(t) + '"</button>').join('') + '</div>' +
      '<form class="say-row" id="say-form"><input id="say-input" placeholder="글자로 써도 돼요" aria-label="할 말"><button type="submit">보내기</button></form></div>';
  }

  function openVoice() {
    ui.voiceOpen = true; ui.heard = '';
    render();
    listen();
  }

  function listen() {
    if (!Recognition) return;
    try { if (rec) rec.abort(); } catch (e) { /* 이미 멈춤 */ }
    rec = new Recognition();
    rec.lang = 'ko-KR';
    rec.interimResults = true;
    rec.maxAlternatives = 3;
    rec.onresult = e => {
      const res = e.results[e.results.length - 1];
      ui.heard = res[0].transcript;
      const el = document.getElementById('heard'); if (el) el.textContent = '"' + ui.heard + '"';
      if (res.isFinal) {
        const alts = []; for (let i = 0; i < res.length; i++) alts.push(res[i].transcript);
        handleUtterance(alts);
      }
    };
    rec.onerror = e => { if (e.error === 'not-allowed') toast('마이크를 쓸 수 있게 허용해 주세요'); };
    rec.onend = () => { ui.listening = false; if (ui.voiceOpen) render(); };
    ui.listening = true;
    rec.start();
    render();
  }

  function handleUtterance(candidates) {
    const r = window.HyodoVoice.parseBest(candidates, contacts());
    ui.heard = '"' + r.heard + '"';
    rpc('hyodo_voice_log', { p_token: token, p_heard: r.heard, p_intent: r.intent + (r.who ? ':' + r.who.name : '') }).catch(() => {});
    if (r.intent === 'unknown') { ui.heard = '잘 못 알아들었어요. 다시 말씀해 주세요'; return render(); }
    ui.voiceOpen = false;
    try { if (rec) rec.abort(); } catch (e) { /* 이미 멈춤 */ }
    if (r.intent === 'took') return takeMed();
    if (r.intent === 'medinfo') return go('medinfo');
    if (r.intent === 'call') return r.who ? startCall(r.who) : go('call');
    if (r.intent === 'photo') {
      if (!r.who) return go('photo-who');
      go('photo-send', { who: r.who });
      return photoInput.click();
    }
  }

  /* ---------- 약 알람 (앱이 열려 있을 때) ---------- */
  let audioCtx = null, beepTimer = null, speakTimer = null;
  function unlockAudio() {
    if (audioCtx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) { audioCtx = new AC(); audioCtx.resume(); }
  }
  function beep() {
    if (!audioCtx) return;
    [0, 0.35].forEach(t => {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.frequency.value = 880; o.connect(g); g.connect(audioCtx.destination);
      g.gain.setValueAtTime(0.0001, audioCtx.currentTime + t);
      g.gain.exponentialRampToValueAtTime(0.5, audioCtx.currentTime + t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + t + 0.3);
      o.start(audioCtx.currentTime + t); o.stop(audioCtx.currentTime + t + 0.32);
    });
    if (navigator.vibrate) navigator.vibrate([400, 200, 400]);
  }
  function speak(text) {
    if (!window.speechSynthesis) return;
    const u = new SpeechSynthesisUtterance(text); u.lang = 'ko-KR'; u.rate = 0.9;
    window.speechSynthesis.cancel(); window.speechSynthesis.speak(u);
  }
  function snoozes() { try { return JSON.parse(store.get('snooze') || '{}'); } catch (e) { return {}; } }

  function dueMed() {
    if (!S || role !== 'senior') return null;
    const d = new Date(), mins = d.getHours() * 60 + d.getMinutes(), sn = snoozes();
    return S.meds.find(m => {
      if (m.status === 'ok') return false;
      const [h, mm] = m.time.split(':').map(Number), t = h * 60 + mm;
      if (mins < t || mins > t + 120) return false;           // 2시간 지나면 알람은 그만
      return !(sn[m.id] && Date.now() < sn[m.id]);
    }) || null;
  }

  function checkAlarm() {
    const m = dueMed();
    if (m && !ui.alarm) {
      ui.alarm = m;
      render();
      beep(); beepTimer = setInterval(beep, 2500);
      speak('약 드실 시간이에요. ' + m.label + '입니다.');
      speakTimer = setInterval(() => speak('약 드실 시간이에요. ' + m.label + '입니다.'), 20000);
    }
  }
  function stopAlarm() {
    ui.alarm = null;
    clearInterval(beepTimer); clearInterval(speakTimer);
    if (window.speechSynthesis) window.speechSynthesis.cancel();
  }

  /* ---------- 보호자 화면 ---------- */
  const photoCache = new Map();
  let guardianDirty = false;

  function renderGuardianSafe() {
    const a = document.activeElement;
    if (a && $app.contains(a) && /^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName)) { guardianDirty = true; return; }
    renderGuardian();
  }

  function minsAgo(ts) {
    const m = Math.round((Date.now() - new Date(ts).getTime()) / 60000);
    if (m < 1) return '방금 전';
    if (m < 60) return m + '분 전';
    if (m < 60 * 24) return Math.floor(m / 60) + '시간 전';
    return Math.floor(m / 1440) + '일 전';
  }

  function renderGuardian() {
    guardianDirty = false;
    const ok = S.meds.filter(m => m.status === 'ok').length;
    const missed = S.meds.filter(m => m.status === 'miss');
    const stale = Date.now() - new Date(S.last_active).getTime() > 3 * 3600 * 1000;
    let html = '<div class="guardian">' +
      '<div class="g-top"><span class="g-avatar">' + esc(S.elder_name.charAt(0)) + '</span>' +
      '<div><h1>' + esc(S.elder_name) + ' 님</h1><small><span class="dot' + (stale ? ' stale' : '') + '"></span>마지막 활동 ' + minsAgo(S.last_active) + '</small></div></div>';

    missed.forEach(m => {
      html += '<div class="alert-banner"><span>⚠️ ' + esc(m.label) + '을 30분 넘게 안 드셨어요</span>' +
        '<span>' + sayTime(m.time) + ' 약이에요. 전화해 보시겠어요?</span></div>';
    });

    if ('Notification' in window && Notification.permission === 'default') {
      html += '<div class="notice"><span>약을 안 드시면 이 폰에 알림을 띄울까요?</span><button class="g-btn primary" data-g="notify">알림 켜기</button></div>';
    }

    html += '<div class="card"><h2>오늘 약 <span>' + ok + ' / ' + S.meds.length + ' 드심</span></h2>' +
      (S.meds.length ? S.meds.map(m => {
        const chip = m.status === 'ok' ? '<span class="pill-chip st-ok">드심 ' + esc(m.at) + '</span>'
          : m.status === 'miss' ? '<span class="pill-chip st-miss">안 드심</span>'
          : m.status === 'due' ? '<span class="pill-chip st-due">드실 시간</span>'
          : '<span class="pill-chip st-wait">대기</span>';
        return '<div class="med-row"><input type="time" id="mt-' + m.id + '" data-med="' + m.id + '" value="' + esc(m.time) + '" aria-label="약 시간">' +
          '<input id="ml-' + m.id + '" data-med="' + m.id + '" value="' + esc(m.label) + '" maxlength="30" aria-label="약 이름">' + chip +
          '<button class="x-btn" data-g="rm-med" data-id="' + m.id + '" aria-label="' + esc(m.label) + ' 빼기">✕</button></div>';
      }).join('') : '<div class="empty">아직 약이 없어요. 아래에서 추가해 주세요.</div>') +
      '<form class="med-row" id="add-med"><input type="time" id="new-med-time" value="08:00" aria-label="새 약 시간" required>' +
      '<input id="new-med-label" placeholder="예: 혈압약 (아침)" maxlength="30" aria-label="새 약 이름" required>' +
      '<button class="g-btn primary" type="submit">추가</button><span></span></form></div>';

    html += '<div class="card"><h2>어르신이 보낸 사진 <span>최근 ' + S.photos.length + '장</span></h2>' +
      (S.photos.length
        ? '<div class="photos">' + S.photos.map(p => '<figure><img data-pid="' + p.id + '" alt="어르신이 보낸 사진"' + (photoCache.has(p.id) ? ' src="' + photoCache.get(p.id) + '"' : '') + '><figcaption>' + esc(p.t) + '</figcaption></figure>').join('') + '</div>'
        : '<div class="empty">아직 받은 사진이 없어요.</div>') + '</div>';

    html += '<div class="card"><h2>연락처 3명 <span>얼굴을 누르면 사진을 바꿔요</span></h2>';
    for (let slot = 0; slot < 3; slot++) {
      const c = contacts().find(x => x.slot === slot) || { slot, name: '', rel: '', phone: '', photo: null };
      html += '<form class="contact" data-slot="' + slot + '">' +
        '<button type="button" class="thumb" data-g="face" data-slot="' + slot + '" aria-label="' + (slot + 1) + '번 연락처 사진">' + (c.photo ? '<img src="' + esc(c.photo) + '" alt="">' : '사진') + '</button>' +
        '<div class="contact-fields">' +
          '<input name="name" id="cn-' + slot + '" value="' + esc(c.name) + '" maxlength="12" placeholder="이름 (예: 딸 지은)" aria-label="이름">' +
          '<select name="rel" id="cr-' + slot + '" aria-label="관계">' + window.HyodoVoice.RELS.map(r => '<option' + (r === c.rel ? ' selected' : '') + '>' + r + '</option>').join('') + '</select>' +
          '<input name="phone" id="cp-' + slot + '" class="full" value="' + esc(c.phone) + '" inputmode="tel" placeholder="전화번호" aria-label="전화번호">' +
          '<div class="btn-row full"><button class="g-btn primary" type="submit">저장</button>' + (c.name ? '<button class="g-btn" type="button" data-g="clear-contact" data-slot="' + slot + '">비우기</button>' : '') + '</div>' +
        '</div></form>';
    }
    html += '</div>';

    html += '<div class="card"><h2>어르신 화면</h2>' +
      '<form class="row-input" id="elder-form"><input id="elder-name-g" value="' + esc(S.elder_name) + '" maxlength="20" aria-label="어르신 성함"><button class="g-btn" type="submit">이름 저장</button></form>' +
      '<div class="seg" role="group" aria-label="글자 크기">' + [[1, '크게'], [1.12, '더 크게'], [1.24, '아주 크게']].map(([v, l]) =>
        '<button data-scale="' + v + '" aria-pressed="' + (Number(S.scale) === v) + '">' + l + '</button>').join('') + '</div></div>';

    html += '<div class="card"><h2>최근 활동</h2><div class="log">' +
      (S.activity.length ? S.activity.map(l => '<div><time>' + esc(l.t) + '</time><span>' + esc(l.msg) + '</span></div>').join('') : '<span class="empty">아직 기록이 없어요.</span>') +
      '</div></div>';

    html += '<div class="foot">' +
      (S.pair_code ? '<div>다른 가족을 더 연결하려면 이 코드를 쓰세요: <b>' + esc(S.pair_code) + '</b> (30분 유효)</div>'
                   : '<div><button class="g-btn" data-g="new-code">다른 가족 연결 코드 만들기</button></div>') +
      '<div><button class="g-btn" data-g="leave">이 폰 연결 끊기</button></div></div></div>';

    $app.innerHTML = html;
    loadPhotos();
    notifyMissed(missed);
  }

  async function loadPhotos() {
    for (const img of $app.querySelectorAll('img[data-pid]')) {
      const id = Number(img.dataset.pid);
      if (photoCache.has(id)) continue;
      try {
        const data = await rpc('hyodo_photo', { p_token: token, p_id: id });
        if (data) { photoCache.set(id, data); img.src = data; }
      } catch (e) { /* 다음 새로고침 때 다시 */ }
    }
  }

  function notifyMissed(missed) {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    const today = new Date().toDateString();
    let seen; try { seen = JSON.parse(store.get('notified') || '{}'); } catch (e) { seen = {}; }
    if (seen.day !== today) seen = { day: today, ids: [] };
    missed.forEach(m => {
      if (seen.ids.includes(m.id)) return;
      seen.ids.push(m.id);
      try { new Notification('효도비서', { body: S.elder_name + ' 님이 ' + m.label + '을 30분 넘게 안 드셨어요', icon: 'icon.svg' }); } catch (e) { /* 알림 불가 */ }
    });
    store.set('notified', JSON.stringify(seen));
  }

  async function guardianDo(fn, okMsg) {
    try {
      await fn(); ping(); if (okMsg) toast(okMsg);
      if (document.activeElement && $app.contains(document.activeElement)) document.activeElement.blur();
      await refresh();
    }
    catch (e) {
      if (!token) return render();
      toast(e.message === 'too_many' ? '약은 8개까지 넣을 수 있어요' : '저장하지 못했어요. 다시 해 주세요');
    }
  }

  /* ---------- 이벤트 ---------- */
  document.addEventListener('pointerdown', unlockAudio, { once: true });

  $app.addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;

    if (b.dataset.start) {
      ui.route = b.dataset.start === 'back' ? 'start' : 'start-' + b.dataset.start;
      if (b.dataset.start === 'back') history.replaceState(null, '', location.pathname);
      return renderStart();
    }

    if (role === 'senior') {
      if (b.dataset.go) return go(b.dataset.go);
      if (b.dataset.say) return handleUtterance([b.dataset.say]);
      if (b.dataset.pick !== undefined) {
        const c = contacts().find(x => x.slot === Number(b.dataset.pick));
        if (ui.route === 'call') return startCall(c);
        go('photo-send', { who: c });
        return photoInput.click();
      }
      const a = b.dataset.act;
      if (a === 'took' || a === 'alarm-took') return takeMed();
      if (a === 'undo') return undoMed();
      if (a === 'voice') return openVoice();
      if (a === 'listen') return listen();
      if (a === 'voice-close') { ui.voiceOpen = false; try { if (rec) rec.abort(); } catch (err) { /* 이미 멈춤 */ } return render(); }
      if (a === 'shoot') return photoInput.click();
      if (a === 'show-pair') return go('pair');
      if (a === 'new-code') return rpc('hyodo_refresh_pair_code', { p_token: token }).then(refresh).catch(() => toast('코드를 받지 못했어요'));
      if (a === 'alarm-snooze') {
        const sn = snoozes(); sn[ui.alarm.id] = Date.now() + 10 * 60000; store.set('snooze', JSON.stringify(sn));
        rpc('hyodo_log', { p_token: token, p_msg: ui.alarm.label + ' 알람을 10분 미루셨어요' }).then(() => ping()).catch(() => {});
        stopAlarm(); return render();
      }
      if (a === 'send') {
        const c = ui.ctx.who;
        ui.ctx.sending = true; render();
        return rpc('hyodo_send_photo', { p_token: token, p_to: c.name, p_data: ui.ctx.img })
          .then(() => { ping(); go('sent', { who: c }); })
          .catch(() => { ui.ctx.sending = false; render(); toast('보내지 못했어요. 다시 눌러 주세요'); });
      }
      return;
    }

    if (role === 'guardian') {
      if (b.dataset.scale) return guardianDo(() => rpc('hyodo_save_settings', { p_token: token, p_elder_name: S.elder_name, p_scale: Number(b.dataset.scale) }), '글자 크기를 바꿨어요');
      const g = b.dataset.g;
      if (g === 'face') { contactPhotoInput.dataset.slot = b.dataset.slot; return contactPhotoInput.click(); }
      if (g === 'rm-med') return guardianDo(() => rpc('hyodo_remove_med', { p_token: token, p_id: Number(b.dataset.id) }), '약을 뺐어요');
      if (g === 'clear-contact') return guardianDo(() => rpc('hyodo_save_contact', { p_token: token, p_slot: Number(b.dataset.slot), p_name: '', p_rel: '', p_phone: '', p_photo: null }), '연락처를 비웠어요');
      if (g === 'notify') return Notification.requestPermission().then(() => renderGuardian());
      if (g === 'new-code') return guardianDo(() => rpc('hyodo_refresh_pair_code', { p_token: token }));
      if (g === 'leave') {
        if (b.dataset.confirm) { forget(); ui.route = 'start'; return render(); }
        b.dataset.confirm = '1'; b.textContent = '정말 끊을까요? 한 번 더 누르세요'; return;
      }
    }
  });

  $app.addEventListener('submit', e => {
    e.preventDefault();
    const f = e.target;
    const err = document.getElementById('err');
    if (f.id === 'f-senior') {
      return startSenior(document.getElementById('elder-name').value).catch(() => { err.textContent = '시작하지 못했어요. 인터넷 연결을 확인해 주세요'; });
    }
    if (f.id === 'f-guardian') {
      const code = document.getElementById('pair-code').value.replace(/\D/g, '');
      if (code.length !== 6) { err.textContent = '숫자 6자리를 넣어 주세요'; return; }
      return startGuardian(code).catch(ex => { err.textContent = ex.message === 'bad_code' ? '코드가 맞지 않거나 시간이 지났어요. 어르신 폰에서 새 코드를 받아 주세요' : '연결하지 못했어요. 인터넷 연결을 확인해 주세요'; });
    }
    if (f.id === 'add-med') {
      return guardianDo(() => rpc('hyodo_save_med', { p_token: token, p_id: null, p_time: document.getElementById('new-med-time').value, p_label: document.getElementById('new-med-label').value }), '약을 추가했어요');
    }
    if (f.id === 'elder-form') {
      return guardianDo(() => rpc('hyodo_save_settings', { p_token: token, p_elder_name: document.getElementById('elder-name-g').value, p_scale: S.scale }), '이름을 저장했어요');
    }
    if (f.classList.contains('contact')) {
      const slot = Number(f.dataset.slot);
      const name = f.elements.name.value.trim();
      if (!name) { toast('이름을 넣어 주세요'); return; }
      return guardianDo(() => rpc('hyodo_save_contact', { p_token: token, p_slot: slot, p_name: name, p_rel: f.elements.rel.value, p_phone: f.elements.phone.value.trim(), p_photo: null }), '연락처를 저장했어요');
    }
  });

  // 약 시간·이름은 칸에서 나오면 바로 저장
  $app.addEventListener('change', e => {
    const t = e.target;
    if (role !== 'guardian' || !t.dataset.med) return;
    const id = Number(t.dataset.med);
    const time = document.getElementById('mt-' + id).value, label = document.getElementById('ml-' + id).value.trim();
    if (!time || !label) return;
    guardianDo(() => rpc('hyodo_save_med', { p_token: token, p_id: id, p_time: time, p_label: label }), '약 정보를 저장했어요');
  });
  $app.addEventListener('focusout', () => { setTimeout(() => { if (guardianDirty && role === 'guardian') renderGuardianSafe(); }, 200); });

  photoInput.addEventListener('change', async () => {
    const file = photoInput.files && photoInput.files[0];
    photoInput.value = '';
    if (!file || ui.route !== 'photo-send') return;
    try { ui.ctx.img = await resizeImage(file, 1280, 0.75, false); render(); }
    catch (e) { toast(e.message); }
  });

  contactPhotoInput.addEventListener('change', async () => {
    const file = contactPhotoInput.files && contactPhotoInput.files[0];
    contactPhotoInput.value = '';
    if (!file) return;
    const slot = Number(contactPhotoInput.dataset.slot);
    const c = contacts().find(x => x.slot === slot);
    const form = $app.querySelector('form.contact[data-slot="' + slot + '"]');
    const name = (form && form.elements.name.value.trim()) || (c && c.name);
    if (!name) { toast('이름을 먼저 넣고 저장해 주세요'); return; }
    try {
      const data = await resizeImage(file, 256, 0.8, true);
      guardianDo(() => rpc('hyodo_save_contact', {
        p_token: token, p_slot: slot, p_name: name,
        p_rel: form ? form.elements.rel.value : (c ? c.rel : ''),
        p_phone: form ? form.elements.phone.value.trim() : (c ? c.phone : ''),
        p_photo: data
      }), '사진을 바꿨어요');
    } catch (e) { toast(e.message); }
  });

  /* ---------- 시작 ---------- */
  if (token) { ui.route = 'home'; refresh().then(render); } else render();
  window.addEventListener('hashchange', () => { if (!token) render(); });

  // 어르신 폰: 시계·알람은 20초마다, 서버 상태는 1분마다. 보호자 폰: 1분마다.
  setInterval(() => {
    if (role !== 'senior' || !S) return;
    checkAlarm();
    if (ui.route === 'home' && !ui.voiceOpen && !ui.alarm) render();
  }, 20000);
  setInterval(() => { if (token && document.visibilityState === 'visible') refresh(); }, 60000);
  setInterval(() => { if (role === 'senior' && document.visibilityState === 'visible') rpc('hyodo_touch', { p_token: token }).catch(() => {}); }, 5 * 60000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && token) {
      refresh();
      if (role === 'senior') rpc('hyodo_touch', { p_token: token }).catch(() => {});
    }
  });
})();

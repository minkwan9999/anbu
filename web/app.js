(function () {
  const cfg = window.HYODO_CONFIG;
  const sb = window.supabase.createClient(cfg.url, cfg.key, { auth: { persistSession: false } });
  const $app = document.getElementById('app');
  const $toast = document.getElementById('toast');
  const photoInput = document.getElementById('photo-input');        // 카메라로 바로 찍기
  const galleryInput = document.getElementById('gallery-input');    // 사진첩에서 고르기
  const contactPhotoInput = document.getElementById('contact-photo-input');
  const joinPhotoInput = document.getElementById('join-photo-input');   // 보호자 등록 때 내 얼굴 사진

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

  // 어르신·보호자 토큰을 따로 둔다. 한 기기(예: PC 하나)로 둘 다 시험해도 서로 덮어쓰지 않는다.
  // 주소: 기본 = 어르신 화면, #/guardian = 보호자(연결된 어르신 목록), #/guardian/h/<가구> = 한 어르신 상세,
  //       #/join/코드 = 보호자 연결 (이미 보호자면 목록에 어르신 추가)
  // 모드: 'real' 실제 사용 / 'demo' 체험(테스트용). 체험 연결 정보는 'demo.' 칸에 따로 둬서 실제 연결과 섞이지 않는다.
  let mode = store.get('mode') === 'demo' ? 'demo' : 'real';
  const tkey = r => (mode === 'demo' ? 'demo.' : '') + r + '.token';
  function setMode(m) { mode = m; store.set('mode', m === 'demo' ? 'demo' : null); }
  const hasDemo = () => !!(store.get('demo.senior.token') || store.get('demo.guardian.token'));
  (function migrate() {
    const t = store.get('token'), r = store.get('role');
    if (t && r) { store.set(r + '.token', t); store.set('token', null); store.set('role', null); }
    // 예전 체험(실제 칸에 같이 저장하던 방식) → 체험 칸으로 옮긴다
    if (store.get('demo') === '1') {
      store.set('demo.senior.token', store.get('senior.token')); store.set('senior.token', null);
      if (store.get('demo.newGuardian')) { store.set('demo.guardian.token', store.get('guardian.token')); store.set('guardian.token', null); }
      ['demo', 'demo.hid', 'demo.newGuardian'].forEach(k => store.set(k, null));
      setMode('demo');
    }
    if (location.hash === '#/demo') setMode('demo');
    else if (mode === 'demo' && !hasDemo()) setMode('real');
  })();
  function pickRole() {
    const h = location.hash, s = store.get(tkey('senior')), g = store.get(tkey('guardian'));
    if (/^#\/join\//.test(h)) return null;            // 연결 링크는 handleJoin 이 처리
    if (h === '#/demo') return null;                    // 체험 주소는 늘 체험 시작 화면부터
    if (/^#\/guardian/.test(h)) return g ? 'guardian' : null;
    if (/^#\/senior/.test(h)) return s ? 'senior' : null;
    return s ? 'senior' : g ? 'guardian' : null;
  }
  let role = pickRole();
  let token = role ? store.get(tkey(role)) : null;
  let S = null;              // 서버 상태: 어르신 화면, 또는 보호자가 보는 한 어르신 (hyodo_state / hyodo_g_state)
  let G = null;              // 보호자: 연결된 어르신 목록 (hyodo_g_list)
  const hashHid = () => (location.hash.match(/^#\/guardian\/h\/([0-9a-f-]{36})/) || [])[1] || null;
  const hashJoin = () => (location.hash.match(/^#\/join\/(\d{6})$/) || [])[1] || null;
  const ui = { route: 'home', ctx: {}, alarm: null, heard: '' };

  function forget() {
    if (role) store.set(tkey(role), null);
    token = null; role = null; S = null; G = null;
    setChannels([]);
  }

  /* ---------- 실시간: 바뀌면 서로 알려 주고 각자 다시 불러온다 ---------- */
  // 어르신 폰·보호자 상세 화면은 가구 채널 하나, 보호자 목록 화면은 맡은 가구 채널 모두를 듣는다
  const chans = new Map();
  let pendingPaired = false;
  function setChannels(names) {
    for (const [n, c] of chans) if (!names.includes(n)) { sb.removeChannel(c); chans.delete(n); }
    names.forEach(n => { if (!chans.has(n)) chans.set(n, joinChannel(n)); });
  }
  function joinChannel(name) {
    const chan = sb.channel('hyodo-' + name, { config: { broadcast: { self: false } } });
    chan.on('broadcast', { event: 'changed' }, () => refresh())
        .on('broadcast', { event: 'paired' }, () => {
          if (role === 'senior') { toast('보호자 폰과 연결됐어요'); if (ui.route === 'pair') go('home'); }
          refresh();
        })
        .subscribe(status => {
          if (status === 'SUBSCRIBED' && pendingPaired) { pendingPaired = false; ping('paired'); }
        });
    return chan;
  }
  function ping(event) { chans.forEach(c => c.send({ type: 'broadcast', event: event || 'changed', payload: {} })); }

  async function refresh() {
    if (!token) return render();
    try {
      if (role === 'senior') {
        S = await rpc('hyodo_state', { p_token: token });
        setChannels([S.channel]);
      } else if (hashHid()) {
        S = await rpc('hyodo_g_state', { p_token: token, p_hid: hashHid() });
        setChannels([S.channel]);
      } else {
        G = await rpc('hyodo_g_list', { p_token: token }); S = null;
        // 가족처럼 어르신이 한 분이면 목록 없이 바로 그 어르신 화면으로
        if (G.households.length === 1 && !ui.forceList && !hashJoin() && ui.route !== 'g-add') {
          location.replace('#/guardian/h/' + G.households[0].hid);
          return;
        }
        setChannels(G.households.map(h => h.channel));
      }
      document.documentElement.style.setProperty('--scale', role === 'senior' ? S.scale : 1);
    } catch (e) {
      if (!token) return render();
      if (e.message === 'forbidden') { location.replace('#/guardian'); return; }   // 연결이 끊긴 어르신
      toast('인터넷 연결을 확인해 주세요');
      return;
    }
    if (role === 'senior') {
      if (S.guardian_count === 0 && ui.route === 'home' && !ui.pairDismissed) ui.route = 'pair';
      checkAlarm(); if (['home', 'medinfo', 'pair'].includes(ui.route)) render();
    }
    else { renderGuardianSafe(); if (pushState === 'checking') checkPush(); }
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
    renderDemoBar();
    if (!token) return renderStart();
    if (role === 'guardian' && ui.route === 'g-add') return renderGuardianAdd();
    if (role === 'guardian' && !hashHid()) return G ? renderGuardianList() : loading();
    if (!S) return loading();
    if (role === 'senior') return renderSenior();
    return renderGuardian();
  }
  function loading() { $app.innerHTML = '<div class="center"><p>불러오는 중…</p></div>';
  }

  /* ---------- 처음 시작 ---------- */
  const GUARDIAN_RELS = ['딸', '아들', '며느리', '사위', '손주', '배우자', '요양보호사', '사회복지사', '기타'];
  // 어르신 화면 연락처에 넣을 호칭: '말로 하기'가 알아듣는 말로 맞춘다 ("선생님한테 전화해줘")
  const CONTACT_REL = { '요양보호사': '선생님', '사회복지사': '선생님', '': '기타' };
  function renderStart() {
    const join = (location.hash.match(/^#\/join\/(\d{6})$/) || [])[1];
    const step = ['start-senior', 'start-guardian', 'demo-role'].includes(ui.route) ? ui.route : (join ? 'start-guardian' : 'start');
    const demo = mode === 'demo';
    // 실제 사용 시작 화면(기본 주소)과 체험 시작 화면(#/demo)은 주소로 완전히 나눈다
    if (step === 'demo-role') {
      $app.innerHTML = '<div class="start"><span class="demo-tag start-tag">체험 · 폰 두 대</span><h1>효도비서</h1><p>이 폰은 누가 쓰나요?</p>' +
        '<button class="role-btn" data-start="demo-senior"><b>👵 어르신 폰</b><span>큰 버튼 3개와 말로 하기. 설정은 보호자 폰에서 합니다.</span></button>' +
        '<button class="role-btn" data-start="demo-guardian"><b>👨‍👩‍👧 보호자 폰</b><span>자녀나 요양보호사가 약 시간·연락처를 설정하고 소식을 받습니다.</span></button>' +
        '<button class="small-link" type="button" data-start="back">← 뒤로</button></div>';
    } else if (step === 'start' && demo) {
      // 이어서 하기는 보호자 등록까지 마친 체험이 있을 때만. 등록 전에 나간 체험은 이어 갈 게 없다
      const resume = !!(store.get('demo.senior.token') && store.get('demo.guardian.token'));
      $app.innerHTML = '<div class="start"><span class="demo-tag start-tag">체험 · 테스트용</span><h1>효도비서 체험</h1>' +
        '<p>여기서 만든 체험 데이터는 실제 사용과 따로 저장돼요.</p>' +
        (resume ? '<button class="role-btn" data-start="demo-resume"><b>▶ 하던 체험 이어서 하기</b><span>이 폰에서 하던 체험 화면으로 돌아가요.</span></button>' : '') +
        '<button class="role-btn" data-start="demo1"><b>📱 폰 하나로 체험' + (resume ? ' (새로 시작)' : '') + '</b><span>어르신 화면과 보호자 화면을 이 폰에서 번갈아 보며 알람까지 울려 봐요.</span></button>' +
        '</div>';   // 폰 두 대로 체험(demo2)은 화면에서 숨김: 체험은 폰 하나로만
    } else if (step === 'start') {
      $app.innerHTML = '<div class="start"><h1>효도비서</h1><p>이 폰은 누가 쓰나요?</p>' +
        '<button class="role-btn" data-start="senior"><b>👵 어르신 폰</b><span>큰 버튼 3개와 말로 하기. 설정은 보호자 폰에서 합니다.</span></button>' +
        '<button class="role-btn" data-start="guardian"><b>👨‍👩‍👧 보호자 폰</b><span>자녀나 요양보호사가 약 시간·연락처를 설정하고 소식을 받습니다.</span></button></div>';
    } else if (step === 'start-senior') {
      $app.innerHTML = '<form class="start" id="f-senior"><h1>' + (demo ? '체험용 어르신 폰' : '어르신 폰') + '</h1>' +
        '<div class="field"><label for="elder-name">어르신 성함 (보호자 화면에 표시)</label><input id="elder-name" maxlength="20" placeholder="예: 김순자" autocomplete="off"></div>' +
        '<div class="err" id="err"></div>' +
        '<button class="wide-btn" style="background:var(--ink);color:var(--surface)" type="submit">시작하기</button>' +
        '<button class="small-link" type="button" data-start="back">← 뒤로</button></form>';
    } else {
      const ji = ui.joinInfo;
      $app.innerHTML = '<form class="start" id="f-guardian"><h1>' + (demo ? '체험용 보호자 폰' : '보호자 폰') + '</h1>' +
        (ji && !ji.bad && !ji.fresh ? '<p><b>' + esc(ji.elder_name) + '</b> 님' + (ji.demo && ji.elder_name !== '체험 어르신' ? '(체험용)' : '') + '과 연결해요. 내 정보를 넣고 연결하기를 눌러 주세요.</p>'
                       : '<p>먼저 내 정보를 등록해요. 어르신과의 연결은 지금 아래 연결 코드를 넣어도 되고, 등록한 뒤 <b>＋ 어르신 추가</b>에서 해도 돼요.</p>') +
        '<div class="field"><label for="guardian-rel">내 사진 · 어르신과의 관계 · 내 이름 <span>(사진과 이름은 어르신 폰 "전화하기"에 나와요)</span></label>' +
          '<div class="join-who"><button type="button" class="thumb join-thumb" data-start="join-photo" aria-label="내 사진 고르기">' +
            (ui.joinPhoto ? '<img src="' + ui.joinPhoto + '" alt="">' : '사진') + '</button>' +
          '<div class="name-pair"><select id="guardian-rel" aria-label="어르신과의 관계"><option value="">관계</option>' +
            GUARDIAN_RELS.map(r => '<option' + (ui.joinDraft && ui.joinDraft.rel === r ? ' selected' : '') + '>' + r + '</option>').join('') + '</select>' +
          '<input id="guardian-name" maxlength="12" placeholder="이름 (예: 지은)" autocomplete="off" aria-label="내 이름" value="' + esc((ui.joinDraft && ui.joinDraft.name) || '') + '"></div></div></div>' +
        '<div class="field"><label for="guardian-phone">내 전화번호 <span>(어르신 폰 "전화하기"에 바로 들어가요)</span></label>' +
          '<input id="guardian-phone" type="tel" inputmode="tel" maxlength="20" placeholder="010-0000-0000" autocomplete="tel" value="' + esc((ui.joinDraft && ui.joinDraft.phone) || '') + '"></div>' +
        '<div class="field"><label for="pair-code">연결 코드 <span>(어르신 폰에 나온 숫자 6자리 · 나중에 넣어도 돼요)</span></label><input id="pair-code" class="code-input" inputmode="numeric" maxlength="6" autocomplete="one-time-code" value="' + esc(join || (ji && ji.code) || '') + '"></div>' +
        '<div class="err" id="err">' + (ji && ji.bad ? '코드가 맞지 않거나 시간이 지났어요. 어르신 폰에서 새 코드를 받아 주세요' : '') + '</div>' +
        '<button class="wide-btn" style="background:var(--ink);color:var(--surface)" type="submit">' + (join || (ji && ji.code) ? '연결하기' : '등록하기') + '</button>' +
        '<button class="small-link" type="button" data-start="back">← 뒤로</button></form>';
      if (join) document.getElementById('guardian-rel').focus();
    }
  }

  async function startSenior(name) {
    const r = await rpc(mode === 'demo' ? 'hyodo_create_demo_household' : 'hyodo_create_household', { p_elder_name: name });
    token = r.token; role = 'senior'; store.set(tkey('senior'), token);
    history.replaceState(null, '', location.pathname);
    ui.route = 'pair'; ui.ctx = {};
    await refresh(); render();
  }

  async function registerGuardian(name, rel, phone, photo) {
    const r = await rpc('hyodo_g_register', { p_name: name, p_rel: rel || null, p_phone: phone || null, p_photo: photo || null });
    ui.joinPhoto = null; ui.joinDraft = null; ui.joinInfo = null;
    store.set(tkey('guardian'), r.token);
    ui.route = 'home'; ui.forceList = true;
    if (location.hash === '#/guardian') return switchTo('guardian');
    location.hash = '#/guardian';
    toast('등록했어요. 이제 어르신을 연결해 주세요');
  }

  // 보호자 연결: 처음이면 보호자 계정을 만들고, 이미 보호자면 연결된 어르신 목록에 추가한다
  async function startGuardian(code, name, rel, phone, photo) {
    const r = await rpc('hyodo_g_join', { p_code: code, p_token: store.get(tkey('guardian')) || null, p_name: name || null, p_demo: mode === 'demo', p_rel: rel || null, p_phone: phone || null, p_photo: photo || null });
    ui.joinPhoto = null; ui.joinDraft = null; ui.joinInfo = null;
    token = r.token; role = 'guardian'; store.set(tkey('guardian'), token);
    history.replaceState(null, '', location.pathname + '#/guardian/h/' + r.hid);
    pendingPaired = true;
    ui.route = 'home'; ui.forceList = false;
    await refresh(); render();
    toast(r.contact === 'added' ? '연결됐어요. 어르신 폰 연락처에도 들어갔어요'
      : r.contact === 'full' ? '연결됐어요. 어르신 연락처 3칸이 꽉 차서 연락처에는 넣지 못했어요'
      : '어르신 폰과 연결됐어요');
  }

  function joinError(ex) {
    if (ex.message === 'bad_code') return '코드가 맞지 않거나 시간이 지났어요. 어르신 폰에서 새 코드를 받아 주세요';
    if (ex.message === 'mode_mismatch') return mode === 'demo' ? '실제 사용 중인 어르신이에요. 체험을 끝내고 연결해 주세요' : '체험용 어르신이에요. 체험 모드에서 연결해 주세요';
    return '연결하지 못했어요. 인터넷 연결을 확인해 주세요';
  }

  // QR(#/join/코드)을 찍고 들어오면: 코드가 체험용인지 실제용인지 보고 그 모드로 연결한다
  async function handleJoin() {
    const code = hashJoin();
    setChannels([]); stopAlarm(); S = null; G = null;
    try { const info = await rpc('hyodo_code_info', { p_code: code }); setMode(info.demo ? 'demo' : 'real'); ui.joinInfo = info; }
    catch (e) { ui.joinInfo = { bad: true }; }
    const gt = store.get(tkey('guardian'));
    if (gt) { role = 'guardian'; token = gt; ui.route = 'g-add'; }
    else { role = null; token = null; ui.route = 'start-guardian'; }
    render();
  }

  /* ---------- 어르신 화면 ---------- */
  const contacts = () => (S && S.contacts) || [];
  // 같은 시간에 먹는 약은 한 묶음으로 다룬다: { time, label: '혈압약, 당뇨약', ids }
  function groupByTime(meds) {
    const groups = [];
    meds.forEach(m => {
      const g = groups.find(x => x.time === m.time);
      if (g) { g.label += ', ' + m.label; g.ids.push(m.id); }
      else groups.push({ time: m.time, label: m.label, ids: [m.id] });
    });
    return groups;
  }
  const nextGroup = () => groupByTime(S.meds.filter(m => m.status !== 'ok'))[0];
  const minsOf = hm => { const [h, m] = hm.split(':').map(Number); return h * 60 + m; };
  const nowMins = () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); };
  function snoozeIds(ids) { const sn = snoozes(); ids.forEach(id => { sn[id] = Date.now() + 10 * 60000; }); store.set('snooze', JSON.stringify(sn)); }

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
        '<button class="ghost-btn" data-act="pair-done">다 했어요</button></div>';
    } else if (r === 'home') {
      const nm = nextGroup();
      html += '<div><div class="s-date">' + (d.getMonth() + 1) + '월 ' + d.getDate() + '일 ' + days[d.getDay()] + '요일</div>' +
        '<div class="s-time">' + sayTime(nowHM()) + '</div></div>' +
        (S.meds.length === 0 ? '' : nm
          ? '<div class="s-next">💊 <span>' + (nowMins() > minsOf(nm.time) ? '아직 안 드신 약' : '다음 약') + ' <b>' + sayTime(nm.time) + '</b><br>' + esc(nm.label) + '</span></div>'
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
            '<div class="two-btn"><button class="ghost-btn" data-act="shoot">📷 다시 찍기</button><button class="ghost-btn" data-act="gallery">🖼️ 다른 사진</button></div>'
          : '<div class="center"><button class="wide-btn" style="background:var(--photo)" data-act="shoot">📷 사진 찍기</button>' +
            '<button class="wide-btn" style="background:var(--surface);color:var(--photo);box-shadow:inset 0 0 0 3px var(--photo)" data-act="gallery">🖼️ 사진첩에서 고르기</button></div>');
    } else if (r === 'sent') {
      html += '<div class="center s-center"><div class="ring" style="background:var(--photo)">✓</div>' +
        '<h2>' + esc(ui.ctx.who.name) + '에게<br>사진을 보냈어요</h2><button class="ghost-btn" data-go="home">처음으로</button></div>';
    } else if (r === 'took') {
      html += '<div class="center s-center"><div class="ring" style="background:var(--pill)">✓</div>' +
        '<h2>잘하셨어요!</h2><p>' + esc(ui.ctx.label) + ' 드신 것을<br>보호자에게 알렸어요</p>' +
        (ui.ctx.sample ? '<p class="hint">체험용 예시 약이라 기록은 남지 않아요</p>' : '') +
        '<button class="wide-btn" style="background:var(--ink);color:var(--surface)" data-go="home">처음으로</button>' +
        (ui.ctx.sample ? '' : '<button class="ghost-btn" data-act="undo">↩ 잘못 눌렀어요<br><small>아직 안 먹었어요</small></button>') + '</div>';
    } else if (r === 'undone') {
      html += '<div class="center s-center"><div class="ring" style="background:var(--wait-fg)">↩</div>' +
        '<h2>되돌렸어요</h2><p>' + esc(ui.ctx.label) + '은 아직 안 드신 걸로 할게요.<br>드신 다음에 다시 눌러 주세요</p>' +
        '<button class="ghost-btn" data-go="home">처음으로</button></div>';
    } else if (r === 'medinfo' || r === 'nomed') {
      const left = groupByTime(S.meds.filter(m => m.status !== 'ok'));
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

  async function takeMed(time) {
    stopAlarm();
    try {
      const r = time
        ? await rpc('hyodo_take_med_at', { p_token: token, p_time: time })
        : await rpc('hyodo_take_med', { p_token: token });
      if (r.none) { await refresh(); return go('nomed'); }
      // 새로 불러오기 전에 알람이 다시 울리지 않도록 같은 시간 약을 바로 표시해 둔다
      S.meds.forEach(x => { if (x.time === r.time) x.status = 'ok'; });
      ping();
      go('took', { log_ids: r.log_ids || [r.log_id], label: r.label, time: r.time });
      refresh();
    } catch (e) { toast('기록하지 못했어요. 다시 눌러 주세요'); }
  }

  async function undoMed() {
    try {
      await rpc('hyodo_undo_meds', { p_token: token, p_log_ids: ui.ctx.log_ids });
      // 아직 안 드셨다고 하셨으니 알람은 10분 뒤에 다시
      snoozeIds(S.meds.filter(x => x.time === ui.ctx.time).map(x => x.id));
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
      return go('photo-send', { who: r.who });
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

  function dueGroup() {
    if (!S || role !== 'senior') return null;
    const mins = nowMins(), sn = snoozes();
    return groupByTime(S.meds.filter(m => {
      if (m.status === 'ok') return false;
      const t = minsOf(m.time);
      if (mins < t || mins > t + 120) return false;           // 2시간 지나면 알람은 그만
      return !(sn[m.id] && Date.now() < sn[m.id]);
    }))[0] || null;
  }

  function checkAlarm() {
    const m = dueGroup();
    // 알람이 떠 있는 동안 같은 시간 약이 추가되면 화면을 고친다
    if (m && ui.alarm && m.time === ui.alarm.time && m.ids.join() !== ui.alarm.ids.join()) { ui.alarm = m; render(); }
    if (m && !ui.alarm) startAlarm(m);
  }
  function startAlarm(m) {
    stopAlarm();
    ui.alarm = m; ui.voiceOpen = false;
    render();
    beep(); beepTimer = setInterval(beep, 2500);
    speak('약 드실 시간이에요. ' + m.label + '입니다.');
    speakTimer = setInterval(() => speak('약 드실 시간이에요. ' + m.label + '입니다.'), 20000);
  }
  // 체험: 다음 약(없으면 예시 약)으로 알람을 바로 울려 본다
  function previewAlarm() {
    const g = nextGroup();
    startAlarm(g ? Object.assign({}, g) : { time: nowHM(), label: '예시 약', ids: [], sample: true });
  }
  function stopAlarm() {
    ui.alarm = null;
    clearInterval(beepTimer); clearInterval(speakTimer);
    if (window.speechSynthesis) window.speechSynthesis.cancel();
  }

  /* ---------- 보호자 화면 ---------- */
  const photoCache = new Map();
  const editingContacts = new Set();   // '수정'을 눌러 고치는 중인 연락처 칸
  let editingName = false;              // 맨 위 어르신 이름을 고치는 중
  let guardianDirty = false;

  function renderGuardianSafe() {
    if (ui.route === 'g-add') return;   // 연결 코드를 넣는 중에는 다시 그리지 않는다
    const a = document.activeElement;
    if (a && $app.contains(a) && /^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName)) { guardianDirty = true; return; }
    render();
  }

  function minsAgo(ts) {
    const m = Math.round((Date.now() - new Date(ts).getTime()) / 60000);
    if (m < 1) return '방금 전';
    if (m < 60) return m + '분 전';
    if (m < 60 * 24) return Math.floor(m / 60) + '시간 전';
    return Math.floor(m / 1440) + '일 전';
  }

  // 브라우저 기본 시간 선택기 대신 '아침 8시' 식의 시 + 30분 단위 분 드롭다운
  function timePick(id, hm, medId) {
    const [h, m] = hm.split(':').map(Number);
    const data = medId ? ' data-med="' + medId + '"' : '';
    const mins = [0, 30];
    if (!mins.includes(m)) mins.push(m), mins.sort((a, b) => a - b);
    return '<span class="time-pick">' +
      '<select id="' + id + '-h"' + data + ' aria-label="약 먹는 시">' +
        Array.from({ length: 24 }, (_, i) => '<option value="' + i + '"' + (i === h ? ' selected' : '') + '>' + period(i) + ' ' + (i % 12 || 12) + '시</option>').join('') +
      '</select>' +
      '<select id="' + id + '-m"' + data + ' aria-label="약 먹는 분">' +
        mins.map(v => '<option value="' + v + '"' + (v === m ? ' selected' : '') + '>' + pad(v) + '분</option>').join('') +
      '</select></span>';
  }
  const pickedTime = id => pad(document.getElementById(id + '-h').value) + ':' + pad(document.getElementById(id + '-m').value);

  function renderGuardian() {
    guardianDirty = false;
    const ok = S.meds.filter(m => m.status === 'ok').length;
    const missed = groupByTime(S.meds.filter(m => m.status === 'miss'));
    const stale = Date.now() - new Date(S.last_active).getTime() > 3 * 3600 * 1000;
    let html = '<div class="guardian">' +
      '<button class="g-back" data-g="to-list">← 연결된 어르신 목록</button>' +
      '<div class="g-top"><span class="g-avatar">' + esc(S.elder_name.charAt(0)) + '</span>' +
      '<div class="g-name">' + (editingName
        ? '<form class="name-edit" id="name-form"><input id="elder-name-g" value="' + esc(S.elder_name) + '" maxlength="20" aria-label="어르신 성함">' +
          '<button class="g-btn primary" type="submit">저장</button><button class="g-btn" type="button" data-g="cancel-name">취소</button></form>'
        : '<div class="name-row"><h1>' + esc(S.elder_name) + ' 님</h1><button class="g-btn small" data-g="edit-name">수정</button></div>') + '<small><span class="dot' + (stale ? ' stale' : '') + '"></span>마지막 활동 ' + minsAgo(S.last_active) + '</small>' +
      (S.owner_name ? '<small class="owner-line">' + (S.is_owner ? '<span class="owner-tag">시작 보호자</span> 나' : '시작 보호자: ' + esc(S.owner_name) + ' 님') + '</small>' : '') +
      '</div></div>';

    missed.forEach(m => {
      html += '<div class="alert-banner"><span>⚠️ ' + esc(m.label) + '을 30분 넘게 안 드셨어요</span>' +
        '<span>' + sayTime(m.time) + ' 약이에요. 전화해 보시겠어요?</span></div>';
    });

    html += pushNotice();

    html += '<div class="card"><h2>오늘 약 <span>' + ok + ' / ' + S.meds.length + ' 드심</span></h2>' +
      (S.meds.length ? S.meds.map(m => {
        const chip = m.status === 'ok' ? '<span class="pill-chip st-ok">드심 ' + esc(m.at) + '</span>'
          : m.status === 'miss' ? '<span class="pill-chip st-miss">안 드심</span>'
          : m.status === 'due' ? '<span class="pill-chip st-due">드실 시간</span>'
          : '<span class="pill-chip st-wait">대기</span>';
        return '<div class="med-row">' + timePick('mt-' + m.id, m.time, m.id) +
          '<input id="ml-' + m.id + '" data-med="' + m.id + '" value="' + esc(m.label) + '" maxlength="30" aria-label="약 이름">' + chip +
          '<button class="x-btn" data-g="rm-med" data-id="' + m.id + '" aria-label="' + esc(m.label) + ' 빼기">✕</button></div>';
      }).join('') : '<div class="empty">아직 약이 없어요. 아래에서 추가해 주세요.</div>') +
      '<form class="med-row" id="add-med">' + timePick('new-med', '08:00') +
      '<input id="new-med-label" placeholder="예: 혈압약 (아침)" maxlength="30" aria-label="새 약 이름" required>' +
      '<button class="g-btn primary" type="submit">추가</button><span></span></form></div>';

    html += '<div class="card"><h2>어르신이 보낸 사진 <span>최근 ' + S.photos.length + '장</span></h2>' +
      (S.photos.length
        ? '<div class="photos">' + S.photos.map(p => '<figure><img data-pid="' + p.id + '" alt="어르신이 보낸 사진"' + (photoCache.has(p.id) ? ' src="' + photoCache.get(p.id) + '"' : '') + '><figcaption>' + esc(p.t) + '</figcaption></figure>').join('') + '</div>'
        : '<div class="empty">아직 받은 사진이 없어요.</div>') + '</div>';

    html += '<div class="card"><h2>연락처 3명 <span>얼굴을 누르면 사진을 바꿔요</span></h2>';
    for (let slot = 0; slot < 3; slot++) {
      const c = contacts().find(x => x.slot === slot) || { slot, name: '', rel: '', phone: '', photo: null };
      // 저장된 연락처는 잠가 두고 '수정'을 눌러야 고칠 수 있다
      const locked = c.name && !editingContacts.has(slot) ? ' disabled' : '';
      html += '<form class="contact' + (locked ? ' saved' : '') + '" data-slot="' + slot + '">' +
        '<button type="button" class="thumb" data-g="face" data-slot="' + slot + '" aria-label="' + (slot + 1) + '번 연락처 사진">' + (c.photo ? '<img src="' + esc(c.photo) + '" alt="">' : '사진') + '</button>' +
        '<div class="contact-fields">' +
          '<input name="name" id="cn-' + slot + '" value="' + esc(c.name) + '" maxlength="12" placeholder="이름 (예: 딸 지은)" aria-label="이름"' + locked + '>' +
          '<select name="rel" id="cr-' + slot + '" aria-label="관계"' + locked + '>' + window.HyodoVoice.RELS.map(r => '<option' + (r === c.rel ? ' selected' : '') + '>' + r + '</option>').join('') + '</select>' +
          '<input name="phone" id="cp-' + slot + '" class="full" value="' + esc(c.phone) + '" inputmode="tel" placeholder="' + (locked ? '전화번호 없음' : '전화번호') + '" aria-label="전화번호"' + locked + '>' +
          '<div class="btn-row full">' + (locked
            ? '<button class="g-btn" type="button" data-g="edit-contact" data-slot="' + slot + '">수정</button><span class="saved-mark">✓ 저장됨</span>'
            : '<button class="g-btn primary" type="submit">저장</button>' + (c.name ? '<button class="g-btn" type="button" data-g="cancel-contact" data-slot="' + slot + '">취소</button>' : '')) +
          (c.name ? '<button class="g-btn" type="button" data-g="clear-contact" data-slot="' + slot + '">비우기</button>' : '') + '</div>' +
        '</div></form>';
    }
    html += '</div>';

    html += '<div class="card"><h2>어르신 화면 글자 크기</h2>' +
      '<div class="seg" role="group" aria-label="글자 크기">' + [[1, '크게'], [1.12, '더 크게'], [1.24, '아주 크게']].map(([v, l]) =>
        '<button data-scale="' + v + '" aria-pressed="' + (Number(S.scale) === v) + '">' + l + '</button>').join('') + '</div></div>';

    html += '<div class="card"><h2>최근 활동</h2><div class="log">' +
      (S.activity.length ? S.activity.map(l => '<div><time>' + esc(l.t) + '</time><span>' + esc(l.msg) + '</span></div>').join('') : '<span class="empty">아직 기록이 없어요.</span>') +
      '</div></div>';

    if (S.is_owner) {
      html += '<div class="card reset-card"><h2>데이터 초기화 <span>시작 보호자만 할 수 있어요</span></h2>' +
        '<p>약, 연락처, 받은 사진, 활동 기록을 비우고 처음부터 다시 시작해요. 어르신 폰과 보호자들의 <b>연결은 그대로</b> 남아요.</p>' +
        '<div><button class="g-btn danger" data-g="reset">데이터 초기화</button></div></div>';
    }

    html += '<div class="foot">' + (S.demo ? '' :
      (S.pair_code ? '<div>다른 가족·보호자를 더 연결하려면 이 코드를 쓰세요: <b>' + esc(S.pair_code) + '</b> (30분 유효)</div>'
                   : '<div><button class="g-btn" data-g="new-code">다른 가족·보호자 연결 코드 만들기</button></div>') +
      '<div><button class="g-btn" data-g="unlink">' + esc(S.elder_name) + ' 님과 연결 끊기</button></div>') + '</div></div>';

    $app.innerHTML = html;
    loadPhotos();
  }

  // 보호자 첫 화면: 연결된 어르신 목록. 문제가 있는 분이 맨 위.
  let editingMyName = false;
  function renderGuardianList() {
    const rank = h => h.miss > 0 ? 0 : h.due > 0 ? 1 : 2;
    const list = G.households.slice().sort((a, b) => rank(a) - rank(b));
    let html = '<div class="guardian">' +
      '<div class="g-top"><div class="g-name">' + (editingMyName
        ? '<form class="name-edit" id="my-name-form"><input id="my-name" value="' + esc(G.name) + '" maxlength="20" aria-label="내 이름">' +
          '<button class="g-btn primary" type="submit">저장</button><button class="g-btn" type="button" data-g="cancel-my-name">취소</button></form>'
        : '<div class="name-row"><h1>' + esc(G.name) + ' 님</h1><button class="g-btn small" data-g="edit-my-name">수정</button></div>') +
      '<small>연결된 어르신 ' + list.length + '명</small></div></div>';
    html += pushNotice();
    html += list.length ? '<div class="elder-list">' + list.map(h => {
      const status = h.miss > 0 ? '<span class="pill-chip st-miss">⚠️ 약 ' + h.miss + '개 안 드심</span>'
        : h.due > 0 ? '<span class="pill-chip st-due">💊 지금 드실 시간</span>'
        : h.total === 0 ? '<span class="pill-chip st-wait">약 없음</span>'
        : h.ok === h.total ? '<span class="pill-chip st-ok">✅ 오늘 약 다 드심</span>'
        : '<span class="pill-chip st-wait">다음 ' + sayTime(h.next_time) + ' · ' + h.ok + '/' + h.total + '</span>';
      return '<a class="elder-card' + (h.miss > 0 ? ' warn' : '') + '" href="#/guardian/h/' + h.hid + '">' +
        '<span class="g-avatar">' + esc(h.elder_name.charAt(0)) + '</span>' +
        '<span class="elder-main"><b>' + esc(h.elder_name) + ' 님' + (h.demo ? ' <span class="demo-tag">체험</span>' : '') + '</b>' + status + '</span>' +
        '<small>' + minsAgo(h.last_active) + '</small></a>';
    }).join('') + '</div>'
      : '<div class="notice"><span>아직 연결된 어르신이 없어요. <b>＋ 어르신 추가</b>를 누르고 어르신 폰에 나온 숫자 6자리를 넣거나, 그 QR을 이 폰 카메라로 찍어 주세요.</span></div>';
    html += '<button class="wide-btn add-elder" data-g="add">＋ 어르신 추가</button>';
    // 체험 중에는 실제 사용용 안내(주소·나가기)를 숨긴다. 체험은 맨 위 막대의 '끝내기'로 끝낸다
    if (mode === 'demo') { $app.innerHTML = html + '</div>'; return; }
    html += '<div class="foot">' +
      '<div>보호자 화면 주소: <b>' + esc(location.origin + location.pathname) + '#/guardian</b></div>' +
      (store.get(tkey('senior')) ? '<div><a href="#/senior">이 기기의 어르신 화면 보기 →</a></div>' : '') +
      (mode === 'real' ? '<div><button class="g-btn" data-g="demo">📱 체험 모드 열기 (실제 연결은 그대로)</button></div>' : '') +
      '<div><button class="g-btn" data-g="leave">이 폰에서 보호자 나가기</button></div></div></div>';
    $app.innerHTML = html;
  }

  function renderGuardianAdd() {
    const join = hashJoin();
    $app.innerHTML = '<form class="start" id="f-add"><h1>어르신 추가</h1>' +
      '<p>추가할 어르신 폰에서 <b>보호자 폰 연결</b>을 누르면 나오는 숫자 6자리를 넣거나, 그 QR을 이 폰 카메라로 찍어 주세요.</p>' +
      '<div class="field"><label for="add-code">연결 코드</label><input id="add-code" class="code-input" inputmode="numeric" maxlength="6" autocomplete="one-time-code" value="' + esc(join || '') + '"></div>' +
      '<div class="err" id="err"></div>' +
      '<button class="wide-btn" style="background:var(--ink);color:var(--surface)" type="submit">연결하기</button>' +
      '<button class="small-link" type="button" data-g="to-list">← 목록으로</button></form>';
    if (join) setTimeout(() => document.getElementById('f-add').requestSubmit(), 0);
  }

  async function loadPhotos() {
    for (const img of $app.querySelectorAll('img[data-pid]')) {
      const id = Number(img.dataset.pid);
      if (photoCache.has(id)) continue;
      try {
        const data = await rpc('hyodo_g_photo', { p_token: token, p_hid: S.hid, p_id: id });
        if (data) { photoCache.set(id, data); img.src = data; }
      } catch (e) { /* 다음 새로고침 때 다시 */ }
    }
  }

  /* ---------- 보호자 알림 (웹 푸시): 앱이 닫혀 있어도 약 미응답을 알려 준다 ---------- */
  const PUSH_URL = cfg.url + '/functions/v1/hyodo-push';
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  let pushState = 'checking';   // checking | on | off | denied | ios-install | unsupported

  async function checkPush() {
    let st;
    if (isIOS && !isStandalone) st = 'ios-install';
    else if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) st = 'unsupported';
    else if (Notification.permission === 'denied') st = 'denied';
    else {
      try {
        const reg = await navigator.serviceWorker.register('sw.js');
        const sub = await reg.pushManager.getSubscription();
        st = sub && Notification.permission === 'granted' ? 'on' : 'off';
      } catch (e) { st = 'unsupported'; }
    }
    if (st !== pushState) { pushState = st; if (role === 'guardian') renderGuardianSafe(); }
  }

  function pushNotice() {
    if (pushState === 'checking') return '';
    if (pushState === 'on') return '<div class="notice push-on"><span>🔔 약을 안 드시면 이 폰으로 알림이 와요</span><button class="g-btn" data-g="push-test">테스트 알림</button></div>';
    if (pushState === 'off') return '<div class="notice"><span>약을 30분 넘게 안 드시면 앱이 닫혀 있어도 알림을 받을까요?</span><button class="g-btn primary" data-g="push-on">알림 켜기</button></div>';
    if (pushState === 'denied') return '<div class="notice"><span>알림이 막혀 있어요. 브라우저 설정에서 이 사이트의 알림을 허용해 주세요.</span></div>';
    if (pushState === 'ios-install') return '<div class="notice"><span>아이폰은 <b>공유 → 홈 화면에 추가</b>로 앱을 설치한 뒤, 그 앱에서 다시 연결하면 알림을 받을 수 있어요.</span></div>';
    return '<div class="notice"><span>이 브라우저는 알림을 지원하지 않아요. 크롬이나 사파리를 써 주세요.</span></div>';
  }

  async function pushCall(body) {
    const r = await fetch(PUSH_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: cfg.key, Authorization: 'Bearer ' + cfg.key }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error('push_' + r.status);
    return r.json();
  }

  function b64urlToBytes(s) {
    const pad = '='.repeat((4 - s.length % 4) % 4);
    const raw = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(raw, c => c.charCodeAt(0));
  }

  async function enablePush() {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { pushState = perm === 'denied' ? 'denied' : 'off'; return render(); }
    try {
      const reg = await navigator.serviceWorker.register('sw.js');
      await navigator.serviceWorker.ready;
      const { publicKey } = await pushCall({ action: 'vapid' });
      let sub = await reg.pushManager.getSubscription();
      if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64urlToBytes(publicKey) });
      const j = sub.toJSON();
      await rpc('hyodo_g_save_push', { p_token: token, p_endpoint: j.endpoint, p_p256dh: j.keys.p256dh, p_auth: j.keys.auth });
      pushState = 'on'; toast('알림을 켰어요'); ping(); refresh();
    } catch (e) { toast('알림을 켜지 못했어요. 다시 해 주세요'); }
  }


  async function guardianDo(fn, okMsg) {
    try {
      await fn(); ping(); if (okMsg) toast(okMsg);
      if (document.activeElement && $app.contains(document.activeElement)) document.activeElement.blur();
      await refresh();
    }
    catch (e) {
      if (!token) return render();
      toast(e.message === 'too_many' ? '약은 8개까지 넣을 수 있어요'
        : e.message === 'not_owner' ? '시작 보호자만 할 수 있어요'
        : '저장하지 못했어요. 다시 해 주세요');
    }
  }

  /* ---------- 이벤트 ---------- */
  document.addEventListener('pointerdown', unlockAudio, { once: true });

  $app.addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;

    const st = b.dataset.start;
    if (st === 'join-photo') return joinPhotoInput.click();
    if (st === 'demo-resume') { location.hash = store.get('demo.guardian.token') ? '#/guardian' : '#/senior'; return; }
    if (st === 'demo1') {
      // 새로 시작: 하던 체험은 지우고 등록부터
      store.set('demo.senior.token', null); store.set('demo.guardian.token', null);
      b.disabled = true;
      return startDemo().catch(() => { b.disabled = false; toast('시작하지 못했어요. 인터넷 연결을 확인해 주세요'); });
    }
    if (st === 'demo2') {
      store.set('demo.senior.token', null); store.set('demo.guardian.token', null);
      setMode('demo'); ui.route = 'demo-role'; return renderStart();
    }
    if (st === 'demo-senior' || st === 'demo-guardian') { ui.route = 'start-' + st.slice(5); ui.joinInfo = null; return renderStart(); }
    if (st === 'senior' || st === 'guardian') { setMode('real'); ui.route = 'start-' + st; ui.joinInfo = null; return renderStart(); }
    if (st === 'back') {
      // 체험 쪽에서 뒤로 가면 체험 시작 화면, 실제 쪽이면 실제 시작 화면
      ui.route = 'start'; ui.joinInfo = null;
      history.replaceState(null, '', location.pathname + (mode === 'demo' ? '#/demo' : ''));
      return renderStart();
    }

    if (role === 'senior') {
      if (b.dataset.go) return go(b.dataset.go);
      if (b.dataset.say) return handleUtterance([b.dataset.say]);
      if (b.dataset.pick !== undefined) {
        const c = contacts().find(x => x.slot === Number(b.dataset.pick));
        if (ui.route === 'call') return startCall(c);
        return go('photo-send', { who: c });
      }
      const a = b.dataset.act;
      if (a === 'took') return takeMed();
      if (a === 'alarm-took') {
        const al = ui.alarm;
        if (al.sample) { stopAlarm(); return go('took', { label: al.label, sample: true }); }
        return takeMed(al.time);
      }
      if (a === 'undo') return undoMed();
      if (a === 'voice') return openVoice();
      if (a === 'listen') return listen();
      if (a === 'voice-close') { ui.voiceOpen = false; try { if (rec) rec.abort(); } catch (err) { /* 이미 멈춤 */ } return render(); }
      if (a === 'shoot') return photoInput.click();
      if (a === 'gallery') return galleryInput.click();
      if (a === 'show-pair') return go('pair');
      if (a === 'pair-done') { ui.pairDismissed = true; return go('home'); }
      if (a === 'new-code') return rpc('hyodo_refresh_pair_code', { p_token: token }).then(refresh).catch(() => toast('코드를 받지 못했어요'));
      if (a === 'alarm-snooze') {
        snoozeIds(ui.alarm.ids);
        if (!ui.alarm.sample) rpc('hyodo_log', { p_token: token, p_msg: ui.alarm.label + ' 알람을 10분 미루셨어요' }).then(() => ping()).catch(() => {});
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
      const g = b.dataset.g;
      if (g === 'to-list') { ui.forceList = true; ui.route = 'home'; if (location.hash === '#/guardian') return refresh().then(render); location.hash = '#/guardian'; return; }
      if (g === 'add') { ui.route = 'g-add'; return render(); }
      if (g === 'demo') { b.disabled = true; return startDemo().catch(() => { b.disabled = false; toast('시작하지 못했어요. 인터넷 연결을 확인해 주세요'); }); }
      if (g === 'edit-my-name') { editingMyName = true; render(); return document.getElementById('my-name').select(); }
      if (g === 'cancel-my-name') { editingMyName = false; return render(); }
      if (b.dataset.scale) return guardianDo(() => rpc('hyodo_g_save_settings', { p_token: token, p_hid: S.hid, p_elder_name: S.elder_name, p_scale: Number(b.dataset.scale) }), '글자 크기를 바꿨어요');
      if (g === 'face') { contactPhotoInput.dataset.slot = b.dataset.slot; return contactPhotoInput.click(); }
      if (g === 'rm-med') return guardianDo(() => rpc('hyodo_g_remove_med', { p_token: token, p_hid: S.hid, p_id: Number(b.dataset.id) }), '약을 뺐어요');
      if (g === 'edit-name') { editingName = true; renderGuardian(); return document.getElementById('elder-name-g').select(); }
      if (g === 'cancel-name') { editingName = false; return renderGuardian(); }
      if (g === 'edit-contact') { editingContacts.add(Number(b.dataset.slot)); renderGuardian(); return document.getElementById('cn-' + b.dataset.slot).focus(); }
      if (g === 'cancel-contact') { editingContacts.delete(Number(b.dataset.slot)); return renderGuardian(); }
      if (g === 'clear-contact') return guardianDo(() => rpc('hyodo_g_save_contact', { p_token: token, p_hid: S.hid, p_slot: Number(b.dataset.slot), p_name: '', p_rel: '', p_phone: '', p_photo: null }), '연락처를 비웠어요');
      if (g === 'push-on') return enablePush();
      if (g === 'push-test') return pushCall({ action: 'test', token }).then(r => toast(r.sent ? '테스트 알림을 보냈어요' : '보낼 곳이 없어요. 알림을 다시 켜 주세요')).catch(() => toast('보내지 못했어요'));
      if (g === 'new-code') return guardianDo(() => rpc('hyodo_g_refresh_pair_code', { p_token: token, p_hid: S.hid }));
      if (g === 'reset') {
        if (!b.dataset.confirm) { b.dataset.confirm = '1'; b.textContent = '정말 지울까요? 한 번 더 누르면 초기화돼요'; return; }
        b.disabled = true;
        return guardianDo(async () => {
          await rpc('hyodo_g_reset', { p_token: token, p_hid: S.hid });
          photoCache.clear(); editingContacts.clear();
        }, '데이터를 초기화했어요').then(() => { window.scrollTo(0, 0); });
      }
      if (g === 'unlink') {
        if (!b.dataset.confirm) { b.dataset.confirm = '1'; b.textContent = '정말 끊을까요? 한 번 더 누르세요'; return; }
        return rpc('hyodo_g_unlink', { p_token: token, p_hid: S.hid })
          .then(() => { toast('연결을 끊었어요'); ui.forceList = true; location.hash = '#/guardian'; })
          .catch(() => toast('끊지 못했어요. 다시 해 주세요'));
      }
      if (g === 'leave') {
        if (b.dataset.confirm) { forget(); history.replaceState(null, '', location.pathname); ui.route = 'start'; return render(); }
        b.dataset.confirm = '1'; b.textContent = '다시 쓰려면 어르신마다 다시 연결해야 해요. 한 번 더 누르면 나가요'; return;
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
      const rel = document.getElementById('guardian-rel').value, nm = document.getElementById('guardian-name').value.trim();
      if (!nm) { err.textContent = '이름을 넣어 주세요'; return; }
      if (code.length && code.length !== 6) { err.textContent = '연결 코드는 숫자 6자리예요. 나중에 넣으려면 비워 두세요'; return; }
      // 코드 없이 등록: 보호자 계정만 만들고 빈 보호자 화면으로. 어르신은 '어르신 추가'로 연결한다
      if (!code) return registerGuardian((rel && rel !== '기타' ? rel + ' ' : '') + nm, CONTACT_REL[rel] || rel, document.getElementById('guardian-phone').value.trim(), ui.joinPhoto)
        .catch(() => { err.textContent = '등록하지 못했어요. 인터넷 연결을 확인해 주세요'; });
      // 기록에는 '딸 지은', '요양보호사 김미영'처럼 관계와 이름을 붙여 남긴다
      return startGuardian(code, (rel && rel !== '기타' ? rel + ' ' : '') + nm, CONTACT_REL[rel] || rel, document.getElementById('guardian-phone').value.trim(), ui.joinPhoto)
        .catch(ex => { err.textContent = joinError(ex); });
    }
    if (f.id === 'f-add') {
      const code = document.getElementById('add-code').value.replace(/\D/g, '');
      if (code.length !== 6) { err.textContent = '숫자 6자리를 넣어 주세요'; return; }
      return startGuardian(code, null).catch(ex => { err.textContent = joinError(ex); });
    }
    if (f.id === 'my-name-form') {
      return rpc('hyodo_g_set_name', { p_token: token, p_name: document.getElementById('my-name').value })
        .then(() => { editingMyName = false; toast('이름을 바꿨어요'); return refresh(); })
        .catch(() => toast('저장하지 못했어요. 다시 해 주세요'));
    }
    if (f.id === 'name-form') {
      return guardianDo(async () => {
        await rpc('hyodo_g_save_settings', { p_token: token, p_hid: S.hid, p_elder_name: document.getElementById('elder-name-g').value, p_scale: S.scale });
        editingName = false;
      }, '이름을 바꿨어요');
    }
    if (f.id === 'add-med') {
      return guardianDo(() => rpc('hyodo_g_save_med', { p_token: token, p_hid: S.hid, p_id: null, p_time: pickedTime('new-med'), p_label: document.getElementById('new-med-label').value }), '약을 추가했어요');
    }
    if (f.classList.contains('contact')) {
      const slot = Number(f.dataset.slot);
      const name = f.elements.name.value.trim();
      if (!name) { toast('이름을 넣어 주세요'); return; }
      return guardianDo(async () => {
        await rpc('hyodo_g_save_contact', { p_token: token, p_hid: S.hid, p_slot: slot, p_name: name, p_rel: f.elements.rel.value, p_phone: f.elements.phone.value.trim(), p_photo: null });
        editingContacts.delete(slot);
      }, '연락처를 저장했어요');
    }
  });

  // 약 시간·이름은 칸에서 나오면 바로 저장
  $app.addEventListener('change', e => {
    const t = e.target;
    if (role !== 'guardian' || !t.dataset.med) return;
    const id = Number(t.dataset.med);
    const time = pickedTime('mt-' + id), label = document.getElementById('ml-' + id).value.trim();
    if (!time || !label) return;
    guardianDo(() => rpc('hyodo_g_save_med', { p_token: token, p_hid: S.hid, p_id: id, p_time: time, p_label: label }), '약 정보를 저장했어요');
  });
  $app.addEventListener('focusout', () => { setTimeout(() => { if (guardianDirty && role === 'guardian') renderGuardianSafe(); }, 200); });

  [photoInput, galleryInput].forEach(input => input.addEventListener('change', async () => {
    const file = input.files && input.files[0];
    input.value = '';
    if (!file || ui.route !== 'photo-send') return;
    try { ui.ctx.img = await resizeImage(file, 1280, 0.75, false); render(); }
    catch (e) { toast(e.message); }
  }));

  joinPhotoInput.addEventListener('change', async () => {
    const file = joinPhotoInput.files && joinPhotoInput.files[0];
    joinPhotoInput.value = '';
    if (!file) return;
    try {
      ui.joinPhoto = await resizeImage(file, 256, 0.8, true);
      // 다시 그려도 지금까지 넣은 값이 남도록 적어 둔다
      const v = id => { const el = document.getElementById(id); return el ? el.value : ''; };
      ui.joinDraft = { rel: v('guardian-rel'), name: v('guardian-name'), phone: v('guardian-phone') };
      const code = v('pair-code');
      renderStart();
      if (code) document.getElementById('pair-code').value = code;
    } catch (e) { toast(e.message); }
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
      guardianDo(() => rpc('hyodo_g_save_contact', {
        p_token: token, p_hid: S.hid, p_slot: slot, p_name: name,
        p_rel: form ? form.elements.rel.value : (c ? c.rel : ''),
        p_phone: form ? form.elements.phone.value.trim() : (c ? c.phone : ''),
        p_photo: data
      }), '사진을 바꿨어요');
    } catch (e) { toast(e.message); }
  });

  /* ---------- 체험 모드 (테스트용) ----------
     체험 연결은 'demo.' 칸에, 실제 연결은 원래 칸에 따로 저장한다. 체험 중에는 맨 위에 주황색 막대가 늘 보인다. */
  const $demoBar = document.getElementById('demo-bar');
  const isDemo = () => mode === 'demo';
  let pendingPreview = false;

  // 폰 하나로 체험: 체험용 어르신을 만들고, 실제와 똑같은 보호자 등록 화면으로 간다. 이미 체험 중이면 이어서 한다.
  async function startDemo() {
    setMode('demo');
    if (store.get('demo.senior.token') && store.get('demo.guardian.token')) {
      if (location.hash === '#/guardian') return switchTo('guardian');
      location.hash = '#/guardian'; return;
    }
    let st = store.get('demo.senior.token');
    if (!st) {
      st = (await rpc('hyodo_create_demo_household', { p_elder_name: '체험 어르신' })).token;
      store.set('demo.senior.token', st);
    }
    setChannels([]); stopAlarm();
    role = null; token = null; S = null; G = null;
    ui.joinInfo = { demo: true, fresh: true };
    ui.route = 'start-guardian';
    history.replaceState(null, '', location.pathname + '#/demo');
    render();
  }

  // 체험 끝내기: 체험 칸만 비우고 실제 사용으로 돌아간다 (실제 연결이 있으면 그 화면으로)
  function endDemo() {
    stopAlarm();
    store.set('demo.senior.token', null); store.set('demo.guardian.token', null);
    setMode('real');
    history.replaceState(null, '', location.pathname);
    switchTo(pickRole());
  }

  function renderDemoBar() {
    const on = isDemo() && !!token;
    document.body.classList.toggle('demo', on);
    $demoBar.hidden = !on;
    if (!on) return;
    const both = store.get('demo.senior.token') && store.get('demo.guardian.token');
    $demoBar.innerHTML = '<span class="demo-tag">체험 모드</span>' +
      (both ? '<div class="demo-seg"><button data-demo="senior" aria-pressed="' + (role === 'senior') + '">👵 어르신</button>' +
              '<button data-demo="guardian" aria-pressed="' + (role === 'guardian') + '">👨‍👩‍👧 보호자</button></div>' : '') +
      (store.get('demo.senior.token') ? '<button data-demo="alarm">🔔 알람</button>' : '') +
      '<button data-demo="end" class="demo-end">끝내기</button>';
  }

  $demoBar.addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    const d = b.dataset.demo;
    if (d === 'senior') { location.hash = '#/senior'; return; }
    if (d === 'guardian') { location.hash = '#/guardian'; return; }
    if (d === 'alarm') {
      if (role === 'senior' && S) return previewAlarm();
      pendingPreview = true; location.hash = '#/senior'; return;
    }
    if (d === 'end') {
      if (b.dataset.confirm) return endDemo();
      b.dataset.confirm = '1'; b.textContent = '정말 끝낼까요?'; return;
    }
  });

  /* ---------- 시작 ---------- */
  if (hashJoin()) handleJoin();
  else if (token) { ui.route = 'home'; refresh().then(render); } else render();
  // 주소의 #/guardian 등을 바꾸면 그 역할 화면으로 바꿔 보여 준다
  function switchTo(r) {
    setChannels([]);
    stopAlarm();
    role = r; token = r ? store.get(tkey(r)) : null; S = null; G = null;
    ui.route = token ? 'home' : 'start'; ui.ctx = {}; ui.voiceOpen = false; ui.forceList = false;
    if (token) return refresh().then(render);
    render();
    return Promise.resolve();
  }
  window.addEventListener('hashchange', () => {
    if (hashJoin()) return handleJoin();
    if (location.hash === '#/demo') setMode('demo');
    const r = pickRole();
    if (r === role && token) {
      // 보호자 안에서 목록 ↔ 어르신 상세 ↔ 어르신 추가 이동
      if (role === 'guardian') {
        S = null; editingName = false; editingContacts.clear();
        ui.route = hashJoin() ? 'g-add' : 'home';
        render(); refresh();
      }
      return;
    }
    switchTo(r).then(() => { if (pendingPreview && role === 'senior') { pendingPreview = false; previewAlarm(); } });
  });

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

  // 새 버전이 배포되면 알아서 다시 불러온다 (배포 때 index.html 의 ?v= 가 커밋 번호로 바뀐다).
  // 글자를 넣는 중이거나 알람이 울리는 중에는 건드리지 않는다.
  const myVersion = ((document.querySelector('script[src*="app.js"]') || {}).src || '').split('v=')[1];
  async function checkUpdate() {
    if (!myVersion || myVersion === 'dev' || ui.alarm) return;
    if (document.activeElement && /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName)) return;
    try {
      const html = await (await fetch('index.html?check=' + Date.now(), { cache: 'no-store' })).text();
      const v = (html.match(/app\.js\?v=([\w-]+)/) || [])[1];
      if (v && v !== 'dev' && v !== myVersion) location.reload();
    } catch (e) { /* 인터넷이 없으면 다음에 */ }
  }
  setInterval(() => { if (document.visibilityState === 'visible') checkUpdate(); }, 2 * 60000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') checkUpdate(); });
})();

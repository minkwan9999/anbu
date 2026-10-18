// 말로 하기: 들린 문장을 할 일(intent)로 바꾼다. 표준어와 사투리를 함께 받는다.
(function () {
  // 호칭별로 실제로 부르는 말 (경상·전라·충청·제주 포함)
  const REL_WORDS = {
    '딸': ['딸', '딸내미', '딸래미', '따님', '큰딸', '작은딸', '똘'],
    '아들': ['아들', '아들내미', '아들래미', '아드님', '큰아들', '작은아들', '아덜'],
    '며느리': ['며느리', '며늘', '메느리', '메누리'],
    '사위': ['사위', '사우'],
    '손주': ['손주', '손자', '손녀', '손지'],
    '배우자': ['배우자', '남편', '아내', '여보', '영감', '할멈', '마누라', '집사람', '바깥양반'],
    '선생님': ['선생', '쌤', '샘', '요양', '보호사', '복지사']
  };
  const RELS = Object.keys(REL_WORDS).concat(['기타']);

  // 먹었다: 표준어 + 경상(묵었다, 뭇다) + 충청(먹었슈) + 제주(먹언)
  const TOOK = /(먹었|먹엇|먹음|묵었|묵엇|뭇다|뭇어|먹언|드셨|복용)/;
  const CALL = /(전화|통화|걸어|걸아|연결)/;
  const PHOTO = /(사진|사징|찍)/;

  function findContact(t, contacts) {
    return contacts.find(c => {
      const words = c.name.split(/\s+/).filter(w => w.length > 1).concat(REL_WORDS[c.rel] || []);
      return words.some(w => t.includes(w)) || t.includes(c.name.replace(/\s+/g, ''));
    }) || null;
  }

  function parse(text, contacts) {
    const t = String(text || '').replace(/\s+/g, '');
    if (!t) return { intent: 'unknown' };
    const who = findContact(t, contacts);
    if (/약/.test(t) && TOOK.test(t)) return { intent: 'took' };
    if (/약/.test(t)) return { intent: 'medinfo' };
    if (CALL.test(t)) return { intent: 'call', who };
    if (PHOTO.test(t)) return { intent: 'photo', who };
    return { intent: 'unknown' };
  }

  // 인식 후보가 여러 개면 뜻이 잡히는 첫 후보를 쓴다
  function parseBest(candidates, contacts) {
    for (const c of candidates) {
      const r = parse(c, contacts);
      if (r.intent !== 'unknown') return Object.assign({ heard: c }, r);
    }
    return { heard: candidates[0] || '', intent: 'unknown' };
  }

  window.HyodoVoice = { parse, parseBest, RELS };
})();

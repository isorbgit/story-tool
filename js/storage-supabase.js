/* storage-supabase.js — 원격 저장 어댑터 (Supabase Storage).

   SPEC 3.0 의 계약을 그대로 만족하므로 상위 코드(노드 CRUD·자동저장·백업)는
   이 어댑터가 붙었는지 모른다. FSA/OPFS 와 달리 FileSystemDirectoryHandle 이
   아니라 HTTP 위에 서므로 DirAdapter 를 물려받지 않고 따로 구현한다.

   버킷 안의 트리는 폴더 저장과 **같은 모양**이다:
       data/{schema,nodes,edges,canvases}.json
       backup/<stamp>/*.json
   그래서 PC 폴더를 그대로 올리거나 내려도 아귀가 맞는다.

   SDK 를 쓰지 않는다. supabase-js 는 npm 패키지라 빌드 도구가 필요해지는데
   이 프로젝트에는 빌드 도구가 없다(SPEC 1.3). REST 는 그냥 HTTP 다.

   anon key 는 클라이언트에 박으라고 만든 키다. GitHub PAT 와 달리 노출을
   전제로 설계돼 있고, 실제 방어는 버킷의 RLS 정책과 로그인이 한다.
   **버킷을 private 으로 두고 정책을 걸지 않으면 이 파일만 보고도 누구나
   데이터를 읽는다.** 설정은 README 참조. */
(function (WM) {
  'use strict';
  var U = WM.util, el = U.el;

  var CFG_KEY = 'worldmap-supabase-cfg';      // { url, anonKey, bucket }
  var SESSION_KEY = 'worldmap-supabase-session';
  var DATA_FILES = ['schema.json', 'nodes.json', 'edges.json', 'canvases.json'];

  function SupabaseAdapter() {
    this.id = 'supabase';
    this.label = '원격 저장소';
    this.isUserVisible = false;
    this.canRotateBackup = true;
    this.cfg = null;
    this.session = null;                       // { access_token, refresh_token, expires_at }
  }

  /* 설정이 저장돼 있어야 후보가 된다. 처음 쓰는 사람에게 로그인 창부터
     들이밀지 않는다 — 폴더 저장이 기본이고 이건 고르는 것이다. */
  SupabaseAdapter.isAvailable = function () {
    return typeof fetch === 'function' && !!window.isSecureContext;
  };

  SupabaseAdapter.loadConfig = function () {
    return U.idbGet(CFG_KEY).catch(function () { return null; });
  };

  SupabaseAdapter.saveConfig = function (cfg) { return U.idbSet(CFG_KEY, cfg); };
  SupabaseAdapter.forgetConfig = function () {
    return U.idbDel(CFG_KEY).then(function () { return U.idbDel(SESSION_KEY); });
  };

  SupabaseAdapter.prototype.isConnected = function () {
    return !!(this.cfg && this.session && this.session.access_token);
  };

  /* ---------- 인증 ---------- */

  SupabaseAdapter.prototype._authUrl = function (grant) {
    return this.cfg.url.replace(/\/+$/, '') + '/auth/v1/token?grant_type=' + grant;
  };

  SupabaseAdapter.prototype._storeSession = function (j) {
    if (!j || !j.access_token) throw new Error('토큰을 받지 못했습니다');
    this.session = {
      access_token: j.access_token,
      refresh_token: j.refresh_token,
      // 만료 60초 전에 미리 갱신한다. 저장 도중 만료되면 그 저장이 통째로 실패한다.
      expires_at: Date.now() + (Number(j.expires_in || 3600) - 60) * 1000
    };
    return U.idbSet(SESSION_KEY, this.session).then(function () { return true; });
  };

  SupabaseAdapter.prototype.signIn = function (email, password) {
    var self = this;
    return fetch(this._authUrl('password'), {
      method: 'POST',
      headers: { 'apikey': this.cfg.anonKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email, password: password })
    }).then(function (r) {
      return r.json().then(function (j) {
        if (!r.ok) throw new Error(j.error_description || j.msg || j.message || ('로그인 실패 (' + r.status + ')'));
        return self._storeSession(j);
      });
    });
  };

  /* 갱신은 한 번에 하나만 돈다.
     readAll() 은 파일 4개를 병렬로 읽는데, 그 사이 토큰이 만료돼 있으면 넷이 각자
     갱신을 부른다. refresh_token 은 쓸 때마다 회전하므로 동시에 네 번 쓰면 뒤의
     것들이 이미 폐기된 토큰을 들고 가 세션이 통째로 날아간다. */
  SupabaseAdapter.prototype._refresh = function () {
    var self = this;
    if (this._refreshing) return this._refreshing;
    if (!this.session || !this.session.refresh_token) return Promise.reject(new Error('세션이 없습니다'));

    this._refreshing = fetch(this._authUrl('refresh_token'), {
      method: 'POST',
      headers: { 'apikey': this.cfg.anonKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: this.session.refresh_token })
    }).then(function (r) {
      return r.json().then(function (j) {
        if (!r.ok) throw new Error('세션 갱신 실패 — 다시 로그인해야 합니다');
        return self._storeSession(j);
      });
    }).then(function (v) {
      self._refreshing = null;
      return v;
    }, function (e) {
      self._refreshing = null;
      throw e;
    });

    return this._refreshing;
  };

  /** 만료됐으면 갱신하고 헤더를 준다. 모든 요청이 이걸 거친다. */
  SupabaseAdapter.prototype._headers = function (extra) {
    var self = this;
    var need = !this.session || Date.now() >= this.session.expires_at;
    return (need ? this._refresh() : Promise.resolve()).then(function () {
      var h = {
        'apikey': self.cfg.anonKey,
        'Authorization': 'Bearer ' + self.session.access_token
      };
      if (extra) Object.keys(extra).forEach(function (k) { h[k] = extra[k]; });
      return h;
    });
  };

  /* ---------- Storage ---------- */

  SupabaseAdapter.prototype._objUrl = function (path) {
    return this.cfg.url.replace(/\/+$/, '') + '/storage/v1/object/' +
      encodeURIComponent(this.cfg.bucket) + '/' + path.split('/').map(encodeURIComponent).join('/');
  };

  /** 없는 파일은 null. 첫 실행이면 정상이므로 오류로 만들지 않는다(DirAdapter 와 같은 태도). */
  SupabaseAdapter.prototype._readText = function (path) {
    var self = this;
    return this._headers().then(function (h) {
      return fetch(self._objUrl(path), { headers: h, cache: 'no-store' });
    }).then(function (r) {
      if (r.ok) return r.text();
      return r.text().then(function (body) {
        /* Supabase 는 "파일 없음" 을 HTTP 404 로 주지 않는다. **HTTP 400** 에
           본문의 statusCode 만 404 다. 상태 코드만 보면 "아직 파일이 없다" 를
           "읽기 실패" 로 오해해 빈 버킷에 대한 첫 연결이 통째로 막힌다.

           권한 거부(AccessDenied)는 절대 여기서 삼키면 안 된다. 그걸 null 로
           돌리면 정책이 틀린 것이 "빈 저장소" 로 보이고, 곧이어 그 빈 상태가
           저장되어 데이터를 덮는다. */
        var code = '';
        try {
          var j = JSON.parse(body);
          code = j.code || '';
          if (!code && String(j.statusCode) === '404') code = 'NoSuchKey';
        } catch (e) { /* JSON 이 아니면 아래에서 오류로 넘어간다 */ }

        if (code === 'NoSuchKey' || r.status === 404) return null;
        throw new Error(path + ' 읽기 실패 (' + r.status + ' ' + (code || '?') + ') ' + body.slice(0, 160));
      });
    });
  };

  SupabaseAdapter.prototype._writeText = function (path, text) {
    var self = this;
    return this._headers({ 'Content-Type': 'application/json', 'x-upsert': 'true' }).then(function (h) {
      return fetch(self._objUrl(path), { method: 'POST', headers: h, body: text });
    }).then(function (r) {
      if (r.ok) return true;
      return r.text().then(function (t) { throw new Error(path + ' 저장 실패 (' + r.status + ') ' + t.slice(0, 200)); });
    });
  };

  SupabaseAdapter.prototype._delete = function (paths) {
    var self = this;
    if (!paths.length) return Promise.resolve();
    return this._headers({ 'Content-Type': 'application/json' }).then(function (h) {
      return fetch(self.cfg.url.replace(/\/+$/, '') + '/storage/v1/object/' + encodeURIComponent(self.cfg.bucket), {
        method: 'DELETE', headers: h, body: JSON.stringify({ prefixes: paths })
      });
    }).then(function (r) {
      if (!r.ok) console.warn('[wm] 원격 삭제 실패', r.status, paths);
    });
  };

  /** prefix 아래 항목 이름 목록. 폴더는 id 가 null 로 온다. */
  SupabaseAdapter.prototype._list = function (prefix) {
    var self = this;
    return this._headers({ 'Content-Type': 'application/json' }).then(function (h) {
      return fetch(self.cfg.url.replace(/\/+$/, '') + '/storage/v1/object/list/' + encodeURIComponent(self.cfg.bucket), {
        method: 'POST', headers: h,
        body: JSON.stringify({ prefix: prefix, limit: 200, sortBy: { column: 'name', order: 'asc' } })
      });
    }).then(function (r) {
      if (!r.ok) return [];
      return r.json();
    }).catch(function () { return []; });
  };

  /* ---------- 어댑터 계약 ---------- */

  SupabaseAdapter.prototype.connect = function () {
    var self = this;
    return SupabaseAdapter.loadConfig().then(function (cfg) {
      if (!cfg || !cfg.url || !cfg.anonKey || !cfg.bucket) throw new Error('원격 저장소 설정이 없습니다');
      self.cfg = cfg;
      return U.idbGet(SESSION_KEY);
    }).then(function (s) {
      self.session = s || null;
      if (!self.session) throw new Error('로그인이 필요합니다');
      // 토큰이 살아 있는지 실제로 한 번 눌러 본다. OPFS.probe() 와 같은 태도다.
      return self._headers().then(function () { return self; });
    });
  };

  SupabaseAdapter.prototype.restore = function () { return this.connect(); };

  SupabaseAdapter.prototype.readAll = function () {
    var self = this;
    return Promise.all(DATA_FILES.map(function (n) { return self._readText('data/' + n); }))
      .then(function (texts) {
        var out = {};
        DATA_FILES.forEach(function (name, i) {
          var key = name.replace('.json', '');
          var t = texts[i];
          if (t === null || t === '') { out[key] = null; return; }
          try { out[key] = JSON.parse(t); }
          catch (e) { throw new Error(name + ' 을(를) 읽을 수 없습니다 (JSON 구문 오류): ' + e.message); }
        });
        return out;
      });
  };

  /* 순차로 쓴다. 병렬로 던지면 하나만 실패했을 때 어디까지 올라갔는지 알 수 없다. */
  SupabaseAdapter.prototype.writeFiles = function (files) {
    var self = this;
    return Object.keys(files).reduce(function (p, n) {
      return p.then(function () { return self._writeText('data/' + n, files[n]); });
    }, Promise.resolve());
  };

  SupabaseAdapter.prototype.writeTree = function (files) {
    var self = this;
    return Object.keys(files).reduce(function (p, path) {
      return p.then(function () { return self._writeText(path, files[path]); });
    }, Promise.resolve());
  };

  SupabaseAdapter.prototype.removePath = function (path) {
    var self = this;
    return this._list(path).then(function (items) {
      return self._delete(items.filter(function (i) { return i.id; })
        .map(function (i) { return path + '/' + i.name; }));
    });
  };

  SupabaseAdapter.prototype.listBackups = function () {
    return this._list('backup').then(function (items) {
      return items.filter(function (i) { return !i.id; })      // 폴더만
        .map(function (i) { return i.name; }).sort();
    });
  };

  SupabaseAdapter.prototype.writeBackup = function (stamp, files) {
    var self = this;
    return Object.keys(files).reduce(function (p, n) {
      return p.then(function () { return self._writeText('backup/' + stamp + '/' + n, files[n]); });
    }, Promise.resolve());
  };

  SupabaseAdapter.prototype.deleteBackup = function (stamp) {
    return this._delete(DATA_FILES.map(function (n) { return 'backup/' + stamp + '/' + n; }));
  };

  SupabaseAdapter.prototype.rotateBackups = function () {
    var self = this;
    return this.listBackups().then(function (list) {
      var excess = list.slice(0, Math.max(0, list.length - WM.storage.MAX_BACKUPS));
      return excess.reduce(function (p, s) {
        return p.then(function () { return self.deleteBackup(s); });
      }, Promise.resolve());
    });
  };

  SupabaseAdapter.prototype.forget = function () {
    this.session = null;
    return SupabaseAdapter.forgetConfig();
  };

  /* ---------- 설정·로그인 UI ---------- */

  /** 시작 화면의 [원격 저장소] 에서 부른다. 성공하면 연결된 어댑터를 준다. */
  SupabaseAdapter.setup = function () {
    return SupabaseAdapter.loadConfig().then(function (cfg) {
      cfg = cfg || { url: '', anonKey: '', bucket: 'worldmap' };
      var f = {};
      function field(key, label, type, hint) {
        f[key] = el('input.input', { type: type || 'text', value: cfg[key] || '', autocapitalize: 'off', spellcheck: false });
        return el('label.field', {}, [
          el('span.field__label', { text: label }),
          f[key],
          hint ? el('em.field__hint', { text: hint }) : null
        ]);
      }

      var body = [
        el('p.dim', { text: 'Supabase 프로젝트의 값을 넣습니다. anon key 는 공개를 전제로 만든 키라 여기 넣어도 됩니다 — 실제 방어는 버킷 정책과 로그인이 합니다.' }),
        field('url', '프로젝트 URL', 'url', 'https://xxxx.supabase.co'),
        field('anonKey', 'anon key', 'text', 'Project Settings → API'),
        field('bucket', '버킷 이름', 'text', 'private 으로 만들어 둘 것'),
        el('hr'),
        field('email', '이메일', 'email'),
        field('password', '비밀번호', 'password')
      ];

      return U.modal({
        title: '원격 저장소 연결',
        body: body,
        actions: [{ label: '취소', value: null }, { label: '연결', value: true, kind: 'primary' }]
      }).then(function (ok) {
        if (!ok) return null;
        var next = {
          url: f.url.value.trim(),
          anonKey: f.anonKey.value.trim(),
          bucket: f.bucket.value.trim() || 'worldmap'
        };
        if (!next.url || !next.anonKey) { U.toast('URL 과 anon key 가 필요합니다', 'bad', 4000); return null; }

        var a = new SupabaseAdapter();
        a.cfg = next;
        /* 여기서 설정을 저장하지 않는다. 로그인이 됐다고 연결이 된 것이 아니다 —
           정책이 틀리면 읽기가 막힌다. 반쪽짜리 설정을 저장해 두면 다음 부팅을
           그게 가로채서, 실패했는데도 원격에 붙은 것처럼 보인다.
           읽기까지 확인한 뒤 호출부가 saveConfig 한다. */
        return a.signIn(f.email.value.trim(), f.password.value).then(function () {
          return a;
        }).catch(function (e) {
          U.toast(e.message || String(e), 'bad', 6000);
          return null;
        });
      });
    });
  };

  WM.storage.SupabaseAdapter = SupabaseAdapter;
})(window.WM);

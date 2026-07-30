/* storage.js — 저장 어댑터 (SPEC 3.0).
   FSA와 OPFS는 둘 다 FileSystemDirectoryHandle 위에서 도는 같은 API라,
   디렉터리 조작 로직은 DirAdapter 하나로 공유하고 "루트를 어떻게 얻는가"만 다르다. */
(function (WM) {
  'use strict';
  var U = WM.util;

  var DATA_FILES = ['schema.json', 'nodes.json', 'edges.json', 'canvases.json'];
  var HANDLE_KEY = 'worldmap-dir-handle';
  var MAX_BACKUPS = 10;

  /* ---------- 공통: DirectoryHandle 기반 ---------- */

  function DirAdapter() {
    this.root = null;
    this.canRotateBackup = true;
    this.isUserVisible = false;
  }

  DirAdapter.prototype.isConnected = function () { return !!this.root; };

  DirAdapter.prototype._dir = function (parent, name, create) {
    return parent.getDirectoryHandle(name, { create: !!create });
  };

  DirAdapter.prototype._readText = function (dir, name) {
    return dir.getFileHandle(name).then(function (fh) {
      return fh.getFile();
    }).then(function (f) {
      return f.text();
    }).catch(function (e) {
      if (e && e.name === 'NotFoundError') return null;   // 아직 없는 파일 — 첫 실행이면 정상
      throw e;
    });
  };

  DirAdapter.prototype._writeText = function (dir, name, text) {
    return dir.getFileHandle(name, { create: true }).then(function (fh) {
      if (typeof fh.createWritable !== 'function') {
        throw new Error('이 브라우저는 파일 쓰기(createWritable)를 지원하지 않습니다. iOS는 17 이상이 필요합니다.');
      }
      return fh.createWritable().then(function (w) {
        return w.write(text).then(function () { return w.close(); });
      });
    });
  };

  /** values() 비동기 이터레이터를 배열로. */
  DirAdapter.prototype._entries = function (dir) {
    var out = [];
    if (typeof dir.values !== 'function') return Promise.resolve(out);
    var it = dir.values();
    function step() {
      return it.next().then(function (r) {
        if (r.done) return out;
        out.push(r.value);
        return step();
      });
    }
    return step().catch(function () { return out; });
  };

  DirAdapter.prototype.readAll = function () {
    var self = this;
    return this._dir(this.root, 'data', true).then(function (data) {
      return Promise.all(DATA_FILES.map(function (n) { return self._readText(data, n); }));
    }).then(function (texts) {
      var out = {};
      DATA_FILES.forEach(function (name, i) {
        var key = name.replace('.json', '');
        var t = texts[i];
        if (t === null || t === '') { out[key] = null; return; }
        try {
          out[key] = JSON.parse(t);
        } catch (e) {
          throw new Error(name + ' 을(를) 읽을 수 없습니다 (JSON 구문 오류): ' + e.message);
        }
      });
      return out;
    });
  };

  DirAdapter.prototype.writeFiles = function (files) {
    var self = this;
    return this._dir(this.root, 'data', true).then(function (data) {
      var names = Object.keys(files);
      return names.reduce(function (p, n) {
        return p.then(function () { return self._writeText(data, n, files[n]); });
      }, Promise.resolve());
    });
  };

  /** 'a/b/c' 를 따라가며 없으면 만든다. */
  DirAdapter.prototype._dirPath = function (parts) {
    var self = this;
    return parts.reduce(function (p, name) {
      return p.then(function (d) { return self._dir(d, name, true); });
    }, Promise.resolve(this.root));
  };

  /** files: { 'export/markdown/character/chr_lena.md': '...' } — 중간 폴더는 알아서 만든다. */
  DirAdapter.prototype.writeTree = function (files) {
    var self = this;
    return Object.keys(files).reduce(function (p, path) {
      return p.then(function () {
        var parts = path.split('/');
        var file = parts.pop();
        return self._dirPath(parts).then(function (d) {
          return self._writeText(d, file, files[path]);
        });
      });
    }, Promise.resolve());
  };

  /** 다시 내보내기 전에 옛 결과를 지운다. 안 지우면 삭제된 노드의 문서가 남는다. */
  DirAdapter.prototype.removePath = function (path) {
    var parts = path.split('/');
    var last = parts.pop();
    return this._dirPath(parts).then(function (d) {
      return d.removeEntry(last, { recursive: true });
    }).catch(function () { /* 처음 내보내는 경우 — 없는 게 정상 */ });
  };

  DirAdapter.prototype.listBackups = function () {
    var self = this;
    return this._dir(this.root, 'backup', true).then(function (b) {
      return self._entries(b);
    }).then(function (entries) {
      return entries.filter(function (e) { return e.kind === 'directory'; })
        .map(function (e) { return e.name; })
        .sort();
    }).catch(function () { return []; });
  };

  DirAdapter.prototype.writeBackup = function (stamp, files) {
    var self = this;
    return this._dir(this.root, 'backup', true).then(function (b) {
      return self._dir(b, stamp, true);
    }).then(function (snap) {
      return Object.keys(files).reduce(function (p, n) {
        return p.then(function () { return self._writeText(snap, n, files[n]); });
      }, Promise.resolve());
    });
  };

  DirAdapter.prototype.deleteBackup = function (stamp) {
    var self = this;
    return this._dir(this.root, 'backup', true).then(function (b) {
      return b.removeEntry(stamp, { recursive: true });
    }).catch(function (e) { console.warn('[wm] 백업 삭제 실패', stamp, e); });
  };

  /** 오래된 백업 삭제. MAX_BACKUPS 개만 남긴다. */
  DirAdapter.prototype.rotateBackups = function () {
    var self = this;
    return this.listBackups().then(function (list) {
      var excess = list.slice(0, Math.max(0, list.length - MAX_BACKUPS));
      return excess.reduce(function (p, s) {
        return p.then(function () { return self.deleteBackup(s); });
      }, Promise.resolve());
    });
  };

  /* ---------- FsaAdapter — 데스크톱 크로미움 ---------- */

  function FsaAdapter() {
    DirAdapter.call(this);
    this.id = 'fsa';
    this.label = '로컬 폴더';
    this.isUserVisible = true;
  }
  FsaAdapter.prototype = Object.create(DirAdapter.prototype);
  FsaAdapter.prototype.constructor = FsaAdapter;

  FsaAdapter.isAvailable = function () {
    return typeof window.showDirectoryPicker === 'function';
  };

  function verifyPermission(handle, interactive) {
    var opts = { mode: 'readwrite' };
    return handle.queryPermission(opts).then(function (p) {
      if (p === 'granted') return true;
      if (!interactive) return false;
      return handle.requestPermission(opts).then(function (p2) { return p2 === 'granted'; });
    }).catch(function () { return false; });
  }

  /** 사용자 제스처 안에서 호출해야 한다. */
  FsaAdapter.prototype.connect = function () {
    var self = this;
    return window.showDirectoryPicker({ mode: 'readwrite', id: 'worldmap' }).then(function (h) {
      self.root = h;
      return U.idbSet(HANDLE_KEY, h).then(function (ok) {
        if (!ok) self.handleNotPersisted = true;
        return self;
      });
    });
  };

  /** 저장된 핸들로 조용히 재연결. 권한이 남아있지 않으면 null. */
  FsaAdapter.prototype.restore = function (interactive) {
    var self = this;
    return U.idbGet(HANDLE_KEY).then(function (h) {
      if (!h) return null;
      return verifyPermission(h, !!interactive).then(function (ok) {
        if (!ok) return null;
        self.root = h;
        return self;
      });
    }).catch(function () { return null; });
  };

  FsaAdapter.prototype.forget = function () {
    this.root = null;
    return U.idbDel(HANDLE_KEY);
  };

  /* ---------- OpfsAdapter — iOS 등 FSA 미지원 ---------- */

  function OpfsAdapter() {
    DirAdapter.call(this);
    this.id = 'opfs';
    this.label = '브라우저 내부 저장소';
    this.isUserVisible = false;
  }
  OpfsAdapter.prototype = Object.create(DirAdapter.prototype);
  OpfsAdapter.prototype.constructor = OpfsAdapter;

  OpfsAdapter.isAvailable = function () {
    return !!(navigator.storage && typeof navigator.storage.getDirectory === 'function');
  };

  OpfsAdapter.prototype.connect = function () {
    var self = this;
    return navigator.storage.getDirectory().then(function (root) {
      return root.getDirectoryHandle('worldmap', { create: true });
    }).then(function (h) {
      self.root = h;
      // 데이터가 브라우저 정리로 날아가지 않게 요청. 거부돼도 계속 진행한다.
      if (navigator.storage.persist) {
        navigator.storage.persist().then(function (granted) { self.persisted = granted; })
          .catch(function () {});
      }
      return self;
    });
  };

  OpfsAdapter.prototype.restore = function () { return this.connect(); };

  /**
   * 진짜 쓰고 읽어 보고 판정한다.
   * 프로토콜이나 브라우저 이름으로 넘겨짚으면 틀린다. 실측 결과:
   *   Chrome file://  → getDirectory 는 있는데 쓰려고 하면 SecurityError
   *   Firefox file:// → 멀쩡히 되고 재시작해도 남는다 (할당량 10GB)
   * 즉 "file:// 면 OPFS 불가" 는 사실이 아니다.
   */
  OpfsAdapter.prototype.probe = function () {
    var self = this;
    return this.connect().then(function () {
      return self._dir(self.root, '.probe', true);
    }).then(function (d) {
      return self._writeText(d, 'w.txt', 'ok').then(function () { return self._readText(d, 'w.txt'); });
    }).then(function (t) {
      return self.root.removeEntry('.probe', { recursive: true })
        .catch(function () {})
        .then(function () { return t === 'ok'; });
    }).catch(function (e) {
      self.root = null;
      self.lastError = (e && (e.name + ': ' + e.message)) || String(e);
      console.warn('[wm] OPFS 사용 불가 —', self.lastError);
      return false;
    });
  };

  /* ---------- MemoryAdapter — 최후의 수단 ---------- */

  function MemoryAdapter(reason) {
    this.id = 'memory';
    this.label = '메모리 (임시)';
    this.reason = reason || null;
    this.isUserVisible = false;
    this.canRotateBackup = false;
    this.files = {};
    this.backups = {};
    this.root = true;
  }
  MemoryAdapter.isAvailable = function () { return true; };
  MemoryAdapter.prototype.isConnected = function () { return true; };
  MemoryAdapter.prototype.connect = function () { return Promise.resolve(this); };
  MemoryAdapter.prototype.restore = function () { return Promise.resolve(this); };
  MemoryAdapter.prototype.readAll = function () {
    var self = this, out = {};
    DATA_FILES.forEach(function (n) {
      var t = self.files[n];
      out[n.replace('.json', '')] = t ? JSON.parse(t) : null;
    });
    return Promise.resolve(out);
  };
  MemoryAdapter.prototype.writeFiles = function (files) {
    Object.assign(this.files, files);
    return Promise.resolve();
  };
  MemoryAdapter.prototype.listBackups = function () { return Promise.resolve(Object.keys(this.backups).sort()); };
  MemoryAdapter.prototype.writeBackup = function (s, f) { this.backups[s] = f; return Promise.resolve(); };
  MemoryAdapter.prototype.deleteBackup = function (s) { delete this.backups[s]; return Promise.resolve(); };
  MemoryAdapter.prototype.rotateBackups = function () { return Promise.resolve(); };

  /* ---------- 선택 ----------
     FSA → OPFS → Memory.
     OPFS 는 API 존재 여부만으로 판단할 수 없다. 실제로 써 보고 정한다. */

  function pickAdapter() {
    if (FsaAdapter.isAvailable()) return Promise.resolve(new FsaAdapter());
    if (!OpfsAdapter.isAvailable()) {
      return Promise.resolve(new MemoryAdapter('이 브라우저에 OPFS(navigator.storage.getDirectory)가 없습니다.'));
    }
    var o = new OpfsAdapter();
    return o.probe().then(function (ok) {
      return ok ? o : new MemoryAdapter(o.lastError);
    });
  }

  function describeEnvironment() {
    var ua = navigator.userAgent || '';
    return {
      isFile: location.protocol === 'file:',
      protocol: location.protocol,
      isSecureContext: !!window.isSecureContext,
      hasFsa: FsaAdapter.isAvailable(),
      hasOpfs: OpfsAdapter.isAvailable(),
      hasIdb: typeof indexedDB !== 'undefined',
      browser: /Firefox\//.test(ua) ? 'Firefox'
        : /Edg\//.test(ua) ? 'Edge'
        : /Chrome\//.test(ua) ? 'Chrome'
        : /Safari\//.test(ua) ? 'Safari' : '알 수 없음',
      // iOS는 브라우저를 바꿔도 전부 WebKit이라 FSA가 없다.
      likelyIos: /iP(hone|ad|od)/.test(navigator.platform) ||
        (navigator.maxTouchPoints > 1 && /Mac/.test(navigator.platform))
    };
  }

  WM.storage = {
    DATA_FILES: DATA_FILES,
    MAX_BACKUPS: MAX_BACKUPS,
    FsaAdapter: FsaAdapter,
    OpfsAdapter: OpfsAdapter,
    MemoryAdapter: MemoryAdapter,
    pickAdapter: pickAdapter,
    describeEnvironment: describeEnvironment
  };
})(window.WM);

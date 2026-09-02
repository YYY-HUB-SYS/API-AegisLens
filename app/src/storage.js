const fs = require('node:fs');
const path = require('node:path');
const { encryptField, decryptField } = require('./crypto');
const { inferStyle } = require('./adapters');

function nowIso() { return new Date().toISOString(); }

function normEps(platform, eps) {
  return (eps || []).map(function (e) {
    e = e || {};
    return {
      url: String(e.url == null ? '' : e.url),
      style: String(e.style == null ? '' : e.style) || inferStyle(platform)
    };
  });
}

function legacyEps(platform, base) {
  return base ? [{ url: base, style: inferStyle(platform) }] : [];
}

function createStore(dataDir, masterKey, opts) {
  fs.mkdirSync(dataDir, { recursive: true });
  const prefer = (opts && opts.backend) || 'auto';
  if (prefer !== 'json') {
    try {
      const { DatabaseSync } = require('node:sqlite');
      return makeSqliteStore(dataDir, masterKey, DatabaseSync);
    } catch (e) {
      if (prefer === 'sqlite') throw e;
    }
  }
  return makeJsonStore(dataDir, masterKey);
}

function emptyBalance(status) {
  return { value: null, status: status || 'pending', updatedAt: null };
}

/* ================= JSON 文件后端 ================= */

function makeJsonStore(dataDir, masterKey) {
  const file = path.join(dataDir, 'store.json');
  let data;
  if (fs.existsSync(file)) {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } else {
    data = { nextId: 1, keys: [] };
  }
  function persist() {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
  }
  function find(id) { return data.keys.find(function (x) { return x.id === id; }) || null; }
  function epsOf(doc) {
    if (Array.isArray(doc.endpoints)) return normEps(doc.platform, doc.endpoints);
    return legacyEps(doc.platform, doc.base || '');
  }
  function toRec(doc) {
    const eps = epsOf(doc);
    return {
      id: doc.id,
      name: doc.name,
      platform: doc.platform,
      customName: doc.customName || '',
      key: decryptField(masterKey, doc.keyEnc),
      endpoints: eps,
      base: eps.length ? eps[0].url : '',
      model: doc.model || '',
      reg: doc.reg || '',
      exp: doc.exp || '',
      authNote: doc.authNote || '',
      balance: doc.balance || emptyBalance(),
      test: doc.test || null,
      modelsFetched: !!doc.modelsFetched,
      models: doc.models || [],
      assigned: doc.assigned || [],
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt
    };
  }

  return {
    backend: 'json',
    dataDir: dataDir,

    listKeys() { return data.keys.map(toRec); },
    getKey(id) { const d = find(id); return d ? toRec(d) : null; },

    createKey(input) {
      const eps = Array.isArray(input.endpoints)
        ? normEps(input.platform, input.endpoints)
        : legacyEps(input.platform, input.base || '');
      const doc = {
        id: data.nextId++,
        name: input.name,
        platform: input.platform,
        customName: input.customName || '',
        keyEnc: encryptField(masterKey, input.key),
        endpoints: eps,
        base: eps.length ? eps[0].url : '',
        model: input.model || '',
        reg: input.reg || '',
        exp: input.exp || '',
        authNote: input.authNote || '',
        balance: emptyBalance(input.balanceStatus),
        test: null,
        modelsFetched: false,
        models: [],
        assigned: [],
        createdAt: nowIso(),
        updatedAt: nowIso()
      };
      data.keys.push(doc);
      persist();
      return toRec(doc);
    },

    updateKey(id, patch) {
      const d = find(id);
      if (!d) return null;
      ['name', 'platform', 'customName', 'model', 'reg', 'exp', 'authNote'].forEach(function (f) {
        if (patch[f] !== undefined) d[f] = patch[f];
      });
      if (patch.key !== undefined) d.keyEnc = encryptField(masterKey, patch.key);
      if (patch.endpoints !== undefined) {
        d.endpoints = normEps(d.platform, patch.endpoints);
        d.base = d.endpoints.length ? d.endpoints[0].url : '';
      } else if (patch.base !== undefined) {
        d.base = patch.base;
        d.endpoints = legacyEps(d.platform, patch.base);
      }
      d.updatedAt = nowIso();
      persist();
      return toRec(d);
    },

    saveBalance(id, balance) {
      const d = find(id);
      if (!d) return null;
      d.balance = {
        value: balance.value == null ? null : Number(balance.value),
        status: balance.status || 'ok',
        updatedAt: nowIso()
      };
      persist();
      return toRec(d);
    },

    saveTest(id, test) {
      const d = find(id);
      if (!d) return null;
      d.test = Object.assign({ at: nowIso() }, test);
      persist();
      return toRec(d);
    },

    replaceModels(id, models) {
      const d = find(id);
      if (!d) return null;
      d.models = models;
      d.modelsFetched = true;
      d.updatedAt = nowIso();
      persist();
      return toRec(d);
    },

    upsertModel(id, m) {
      const d = find(id);
      if (!d) return null;
      d.models = d.models || [];
      let hit = null;
      for (let i = 0; i < d.models.length; i++) {
        if (d.models[i].id === m.id) { hit = d.models[i]; break; }
      }
      if (!hit) {
        hit = { id: m.id, ctx: null, out: null, src: m.src || 'manual', note: null };
        d.models.push(hit);
      }
      ['ctx', 'out', 'src', 'note'].forEach(function (f) {
        if (m[f] !== undefined) hit[f] = m[f];
      });
      d.updatedAt = nowIso();
      persist();
      return toRec(d);
    },

    addAssigned(id, tool) {
      const d = find(id);
      if (!d) return null;
      d.assigned = d.assigned || [];
      if (d.assigned.indexOf(tool) >= 0) return null;
      d.assigned.push(tool);
      d.updatedAt = nowIso();
      persist();
      return toRec(d);
    },

    removeAssigned(id, tool) {
      const d = find(id);
      if (!d) return null;
      d.assigned = d.assigned.filter(function (t) { return t !== tool; });
      d.updatedAt = nowIso();
      persist();
      return toRec(d);
    },

    deleteKey(id) {
      const before = data.keys.length;
      data.keys = data.keys.filter(function (x) { return x.id !== id; });
      if (data.keys.length === before) return false;
      persist();
      return true;
    }
  };
}

/* ================= SQLite 后端（node:sqlite） ================= */

function makeSqliteStore(dataDir, masterKey, DatabaseSync) {
  const db = new DatabaseSync(path.join(dataDir, 'keys.db'));
  db.exec([
    'CREATE TABLE IF NOT EXISTS keys (',
    '  id INTEGER PRIMARY KEY AUTOINCREMENT,',
    '  name TEXT NOT NULL,',
    '  platform TEXT NOT NULL,',
    '  custom_name TEXT DEFAULT \'\',',
    '  key_enc TEXT NOT NULL,',
    '  base TEXT DEFAULT \'\',',
    '  endpoints_json TEXT,',
    '  model TEXT DEFAULT \'\',',
    '  reg TEXT DEFAULT \'\',',
    '  exp TEXT DEFAULT \'\',',
    '  auth_note TEXT DEFAULT \'\',',
    '  balance_value REAL,',
    '  balance_status TEXT DEFAULT \'pending\',',
    '  balance_updated_at TEXT,',
    '  test_json TEXT,',
    '  models_fetched INTEGER DEFAULT 0,',
    '  created_at TEXT,',
    '  updated_at TEXT',
    ');',
    'CREATE TABLE IF NOT EXISTS models (',
    '  key_id INTEGER NOT NULL,',
    '  id TEXT NOT NULL,',
    '  ctx INTEGER,',
    '  out INTEGER,',
    '  src TEXT DEFAULT \'meta\',',
    '  note TEXT,',
    '  PRIMARY KEY (key_id, id)',
    ');',
    'CREATE TABLE IF NOT EXISTS assigned (',
    '  key_id INTEGER NOT NULL,',
    '  tool TEXT NOT NULL,',
    '  PRIMARY KEY (key_id, tool)',
    ');'
  ].join('\n'));
  try {
    db.exec('ALTER TABLE keys ADD COLUMN endpoints_json TEXT');
  } catch (e) { /* 旧库已有该列或新库已含，忽略 */ }
  try {
    db.exec('ALTER TABLE keys ADD COLUMN auth_note TEXT');
  } catch (e) { /* 旧库已有该列或新库已含，忽略 */ }

  const stmt = {
    selectAll: db.prepare('SELECT * FROM keys ORDER BY id'),
    selectOne: db.prepare('SELECT * FROM keys WHERE id = ?'),
    insert: db.prepare('INSERT INTO keys (name, platform, custom_name, key_enc, base, endpoints_json, model, reg, exp, auth_note, balance_status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'),
    update: db.prepare('UPDATE keys SET name = ?, platform = ?, custom_name = ?, key_enc = ?, base = ?, endpoints_json = ?, model = ?, reg = ?, exp = ?, auth_note = ?, updated_at = ? WHERE id = ?'),
    setBalance: db.prepare('UPDATE keys SET balance_value = ?, balance_status = ?, balance_updated_at = ? WHERE id = ?'),
    setTest: db.prepare('UPDATE keys SET test_json = ? WHERE id = ?'),
    setModelsFetched: db.prepare('UPDATE keys SET models_fetched = 1 WHERE id = ?'),
    touch: db.prepare('UPDATE keys SET updated_at = ? WHERE id = ?'),
    delKey: db.prepare('DELETE FROM keys WHERE id = ?'),
    selModels: db.prepare('SELECT id, ctx, out, src, note FROM models WHERE key_id = ? ORDER BY rowid'),
    delModels: db.prepare('DELETE FROM models WHERE key_id = ?'),
    insModel: db.prepare('INSERT INTO models (key_id, id, ctx, out, src, note) VALUES (?, ?, ?, ?, ?, ?)'),
    selModel: db.prepare('SELECT id, ctx, out, src, note FROM models WHERE key_id = ? AND id = ?'),
    updModel: db.prepare('UPDATE models SET ctx = ?, out = ?, src = ?, note = ? WHERE key_id = ? AND id = ?'),
    selAssigned: db.prepare('SELECT tool FROM assigned WHERE key_id = ? ORDER BY rowid'),
    insAssigned: db.prepare('INSERT OR IGNORE INTO assigned (key_id, tool) VALUES (?, ?)'),
    delAssigned: db.prepare('DELETE FROM assigned WHERE key_id = ? AND tool = ?'),
    delAssignedAll: db.prepare('DELETE FROM assigned WHERE key_id = ?')
  };

  function loadModels(id) {
    return stmt.selModels.all(id).map(function (r) {
      return { id: r.id, ctx: r.ctx == null ? null : r.ctx, out: r.out == null ? null : r.out, src: r.src || 'api', note: r.note == null ? null : r.note };
    });
  }
  function loadAssigned(id) {
    return stmt.selAssigned.all(id).map(function (r) { return r.tool; });
  }
  function epsOfRow(row) {
    if (row.endpoints_json) {
      try {
        const parsed = JSON.parse(row.endpoints_json);
        if (Array.isArray(parsed)) return normEps(row.platform, parsed);
      } catch (e) { /* JSON 损坏时回退 legacy */ }
    }
    return legacyEps(row.platform, row.base || '');
  }
  function toRec(row) {
    let test = null;
    if (row.test_json) {
      try { test = JSON.parse(row.test_json); } catch (e) { test = null; }
    }
    const eps = epsOfRow(row);
    return {
      id: row.id,
      name: row.name,
      platform: row.platform,
      customName: row.custom_name || '',
      key: decryptField(masterKey, row.key_enc),
      endpoints: eps,
      base: eps.length ? eps[0].url : '',
      model: row.model || '',
      reg: row.reg || '',
      exp: row.exp || '',
      authNote: row.auth_note || '',
      balance: {
        value: row.balance_value == null ? null : row.balance_value,
        status: row.balance_status || 'pending',
        updatedAt: row.balance_updated_at || null
      },
      test: test,
      modelsFetched: !!row.models_fetched,
      models: loadModels(row.id),
      assigned: loadAssigned(row.id),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }
  function getRow(id) { return stmt.selectOne.get(id) || null; }

  return {
    backend: 'sqlite',
    dataDir: dataDir,

    listKeys() { return stmt.selectAll.all().map(toRec); },
    getKey(id) { const r = getRow(id); return r ? toRec(r) : null; },

    createKey(input) {
      const now = nowIso();
      const eps = Array.isArray(input.endpoints)
        ? normEps(input.platform, input.endpoints)
        : legacyEps(input.platform, input.base || '');
      const r = stmt.insert.run(
        input.name, input.platform, input.customName || '',
        encryptField(masterKey, input.key),
        eps.length ? eps[0].url : '', JSON.stringify(eps),
        input.model || '', input.reg || '', input.exp || '',
        input.authNote || '', input.balanceStatus || 'pending', now, now
      );
      return toRec(getRow(Number(r.lastInsertRowid)));
    },

    updateKey(id, patch) {
      const cur = getRow(id);
      if (!cur) return null;
      const platform = patch.platform !== undefined ? patch.platform : cur.platform;
      let eps;
      if (patch.endpoints !== undefined) {
        eps = normEps(platform, patch.endpoints);
      } else if (patch.base !== undefined) {
        eps = legacyEps(platform, patch.base);
      } else {
        eps = epsOfRow(cur);
      }
      const merged = {
        name: patch.name !== undefined ? patch.name : cur.name,
        platform: platform,
        customName: patch.customName !== undefined ? patch.customName : (cur.custom_name || ''),
        keyEnc: patch.key !== undefined ? encryptField(masterKey, patch.key) : cur.key_enc,
        base: eps.length ? eps[0].url : '',
        endpointsJson: JSON.stringify(eps),
        model: patch.model !== undefined ? patch.model : cur.model,
        reg: patch.reg !== undefined ? patch.reg : cur.reg,
        exp: patch.exp !== undefined ? patch.exp : cur.exp,
        authNote: patch.authNote !== undefined ? patch.authNote : (cur.auth_note || '')
      };
      stmt.update.run(
        merged.name, merged.platform, merged.customName, merged.keyEnc,
        merged.base, merged.endpointsJson,
        merged.model, merged.reg, merged.exp, merged.authNote, nowIso(), id
      );
      return toRec(getRow(id));
    },

    saveBalance(id, balance) {
      const cur = getRow(id);
      if (!cur) return null;
      stmt.setBalance.run(
        balance.value == null ? null : Number(balance.value),
        balance.status || 'ok',
        nowIso(), id
      );
      return toRec(getRow(id));
    },

    saveTest(id, test) {
      const cur = getRow(id);
      if (!cur) return null;
      stmt.setTest.run(JSON.stringify(Object.assign({ at: nowIso() }, test)), id);
      return toRec(getRow(id));
    },

    replaceModels(id, models) {
      const cur = getRow(id);
      if (!cur) return null;
      stmt.delModels.run(id);
      models.forEach(function (m) {
        stmt.insModel.run(id, m.id, m.ctx == null ? null : m.ctx, m.out == null ? null : m.out, m.src || 'api', m.note == null ? null : m.note);
      });
      stmt.setModelsFetched.run(id);
      stmt.touch.run(nowIso(), id);
      return toRec(getRow(id));
    },

    upsertModel(id, m) {
      const cur = getRow(id);
      if (!cur) return null;
      const hit = stmt.selModel.get(id, m.id);
      if (hit) {
        stmt.updModel.run(
          m.ctx !== undefined ? (m.ctx == null ? null : m.ctx) : hit.ctx,
          m.out !== undefined ? (m.out == null ? null : m.out) : hit.out,
          m.src !== undefined ? m.src : hit.src,
          m.note !== undefined ? m.note : hit.note,
          id, m.id
        );
      } else {
        stmt.insModel.run(id, m.id, m.ctx == null ? null : m.ctx, m.out == null ? null : m.out, m.src || 'manual', m.note == null ? null : m.note);
      }
      stmt.touch.run(nowIso(), id);
      return toRec(getRow(id));
    },

    addAssigned(id, tool) {
      const cur = getRow(id);
      if (!cur) return null;
      const r = stmt.insAssigned.run(id, tool);
      if (r.changes === 0) return null;
      stmt.touch.run(nowIso(), id);
      return toRec(getRow(id));
    },

    removeAssigned(id, tool) {
      const cur = getRow(id);
      if (!cur) return null;
      stmt.delAssigned.run(id, tool);
      stmt.touch.run(nowIso(), id);
      return toRec(getRow(id));
    },

    deleteKey(id) {
      const cur = getRow(id);
      if (!cur) return false;
      stmt.delModels.run(id);
      stmt.delAssignedAll.run(id);
      stmt.delKey.run(id);
      return true;
    }
  };
}

module.exports = { createStore };

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = 8080;

// Credenciais do app Meta para renovação de token (NÃO expor ao frontend)
const META_APP_ID     = '723794679203020';
const META_APP_SECRET = '84110c54d109437824fa4011cb3007b5';

// Helper: GET/POST JSON via https
function httpsJson(opts, body) {
  return new Promise(function(resolve, reject) {
    var req = https.request(opts, function(res) {
      var chunks = '';
      res.on('data', function(c) { chunks += c; });
      res.on('end', function() {
        try { resolve({ status: res.statusCode, data: JSON.parse(chunks) }); }
        catch(e) { resolve({ status: res.statusCode, data: chunks }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}
const DIR = __dirname;
const CONFIG_FILE    = path.join(DIR, 'config.json');
const SNAPSHOT_FILE  = path.join(DIR, 'snapshot.json');
const EVENTS_FILE    = path.join(DIR, 'leads-events.json');

// Sessões em memória (resetam ao reiniciar o container)
const sessions = new Map();

// Limpa sessões expiradas a cada 30 min
setInterval(function() {
  var now = Date.now();
  sessions.forEach(function(data, token) {
    if (now - data.ts > 28800000) sessions.delete(token); // 8h
  });
}, 1800000);

function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); }
  catch(e) { return {}; }
}

function writeConfig(data) {
  var current = readConfig();
  var merged = Object.assign(current, data);
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2));
  return merged;
}

function readSnapshot() {
  try { return JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8')); }
  catch(e) { return {}; }
}

// Merge dois snapshots: mantém a data MAIS ANTIGA de cada entrada
// Garante que nunca perdemos o primeiro registro de uma etapa
function mergeSnapshots(base, incoming) {
  var result = JSON.parse(JSON.stringify(base)); // deep clone
  Object.keys(incoming).forEach(function(pid) {
    if (!result[pid]) result[pid] = {};
    Object.keys(incoming[pid]).forEach(function(fk) {
      if (!result[pid][fk]) result[pid][fk] = {};
      Object.keys(incoming[pid][fk]).forEach(function(sid) {
        var inc = incoming[pid][fk][sid];
        var cur = result[pid][fk][sid];
        if (!cur || inc.at < cur.at) {
          result[pid][fk][sid] = inc;
        }
      });
    });
  });
  return result;
}

function writeSnapshot(incoming) {
  var merged = mergeSnapshots(readSnapshot(), incoming);
  fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(merged));
  return merged;
}

function readEvents() {
  try { return JSON.parse(fs.readFileSync(EVENTS_FILE, 'utf8')); }
  catch(e) { return []; }
}

// Registra novos eventos no log (append-only, sem duplicatas)
function appendEvents(newEvents) {
  var existing = readEvents();
  // Cria índice de eventos já registrados: pid+fk+sid
  var seen = {};
  existing.forEach(function(e) { seen[e.pid + '|' + e.fk + '|' + e.sid] = true; });
  var added = [];
  newEvents.forEach(function(e) {
    var key = e.pid + '|' + e.fk + '|' + e.sid;
    if (!seen[key]) { existing.push(e); added.push(e); seen[key] = true; }
  });
  if (added.length > 0) fs.writeFileSync(EVENTS_FILE, JSON.stringify(existing));
  return added.length;
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function parseCookies(header) {
  var c = {};
  if (!header) return c;
  header.split(';').forEach(function(p) {
    var eq = p.indexOf('=');
    if (eq < 0) return;
    c[p.slice(0, eq).trim()] = p.slice(eq + 1).trim();
  });
  return c;
}

function isAuth(req) {
  var token = parseCookies(req.headers.cookie)['hase_session'];
  return !!(token && sessions.has(token));
}

var LOGIN_PAGE = [
  '<!DOCTYPE html><html lang="pt-BR">',
  '<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">',
  '<title>HASE Engenharia \u2014 Acesso</title>',
  '<style>',
  '*{margin:0;padding:0;box-sizing:border-box}',
  'body{min-height:100vh;display:flex;align-items:center;justify-content:center;',
  'background:linear-gradient(135deg,#0f172a 0%,#1e293b 50%,#0f172a 100%);',
  "font-family:'Segoe UI',system-ui,sans-serif}",
  '.card{background:rgba(30,41,59,.95);border:1px solid rgba(148,163,184,.12);',
  'border-radius:16px;padding:48px 40px;width:100%;max-width:360px;',
  'box-shadow:0 25px 50px rgba(0,0,0,.5)}',
  '.top{text-align:center;margin-bottom:32px}',
  '.icon{font-size:42px;margin-bottom:14px}',
  'h1{color:#f97316;font-size:20px;font-weight:700;letter-spacing:-.5px}',
  '.sub{color:#94a3b8;font-size:12px;margin-top:4px}',
  'label{display:block;color:#cbd5e1;font-size:12px;font-weight:600;',
  'margin-bottom:8px;text-transform:uppercase;letter-spacing:.5px}',
  'input{width:100%;padding:12px 16px;background:rgba(15,23,42,.8);',
  'border:1px solid rgba(148,163,184,.2);border-radius:8px;color:#f1f5f9;',
  'font-size:16px;outline:none;transition:border-color .2s}',
  'input:focus{border-color:#f97316}',
  'button{width:100%;padding:13px;margin-top:20px;background:#f97316;color:#fff;',
  'border:none;border-radius:8px;font-size:15px;font-weight:700;cursor:pointer;',
  'transition:background .2s,transform .1s;font-family:inherit}',
  'button:hover{background:#ea6c0a}',
  'button:active{transform:scale(.98)}',
  'button:disabled{opacity:.6;cursor:not-allowed}',
  '.err{color:#f87171;font-size:13px;margin-top:14px;text-align:center;min-height:20px}',
  '</style></head><body>',
  '<div class="card">',
  '  <div class="top">',
  '    <div class="icon">\uD83D\uDD10</div>',
  '    <h1>HASE Engenharia</h1>',
  '    <p class="sub">Dashboard de Tr\u00e1fego</p>',
  '  </div>',
  '  <form id="f">',
  '    <label>Senha de acesso</label>',
  '    <input type="password" id="pw" placeholder="\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022" autofocus autocomplete="current-password">',
  '    <button type="submit" id="btn">Acessar \u2192</button>',
  '    <div class="err" id="err"></div>',
  '  </form>',
  '</div>',
  '<script>',
  "document.getElementById('f').addEventListener('submit',async function(e){",
  '  e.preventDefault();',
  "  var btn=document.getElementById('btn');",
  "  var err=document.getElementById('err');",
  "  btn.textContent='Verificando...';btn.disabled=true;err.textContent='';",
  '  try{',
  "    var r=await fetch('/auth',{method:'POST',headers:{'Content-Type':'application/json'},",
  "      body:JSON.stringify({password:document.getElementById('pw').value})});",
  '    var d=await r.json();',
  "    if(d.ok){window.location.href='/';return;}",
  "    err.textContent='Senha incorreta. Tente novamente.';",
  "  }catch(ex){err.textContent='Erro de conex\u00e3o.';}",
  "  btn.textContent='Acessar \u2192';btn.disabled=false;",
  "  document.getElementById('pw').select();",
  '});',
  '<\/script></body></html>'
].join('\n');

var server = http.createServer(function(req, res) {
  var urlPath = (req.url === '/' ? '/dashboard.html' : req.url.split('?')[0]);

  // Bloqueia acesso direto ao config.json
  if (urlPath === '/config.json') {
    res.writeHead(403); res.end('Forbidden'); return;
  }

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    res.end(); return;
  }

  // POST /auth — público (não requer sessão)
  if (req.method === 'POST' && urlPath === '/auth') {
    var authBody = '';
    req.on('data', function(c) { authBody += c; });
    req.on('end', function() {
      try {
        var pw = JSON.parse(authBody).password;
        var cfg = readConfig();
        var correct = cfg.accessPassword || 'hase2024';
        if (pw === correct) {
          var tok = generateToken();
          sessions.set(tok, { ts: Date.now() });
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Set-Cookie': 'hase_session=' + tok + '; Path=/; HttpOnly; Max-Age=28800; SameSite=Strict'
          });
          res.end('{"ok":true}');
        } else {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end('{"ok":false}');
        }
      } catch(e) { res.writeHead(400); res.end('Bad Request'); }
    });
    return;
  }

  // POST /logout
  if (req.method === 'POST' && urlPath === '/logout') {
    var logoutTok = parseCookies(req.headers.cookie)['hase_session'];
    if (logoutTok) sessions.delete(logoutTok);
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Set-Cookie': 'hase_session=; Path=/; HttpOnly; Max-Age=0'
    });
    res.end('{"ok":true}'); return;
  }

  // Portão de autenticação — mostra login se não autenticado
  if (!isAuth(req)) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(LOGIN_PAGE); return;
  }

  // POST /set-password — requer autenticação
  if (req.method === 'POST' && urlPath === '/set-password') {
    var pwBody = '';
    req.on('data', function(c) { pwBody += c; });
    req.on('end', function() {
      try {
        var newPw = JSON.parse(pwBody).newPassword;
        if (!newPw || newPw.length < 4) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end('{"ok":false,"error":"M\u00ednimo 4 caracteres"}'); return;
        }
        writeConfig({ accessPassword: newPw });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      } catch(e) { res.writeHead(400); res.end('Bad Request'); }
    });
    return;
  }

  // GET /config — só expõe estado mínimo (NUNCA segredos)
  // Token Meta e smApiKey ficam server-side; frontend usa endpoints proxy.
  if (req.method === 'GET' && urlPath === '/config') {
    var cfg = readConfig();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      tokenConfigured: !!cfg.token,
      smConfigured: !!cfg.smApiKey
    })); return;
  }

  // GET /meta-token — retorna o token Meta para chamadas Graph API client-side.
  // Necessário porque o dashboard chama graph.facebook.com diretamente do browser.
  // Protegido por auth de sessão (cookie HttpOnly).
  if (req.method === 'GET' && urlPath === '/meta-token') {
    var tkCfg = readConfig();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ token: tkCfg.token || null })); return;
  }

  // POST /renew-token — renova token Meta server-side (APP_SECRET nunca vai pro browser)
  if (req.method === 'POST' && urlPath === '/renew-token') {
    var tkCfg = readConfig();
    if (!tkCfg.token) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end('{"ok":false,"error":"no_token"}'); return;
    }
    var qs = 'grant_type=fb_exchange_token'
      + '&client_id=' + META_APP_ID
      + '&client_secret=' + META_APP_SECRET
      + '&fb_exchange_token=' + encodeURIComponent(tkCfg.token);
    httpsJson({
      method: 'GET',
      hostname: 'graph.facebook.com',
      path: '/oauth/access_token?' + qs
    }).then(function(r) {
      if (r.data && r.data.access_token) {
        var newExp = new Date(Date.now() + (r.data.expires_in || 5184000) * 1000).toISOString();
        writeConfig({ token: r.data.access_token, tokenExpiry: newExp });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, expiresAt: newExp }));
      } else {
        var msg = (r.data && r.data.error && r.data.error.message) || 'unknown';
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: msg }));
      }
    }).catch(function(e) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    });
    return;
  }

  // POST /sm-signin — faz signin na SolarMarket server-side e devolve o JWT
  // (smApiKey nunca vai pro browser). Frontend usa o JWT pra chamar a API diretamente.
  if (req.method === 'POST' && urlPath === '/sm-signin') {
    var smCfg = readConfig();
    if (!smCfg.smApiKey) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end('{"ok":false,"error":"no_apikey"}'); return;
    }
    var smBody = JSON.stringify({ token: smCfg.smApiKey });
    httpsJson({
      method: 'POST',
      hostname: 'business.solarmarket.com.br',
      path: '/api/v2/auth/signin',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(smBody)
      }
    }, smBody).then(function(r) {
      if (r.data && r.data.access_token) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, access_token: r.data.access_token }));
      } else {
        var msg = (r.data && r.data.message) || 'signin_failed';
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: msg }));
      }
    }).catch(function(e) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    });
    return;
  }

  // POST /config
  if (req.method === 'POST' && urlPath === '/config') {
    var cfgBody = '';
    req.on('data', function(c) { cfgBody += c; });
    req.on('end', function() {
      try {
        var data = JSON.parse(cfgBody);
        delete data.accessPassword; // protege a senha
        var merged = writeConfig(data);
        delete merged.accessPassword;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(merged));
      } catch(e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end('{"error":"invalid json"}');
      }
    });
    return;
  }

  // GET /snapshot — retorna snapshot.json para o cliente
  if (req.method === 'GET' && urlPath === '/snapshot') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(readSnapshot())); return;
  }

  // POST /snapshot — recebe snapshot do cliente, faz merge e persiste
  if (req.method === 'POST' && urlPath === '/snapshot') {
    var snapBody = '';
    req.on('data', function(c) { snapBody += c.toString().slice(0, 5000000); }); // 5MB max
    req.on('end', function() {
      try {
        var incoming = JSON.parse(snapBody);
        var merged = writeSnapshot(incoming);

        // Extrai eventos do snapshot para o log append-only
        var newEvents = [];
        Object.keys(incoming).forEach(function(pid) {
          Object.keys(incoming[pid]).forEach(function(fk) {
            Object.keys(incoming[pid][fk]).forEach(function(sid) {
              var entry = incoming[pid][fk][sid];
              newEvents.push({ pid:pid, fk:fk, sid:sid, n:entry.n, at:entry.at });
            });
          });
        });
        var added = appendEvents(newEvents);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok:true, leads: Object.keys(merged).length, newEvents: added }));
      } catch(e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end('{"error":"invalid json"}');
      }
    });
    return;
  }

  // GET /events — retorna leads-events.json completo (para exportar CSV)
  if (req.method === 'GET' && urlPath === '/events') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(readEvents())); return;
  }

  // Bloqueia acesso direto aos arquivos internos
  if (urlPath === '/snapshot.json' || urlPath === '/leads-events.json') {
    res.writeHead(403); res.end('Forbidden'); return;
  }

  // Arquivos estáticos
  var filePath = path.join(DIR, urlPath);
  fs.readFile(filePath, function(err, data) {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    var ext = path.extname(filePath);
    var mime = {
      '.html': 'text/html; charset=utf-8',
      '.js':   'application/javascript',
      '.css':  'text/css',
      '.png':  'image/png',
      '.ico':  'image/x-icon'
    };
    res.writeHead(200, { 'Content-Type': mime[ext] || 'text/plain' });
    res.end(data);
  });
});

server.on('error', function(err) {
  console.error('Erro no servidor:', err.message);
  process.exit(1);
});

server.listen(PORT, '0.0.0.0', function() {
  console.log('Dashboard HASE rodando em http://localhost:' + PORT);
});

process.on('uncaughtException', function(err) {
  console.error('Erro nao tratado:', err.message);
});

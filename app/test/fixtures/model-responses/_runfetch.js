const A = require(process.env.APP + '/src/adapters.js');

const base = process.env.BASE || 'https://maas-api.unisound.com/v1';
console.log('modelsUrl(openai) =', A.modelsUrl('openai', base));
console.log('inferStyle(base)  =', A.inferStyle('unisound'), '| isKnownStyle(custom) =', A.isKnownStyle('custom'));

const key = process.env.UK;
if (!key) { console.log('NO_KEY_ENV'); process.exit(1); }

A.fetchModels('custom', { url: base, style: 'openai' }, key, {})
  .then(function (r) {
    const ms = r.models || r;
    console.log('\nfetchModels 返回条数 =', ms.length);
    const bySrc = {};
    ms.forEach(function (m) { bySrc[m.src] = (bySrc[m.src] || 0) + 1; });
    console.log('按 src 分组 =', JSON.stringify(bySrc));
    console.log('\nctx/out 为空的条（= 平台报了但代码没读到，或压根没报）:');
    ms.filter(function (m) { return m.ctx == null || m.out == null; })
      .forEach(function (m) { console.log('  ', m.id, 'ctx=' + m.ctx, 'out=' + m.out, 'src=' + m.src); });
    console.log('\n前 6 条原样:');
    console.log(JSON.stringify(ms.slice(0, 6), null, 1));
  })
  .catch(function (e) { console.log('ERR', e && e.message, e && e.code); });

// Provider-independent catalog contracts. Never invent model IDs on failure.
export const CURSOR_DEFAULT_MODELS = ['auto','kimi-k3-max','composer-2.5','claude-opus-5-5-high','claude-sonnet-5-thinking-high','gpt-5.6-sol-high','gpt-5.3-codex-high','gemini-4-argon-high'];
export function recommendedModels(models) {
  const available = new Set(models.map(model => model.id));
  const preferred = CURSOR_DEFAULT_MODELS.filter(id => available.has(id));
  return preferred.length ? preferred : models.slice(0, 8).map(model => model.id);
}
export function creditMultiplier(raw) {
  if (typeof raw === 'number') return Number.isFinite(raw) && raw >= 0 ? raw : undefined;
  if (typeof raw !== 'string') return undefined;
  const match = raw.trim().match(/^(?:[x×]\s*)?(\d+(?:\.\d+)?)(?:\s*[x×倍])?$/i);
  if (!match) return undefined;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : undefined;
}
function withCreditBadge(model, provider) {
  if (provider !== 'workbuddy-cn') return model;
  const multiplier = creditMultiplier(model.credits ?? model.multiplier);
  return multiplier === undefined ? model : { ...model, multiplier, badge: { text: `积分 ×${multiplier}` } };
}
export function normalizeModels(rows, provider) {
  if (!Array.isArray(rows)) throw new Error('Model catalog must be an array');
  const models = new Map();
  for (const row of rows) {
    const value = typeof row === 'string' ? { id: row } : row;
    if (!value || typeof value.id !== 'string' || !value.id.trim()) continue;
    const id = value.id.trim();
    if (!models.has(id)) models.set(id, withCreditBadge({
      ...value, provider, id,
      name: typeof value.name === 'string' && value.name.trim() ? value.name.trim() : id
    }, provider));
  }
  return [...models.values()];
}

const EFFORT_ORDER = ['none','minimal','low','medium','high','xhigh','max','extra-high'];
const EFFORT_NAMES = { none:'无',minimal:'最小',low:'低',medium:'中',high:'高',xhigh:'极高',max:'最大','extra-high':'超高' };
function variant(id) {
  const match = id.match(/-(none|minimal|low|medium|high|xhigh|max|extra-high)(-fast)?$/);
  return match ? { family: id.slice(0, -match[0].length) + (match[2] || ''), effort: match[1] } : null;
}
function modelName(name) {
  const fast = /\s+Fast$/i.test(name);
  let clean = fast ? name.replace(/\s+Fast$/i, '') : name;
  clean = clean.replace(/\s*·\s*(无|最小|低|中|高|极高|最大|超高)$/, '');
  clean = clean.replace(/\s*(?:\((?:None|Minimal|Low|Medium|High|XHigh|Max|Extra[- ]High)\)|\b(?:None|Minimal|Low|Medium|High|XHigh|Max|Extra[- ]High))$/i, '').trim();
  return clean + (fast ? ' Fast' : '');
}
export function withVariantReasoning(models, provider) {
  if (!['cursor','antigravity'].includes(provider)) return models;
  const families = new Map();
  for (const model of models) {
    const info = variant(model.id);
    if (!info) continue;
    if (!families.has(info.family)) families.set(info.family, {});
    families.get(info.family)[info.effort] = model.id;
  }
  return models.map(model => {
    const info = variant(model.id), family = info?.family ?? model.id;
    const routes = families.get(family);
    if (!routes) return model;
    return { ...model, name: model.name === model.id ? family : modelName(model.name), family,
      effortModels: { ...routes },
      reasoning: { efforts: EFFORT_ORDER.filter(id => routes[id]).map(id => ({ id, name: EFFORT_NAMES[id] })),
        ...(info ? { defaultEffort: info.effort } : {}) }
    };
  });
}
export function collapseModels(models) {
  const groups = new Map();
  for (const model of models) {
    const key = model.provider + '\0' + (model.family || model.id);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(model);
  }
  return [...groups.values()].map(rows => rows.find(row => row.id === row.family)
    || rows.find(row => row.reasoning?.defaultEffort === 'medium')
    || rows.find(row => row.reasoning?.defaultEffort === 'high') || rows[0]);
}
export function projectSelection(models, ids) {
  if (!Array.isArray(ids) || !ids.length) return [];
  const representatives = new Map(collapseModels(models).map(row => [row.family || row.id, row.id]));
  return [...new Set(ids.map(id => {
    const model = models.find(row => row.id === id);
    return model ? representatives.get(model.family || model.id) : id;
  }))];
}
export function resolveVariant(models, id, effort) {
  const model = models.find(row => row.id === id);
  if (effort === undefined || !model?.effortModels) return id;
  if (!model.effortModels[effort]) throw new Error('Unsupported reasoning effort: ' + effort);
  return model.effortModels[effort];
}

export function parseCliModels(output, provider) {
  const text = String(output).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').trim();
  try {
    const json = JSON.parse(text);
    const rows = Array.isArray(json) ? json : json.models ?? json.data ?? json.result?.models;
    if (Array.isArray(rows)) return normalizeModels(rows, provider);
  } catch {}
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    // Accept both CLI formats, including namespaced IDs and new model families.
    const match = line.trim().replace(/^[*>]\s*/, '').match(/^([A-Za-z0-9][\w./:[\],=-]*)\s+(?:[-–—]\s+)?(.+)$/);
    if (!match || /^(available|model|models|name|id|loading|error|warning|you|usage|tip|tips|note|help):?$/i.test(match[1])) continue;
    rows.push({ id: match[1], name: match[2].replace(/\s+\(default\)$/, '') });
  }
  return normalizeModels(rows, provider);
}

export function selectModels(models, ids) {
  if (!Array.isArray(ids) || !ids.length) return { models, missing: [], fallback: false };
  const available = new Set(models.map(model => model.id));
  const missing = ids.filter(id => !available.has(id));
  const selected = models.filter(model => ids.includes(model.id));
  // An upstream rename must not turn a configured provider into an empty picker.
  const fallback = models[0]?.provider === 'cursor' ? models.filter(model => recommendedModels(models).includes(model.id)) : models;
  return { models: selected.length ? selected : fallback, missing, fallback: !selected.length && models.length > 0 };
}

export function createProxyAdapter(llm, hub, provider, upstream, name, wrap = stream => stream) {
  const enabled = () => hub.settings()[provider]?.enabled !== false;
  const check = () => { if (!enabled()) throw new Error('DISABLED / 平台已禁用'); };
  return {
    providerInfo: () => ({ id: provider, name }),
    providerRetryPolicy: () => undefined,
    imageRequestPricing: () => undefined,
    imageRequestTarget: (_p, _m, image) => ({ width: image.width, height: image.height, maxBytes: image.bytes }),
    async listModels() {
      if (!enabled()) return [];
      const all = normalizeModels(await llm.listModels(upstream), provider);
      return selectModels(all, hub.settings()[provider]?.visibleModels).models;
    },
    async resolveModel(_p, id, signal) {
      check();
      const info = await llm.resolveModelInfo(upstream, id, signal);
      return { ...info, provider, id };
    },
    async prepareCall(_p, id, signal) {
      signal?.throwIfAborted();
      const model = await this.resolveModel(provider, id, signal);
      return { model, stream: options => { check(); const request = { ...options, provider: upstream, model: id, signal: options.signal ?? signal }; return wrap(llm.stream(request), request); } };
    },
    stream(options) { check(); const request = { ...options, provider: upstream }; return wrap(llm.stream(request), request); }
  };
}

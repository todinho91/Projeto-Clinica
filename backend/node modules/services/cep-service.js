const CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_CACHE_ENTRIES = 2048;
const RATE_WINDOW_MS = 60 * 1000;
const RATE_LIMIT = 30;
const MAX_RATE_KEYS = 10000;
const cache = new Map();
const requests = new Map();

function normalizedCep(value) {
    const cep = typeof value === 'string' ? value.replace(/\D/g, '') : '';
    return /^\d{8}$/.test(cep) ? cep : null;
}

function allowRequest(key, now = Date.now()) {
    const current = requests.get(key);
    if (current && now - current.startedAt >= RATE_WINDOW_MS) {
        requests.delete(key);
    }
    if (!requests.has(key)) {
        if (requests.size >= MAX_RATE_KEYS) {
            for (const [rateKey, entry] of requests) {
                if (now - entry.startedAt >= RATE_WINDOW_MS) requests.delete(rateKey);
            }
        }
        // Fail closed instead of evicting active counters and allowing a caller
        // to reset its own rate limit by filling the in-memory key space.
        if (requests.size >= MAX_RATE_KEYS) return false;
        requests.set(key, { startedAt: now, count: 1 });
        return true;
    }
    const active = requests.get(key);
    if (active.count >= RATE_LIMIT) return false;
    active.count += 1;
    return true;
}

function text(value, maximum) {
    if (typeof value !== 'string') return '';
    return value.trim().replace(/\s+/g, ' ').slice(0, maximum);
}

async function lookupCep(value, options = {}) {
    const cep = normalizedCep(value);
    if (!cep) return { kind: 'invalid' };
    const now = options.now ?? Date.now();
    const cached = cache.get(cep);
    if (cached && cached.expiresAt > now) return { kind: 'found', address: cached.address };
    if (cached) cache.delete(cep);
    if (!allowRequest(String(options.rateKey || 'anonymous'), now)) return { kind: 'limited' };

    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), options.timeoutMs ?? 3500);
    try {
        const response = await (options.fetchImpl || globalThis.fetch)(
            `https://viacep.com.br/ws/${cep}/json/`,
            {
                method: 'GET',
                headers: { Accept: 'application/json' },
                signal: abortController.signal,
                redirect: 'error'
            }
        );
        if (!response.ok) return { kind: 'unavailable' };
        const data = await response.json();
        if (data?.erro === true) return { kind: 'not_found' };
        const address = {
            cep,
            logradouro: text(data?.logradouro, 160),
            bairro: text(data?.bairro, 100),
            cidade: text(data?.localidade, 100),
            uf: text(data?.uf, 2).toUpperCase()
        };
        if (!address.cidade || !/^[A-Z]{2}$/.test(address.uf)) return { kind: 'unavailable' };
        if (!cache.has(cep) && cache.size >= MAX_CACHE_ENTRIES) {
            for (const [cachedCep, entry] of cache) {
                if (entry.expiresAt <= now) cache.delete(cachedCep);
            }
        }
        if (!cache.has(cep) && cache.size >= MAX_CACHE_ENTRIES) {
            cache.delete(cache.keys().next().value);
        }
        cache.set(cep, { address, expiresAt: now + CACHE_TTL_MS });
        return { kind: 'found', address };
    } catch {
        return { kind: 'unavailable' };
    } finally {
        clearTimeout(timeout);
    }
}

function resetForTests() {
    cache.clear();
    requests.clear();
}

module.exports = { allowRequest, lookupCep, normalizedCep, resetForTests };

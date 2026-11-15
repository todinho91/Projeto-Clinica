const LOCAL_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

function localParts(value) {
    const match = typeof value === 'string' ? value.match(LOCAL_DATE_TIME) : null;
    if (!match) return null;
    const parts = match.slice(1).map(Number);
    const [year, month, day, hour, minute] = parts;
    const probe = new Date(Date.UTC(year, month - 1, day, hour, minute));
    if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1
        || probe.getUTCDate() !== day || probe.getUTCHours() !== hour
        || probe.getUTCMinutes() !== minute) return null;
    return { year, month, day, hour, minute };
}

function formatter(timeZone) {
    try {
        return new Intl.DateTimeFormat('en-CA', {
            timeZone, hour12: false, hourCycle: 'h23',
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit'
        });
    } catch {
        return null;
    }
}

function partsAt(date, timeZone) {
    const format = formatter(timeZone);
    if (!format) return null;
    const values = Object.fromEntries(format.formatToParts(date)
        .filter((part) => part.type !== 'literal')
        .map((part) => [part.type, Number(part.value)]));
    if (values.hour === 24) values.hour = 0;
    return values;
}

function sameParts(first, second) {
    return ['year', 'month', 'day', 'hour', 'minute']
        .every((key) => first[key] === second[key]);
}

function zonedLocalToUtc(value, timeZone) {
    const expected = localParts(value);
    if (!expected || !formatter(timeZone)) return null;
    const center = Date.UTC(
        expected.year, expected.month - 1, expected.day, expected.hour, expected.minute
    );
    const matches = [];
    for (let offsetMinutes = -14 * 60; offsetMinutes <= 14 * 60; offsetMinutes += 15) {
        const candidate = new Date(center + offsetMinutes * 60 * 1000);
        if (sameParts(partsAt(candidate, timeZone), expected)) matches.push(candidate);
    }
    return matches.length === 1 ? matches[0] : null;
}

function mysqlUtc(date) {
    return date.toISOString().slice(0, 23).replace('T', ' ');
}

function utcToLocal(value, timeZone) {
    const date = value instanceof Date ? value : new Date(`${String(value).replace(' ', 'T')}Z`);
    if (!Number.isFinite(date.getTime())) return null;
    const parts = partsAt(date, timeZone);
    if (!parts) return null;
    const two = (number) => String(number).padStart(2, '0');
    return `${parts.year}-${two(parts.month)}-${two(parts.day)}T${two(parts.hour)}:${two(parts.minute)}`;
}

module.exports = { localParts, mysqlUtc, utcToLocal, zonedLocalToUtc };

/* Language, privacy, project support and safe GitHub bug reporting. */
const publicAppInfo = require('./app-info.js');
const publicI18n = require('./i18n.js');
const publicKeys = require('./storage-keys.js').LS;

function optionalRequire(name) {
    try { return require(name); } catch (e) { return null; }
}

const uxp = optionalRequire('uxp');
const os = optionalRequire('os');
const publicShell = uxp?.shell;

function storedSetting(key, fallback) {
    try { return localStorage.getItem(key) ?? fallback; }
    catch (e) { return fallback; }
}

async function openExternal(url, consent) {
    if (publicShell?.openExternal) return publicShell.openExternal(url, consent);
    if (typeof window !== 'undefined' && window.open) return window.open(url, '_blank');
    throw new Error(publicI18n.t('common.externalUnavailable'));
}

function safeDiagnostics() {
    const host = uxp?.host || {};
    return [
        `- ExactFill: ${publicAppInfo.version}`,
        `- Host: ${host.name || 'Photoshop'} ${host.version || 'unknown'}`,
        `- OS: ${os?.platform ? os.platform() : 'unknown'}`,
        `- UI locale: ${host.uiLocale || publicI18n.getLocale()}`,
        `- Provider: ${storedSetting(publicKeys.provider, 'unknown')}`,
        `- Model: ${storedSetting(publicKeys.model, 'unknown')}`,
        `- Quality: ${storedSetting(publicKeys.quality, 'medium')}`,
        // network route — the first thing a "no connection" report needs
        `- Network route: ${storedSetting(publicKeys.transport, 'auto')}`,
        `- Lossless input: ${storedSetting(publicKeys.lossless, 'default')}`,
        `- Live preview: ${storedSetting(publicKeys.preview, 'default')}`,
    ].join('\n');
}

function setReportStatus(text) {
    const el = document.getElementById('report-status');
    if (el) el.textContent = text || '';
}

/**
 * Ceiling on the issue-creation URL length. GitHub answers a longer one with
 * 414 URI Too Long, and the report does not open at all — silently, from the
 * user's point of view.
 */
const MAX_REPORT_URL = 7800;

/**
 * Slices a string without splitting a surrogate pair.
 * Otherwise an emoji on the boundary leaves a lone high surrogate, and
 * encodeURIComponent throws URIError on it — so trying to fit the limit
 * would break the report more reliably than the limit itself.
 */
function sliceSafe(text, n) {
    let end = Math.min(n, text.length);
    if (end <= 0) return '';
    const code = text.charCodeAt(end - 1);
    if (code >= 0xD800 && code <= 0xDBFF) end--;
    return text.slice(0, end);
}

function buildReportUrl(summary, details, includeDiagnostics = true) {
    const assemble = text => {
        const parts = [text || '_No additional details provided._'];
        if (includeDiagnostics) parts.push(`\n### Safe diagnostics\n${safeDiagnostics()}`);
        parts.push('\n> ExactFill did not include API keys, prompts, document names, paths, images, or usage history.');
        // encodeURIComponent returns plain ASCII, so .length here is bytes
        return `${publicAppInfo.issues}?title=${encodeURIComponent('[Bug] ' + sliceSafe(summary, 110))}` +
            `&body=${encodeURIComponent(parts.join('\n'))}`;
    };

    const text = details || '';
    const full = assemble(text);
    if (full.length <= MAX_REPORT_URL) return full;

    /* Why the cut has to happen here, not via maxlength on the field: in
       percent-encoding a Latin letter costs 1 byte, a Cyrillic letter 6, an
       emoji 12. The same limit IN CHARACTERS can make a URL twelve times
       longer, so no static number in HTML guarantees the limit. The cut is
       not silent — a note stays at the cut, and the user pastes the rest in
       the GitHub window. */
    const note = '\n\n' + publicI18n.t('report.truncated');
    let lo = 0, hi = text.length;
    while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (assemble(sliceSafe(text, mid) + note).length <= MAX_REPORT_URL) lo = mid;
        else hi = mid - 1;
    }
    return assemble(sliceSafe(text, lo) + note);
}

async function submitReport() {
    const summary = document.getElementById('report-summary')?.value?.trim();
    const details = document.getElementById('report-details')?.value?.trim();
    const include = document.getElementById('report-diagnostics')?.checked !== false;
    if (!summary) { setReportStatus(publicI18n.t('report.required')); return; }

    const url = buildReportUrl(summary, details, include);
    try {
        setReportStatus(publicI18n.t('report.opening'));
        await openExternal(url, publicI18n.t('report.consent'));
    } catch (e) {
        setReportStatus(publicI18n.t('report.openError', { error: e?.message || e }));
    }
}

if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', () => {
    const version = document.getElementById('app-version');
    if (version) version.textContent = `v${publicAppInfo.version}`;

    const language = document.getElementById('language-select');
    if (language) {
        language.value = publicI18n.getLocale();
        language.addEventListener('change', () => publicI18n.setLocale(language.value));
    }

    const support = document.getElementById('support-btn');
    if (support) {
        support.disabled = !publicAppInfo.supportUrl;
        support.addEventListener('click', async () => {
            if (!publicAppInfo.supportUrl) return;
            try { await openExternal(publicAppInfo.supportUrl, publicI18n.t('support.consent')); }
            catch (e) { setReportStatus(publicI18n.t('report.openError', { error: e?.message || e })); }
        });
    }

    const privacy = document.getElementById('privacy-btn');
    if (privacy) privacy.addEventListener('click', async () => {
        try { await openExternal(publicAppInfo.privacy, publicI18n.t('privacy.consent')); }
        catch (e) { setReportStatus(publicI18n.t('report.openError', { error: e?.message || e })); }
    });

    const report = document.getElementById('report-submit');
    if (report) report.addEventListener('click', submitReport);
});

if (typeof module !== 'undefined') module.exports = { safeDiagnostics, buildReportUrl, submitReport, MAX_REPORT_URL };

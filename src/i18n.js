'use strict';

const fallback = require('./locales/en.json');

/** Supported UI languages. Names are shown in their own language in settings. */
const LANGUAGES = [
  { code: 'en', name: 'English', strings: fallback },
  { code: 'pt-BR', name: 'Português (Brasil)', strings: require('./locales/pt-BR.json') },
];

/** Language preference stored in config: 'system' or one of the codes above. */
const PREFERENCES = new Set(['system', ...LANGUAGES.map((l) => l.code)]);

let current = LANGUAGES[0];

/** Maps OS language tags (e.g. "pt-PT", "en-US") to the first supported language. */
function resolve(preference, systemLanguages = []) {
  const direct = LANGUAGES.find((l) => l.code === preference);
  if (direct) return direct.code;
  for (const tag of systemLanguages) {
    const base = String(tag).toLowerCase().split(/[-_]/)[0];
    const match = LANGUAGES.find((l) => l.code.toLowerCase().split('-')[0] === base);
    if (match) return match.code;
  }
  return LANGUAGES[0].code;
}

function setLocale(code) {
  current = LANGUAGES.find((l) => l.code === code) ?? LANGUAGES[0];
}

function format(template, vars) {
  return template.replace(/\{(\w+)\}/g, (whole, name) => (name in vars ? String(vars[name]) : whole));
}

/** Translates with the current locale, falling back to English, then to the key itself. */
function t(key, vars = {}) {
  return format(current.strings[key] ?? fallback[key] ?? key, vars);
}

/** English text for a key, used for log messages. */
function english(key, vars = {}) {
  return format(fallback[key] ?? key, vars);
}

function locale() {
  return current.code;
}

/** Everything the settings UI needs: active locale, its strings and the language list. */
function uiBundle(preference) {
  return {
    locale: current.code,
    preference,
    strings: { ...fallback, ...current.strings },
    languages: LANGUAGES.map(({ code, name }) => ({ code, name })),
  };
}

module.exports = { PREFERENCES, resolve, setLocale, t, english, locale, uiBundle };

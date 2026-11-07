'use strict';

const fs = require('fs');
const { doReadNumber, ReadingConfig } = require('read-vietnamese-number');

const FIXUPS = [
  ['tʃ', 'ʧ'], ['t̪', '\uE100'], ['\uE100', 't'], ['e-', 'æ'],
  ['1', '→'], ['7', '→'], ['2', '↘'], ['ɜ', '↗'], ['3', '↗'],
  ['4', '↓'], ['5', 'ʔ↗'], ['6', 'ʔ↓'], ['ɗ', 'd'], ['ʐ', 'ʒ'],
  ['̪', ''], ['-', ''], ['–', '—'], ['*', ''], ['/', ' '], ['&', ' '],
  ["'", ''], ['’', ''], ['‘', ''], ['đ', 'd'], ['̩', '']
];
const VI_MARK_RE = /[À-ỹĐđ]/u;
const NON_VI_S_CLUSTERS = ['sc', 'sh', 'sk', 'sl', 'sm', 'sn', 'sp', 'st', 'sw'];
const NUMBER_RE = /(^|[^\p{L}\d])(-?\d[\d,.]*\d|-?\d)(?=$|[^\p{L}\d])/gu;
const TOKEN_RE = /<en>.*?<\/en>|[\p{L}\p{M}]+(?:['’][\p{L}\p{M}]+)*|\s+|[^\p{L}\p{M}\d_\s]/gu;
const WORD_RE = /^[\p{L}\p{M}]+(?:['’][\p{L}\p{M}]+)*$/u;

function normalizeNumbers(text) {
  const config = new ReadingConfig();
  return text.replace(NUMBER_RE, (match, prefix, number) => {
    try {
      return `${prefix}${doReadNumber(number, config)}`;
    } catch {
      return match;
    }
  });
}

function replaceFirst(text, from, to) {
  const index = text.indexOf(from);
  return index < 0 ? text : `${text.slice(0, index)}${to}${text.slice(index + from.length)}`;
}

function fixPhonemes(phonemes, sourceText = '') {
  let result = phonemes;
  for (const [oldValue, newValue] of FIXUPS) result = result.split(oldValue).join(newValue);
  if (sourceText) {
    const lower = sourceText.toLowerCase();
    const hasMark = VI_MARK_RE.test(sourceText);
    if ((hasMark || true) && lower.startsWith('th')) result = replaceFirst(result, 't', 'θ');
    else if (lower.startsWith('tr')) result = replaceFirst(result, 'ʧ', 'ʈʂ');
    else if ((hasMark || true) && lower.startsWith('s') && !NON_VI_S_CLUSTERS.some((x) => lower.startsWith(x))) result = replaceFirst(result, 's', 'ʂ');
    else if (lower.startsWith('gi') || /^g[iìíỉĩị]/u.test(lower)) result = replaceFirst(result, 'z', 'ʝ');
  }
  return result;
}

class SeaG2PDictionary {
  constructor(filePath) {
    this.data = fs.readFileSync(filePath);
    if (this.data.toString('ascii', 0, 4) !== 'SEAP') throw new Error('Invalid SEA-G2P dictionary');
    this.version = this.data.readUInt32LE(4);
    this.stringCount = this.data.readUInt32LE(8);
    this.mergedCount = this.data.readUInt32LE(12);
    this.commonCount = this.data.readUInt32LE(16);
    this.stringOffsetsPos = this.data.readUInt32LE(20);
    this.mergedPos = this.data.readUInt32LE(24);
    this.commonPos = this.data.readUInt32LE(28);
    this.stringBase = this.version >= 2 ? 48 : 32;
  }

  string(id) {
    if (id >= this.stringCount) return '';
    const offset = this.data.readUInt32LE(this.stringOffsetsPos + id * 4);
    const start = this.stringBase + offset;
    let end = start;
    while (end < this.data.length && this.data[end] !== 0) end += 1;
    return this.data.toString('utf8', start, end);
  }

  lookupMerged(word) {
    let low = 0;
    let high = this.mergedCount - 1;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const pos = this.mergedPos + mid * 8;
      const current = this.string(this.data.readUInt32LE(pos));
      if (current === word) return this.string(this.data.readUInt32LE(pos + 4));
      if (current < word) low = mid + 1;
      else high = mid - 1;
    }
    return null;
  }

  lookupCommon(word) {
    let low = 0;
    let high = this.commonCount - 1;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const pos = this.commonPos + mid * 12;
      const current = this.string(this.data.readUInt32LE(pos));
      if (current === word) return [this.string(this.data.readUInt32LE(pos + 4)), this.string(this.data.readUInt32LE(pos + 8))];
      if (current < word) low = mid + 1;
      else high = mid - 1;
    }
    return null;
  }
}

class VietnameseG2P {
  constructor(dictionaryPath) {
    this.dictionary = new SeaG2PDictionary(dictionaryPath);
  }

  phoneFor(word, lang) {
    const lower = word.toLowerCase();
    const merged = this.dictionary.lookupMerged(lower);
    if (merged !== null) return merged.replaceAll('<en>', '').trim();
    const common = this.dictionary.lookupCommon(lower);
    if (common) return (lang === 'en' && common[1] ? common[1] : common[0] || common[1]).replaceAll('<en>', '').trim();
    return null;
  }

  charFallback(word, lang) {
    return [...word].map((char) => this.phoneFor(char, lang) || char.toLowerCase()).join('');
  }

  phonemize(text) {
    const normalized = normalizeNumbers(String(text).replaceAll('’', "'").replaceAll('‘', "'"));
    const tokens = [];
    const hasVietnameseMark = VI_MARK_RE.test(normalized);
    for (const token of normalized.match(TOKEN_RE) || []) {
      if (/^\s+$/u.test(token)) tokens.push({ kind: 'space', value: token });
      else if (token.toLowerCase().startsWith('<en>')) tokens.push({ kind: 'en-tag', value: token });
      else if (WORD_RE.test(token)) {
        const lower = token.toLowerCase();
        const merged = this.dictionary.lookupMerged(lower);
        const common = this.dictionary.lookupCommon(lower);
        let lang = hasVietnameseMark ? 'vi' : 'en';
        let phone = null;
        if (merged !== null) {
          lang = merged.includes('<en>') ? 'en' : 'vi';
          phone = merged.replaceAll('<en>', '').trim();
        } else if (common) {
          phone = common;
        }
        tokens.push({ kind: 'word', value: token, lower, lang, phone });
      } else tokens.push({ kind: 'punct', value: token });
    }

    const result = [];
    for (const token of tokens) {
      if (token.kind === 'space') continue;
      if (token.kind === 'punct') {
        const mapped = { ',': ',', '.': '.', '!': '!', '?': '?', ';': ',', ':': ',', '…': '.' }[token.value];
        if (mapped) result.push(mapped);
        continue;
      }
      if (token.kind === 'en-tag') {
        const inner = token.value.replace(/^<en>|<\/en>$/gi, '');
        result.push(this.phonemizeEnglish(inner));
        continue;
      }
      let phone;
      if (Array.isArray(token.phone)) {
        phone = token.lang === 'en' ? token.phone[1] : token.phone[0];
        if (token.lower === 'a' && token.lang === 'en') phone = 'ɐ';
      } else phone = token.phone || this.charFallback(token.value, token.lang);
      result.push(fixPhonemes(phone, token.value));
    }
    return result.join(' ').replaceAll(' .', '.').replaceAll(' ,', ',').replaceAll(' !', '!').replaceAll(' ?', '?');
  }

  // VieNeu v3 is trained on the raw SEA-G2P phoneme dialect: tʃ, ɗ, z, t̪
  // and tone digits 1–7. Kokoro uses a different symbol dialect after FIXUPS
  // (ʧ, d, ʝ, t, arrows), so it must never share the Kokoro post-processing.
  phonemizeVietNeu(text) {
    const normalized = normalizeNumbers(String(text).replaceAll('’', "'").replaceAll('‘', "'"));
    const tokens = [];
    const hasVietnameseMark = VI_MARK_RE.test(normalized);
    for (const token of normalized.match(TOKEN_RE) || []) {
      if (/^\s+$/u.test(token)) tokens.push({ kind: 'space', value: token });
      else if (token.toLowerCase().startsWith('<en>')) tokens.push({ kind: 'en-tag', value: token });
      else if (WORD_RE.test(token)) {
        const lower = token.toLowerCase();
        const merged = this.dictionary.lookupMerged(lower);
        const common = this.dictionary.lookupCommon(lower);
        const lang = hasVietnameseMark ? 'vi' : 'en';
        let phone = null;
        if (merged !== null) phone = merged.replaceAll('<en>', '').trim();
        else if (common) phone = common;
        tokens.push({ kind: 'word', value: token, lower, lang, phone });
      } else tokens.push({ kind: 'punct', value: token });
    }
    const result = [];
    for (const token of tokens) {
      if (token.kind === 'space') continue;
      if (token.kind === 'punct') {
        const mapped = { ',': ',', '.': '.', '!': '!', '?': '?', ';': ',', ':': ',', '…': '.' }[token.value];
        if (mapped) result.push(mapped);
        continue;
      }
      if (token.kind === 'en-tag') { result.push(this.phonemizeEnglish(token.value.replace(/^<en>|<\/en>$/gi, ''))); continue; }
      let phone;
      if (Array.isArray(token.phone)) phone = token.lang === 'en' ? token.phone[1] : token.phone[0];
      else phone = token.phone || this.charFallback(token.value, token.lang);
      result.push(phone);
    }
    let output = result.join(' ').replaceAll(' .', '.').replaceAll(' ,', ',').replaceAll(' !', '!').replaceAll(' ?', '?').trim();
    if (output && !/[.!?]$/u.test(output)) output += '.';
    return output;
  }

  phonemizeEnglish(text) {
    return [...(text.match(TOKEN_RE) || [])].map((token) => {
      if (WORD_RE.test(token)) return this.phoneFor(token, 'en') || this.charFallback(token, 'en');
      return { ',': ',', '.': '.', '!': '!', '?': '?' }[token] || '';
    }).filter(Boolean).join(' ');
  }
}

module.exports = { VietnameseG2P, normalizeNumbers };

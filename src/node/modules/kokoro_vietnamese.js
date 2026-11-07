'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const ort = require('onnxruntime-node');
const { VietnameseG2P } = require('../g2p');

const SAMPLE_RATE = 24000;
const DEFAULT_CROSSFADE_MS = 50;
const VOICES = {
  diem_trinh: { label: 'Diễm Trinh' }, hung_thinh: { label: 'Hưng Thịnh' },
  mai_linh: { label: 'Mai Linh' }, mai_loan: { label: 'Mai Loan' },
  manh_dung: { label: 'Mạnh Dũng' }, my_yen: { label: 'Mỹ Yến' },
  ngoc_huyen: { label: 'Ngọc Huyền' }, phat_tai: { label: 'Phát Tài' },
  thanh_dat: { label: 'Thành Đạt' }, thuc_trinh: { label: 'Thục Trinh' },
  tuan_ngoc: { label: 'Tuấn Ngọc' }, storyvert: { label: 'Storyvert' },
  duc_an: { label: 'Đức An' }, duc_duy: { label: 'Đức Duy' }
};

function splitText(text) {
  const normalized = String(text).trim().replace(/\s+/gu, ' ');
  if (!normalized) return [];
  const chunks = [];
  let start = 0;
  const re = /[.!?…]+(?:["”’)]*)/gu;
  let match;
  while ((match = re.exec(normalized))) {
    const end = match.index + match[0].length;
    if (end < normalized.length && !/\s/u.test(normalized[end])) continue;
    const chunk = normalized.slice(start, end).trim();
    if (chunk) chunks.push(chunk);
    start = end;
  }
  const remainder = normalized.slice(start).trim();
  if (remainder) chunks.push(remainder);
  return chunks;
}

function mergeAudioChunks(chunks, crossfadeSamples) {
  const valid = chunks.filter((chunk) => chunk && chunk.length > 0);
  if (!valid.length) return new Float32Array(0);
  let merged = Float32Array.from(valid[0]);
  for (const chunk of valid.slice(1)) {
    const overlap = Math.min(Math.max(0, Math.trunc(crossfadeSamples)), merged.length, chunk.length);
    if (!overlap) {
      const joined = new Float32Array(merged.length + chunk.length);
      joined.set(merged); joined.set(chunk, merged.length); merged = joined; continue;
    }
    const next = new Float32Array(merged.length + chunk.length - overlap);
    next.set(merged.subarray(0, merged.length - overlap));
    for (let i = 0; i < overlap; i += 1) {
      const fadeOut = 1 - (i + 1) / (overlap + 1);
      next[merged.length - overlap + i] = merged[merged.length - overlap + i] * fadeOut + chunk[i] * (1 - fadeOut);
    }
    next.set(chunk.subarray(overlap), merged.length);
    merged = next;
  }
  return merged;
}

function writeWav(filePath, audio) {
  const samples = Buffer.alloc(audio.length * 2);
  for (let i = 0; i < audio.length; i += 1) {
    const value = Math.max(-1, Math.min(1, Number(audio[i]) || 0));
    samples.writeInt16LE(Math.round(value * (value < 0 ? 32768 : 32767)), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + samples.length, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22); header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(samples.length, 40);
  fs.writeFileSync(filePath, Buffer.concat([header, samples]));
}

class KokoroVietnameseNode {
  static id = 'kokoro-vietnamese-node';
  static name = 'Kokoro Vietnamese ONNX / Node.js';

  constructor() {
    this.bundleDir = process.env.KOKORO_MODEL_DIR || path.resolve(__dirname, '..', '..', 'assets', 'model');
    this.outputDir = path.join(process.env.HOTANVOICE_APP_DATA || os.tmpdir(), 'worker-output');
    fs.mkdirSync(this.outputDir, { recursive: true });
    this.config = JSON.parse(fs.readFileSync(path.join(this.bundleDir, 'config.json'), 'utf8'));
    this.g2p = new VietnameseG2P(path.join(this.bundleDir, 'sea_g2p.bin'));
    this.sessions = new Map();
    this.executionProvider = 'cpu';
  }

  listVoices() {
    return Object.entries(VOICES).map(([id, value]) => ({ id, label: value.label }));
  }

  _setExecutionProvider(useGpu) {
    const desired = useGpu ? 'dml' : 'cpu';
    if (this.executionProvider !== desired) { this.sessions.clear(); this.executionProvider = desired; }
  }

  _sessionOptions(useGpu) {
    return { executionProviders: useGpu ? ['dml', 'cpu'] : ['cpu'], graphOptimizationLevel: 'all', intraOpNumThreads: Number(process.env.ORT_INTRA_OP_NUM_THREADS || 4), interOpNumThreads: Number(process.env.ORT_INTER_OP_NUM_THREADS || 1) };
  }

  async _createSession(modelPath, status) {
    try { return await ort.InferenceSession.create(modelPath, this._sessionOptions(this.executionProvider === 'dml')); }
    catch (error) {
      if (this.executionProvider !== 'dml') throw error;
      status('DirectML không khả dụng, tự chuyển về CPU...', 14, 'warning');
      this._setExecutionProvider(false);
      return ort.InferenceSession.create(modelPath, this._sessionOptions(false));
    }
  }

  async loadVoice(voice, status, options = {}) {
    if (!VOICES[voice]) throw new Error(`Không tìm thấy giọng '${voice}'.`);
    this._setExecutionProvider(Boolean(options.useGpu));
    if (!this.sessions.has(voice)) {
      status(`Đang khởi tạo model và giọng ${VOICES[voice].label} trên ${this.executionProvider === 'dml' ? 'GPU DirectML' : 'CPU'}...`, 12);
      const modelPath = path.join(this.bundleDir, 'kokoro_vi.onnx');
      const voicePath = path.join(this.bundleDir, 'voicepacks-bin', `${voice}.bin`);
      if (!fs.existsSync(modelPath) || !fs.existsSync(voicePath)) throw new Error(`Thiếu asset cho giọng ${voice}.`);
      const session = await this._createSession(modelPath, status);
      const raw = fs.readFileSync(voicePath);
      if (raw.byteLength % (256 * 4) !== 0) throw new Error(`Voicepack ${voice} không đúng kích thước Float32.`);
      const voicepack = new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
      this.sessions.set(voice, { session, voicepack });
    }
    return this.sessions.get(voice);
  }

  async generate(text, voice, speed, crossfadeMs, status, options = {}) {
    const clean = String(text || '').trim();
    if (!clean) throw new Error('Nội dung không được để trống.');
    if (!(speed >= 0.5 && speed <= 2)) throw new Error('Tốc độ phải nằm trong khoảng 0.5 đến 2.0.');
    if (!(crossfadeMs >= 0 && crossfadeMs <= 250)) throw new Error('Crossfade phải nằm trong khoảng 0 đến 250 ms.');
    const { session, voicepack } = await this.loadVoice(voice, status, options);
    const audioChunks = [];
    const phonemeChunks = [];
    const chunks = splitText(clean);
    for (let index = 0; index < chunks.length; index += 1) {
      const phonemes = this.g2p.phonemize(chunks[index]);
      if (!phonemes) continue;
      if (phonemes.length > 510) throw new Error(`Phoneme chunk too long (${phonemes.length} > 510).`);
      phonemeChunks.push(`[${index + 1}] ${phonemes}`);
      const ids = [0];
      for (const symbol of phonemes) {
        if (Object.prototype.hasOwnProperty.call(this.config.vocab, symbol)) ids.push(this.config.vocab[symbol]);
      }
      ids.push(0);
      const styleIndex = Math.min(phonemes.length, Math.floor(voicepack.length / 256)) - 1;
      if (styleIndex < 0) throw new Error('Voicepack rỗng.');
      const refStyle = voicepack.subarray(styleIndex * 256, (styleIndex + 1) * 256);
      const feeds = {
        input_ids: new ort.Tensor('int64', BigInt64Array.from(ids.map((value) => BigInt(value))), [1, ids.length]),
        ref_s: new ort.Tensor('float32', refStyle, [1, 256]),
        speed: new ort.Tensor('float32', Float32Array.of(Number(speed)), [])
      };
      status(`Đang suy luận ${this.executionProvider === 'dml' ? 'GPU DirectML' : 'CPU'} (${index + 1}/${chunks.length})...`, 40 + Math.round((index / Math.max(1, chunks.length)) * 45));
      const result = await session.run(feeds);
      const outputName = Object.keys(result).find((key) => key !== 'duration') || Object.keys(result)[0];
      audioChunks.push(Float32Array.from(result[outputName].data));
    }
    const audio = mergeAudioChunks(audioChunks, Math.round(SAMPLE_RATE * crossfadeMs / 1000));
    if (!audio.length) throw new Error('Model không tạo ra audio.');
    const filename = `kokoro-node-${process.pid}-${crypto.createHash('sha1').update(`${clean}|${voice}|${speed}`).digest('hex').slice(0, 12)}.wav`;
    const wavPath = path.join(this.outputDir, filename);
    writeWav(wavPath, audio);
    status('Đã tạo audio thành công.', 100, 'success');
    return { wavPath, durationMs: Math.round(audio.length / SAMPLE_RATE * 1000), phonemes: phonemeChunks.join('\n'), voiceLabel: VOICES[voice].label, model: KokoroVietnameseNode.id };
  }

  async previewVoice(voice, status) {
    const label = VOICES[voice]?.label || voice;
    return this.generate(`Xin chào đây là giọng đọc ${label}.`, voice, 1, 30, status);
  }
}

module.exports = { KokoroVietnameseNode, SAMPLE_RATE, VOICES };

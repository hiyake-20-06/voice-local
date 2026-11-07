'use strict';

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const ort = require('onnxruntime-node');
const { SentencePieceProcessor } = require('@lambda_x/sptk');
const ffmpegPath = process.env.HOTANVOICE_FFMPEG_PATH || require('ffmpeg-static');

const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const DEFAULT_LANGUAGE = 'zh';
const LANGUAGE_LABELS = {
  zh: '中文', en: 'English', de: 'Deutsch', es: 'Español', fr: 'Français',
  ja: '日本語', it: 'Italiano', hu: 'Magyar', ko: '한국어', ru: 'Русский',
  fa: 'فارسی', ar: 'العربية', pl: 'Polski', pt: 'Português', cs: 'Čeština',
  da: 'Dansk', sv: 'Svenska', el: 'Ελληνικά', tr: 'Türkçe'
};
const SUPPORTED_LANGUAGES = Object.keys(LANGUAGE_LABELS);
const SENTENCE_END = new Set('.!?。！？；;');

function tensor(type, data, dims) { return new ort.Tensor(type, data, dims); }
function int32(values, dims) { return tensor('int32', Int32Array.from(values), dims); }
function float32(values, dims) { return tensor('float32', values instanceof Float32Array ? values : Float32Array.from(values), dims); }

function outputMap(session, values) {
  if (values && !Array.isArray(values)) return values;
  const result = {};
  for (let i = 0; i < session.outputNames.length; i += 1) result[session.outputNames[i]] = values[i];
  return result;
}

function cloneTensor(value) {
  const source = value.data;
  let data;
  if (source instanceof Float32Array) data = Float32Array.from(source);
  else if (source instanceof Int32Array) data = Int32Array.from(source);
  else if (source instanceof BigInt64Array) data = BigInt64Array.from(source);
  else if (source instanceof Uint8Array) data = Uint8Array.from(source);
  else data = new source.constructor(source);
  return new ort.Tensor(value.type, data, value.dims.slice());
}

function cloneState(state) {
  const next = {};
  for (const [key, value] of Object.entries(state)) next[key] = cloneTensor(value);
  return next;
}

function parseWavPcm16(buffer) {
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') throw new Error('WAV không hợp lệ.');
  let offset = 12; let channels = 1; let sampleRate = 0; let bits = 16; let dataStart = -1; let dataSize = 0;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4); const size = buffer.readUInt32LE(offset + 4); offset += 8;
    if (id === 'fmt ' && offset + 16 <= buffer.length) { channels = buffer.readUInt16LE(offset + 2); sampleRate = buffer.readUInt32LE(offset + 4); bits = buffer.readUInt16LE(offset + 14); }
    if (id === 'data') { dataStart = offset; dataSize = Math.min(size, buffer.length - offset); break; }
    offset += size + (size % 2);
  }
  if (dataStart < 0 || bits !== 16 || !sampleRate) throw new Error('WAV cần PCM 16-bit có sample rate hợp lệ.');
  const frames = Math.floor(dataSize / 2 / channels); const mono = new Float32Array(frames);
  for (let i = 0; i < frames; i += 1) { let sum = 0; for (let c = 0; c < channels; c += 1) sum += buffer.readInt16LE(dataStart + (i * channels + c) * 2) / 32768; mono[i] = sum / channels; }
  return { sampleRate, mono };
}

function readReferenceAudio(filePath) {
  if (!ffmpegPath || !fs.existsSync(ffmpegPath)) throw new Error(`Thiếu ffmpeg để đọc audio tham chiếu: ${ffmpegPath || 'unknown'}.`);
  const result = spawnSync(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-i', filePath, '-f', 'f32le', '-ac', String(CHANNELS), '-ar', String(SAMPLE_RATE), 'pipe:1'], { encoding: null, maxBuffer: 256 * 1024 * 1024 });
  if (result.status !== 0 || !result.stdout?.length) throw new Error('Không thể đọc/resample audio tham chiếu.');
  const interleaved = new Float32Array(result.stdout.buffer, result.stdout.byteOffset, Math.floor(result.stdout.byteLength / 4));
  const frames = Math.floor(interleaved.length / CHANNELS); const planar = new Float32Array(frames * CHANNELS);
  for (let i = 0; i < frames; i += 1) for (let c = 0; c < CHANNELS; c += 1) planar[c * frames + i] = interleaved[i * CHANNELS + c];
  return { data: planar, frames };
}

function writeWavStereo(filePath, audio, sampleRate = SAMPLE_RATE) {
  const frames = Math.floor(audio.length / CHANNELS); const pcm = Buffer.alloc(frames * CHANNELS * 2);
  for (let i = 0; i < audio.length; i += 1) { const v = Math.max(-1, Math.min(1, Number(audio[i]) || 0)); pcm.writeInt16LE(Math.round(v * (v < 0 ? 32768 : 32767)), i * 2); }
  const header = Buffer.alloc(44); header.write('RIFF', 0); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVE', 8); header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(CHANNELS, 22); header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * CHANNELS * 2, 28); header.writeUInt16LE(CHANNELS * 2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(pcm.length, 40); fs.writeFileSync(filePath, Buffer.concat([header, pcm]));
}

function concatStereo(chunks) {
  const valid = chunks.filter((item) => item && item.length);
  const total = valid.reduce((sum, item) => sum + item.length, 0); const out = new Float32Array(total); let offset = 0;
  for (const item of valid) { out.set(item, offset); offset += item.length; }
  return out;
}

function speedAdjustStereo(audio, speed) {
  if (!Number.isFinite(speed) || Math.abs(speed - 1) < 0.001 || audio.length < CHANNELS * 2) return audio;
  const frames = Math.floor(audio.length / CHANNELS); const outFrames = Math.max(1, Math.round(frames / speed)); const out = new Float32Array(outFrames * CHANNELS);
  for (let i = 0; i < outFrames; i += 1) { const source = Math.min(frames - 1, i * speed); const left = Math.floor(source); const right = Math.min(frames - 1, left + 1); const frac = source - left; for (let c = 0; c < CHANNELS; c += 1) out[i * CHANNELS + c] = audio[left * CHANNELS + c] * (1 - frac) + audio[right * CHANNELS + c] * frac; }
  return out;
}

function flattenRows(rows, width) { const data = new Int32Array(rows.length * width); for (let i = 0; i < rows.length; i += 1) for (let j = 0; j < width; j += 1) data[i * width + j] = Number(rows[i][j] ?? 0); return data; }
function lastHidden(value) { const dims = value.dims; if (dims.length === 2) return float32(Float32Array.from(value.data), dims); const hidden = dims[dims.length - 1]; const seq = dims[dims.length - 2]; return float32(Float32Array.from(value.data.slice((seq - 1) * hidden, seq * hidden)), [1, hidden]); }

class MossTTSNanoNode {
  static id = 'moss-tts-nano-onnx';
  static name = 'MOSS-TTS-Nano ONNX';

  constructor() {
    this.modelRoot = process.env.MOSS_TTS_MODEL_DIR || path.resolve(__dirname, '..', '..', 'assets', 'model', 'moss-tts-nano');
    this.codecRoot = process.env.MOSS_CODEC_DIR || path.resolve(__dirname, '..', '..', 'assets', 'model', 'moss-onnx');
    this.outputDir = path.join(process.env.HOTANVOICE_APP_DATA || os.tmpdir(), 'worker-output'); fs.mkdirSync(this.outputDir, { recursive: true });
    this.loaded = null; this.referenceCache = new Map(); this.executionProvider = 'cpu';
    this.manifest = null;
    try {
      this.manifest = JSON.parse(fs.readFileSync(path.join(this.modelRoot, 'MOSS-TTS-Nano-100M-ONNX', 'browser_poc_manifest.json'), 'utf8'));
    } catch {}

  }

  listLanguages() { return SUPPORTED_LANGUAGES.map((id) => ({ id, label: LANGUAGE_LABELS[id] })); }
  listVoices() { const source = this.loaded?.manifest || this.manifest; const voices = (source?.builtin_voices || []).map((v) => ({ id: v.voice, label: v.display_name || v.voice, group: v.group || '', kind: 'preset' })); voices.push({ id: 'clone', label: 'Clone giọng — audio tham chiếu', kind: 'clone' }); return voices; }

  _setExecutionProvider(useGpu) {
    const desired = useGpu ? 'dml' : 'cpu';
    if (this.executionProvider !== desired) { this.loaded = null; this.referenceCache.clear(); this.executionProvider = desired; }
  }

  _sessionOptions() {
    return { executionProviders: this.executionProvider === 'dml' ? ['dml', 'cpu'] : ['cpu'], graphOptimizationLevel: 'all', intraOpNumThreads: Number(process.env.ORT_INTRA_OP_NUM_THREADS || 4), interOpNumThreads: 1 };
  }

  async _createSession(modelPath, status) {
    try { return await ort.InferenceSession.create(modelPath, this._sessionOptions()); }
    catch (error) {
      if (this.executionProvider !== 'dml') throw error;
      status('DirectML không khả dụng, tự chuyển MOSS về CPU...', 12, 'warning');
      this._setExecutionProvider(false);
      return ort.InferenceSession.create(modelPath, this._sessionOptions());
    }
  }

  async load(status = () => {}, options = {}) {
    this._setExecutionProvider(Boolean(options.useGpu));
    if (this.loaded) return this.loaded;
    const ttsDir = path.join(this.modelRoot, 'MOSS-TTS-Nano-100M-ONNX'); const codecDir = this.codecRoot;
    const manifest = JSON.parse(await fsp.readFile(path.join(ttsDir, 'browser_poc_manifest.json'), 'utf8')); const ttsMeta = JSON.parse(await fsp.readFile(path.join(ttsDir, 'tts_browser_onnx_meta.json'), 'utf8')); const codecMeta = JSON.parse(await fsp.readFile(path.join(codecDir, 'codec_browser_onnx_meta.json'), 'utf8'));
    const opts = this._sessionOptions();
    const open = async (dir, file) => this._createSession(path.join(dir, file), status);
    status(`Đang nạp MOSS-TTS-Nano ONNX trên ${this.executionProvider === 'dml' ? 'GPU DirectML' : 'CPU'}...`, 8);
    const sessions = {
      prefill: await open(ttsDir, ttsMeta.files.prefill), decode: await open(ttsDir, ttsMeta.files.decode_step), localFixed: await open(ttsDir, ttsMeta.files.local_fixed_sampled_frame),
      codecEncode: await open(codecDir, codecMeta.files.encode), codecDecode: await open(codecDir, codecMeta.files.decode_full)
    };
    const tokenizer = new SentencePieceProcessor(); await tokenizer.load(path.join(ttsDir, manifest.model_files.tokenizer_model));
    this.loaded = { ttsDir, codecDir, manifest, ttsMeta, codecMeta, sessions, tokenizer };
    return this.loaded;
  }

  normalizeText(text, language) {
    let value = String(text || '').trim().replace(/[\r\n]+/gu, ' ').replace(/ {2,}/gu, ' '); if (!value) throw new Error('Nội dung không được để trống.');
    if (language === 'zh' || language === 'ja' || language === 'ko') { if (!/[。！？；]$/u.test(value)) value += '。'; } else if (!/[.!?]$/u.test(value)) value += '.';
    return value;
  }

  splitText(bundle, text, maxTokens = 75, language = DEFAULT_LANGUAGE) {
    const prepared = this.normalizeText(text, language); const parts = prepared.split(language === 'zh' || language === 'ja' || language === 'ko' ? /(?<=[。！？；])\s*/u : /(?<=[.!?])\s+/u).filter(Boolean); const chunks = []; let current = ''; let count = 0;
    for (const part of parts) { const ids = bundle.tokenizer.encodeIds(part); if (current && count + ids.length > maxTokens) { chunks.push(current); current = ''; count = 0; } current += `${current ? (language === 'zh' || language === 'ja' || language === 'ko' ? '' : ' ') : ''}${part}`; count += ids.length; }
    if (current) chunks.push(current); return chunks.length ? chunks : [prepared];
  }

  async encodeReference(bundle, filePath) {
    const key = path.resolve(filePath); if (this.referenceCache.has(key)) return this.referenceCache.get(key); const audio = readReferenceAudio(key);
    const result = await bundle.sessions.codecEncode.run({ waveform: float32(audio.data, [1, CHANNELS, audio.frames]), input_lengths: int32([audio.frames], [1]) }); const map = outputMap(bundle.sessions.codecEncode, result); const codes = map.audio_codes; const length = Number(map.audio_code_lengths.data[0]); const nVq = bundle.codecMeta.codec_config.num_quantizers; const rows = [];
    for (let i = 0; i < length; i += 1) { const row = []; for (let q = 0; q < nVq; q += 1) row.push(Number(codes.data[i * nVq + q])); rows.push(row); }
    this.referenceCache.set(key, rows); return rows;
  }

  async resolvePrompt(bundle, voice, refAudioPath) {
    if (voice === 'clone') { if (!refAudioPath) throw new Error('MOSS-TTS-Nano cần audio tham chiếu khi chọn Clone giọng.'); return this.encodeReference(bundle, refAudioPath); }
    const row = (bundle.manifest.builtin_voices || []).find((item) => item.voice === voice) || bundle.manifest.builtin_voices?.[0]; if (!row) throw new Error('Không có preset MOSS voice.'); return row.prompt_audio_codes;
  }

  buildRows(bundle, promptCodes, tokenIds) {
    const cfg = bundle.manifest.tts_config; const width = cfg.n_vq + 1; const textRows = (ids) => ids.map((id) => { const row = new Array(width).fill(cfg.audio_pad_token_id); row[0] = id; return row; });
    const audioRows = promptCodes.map((codes) => { const row = new Array(width).fill(cfg.audio_pad_token_id); row[0] = cfg.audio_user_slot_token_id; for (let i = 0; i < Math.min(codes.length, cfg.n_vq); i += 1) row[i + 1] = codes[i]; return row; });
    const before = [...cfg ? bundle.manifest.prompt_templates.user_prompt_prefix_token_ids : [], cfg.audio_start_token_id]; const after = [cfg.audio_end_token_id, ...bundle.manifest.prompt_templates.user_prompt_after_reference_token_ids, ...tokenIds, ...bundle.manifest.prompt_templates.assistant_prompt_prefix_token_ids, cfg.audio_start_token_id]; const rows = [...textRows(before), ...audioRows, ...textRows(after)];
    return { ids: flattenRows(rows, width), dims: [1, rows.length, width], mask: int32(new Array(rows.length).fill(1), [1, rows.length]) };
  }

  async generateFrames(bundle, request, maxFrames = 375) {
    const cfg = bundle.manifest.tts_config; const prefill = await bundle.sessions.prefill.run({ input_ids: int32(request.ids, request.dims), attention_mask: request.mask }); const pm = outputMap(bundle.sessions.prefill, prefill); let globalHidden = lastHidden(pm.global_hidden); let pastValid = request.dims[1]; let past = {};
    for (const name of bundle.ttsMeta.onnx.prefill_output_names.slice(1)) past[name.replace('present_', 'past_')] = pm[name];
    const frames = []; const seen = Array.from({ length: cfg.n_vq }, () => new Set());
    for (let step = 0; step < maxFrames; step += 1) {
      const repetition = new Int32Array(cfg.n_vq * cfg.audio_codebook_sizes[0]); for (let c = 0; c < cfg.n_vq; c += 1) for (const id of seen[c]) if (id >= 0 && id < cfg.audio_codebook_sizes[c]) repetition[c * cfg.audio_codebook_sizes[c] + id] = 1;
      const fixed = await bundle.sessions.localFixed.run({ global_hidden: globalHidden, repetition_seen_mask: int32(repetition, [1, cfg.n_vq, cfg.audio_codebook_sizes[0]]), assistant_random_u: float32([Math.min(0.99999994, Math.max(0, Math.random()))], [1]), audio_random_u: float32(Array.from({ length: cfg.n_vq }, () => Math.min(0.99999994, Math.max(0, Math.random()))), [1, cfg.n_vq]) });
      const fm = outputMap(bundle.sessions.localFixed, fixed); if (Number(fm.should_continue.data[0]) === 0) break; const frame = Array.from(fm.frame_token_ids.data, Number); frames.push(frame); for (let c = 0; c < frame.length; c += 1) seen[c].add(frame[c]);
      const row = new Int32Array(cfg.n_vq + 1); row.fill(cfg.audio_pad_token_id); row[0] = cfg.audio_assistant_slot_token_id; for (let i = 0; i < frame.length; i += 1) row[i + 1] = frame[i]; const decoded = await bundle.sessions.decode.run({ input_ids: tensor('int32', row, [1, 1, cfg.n_vq + 1]), past_valid_lengths: int32([pastValid], [1]), ...past }); const dm = outputMap(bundle.sessions.decode, decoded); globalHidden = lastHidden(dm.global_hidden); pastValid += 1; past = {}; for (const name of bundle.ttsMeta.onnx.decode_output_names.slice(1)) past[name.replace('present_', 'past_')] = dm[name];
    }
    return frames;
  }

  async decodeAudio(bundle, frames) {
    if (!frames.length) return new Float32Array(0); const nVq = bundle.codecMeta.codec_config.num_quantizers; const codes = new Int32Array(frames.length * nVq); for (let i = 0; i < frames.length; i += 1) for (let q = 0; q < nVq; q += 1) codes[i * nVq + q] = Number(frames[i][q] || 0);
    const result = await bundle.sessions.codecDecode.run({ audio_codes: int32(codes, [1, frames.length, nVq]), audio_code_lengths: int32([frames.length], [1]) }); const map = outputMap(bundle.sessions.codecDecode, result); const audio = map.audio; const length = Number(map.audio_lengths.data[0]); const channels = audio.dims[1]; const out = new Float32Array(length * channels); for (let c = 0; c < channels; c += 1) for (let i = 0; i < length; i += 1) out[i * channels + c] = Number(audio.data[c * audio.dims[2] + i]); return out;
  }

  async generate(text, voice, speed, crossfadeMs, status, options = {}) {
    const requestedLanguage = options.language ? String(options.language) : DEFAULT_LANGUAGE;
    if (!SUPPORTED_LANGUAGES.includes(requestedLanguage)) throw new Error(`MOSS-TTS-Nano chưa công bố hỗ trợ ngôn ngữ: ${requestedLanguage}`);
    const language = requestedLanguage; const bundle = await this.load(status, options); const prompt = await this.resolvePrompt(bundle, voice, options.refAudioPath); const chunks = this.splitText(bundle, text, Number(options.maxTextTokens || 75), language); const waveforms = []; const maxFrames = Math.max(1, Number(options.maxNewFrames || 375));
    for (let i = 0; i < chunks.length; i += 1) { status(`MOSS-TTS-Nano ${LANGUAGE_LABELS[language]} ${this.executionProvider === 'dml' ? 'GPU DirectML' : 'CPU'} (${i + 1}/${chunks.length})...`, 20 + Math.round((i / chunks.length) * 70)); const ids = bundle.tokenizer.encodeIds(chunks[i]); const request = this.buildRows(bundle, prompt, ids); const frames = await this.generateFrames(bundle, request, maxFrames); const audio = await this.decodeAudio(bundle, frames); if (audio.length) waveforms.push(audio); if (i < chunks.length - 1) waveforms.push(new Float32Array(Math.round(SAMPLE_RATE * 0.24) * CHANNELS)); }
    const audio = speedAdjustStereo(concatStereo(waveforms), Number(speed || 1)); if (!audio.length) throw new Error('MOSS-TTS-Nano không tạo ra audio.'); const filename = `moss-${language}-${crypto.createHash('sha1').update(`${text}|${voice}|${Date.now()}`).digest('hex').slice(0, 12)}.wav`; const wavPath = path.join(this.outputDir, filename); writeWavStereo(wavPath, audio); status('Đã tạo audio MOSS-TTS-Nano thành công.', 100, 'success'); return { wavPath, durationMs: Math.round(audio.length / CHANNELS / SAMPLE_RATE * 1000), voiceLabel: voice === 'clone' ? 'Clone giọng tham chiếu' : voice, model: MossTTSNanoNode.id, language, sampleRate: SAMPLE_RATE };
  }

  async previewVoice(voice, status, options = {}) { if (voice === 'clone') throw new Error('MOSS-TTS-Nano không preview Clone khi chưa có audio tham chiếu.'); const language = options.language || DEFAULT_LANGUAGE; return this.generate(`Xin chào đây là giọng đọc ${voice}.`, voice, 1, 0, status, { language, maxNewFrames: 80, useGpu: Boolean(options.useGpu) }); }
}

module.exports = { MossTTSNanoNode, SAMPLE_RATE, LANGUAGE_LABELS, SUPPORTED_LANGUAGES };

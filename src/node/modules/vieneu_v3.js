'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { execFileSync } = require('child_process');
const ort = require('onnxruntime-node');
const { VietnameseG2P } = require('../g2p');

const SAMPLE_RATE = 48000;
const SPEAKER_RATE = 16000;
const MAX_REF_SECONDS = 8;
const DEFAULT_MAX_FRAMES = 300;
const DEFAULT_REP_WINDOW = 64;
const DEFAULT_TEMPERATURE = 0.8;
const DEFAULT_TOP_K = 25;
const DEFAULT_TOP_P = 0.95;
const DEFAULT_REP_PENALTY = 1.2;

function tensor(type, data, dims) { return new ort.Tensor(type, data, dims); }
function asArray(value) { return value && value.data ? value.data : value; }
function flattenFloat(value) { return Float32Array.from(asArray(value)); }

function nextPow2(n) {
  let x = 1;
  while (x < n) x <<= 1;
  return x;
}

function readZipEntries(buffer) {
  const entries = new Map();
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('NPZ thiếu End of Central Directory.');
  const count = buffer.readUInt16LE(eocd + 10);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  let offset = centralOffset;
  for (let entry = 0; entry < count; entry += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error('Central directory NPZ không hợp lệ.');
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = buffer.subarray(start, start + compressedSize);
    let raw;
    if (method === 0) raw = Buffer.from(compressed);
    else if (method === 8) raw = zlib.inflateRawSync(compressed);
    else throw new Error(`NPZ compression method ${method} không được hỗ trợ.`);
    entries.set(name, raw);
    offset += 46 + nameLength + extraLength + commentLength;
  }
  if (!entries.size) throw new Error('Không đọc được NPZ archive.');
  return entries;
}

function parseNpy(buffer) {
  if (buffer[0] !== 0x93 || buffer.toString('ascii', 1, 6) !== 'NUMPY') throw new Error('Nội dung NPY không hợp lệ.');
  const major = buffer[6];
  const headerLength = major === 1 ? buffer.readUInt16LE(8) : buffer.readUInt32LE(8);
  const headerStart = major === 1 ? 10 : 12;
  const header = buffer.toString('latin1', headerStart, headerStart + headerLength);
  const descrMatch = /['"]descr['"]\s*:\s*['"]([^'"]+)['"]/.exec(header);
  const shapeMatch = /['"]shape['"]\s*:\s*\(([^)]*)\)/.exec(header);
  if (!descrMatch || !shapeMatch) throw new Error('Header NPY thiếu descr/shape.');
  const descr = descrMatch[1];
  const shape = shapeMatch[1].split(',').map((x) => x.trim()).filter(Boolean).map(Number);
  const count = shape.reduce((a, b) => a * b, 1);
  const dataStart = headerStart + headerLength;
  const dataBytes = buffer.subarray(dataStart, dataStart + count * Math.abs(Number(descr.slice(-1)) || 4));
  let data;
  if (descr.endsWith('f4') || descr.endsWith('i4') || descr.endsWith('u4')) {
    const bytes = Buffer.from(dataBytes);
    if (descr.endsWith('f4')) {
      data = new Float32Array(count);
      for (let i = 0; i < count; i += 1) data[i] = bytes.readFloatLE(i * 4);
    } else if (descr.endsWith('i4')) {
      data = new Int32Array(count);
      for (let i = 0; i < count; i += 1) data[i] = bytes.readInt32LE(i * 4);
    } else {
      data = new Uint32Array(count);
      for (let i = 0; i < count; i += 1) data[i] = bytes.readUInt32LE(i * 4);
    }
  } else if (descr.endsWith('f8')) {
    data = new Float64Array(count);
    for (let i = 0; i < count; i += 1) data[i] = dataBytes.readDoubleLE(i * 8);
  } else if (descr.endsWith('i8')) {
    data = new BigInt64Array(count);
    for (let i = 0; i < count; i += 1) data[i] = dataBytes.readBigInt64LE(i * 8);
  } else {
    throw new Error(`dtype NPY chưa hỗ trợ: ${descr}`);
  }
  return { data, shape, descr };
}

function loadNpz(filePath) {
  const entries = readZipEntries(fs.readFileSync(filePath));
  const result = {};
  for (const [name, raw] of entries) result[name.replace(/\.npy$/u, '')] = parseNpy(raw);
  return result;
}

function makeByteEncoder() {
  const bytes = [];
  for (let i = 33; i <= 126; i += 1) bytes.push(i);
  for (let i = 161; i <= 172; i += 1) bytes.push(i);
  for (let i = 174; i <= 255; i += 1) bytes.push(i);
  const map = new Map();
  const reverse = new Map();
  let n = 0;
  for (const b of bytes) { map.set(b, String.fromCodePoint(b)); reverse.set(String.fromCodePoint(b), b); }
  for (let b = 0; b < 256; b += 1) {
    if (!map.has(b)) { const ch = String.fromCodePoint(256 + n); n += 1; map.set(b, ch); reverse.set(ch, b); }
  }
  return { map, reverse };
}

class VietNeuTokenizer {
  constructor(filePath) {
    const spec = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    this.vocab = spec.model.vocab;
    this.unk = this.vocab[spec.model.unk_token] ?? 43;
    this.merges = new Map();
    (spec.model.merges || []).forEach((pair, index) => {
      const left = Array.isArray(pair) ? pair[0] : String(pair).split(' ')[0];
      const right = Array.isArray(pair) ? pair[1] : String(pair).split(' ')[1];
      this.merges.set(`${left}\u0000${right}`, index);
    });
    this.byte = makeByteEncoder();
    this.partsRe = /(?:'s|'t|'re|'ve|'m|'ll|'d)|[^\r\n\p{L}\p{N}]?\p{L}+|\p{N}| ?[^\s\p{L}\p{N}]+[\r\n]*|\s*[\r\n]+|\s+(?!\S)|\s+/gu;
  }

  _bpe(piece) {
    const symbols = Array.from(Buffer.from(piece, 'utf8'), (b) => this.byte.map.get(b));
    if (!symbols.length) return [];
    while (symbols.length > 1) {
      let bestIndex = -1; let bestRank = Infinity;
      for (let i = 0; i < symbols.length - 1; i += 1) {
        const rank = this.merges.get(`${symbols[i]}\u0000${symbols[i + 1]}`);
        if (rank !== undefined && rank < bestRank) { bestRank = rank; bestIndex = i; }
      }
      if (bestIndex < 0) break;
      symbols.splice(bestIndex, 2, symbols[bestIndex] + symbols[bestIndex + 1]);
    }
    return symbols.map((symbol) => this.vocab[symbol] ?? this.unk);
  }

  encode(text) {
    const input = String(text ?? '').normalize('NFC');
    const ids = [];
    this.partsRe.lastIndex = 0;
    let match;
    while ((match = this.partsRe.exec(input))) ids.push(...this._bpe(match[0]));
    return ids;
  }
}

function linearResample(input, fromRate, toRate) {
  const source = Float32Array.from(input);
  if (!source.length || fromRate === toRate) return source;
  const outLength = Math.max(1, Math.round(source.length * toRate / fromRate));
  const output = new Float32Array(outLength);
  const scale = source.length / outLength;
  for (let i = 0; i < outLength; i += 1) {
    const position = i * scale;
    const left = Math.floor(position);
    const right = Math.min(source.length - 1, left + 1);
    const alpha = position - left;
    output[i] = source[left] * (1 - alpha) + source[right] * alpha;
  }
  return output;
}

function parseWav(buffer) {
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') throw new Error('File WAV không hợp lệ.');
  let offset = 12; let channels = 1; let sampleRate = 16000; let bits = 16; let format = 1; let audioData = null;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const start = offset + 8; const end = Math.min(buffer.length, start + size);
    if (id === 'fmt ') {
      format = buffer.readUInt16LE(start); channels = buffer.readUInt16LE(start + 2);
      sampleRate = buffer.readUInt32LE(start + 4); bits = buffer.readUInt16LE(start + 14);
    } else if (id === 'data') audioData = buffer.subarray(start, end);
    offset = end + (size & 1);
  }
  if (!audioData) throw new Error('WAV thiếu chunk data.');
  const bytesPerSample = Math.max(1, Math.ceil(bits / 8));
  const frames = Math.floor(audioData.length / (bytesPerSample * channels));
  const mono = new Float32Array(frames);
  for (let i = 0; i < frames; i += 1) {
    let sum = 0;
    for (let c = 0; c < channels; c += 1) {
      const p = (i * channels + c) * bytesPerSample;
      let value;
      if (format === 3 && bits === 32) value = audioData.readFloatLE(p);
      else if (bits === 8) value = (audioData[p] - 128) / 128;
      else if (bits === 16) value = audioData.readInt16LE(p) / 32768;
      else if (bits === 24) { let x = audioData[p] | (audioData[p + 1] << 8) | (audioData[p + 2] << 16); if (x & 0x800000) x |= 0xff000000; value = x / 8388608; }
      else if (bits === 32) value = audioData.readInt32LE(p) / 2147483648;
      else throw new Error(`WAV bit depth ${bits} chưa hỗ trợ.`);
      sum += value;
    }
    mono[i] = sum / channels;
  }
  return { waveform: mono, sampleRate };
}

function decodeAudioFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.wav') return parseWav(fs.readFileSync(filePath));
  const ffmpeg = process.env.HOTANVOICE_FFMPEG_PATH || require('ffmpeg-static');
  if (!ffmpeg || !fs.existsSync(ffmpeg)) throw new Error(`Không có ffmpeg để đọc file audio ngoài WAV: ${ffmpeg || 'unknown'}.`);
  const wav = execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', filePath, '-f', 'wav', '-ac', '1', 'pipe:1'], { maxBuffer: 128 * 1024 * 1024 });
  return parseWav(wav);
}

function fftPower(frame, nfft) {
  const re = new Float64Array(nfft); const im = new Float64Array(nfft);
  re.set(frame);
  for (let i = 1, j = 0; i < nfft; i += 1) {
    let bit = nfft >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { const t = re[i]; re[i] = re[j]; re[j] = t; }
  }
  for (let len = 2; len <= nfft; len <<= 1) {
    const angle = -2 * Math.PI / len; const wr0 = Math.cos(angle); const wi0 = Math.sin(angle);
    for (let i = 0; i < nfft; i += len) {
      let wr = 1; let wi = 0;
      for (let j = 0; j < len / 2; j += 1) {
        const a = i + j; const b = a + len / 2;
        const tr = re[b] * wr - im[b] * wi; const ti = re[b] * wi + im[b] * wr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        const nextWr = wr * wr0 - wi * wi0; wi = wr * wi0 + wi * wr0; wr = nextWr;
      }
    }
  }
  const power = new Float64Array(nfft / 2 + 1);
  for (let i = 0; i < power.length; i += 1) power[i] = re[i] * re[i] + im[i] * im[i];
  return power;
}

function kaldiFbank(waveform, sampleRate = SPEAKER_RATE, nMels = 80) {
  let wav = Float32Array.from(waveform);
  if (sampleRate !== SPEAKER_RATE) wav = linearResample(wav, sampleRate, SPEAKER_RATE);
  const frameLength = Math.round(0.025 * SPEAKER_RATE); const frameShift = Math.round(0.010 * SPEAKER_RATE);
  if (wav.length < frameLength) throw new Error('Audio tham chiếu quá ngắn; cần ít nhất 25 ms.');
  const frames = 1 + Math.floor((wav.length - frameLength) / frameShift); const nfft = nextPow2(frameLength);
  const lowMel = 1127 * Math.log1p(20 / 700); const highMel = 1127 * Math.log1p((SPEAKER_RATE / 2) / 700);
  const melPoints = new Float64Array(nMels + 2); const bin = new Int32Array(nMels + 2);
  for (let i = 0; i < melPoints.length; i += 1) { melPoints[i] = lowMel + (highMel - lowMel) * i / (nMels + 1); const hz = 700 * (Math.exp(melPoints[i] / 1127) - 1); bin[i] = Math.floor((nfft + 1) * hz / SPEAKER_RATE); }
  const filters = Array.from({ length: nMels }, () => new Float64Array(nfft / 2 + 1));
  for (let m = 1; m <= nMels; m += 1) {
    const left = bin[m - 1]; const center = Math.max(left + 1, bin[m]); const right = Math.max(center + 1, bin[m + 1]);
    for (let k = left; k < center && k < filters[m - 1].length; k += 1) filters[m - 1][k] = (k - left) / (center - left);
    for (let k = center; k < right && k < filters[m - 1].length; k += 1) filters[m - 1][k] = (right - k) / (right - center);
  }
  const result = new Float32Array(frames * nMels); const frame = new Float64Array(nfft);
  for (let f = 0; f < frames; f += 1) {
    const start = f * frameShift; let mean = 0;
    for (let i = 0; i < frameLength; i += 1) mean += wav[start + i];
    mean /= frameLength;
    for (let i = 0; i < frameLength; i += 1) {
      const current = wav[start + i] - mean; const prev = i ? wav[start + i - 1] - mean : current;
      const pre = current - 0.97 * prev; const window = Math.pow(0.5 - 0.5 * Math.cos(2 * Math.PI * i / (frameLength - 1)), 0.85); frame[i] = pre * window;
    }
    frame.fill(0, frameLength);
    const power = fftPower(frame, nfft);
    for (let m = 0; m < nMels; m += 1) { let energy = 0; const filter = filters[m]; for (let k = 0; k < power.length; k += 1) energy += power[k] * filter[k]; result[f * nMels + m] = Math.log(Math.max(energy, 1e-10)); }
  }
  for (let m = 0; m < nMels; m += 1) { let mean = 0; for (let f = 0; f < frames; f += 1) mean += result[f * nMels + m]; mean /= frames; for (let f = 0; f < frames; f += 1) result[f * nMels + m] -= mean; }
  return { data: result, frames, dims: [1, frames, nMels] };
}

function writeWav(filePath, audio, sampleRate) {
  const samples = Buffer.alloc(audio.length * 2);
  for (let i = 0; i < audio.length; i += 1) { const value = Math.max(-1, Math.min(1, Number(audio[i]) || 0)); samples.writeInt16LE(Math.round(value * (value < 0 ? 32768 : 32767)), i * 2); }
  const header = Buffer.alloc(44); header.write('RIFF', 0); header.writeUInt32LE(36 + samples.length, 4); header.write('WAVE', 8); header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(samples.length, 40); fs.writeFileSync(filePath, Buffer.concat([header, samples]));
}

function softmaxSample(logits, temperature, topK, topP, repetitionPenalty, history) {
  const values = Float32Array.from(logits);
  if (repetitionPenalty !== 1 && history && history.length) for (const index of history) values[index] = values[index] < 0 ? values[index] * repetitionPenalty : values[index] / repetitionPenalty;
  if (!(temperature > 0)) { let best = 0; for (let i = 1; i < values.length; i += 1) if (values[i] > values[best]) best = i; return best; }
  const pairs = Array.from(values, (v, i) => [v / temperature, i]).sort((a, b) => b[0] - a[0]);
  const candidates = topK > 0 ? pairs.slice(0, Math.min(topK, pairs.length)) : pairs;
  const max = candidates[0][0]; const probs = candidates.map(([v]) => Math.exp(v - max)); let total = probs.reduce((a, b) => a + b, 0);
  if (topP > 0 && topP < 1) { let cumulative = 0; let keep = candidates.length; for (let i = 0; i < probs.length; i += 1) { const p = probs[i] / total; if (cumulative + p > topP && i > 0) { keep = i; break; } cumulative += p; } candidates.splice(keep); probs.splice(keep); total = probs.reduce((a, b) => a + b, 0); }
  let r = Math.random() * total; for (let i = 0; i < probs.length; i += 1) { r -= probs[i]; if (r <= 0) return candidates[i][1]; }
  return candidates[candidates.length - 1][1];
}

class VietNeuV3Node {
  static id = 'vieneu-v3-turbo-node';
  static name = 'VietNeu-TTS v3 Turbo ONNX / Node.js';
  static sampleRate = SAMPLE_RATE;

  constructor() {
    this.modelDir = process.env.VIENEU_MODEL_DIR || path.resolve(__dirname, '..', '..', 'assets', 'model', 'vieneu-v3-int8');
    this.codecDir = process.env.VIENEU_CODEC_DIR || path.resolve(__dirname, '..', '..', 'assets', 'model', 'moss-onnx');
    this.outputDir = path.join(process.env.HOTANVOICE_APP_DATA || os.tmpdir(), 'worker-output'); fs.mkdirSync(this.outputDir, { recursive: true });
    this.cfg = JSON.parse(fs.readFileSync(path.join(this.modelDir, 'config.json'), 'utf8'));
    this.nVq = Number(this.cfg.n_vq); this.hidden = Number(this.cfg.hidden_size); this.layers = Number(this.cfg.num_hidden_layers || this.cfg.L || 12); this.localLayers = Number(this.cfg.local_num_hidden_layers || this.cfg.L_loc || 1); this.localHeads = Number(this.cfg.local_num_attention_heads || this.cfg.nH_loc || 8); this.headDim = Math.floor(this.hidden / this.localHeads);
    this.audioPad = Number(this.cfg.audio_pad_token_id ?? this.cfg.audio_pad ?? 1024); this.tps = Number(this.cfg.text_prompt_start_token_id ?? this.cfg.tps ?? 3); this.tpe = Number(this.cfg.text_prompt_end_token_id ?? this.cfg.tpe ?? 4); this.sgs = Number(this.cfg.speech_generation_start_token_id ?? this.cfg.sgs ?? 5); this.eosSpeech = Number(this.cfg.speech_generation_end_token_id ?? this.cfg.eos_speech ?? 6); this.refSlot = Number(this.cfg.audio_ref_slot_token_id ?? this.cfg.ref_slot ?? 7); this.defaultStyle = Number(this.cfg.default_style_token_id ?? this.cfg.default_style_id ?? 16); this.speakerDim = Number(this.cfg.speaker_embedding_dim || 192);
    const heads = loadNpz(path.join(this.modelDir, 'vieneu_v3_heads.npz')); this.textEmb = Float32Array.from(heads.text_emb.data); this.audioEmb = Float32Array.from(heads.audio_emb.data); this.xvecW = heads.xvec_w ? Float32Array.from(heads.xvec_w.data) : null; this.xvecB = heads.xvec_b ? Float32Array.from(heads.xvec_b.data) : null; this.xvecLnW = heads.xvec_ln_w ? Float32Array.from(heads.xvec_ln_w.data) : null; this.xvecLnB = heads.xvec_ln_b ? Float32Array.from(heads.xvec_ln_b.data) : null; this.xvecLnEps = heads.xvec_ln_eps ? Number(heads.xvec_ln_eps.data[0]) : 1e-5;
    this.textVocab = heads.text_emb.shape[0]; this.audioVocab = heads.audio_emb.shape[1]; this.tokenizer = new VietNeuTokenizer(path.join(this.modelDir, 'tokenizer.json')); this.g2p = new VietnameseG2P(path.resolve(__dirname, '..', '..', 'assets', 'model', 'sea_g2p.bin'));
    this.sessions = null; this.speakerSession = null; this.codecEncodeSession = null; this.executionProvider = 'cpu'; this.voices = JSON.parse(fs.readFileSync(path.join(this.modelDir, 'voices_v3_turbo.json'), 'utf8'));
  }

  listVoices() { return Object.entries(this.voices.presets || {}).map(([id, v]) => ({ id, label: v.description ? `${id} — ${v.description}` : id })).concat([{ id: 'clone', label: 'Clone giọng — file tham chiếu 3–8 giây' }]); }

  _setExecutionProvider(useGpu) {
    const desired = useGpu ? 'dml' : 'cpu';
    if (this.executionProvider !== desired) { this.sessions = null; this.speakerSession = null; this.codecEncodeSession = null; this.executionProvider = desired; }
  }

  _sessionOptions(useGpu = this.executionProvider === 'dml') {
    return { executionProviders: useGpu ? ['dml', 'cpu'] : ['cpu'], graphOptimizationLevel: 'all', intraOpNumThreads: Number(process.env.ORT_INTRA_OP_NUM_THREADS || 4), interOpNumThreads: 1 };
  }

  async _createSession(modelPath, status) {
    try { return await ort.InferenceSession.create(modelPath, this._sessionOptions()); }
    catch (error) {
      if (this.executionProvider !== 'dml') throw error;
      status('DirectML không khả dụng, tự chuyển VietNeu về CPU...', 14, 'warning');
      this._setExecutionProvider(false);
      return ort.InferenceSession.create(modelPath, this._sessionOptions(false));
    }
  }

  async _ensureSessions(status, options = {}) {
    this._setExecutionProvider(Boolean(options.useGpu));
    if (this.sessions) return;
    status(`Đang nạp VietNeu v3 Turbo ONNX và MOSS codec trên ${this.executionProvider === 'dml' ? 'GPU DirectML' : 'CPU'}...`, 12);
    const sessionOptions = this._sessionOptions();
    this.sessions = { pre: await this._createSession(path.join(this.modelDir, 'vieneu_prefill.onnx'), status), dec: await this._createSession(path.join(this.modelDir, 'vieneu_decode_step.onnx'), status), acoustic: await this._createSession(path.join(this.modelDir, 'vieneu_acoustic_cached.onnx'), status), codecDec: await this._createSession(path.join(this.codecDir, 'moss_audio_tokenizer_decode_full.onnx'), status) };
  }

  _speakerAnchor(speaker) {
    if (!speaker) throw new Error('VietNeu cần speaker embedding; hãy chọn preset hoặc tải file clone giọng.');
    if (!this.xvecW || !this.xvecB || !this.xvecLnW || !this.xvecLnB) throw new Error('Thiếu xvec projection weights trong heads.npz.');
    const projected = new Float32Array(this.hidden); let mean = 0;
    for (let h = 0; h < this.hidden; h += 1) { let sum = this.xvecB[h]; for (let d = 0; d < this.speakerDim; d += 1) sum += speaker[d] * this.xvecW[h * this.speakerDim + d]; projected[h] = sum; mean += sum; }
    mean /= this.hidden; let variance = 0; for (const v of projected) variance += (v - mean) ** 2; variance /= this.hidden; const scale = Math.sqrt(variance + this.xvecLnEps); for (let h = 0; h < this.hidden; h += 1) projected[h] = ((projected[h] - mean) / scale) * this.xvecLnW[h] + this.xvecLnB[h]; return projected;
  }

  _textAt(id, out, offset) { const start = id * this.hidden; for (let h = 0; h < this.hidden; h += 1) out[offset + h] = this.textEmb[start + h]; }
  _addAudio(ch, id, out, offset) { const start = (ch * this.audioVocab + id) * this.hidden; for (let h = 0; h < this.hidden; h += 1) out[offset + h] += this.audioEmb[start + h]; }
  _embedRows(rows, anchor) { const out = new Float32Array(rows.length * this.hidden); for (let t = 0; t < rows.length; t += 1) { const row = rows[t]; const offset = t * this.hidden; this._textAt(row[0], out, offset); for (let ch = 0; ch < this.nVq; ch += 1) { const id = row[ch + 1]; if (id !== this.audioPad) this._addAudio(ch, id, out, offset); } if (anchor) for (let h = 0; h < this.hidden; h += 1) out[offset + h] += anchor[h]; } return tensor('float32', out, [1, rows.length, this.hidden]); }

  _buildRows(phonemes, speaker, refCodes) {
    const ids = this.tokenizer.encode(phonemes); const text = [this.defaultStyle, this.tps, ...ids, this.tpe]; const rows = Array.from({ length: text.length }, () => new Int32Array(this.nVq + 1)); rows.forEach((row, index) => { row.fill(this.audioPad); row[0] = text[index]; });
    if (!refCodes || !refCodes.length) return rows;
    const ref = refCodes.map((codes) => { const row = new Int32Array(this.nVq + 1); row.fill(this.audioPad); row[0] = this.refSlot; for (let ch = 0; ch < this.nVq; ch += 1) row[ch + 1] = Number(codes[ch] ?? this.audioPad); return row; });
    return rows.concat(ref);
  }

  _orderedOutputs(result, session) { if (Array.isArray(result)) return result; const names = session.outputNames || Object.keys(result); return names.map((name) => result[name]); }
  _emptyLocalPast() { const zero = new Float32Array(0); const feed = {}; for (let i = 0; i < this.localLayers; i += 1) { feed[`past_k_${i}`] = tensor('float32', zero, [1, this.localHeads, 0, this.headDim]); feed[`past_v_${i}`] = tensor('float32', zero, [1, this.localHeads, 0, this.headDim]); } return feed; }
  _splitLocal(out) { return { k: out.slice(1, 1 + this.localLayers), v: out.slice(1 + this.localLayers, 1 + 2 * this.localLayers) }; }
  _localFeed(k, v) { const feed = {}; for (let i = 0; i < this.localLayers; i += 1) { feed[`past_k_${i}`] = k[i]; feed[`past_v_${i}`] = v[i]; } return feed; }

  async _acousticFrame(hidden, options, histories) {
    const first = new Float32Array(this.hidden * 2); first.set(asArray(hidden)); const start = this.sgs * this.hidden; for (let h = 0; h < this.hidden; h += 1) first[this.hidden + h] = this.textEmb[start + h];
    const feed = { token_emb: tensor('float32', first, [1, 2, this.hidden]), position_ids: tensor('int64', BigInt64Array.from([0n, 1n]), [1, 2]), ...this._emptyLocalPast() }; const firstResult = await this.sessions.acoustic.run(feed); let out = this._orderedOutputs(firstResult, this.sessions.acoustic); let local = this._splitLocal(out); let h = asArray(out[0]); const slot0 = h.subarray(0, this.hidden); let codes = [];
    for (let ch = 0; ch < this.nVq; ch += 1) { const vector = h.subarray(ch === 0 ? this.hidden : 0, ch === 0 ? 2 * this.hidden : this.hidden); const logits = new Float32Array(this.audioVocab); const embBase = ch * this.audioVocab * this.hidden; for (let id = 0; id < this.audioVocab; id += 1) { let dot = 0; const base = embBase + id * this.hidden; for (let j = 0; j < this.hidden; j += 1) dot = Math.fround(dot + vector[j] * this.audioEmb[base + j]); logits[id] = dot; } const code = softmaxSample(logits, options.temperature, options.topK, options.topP, options.repetitionPenalty, histories[ch]); codes.push(code); if (histories[ch]) { histories[ch].push(code); if (histories[ch].length > options.repetitionWindow) histories[ch].shift(); } if (ch + 1 < this.nVq) { const emb = new Float32Array(this.hidden); const base = ((ch) * this.audioVocab + code) * this.hidden; emb.set(this.audioEmb.subarray(base, base + this.hidden)); const stepFeed = { token_emb: tensor('float32', emb, [1, 1, this.hidden]), position_ids: tensor('int64', BigInt64Array.from([BigInt(ch + 2)]), [1, 1]), ...this._localFeed(local.k, local.v) };         const stepResult = await this.sessions.acoustic.run(stepFeed); out = this._orderedOutputs(stepResult, this.sessions.acoustic); local = this._splitLocal(out); h = asArray(out[0]); } }
    const textStart = this.eosSpeech * this.hidden; let best = 0; let bestScore = -Infinity; for (let id = 0; id < this.textVocab; id += 1) { let dot = 0; const base = id * this.hidden; for (let hIndex = 0; hIndex < this.hidden; hIndex += 1) dot += slot0[hIndex] * this.textEmb[base + hIndex]; if (dot > bestScore) { bestScore = dot; best = id; } } return { codes, eos: best === this.eosSpeech, eosToken: best, eosScore: bestScore };
  }

  async _prepareReference(filePath, status, options = {}) {
    this._setExecutionProvider(Boolean(options.useGpu));
    status('Đang đọc audio tham chiếu và tính speaker embedding...', 24); const decoded = decodeAudioFile(filePath); let wav = decoded.waveform; let sr = decoded.sampleRate; const max = Math.floor(MAX_REF_SECONDS * sr); if (wav.length > max) wav = wav.subarray(0, max); const fbank = kaldiFbank(wav, sr, 80); if (!this.speakerSession) { const sessionOptions = this._sessionOptions(); this.speakerSession = await this._createSession(path.join(this.modelDir, 'speaker_encoder.onnx'), status); } const speakerOut = await this.speakerSession.run({ input: tensor('float32', fbank.data, [1, fbank.frames, 80]) }); const speaker = Float32Array.from(asArray(speakerOut.output || speakerOut[Object.keys(speakerOut)[0]])).slice(0, this.speakerDim); status('Đang mã hóa audio tham chiếu bằng MOSS codec...', 32); const refWav = sr === SAMPLE_RATE ? wav : linearResample(wav, sr, SAMPLE_RATE); if (!this.codecEncodeSession) { const sessionOptions = this._sessionOptions(); this.codecEncodeSession = await this._createSession(path.join(this.codecDir, 'moss_audio_tokenizer_encode.onnx'), status); } const stereo = new Float32Array(refWav.length * 2); stereo.set(refWav); stereo.set(refWav, refWav.length); const encoded = await this.codecEncodeSession.run({ waveform: tensor('float32', stereo, [1, 2, refWav.length]), input_lengths: tensor('int32', Int32Array.of(refWav.length), [1]) }); const codeValue = encoded.audio_codes || encoded[Object.keys(encoded)[0]]; const rawCodes = asArray(codeValue); const dims = codeValue.dims || [1, Math.floor(rawCodes.length / this.nVq), this.nVq]; const frames = Number(dims[1]); const refCodes = Array.from({ length: frames }, (_, t) => Array.from(rawCodes.slice(t * this.nVq, (t + 1) * this.nVq), Number)); return { speaker, refCodes };
  }

  async _resolveVoice(voice, refAudioPath, status, options = {}) {
    if (refAudioPath) return this._prepareReference(refAudioPath, status, options);
    const selected = this.voices.presets?.[voice] || this.voices.presets?.[this.voices.default_voice]; if (!selected) throw new Error('Không tìm thấy preset VietNeu hoặc file clone giọng.'); return { speaker: Float32Array.from(selected.speaker_emb), refCodes: selected.codes || null };
  }

  _splitTextChunks(text, maxChars = 256) {
    const paragraphs = String(text || '').trim().split(/\r?\n+/u).map((p) => p.trim()).filter(Boolean);
    const chunks = [];
    const gaps = [];
    const addParagraph = (paragraph) => {
      const sentences = (paragraph.match(/[^.!?]+[.!?]*|[.!?]+/gu) || []).map((s) => s.trim()).filter(Boolean);
      const packed = [];
      let buffer = '';
      const addPiece = (piece) => {
        const clean = piece.trim();
        if (!clean) return;
        if (buffer && buffer.length + 1 + clean.length > maxChars) { packed.push(buffer.trim()); buffer = clean; }
        else buffer = buffer ? `${buffer} ${clean}` : clean;
      };
      for (const sentence of sentences) {
        if (sentence.length <= maxChars) { addPiece(sentence); continue; }
        const parts = sentence.split(/(?<=[,;:\-–—])\s+/u).filter(Boolean);
        for (const part of parts) {
          if (part.length <= maxChars) { addPiece(part); continue; }
          for (const word of part.split(/\s+/u).filter(Boolean)) addPiece(word);
        }
      }
      if (buffer) packed.push(buffer.trim());
      if (!packed.length) return;
      if (chunks.length) gaps.push('para');
      for (let i = 0; i < packed.length; i += 1) {
        if (i > 0) gaps.push(/[.!?]$/u.test(packed[i - 1].trim()) ? 'sentence' : 'minor');
        chunks.push(packed[i]);
      }
    };
    for (const paragraph of paragraphs) addParagraph(paragraph);
    return { chunks, gaps };
  }

  _joinChunks(audioChunks, gaps) {
    if (audioChunks.length === 1) return audioChunks[0];
    const gapSeconds = { para: 0.35, sentence: 0.18, minor: 0.04 };
    let total = audioChunks.reduce((sum, chunk) => sum + chunk.length, 0);
    for (let i = 0; i < audioChunks.length - 1; i += 1) total += Math.round(SAMPLE_RATE * (gapSeconds[gaps[i]] ?? 0.18));
    const joined = new Float32Array(total);
    let offset = 0;
    for (let i = 0; i < audioChunks.length; i += 1) {
      joined.set(audioChunks[i], offset); offset += audioChunks[i].length;
      if (i < audioChunks.length - 1) offset += Math.round(SAMPLE_RATE * (gapSeconds[gaps[i]] ?? 0.18));
    }
    return joined;
  }

  async _inferChunk(phonemes, condition, anchor, options, status, chunkIndex, chunkCount) {
    const rows = this._buildRows(phonemes, condition.speaker, condition.refCodes);
    const prompt = this._embedRows(rows, anchor);
    status(`Đang prefill VietNeu chunk ${chunkIndex}/${chunkCount} trên ${this.executionProvider === 'dml' ? 'GPU DirectML' : 'CPU'}...`, 34 + Math.round(((chunkIndex - 1) / Math.max(1, chunkCount)) * 14));
    const pre = await this.sessions.pre.run({ inputs_embeds: prompt });
    const preValues = this._orderedOutputs(pre, this.sessions.pre);
    let pastK = preValues.slice(1, 1 + this.layers);
    let pastV = preValues.slice(1 + this.layers, 1 + 2 * this.layers);
    let hidden = asArray(preValues[0]).subarray((prompt.dims[1] - 1) * this.hidden, prompt.dims[1] * this.hidden);
    const requestedFrames = Number(options.maxNewFrames);
    const maxFrames = Number.isFinite(requestedFrames) && requestedFrames > 0
      ? Math.min(600, Math.trunc(requestedFrames))
      : Math.max(48, Math.min(300, Math.ceil(Math.max(1, phonemes.length) * 2.2)));
    const histories = options.repetitionPenalty === 1 ? Array(this.nVq).fill(null) : Array.from({ length: this.nVq }, () => []);
    const frames = [];
    const trace = [];
    for (let t = 0; t < maxFrames; t += 1) {
      const frame = await this._acousticFrame(hidden, options, histories);
      trace.push({ token: frame.eosToken, eos: frame.eos, score: frame.eosScore });
      frames.push(frame.codes);
      if (frame.eos) break;
      const slot = new Int32Array(this.nVq + 1); slot.fill(this.audioPad); slot[0] = this.sgs; slot.set(frame.codes, 1);
      const emb = this._embedRows([slot], anchor);
      const feed = { inputs_embeds: emb, position_ids: tensor('int64', BigInt64Array.from([BigInt(rows.length + t)]), [1, 1]) };
      for (let i = 0; i < this.layers; i += 1) { feed[`past_k_${i}`] = pastK[i]; feed[`past_v_${i}`] = pastV[i]; }
      const decoded = await this.sessions.dec.run(feed);
      const values = this._orderedOutputs(decoded, this.sessions.dec);
      hidden = asArray(values[0]).subarray(0, this.hidden);
      pastK = values.slice(1, 1 + this.layers); pastV = values.slice(1 + this.layers, 1 + 2 * this.layers);
      if (t % 5 === 0) status(`Đang tổng hợp VietNeu chunk ${chunkIndex}/${chunkCount} (${t + 1}/${maxFrames} frame)...`, 48 + Math.round(((chunkIndex - 1) / Math.max(1, chunkCount)) * 34 + (t / maxFrames) * (34 / Math.max(1, chunkCount))));
    }
    if (!frames.length) throw new Error('VietNeu không tạo ra audio codes.');
    const codeTensor = Int32Array.from(frames.flat());
    const decodedAudio = await this.sessions.codecDec.run({ audio_codes: tensor('int32', codeTensor, [1, frames.length, this.nVq]), audio_code_lengths: tensor('int32', Int32Array.of(frames.length), [1]) });
    const audioValue = decodedAudio.audio || decodedAudio[Object.keys(decodedAudio)[0]];
    const audioData = asArray(audioValue); const audioDims = audioValue.dims || [1, 1, audioData.length];
    const channels = Number(audioDims[1] || 1); const samples = Number(audioDims[2] || Math.floor(audioData.length / channels));
    const mono = new Float32Array(samples);
    for (let i = 0; i < samples; i += 1) { let sum = 0; for (let c = 0; c < channels; c += 1) sum += Number(audioData[c * samples + i] || 0); mono[i] = sum / channels; }
    return { audio: mono, trace, frames: frames.length };
  }

  async generate(text, voice, speed, crossfadeMs, status, options = {}) {
    const clean = String(text || '').trim();
    if (!clean) throw new Error('Nội dung không được để trống.');
    await this._ensureSessions(status, options);
    const { chunks, gaps } = this._splitTextChunks(clean, Number(options.maxChars || 256));
    if (!chunks.length) throw new Error('Không tạo được chunk từ nội dung.');
    const selectedVoice = voice || this.voices.default_voice;
    const condition = await this._resolveVoice(selectedVoice, options.refAudioPath, status, options);
    const anchor = this._speakerAnchor(condition.speaker);
    const opts = { temperature: Number(options.temperature ?? DEFAULT_TEMPERATURE), topK: Number(options.topK ?? DEFAULT_TOP_K), topP: Number(options.topP ?? DEFAULT_TOP_P), repetitionPenalty: Number(options.repetitionPenalty ?? DEFAULT_REP_PENALTY), repetitionWindow: Number(options.repetitionWindow ?? 64), maxNewFrames: options.maxNewFrames };
    const audioChunks = []; const phonemeChunks = []; this.lastEosTrace = [];
    for (let i = 0; i < chunks.length; i += 1) {
      const phonemes = this.g2p.phonemizeVietNeu(chunks[i]);
      if (!phonemes) continue;
      const result = await this._inferChunk(phonemes, condition, anchor, opts, status, i + 1, chunks.length);
      audioChunks.push(result.audio); phonemeChunks.push(`[${i + 1}] ${phonemes}`); this.lastEosTrace.push(...result.trace.map((entry) => ({ ...entry, chunk: i + 1 })));
    }
    if (!audioChunks.length) throw new Error('VietNeu không tạo ra audio.');
    status('Đang ghép các đoạn audio VietNeu...', 90);
    const audio = this._joinChunks(audioChunks, gaps);
    const filename = `vieneu-node-${process.pid}-${crypto.createHash('sha1').update(`${clean}|${selectedVoice}|${Date.now()}`).digest('hex').slice(0, 12)}.wav`;
    const wavPath = path.join(this.outputDir, filename); writeWav(wavPath, audio, SAMPLE_RATE);
    status('Đã tạo audio VietNeu thành công.', 100, 'success');
    return { wavPath, durationMs: Math.round(audio.length / SAMPLE_RATE * 1000), phonemes: phonemeChunks.join('\n'), voiceLabel: options.refAudioPath ? 'Clone giọng tham chiếu' : (this.voices.presets?.[selectedVoice]?.description ? `${selectedVoice} — ${this.voices.presets[selectedVoice].description}` : selectedVoice), model: VietNeuV3Node.id };
  }

  async previewVoice(voice, status) {
    const label = this.voices.presets?.[voice]?.description ? `${voice} — ${this.voices.presets[voice].description}` : voice;
    return this.generate(`Xin chào đây là giọng đọc ${label}.`, voice, 1, 30, status, { maxChars: 256 });
  }
}

module.exports = { VietNeuV3Node, SAMPLE_RATE, kaldiFbank, parseWav, loadNpz };

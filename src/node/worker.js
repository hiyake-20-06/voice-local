'use strict';

const readline = require('readline');
const { KokoroVietnameseNode } = require('./modules/kokoro_vietnamese');
const { VietNeuV3Node } = require('./modules/vieneu_v3');
const { MossTTSNanoNode } = require('./modules/moss_tts_nano_onnx');

function emit(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function status(message, progress, level = 'info') {
  const data = { event: 'status', message, level };
  if (progress !== undefined && progress !== null) data.progress = progress;
  emit(data);
}

const definitions = [
  {
    id: KokoroVietnameseNode.id,
    name: 'Kokoro Vietnamese ONNX',
    description: 'Kokoro-Vietnamese, giọng preset, ONNX CPU hoặc DirectML GPU',
    moduleClass: KokoroVietnameseNode,
    capabilities: { voiceCloning: false, gpuAcceleration: true, sampleRate: 24000 },
    defaultVoice: 'diem_trinh'
  },
  {
    id: VietNeuV3Node.id,
    name: 'VietNeu-TTS v3 Turbo',
    description: 'VietNeu v3 Turbo, preset voice và clone giọng, ONNX CPU hoặc DirectML GPU',
    moduleClass: VietNeuV3Node,
    capabilities: { voiceCloning: true, gpuAcceleration: true, sampleRate: 48000, maxReferenceSeconds: 8 },
    defaultVoice: 'Phạm Tuyên'
  },
  {
    id: MossTTSNanoNode.id,
    name: 'MOSS-TTS-Nano ONNX',
    description: 'MOSS-TTS-Nano 100M, 20 ngôn ngữ, clone giọng, ONNX CPU hoặc DirectML GPU 48 kHz stereo',
    moduleClass: MossTTSNanoNode,
    capabilities: { voiceCloning: true, languageSelection: true, gpuAcceleration: true, sampleRate: 48000, channels: 2, maxReferenceSeconds: 12 },
    defaultVoice: 'Junhao',
    defaultLanguage: 'zh'
  }
];
const modules = new Map();

function getDefinition(modelId) {
  return definitions.find((entry) => entry.id === modelId) || definitions[0];
}

function getModule(modelId) {
  const definition = getDefinition(modelId);
  if (!modules.has(definition.id)) modules.set(definition.id, new definition.moduleClass());
  return { definition, module: modules.get(definition.id) };
}

function modelInfo(definition, module) {
  return {
    id: definition.id,
    name: definition.name,
    description: definition.description,
    capabilities: definition.capabilities,
    defaultVoice: definition.defaultVoice,
    defaultLanguage: definition.defaultLanguage,
    languages: module && typeof module.listLanguages === 'function' ? module.listLanguages() : [],
    voices: module ? module.listVoices(definition.defaultLanguage) : []
  };
}

async function main() {
  for (const definition of definitions) getModule(definition.id);
  const models = definitions.map((definition) => modelInfo(definition, modules.get(definition.id)));
  emit({ event: 'ready', model: 'hotanvoice-multi-model', moduleName: 'Ho Tan Voice Model Registry', models, defaultModel: definitions[0].id, voices: models[0].voices });
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const raw of input) {
    if (!raw.trim()) continue;
    let request;
    try {
      request = JSON.parse(raw);
      if (request.action === 'list_models') {
        emit({ id: request.id, ok: true, models: definitions.map((definition) => modelInfo(definition, modules.get(definition.id))) });
      } else if (request.action === 'list_voices') {
        const { definition, module } = getModule(request.modelId);
        emit({ id: request.id, ok: true, voices: module.listVoices(request.language || definition.defaultLanguage), model: definition.id, language: request.language || definition.defaultLanguage });
      } else if (request.action === 'preview_voice') {
        const { definition, module } = getModule(request.modelId);
        if (request.voice === 'clone') throw new Error('Không thể preview voice clone khi chưa có audio tham chiếu.');
        const result = await module.previewVoice(String(request.voice || definition.defaultVoice), status, { language: request.language || definition.defaultLanguage, useGpu: Boolean(request.useGpu) });
        emit({ id: request.id, ok: true, modelLabel: definition.name, ...result });
      } else if (request.action === 'generate') {
        const { definition, module } = getModule(request.modelId);
        const result = await module.generate(
          String(request.text || ''),
          String(request.voice || definition.defaultVoice),
          Number(request.speed || 1),
          Number(request.crossfadeMs ?? 50),
          status,
          {
            modelId: definition.id,
            refAudioPath: request.refAudioPath ? String(request.refAudioPath) : undefined,
            temperature: request.temperature,
            topK: request.topK,
            topP: request.topP,
            maxNewFrames: request.maxNewFrames,
            repetitionPenalty: request.repetitionPenalty,
            repetitionWindow: request.repetitionWindow,
            language: request.language || definition.defaultLanguage,
            useGpu: Boolean(request.useGpu)
          }
        );
        emit({ id: request.id, ok: true, modelLabel: definition.name, ...result });
      } else {
        throw new Error(`Action không được hỗ trợ: ${request.action}`);
      }
    } catch (error) {
      emit({ id: request && request.id, ok: false, error: error.message || String(error), stack: error.stack });
    }
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});

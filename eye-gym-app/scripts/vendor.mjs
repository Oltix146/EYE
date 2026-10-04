// Кладёт рядом со страницей всё, что нужно распознаванию лица, чтобы приложение работало без интернета:
//   www/vendor/tasks-vision/vision_bundle.js  — библиотека MediaPipe (из npm-пакета @mediapipe/tasks-vision)
//   www/vendor/tasks-vision/wasm/*            — её WebAssembly-файлы
//   www/vendor/face_landmarker.task           — модель лица (скачивается с серверов Google один раз при сборке)
//   www/vendor/manifest.json                  — по нему страница понимает, что всё лежит локально
import { mkdir, copyFile, readdir, readFile, writeFile, stat, rm, rename } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'www', 'vendor');
const PKG = path.join(ROOT, 'node_modules', '@mediapipe', 'tasks-vision');
const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
const MODEL_FILE = path.join(OUT, 'face_landmarker.task');
const MIN_MODEL_BYTES = 1_000_000;

const exists = async p => { try{ await stat(p); return true; } catch { return false; } };
const fail = msg => { console.error('\n✖ ' + msg + '\n'); process.exit(1); };

async function copyTasksVision(){
  if (!(await exists(PKG))) fail('Нет пакета @mediapipe/tasks-vision. Сначала выполните: npm install');
  const { version } = JSON.parse(await readFile(path.join(PKG, 'package.json'), 'utf8'));
  const bundle = path.join(PKG, 'vision_bundle.mjs');
  if (!(await exists(bundle))) fail(`В @mediapipe/tasks-vision ${version} нет vision_bundle.mjs. Файлы пакета: ${(await readdir(PKG)).join(', ')}`);
  const dest = path.join(OUT, 'tasks-vision');
  await rm(dest, { recursive: true, force: true });
  await mkdir(path.join(dest, 'wasm'), { recursive: true });
  // .js вместо .mjs: такой файл любой сервер (и WebView на Android) отдаёт с правильным типом для import()
  await copyFile(bundle, path.join(dest, 'vision_bundle.js'));
  const wasmDir = path.join(PKG, 'wasm');
  const wasmFiles = (await readdir(wasmDir)).filter(f => /\.(js|wasm)$/.test(f));
  if (!wasmFiles.some(f => f.endsWith('.wasm'))) fail('В @mediapipe/tasks-vision/wasm нет файлов .wasm');
  for (const f of wasmFiles) await copyFile(path.join(wasmDir, f), path.join(dest, 'wasm', f));
  console.log(`✔ MediaPipe tasks-vision ${version}: vision_bundle.js + ${wasmFiles.length} файла wasm`);
  return version;
}

async function downloadModel(){
  if ((await exists(MODEL_FILE)) && (await stat(MODEL_FILE)).size > MIN_MODEL_BYTES){
    console.log('✔ Модель лица уже скачана');
    return;
  }
  let lastError;
  for (let attempt = 1; attempt <= 4; attempt++){
    try{
      const res = await fetch(MODEL_URL);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < MIN_MODEL_BYTES) throw new Error(`слишком маленький файл (${buf.length} байт)`);
      await writeFile(MODEL_FILE + '.part', buf);
      await rename(MODEL_FILE + '.part', MODEL_FILE);
      console.log(`✔ Модель лица скачана: ${(buf.length / 1e6).toFixed(1)} МБ`);
      return;
    } catch (e){
      lastError = e;
      console.warn(`  попытка ${attempt}: не удалось скачать модель (${e.message})`);
      await new Promise(r => setTimeout(r, attempt * 3000));
    }
  }
  fail(`Не удалось скачать модель лица с ${MODEL_URL}: ${lastError && lastError.message}`);
}

await mkdir(OUT, { recursive: true });
const version = await copyTasksVision();
await downloadModel();
await writeFile(path.join(OUT, 'manifest.json'), JSON.stringify({
  tasksVision: version,
  module: 'tasks-vision/vision_bundle.js',
  wasm: 'tasks-vision/wasm',
  model: 'face_landmarker.task',
}, null, 2));
console.log('✔ www/vendor готов');

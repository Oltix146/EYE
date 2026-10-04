// Дописывает в проект Android (его создаёт `npx cap add android`) то, чего нет в шаблоне Capacitor:
//   • разрешения на камеру, уведомления и точные будильники в AndroidManifest.xml;
//   • постоянный ключ подписи в android/app/build.gradle;
//   • значок уведомления ic_stat_eye (белый глаз) — Android рисует его в строке состояния.
// Скрипт можно запускать повторно: уже добавленное он не дублирует.
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAIN = path.join(ROOT, 'android', 'app', 'src', 'main');
const MANIFEST = path.join(MAIN, 'AndroidManifest.xml');

try{ await stat(MANIFEST); }
catch { console.error('✖ Нет android/app/src/main/AndroidManifest.xml. Сначала выполните: npx cap add android'); process.exit(1); }

let xml = await readFile(MANIFEST, 'utf8');
const additions = [
  '<uses-permission android:name="android.permission.CAMERA" />',
  '<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />',
  // точные будильники: без них Android 12+ сдвигает напоминания на десятки минут
  '<uses-permission android:name="android.permission.SCHEDULE_EXACT_ALARM" />',
  '<uses-permission android:name="android.permission.USE_EXACT_ALARM" />',
  '<uses-feature android:name="android.hardware.camera" android:required="false" />',
  '<uses-feature android:name="android.hardware.camera.front" android:required="false" />',
];
const missing = additions.filter(line => !xml.includes(line.match(/android:name="([^"]+)"/)[0]));
if (missing.length){
  const at = xml.lastIndexOf('</manifest>');
  if (at < 0){ console.error('✖ В AndroidManifest.xml не найден </manifest>'); process.exit(1); }
  xml = xml.slice(0, at) + '\n    <!-- Гимнастика для глаз -->\n' + missing.map(l => '    ' + l).join('\n') + '\n' + xml.slice(at);
  await writeFile(MANIFEST, xml);
}
console.log(missing.length ? `✔ AndroidManifest.xml: добавлено ${missing.length}` : '✔ AndroidManifest.xml уже готов');

// Постоянный ключ подписи. Каждая сборка на GitHub идёт на новой машине, и без этого у каждого APK была бы своя подпись —
// Android не дал бы поставить новую версию поверх старой (пришлось бы удалять приложение вместе с рейтингом).
const GRADLE = path.join(ROOT, 'android', 'app', 'build.gradle');
const MARK = '// eye-gym: постоянный ключ подписи';
let gradle = await readFile(GRADLE, 'utf8');
if (!gradle.includes(MARK)){
  gradle += `
${MARK}
android {
    signingConfigs {
        debug {
            storeFile file("\${rootDir}/../android-signing/debug.keystore")
            storePassword "android"
            keyAlias "androiddebugkey"
            keyPassword "android"
        }
    }
}
`;
  await writeFile(GRADLE, gradle);
  console.log('✔ build.gradle: ключ подписи android-signing/debug.keystore');
} else console.log('✔ build.gradle уже настроен');

// Значок для строки состояния: белый силуэт глаза на прозрачном фоне.
const drawableDir = path.join(MAIN, 'res', 'drawable');
await mkdir(drawableDir, { recursive: true });
await writeFile(path.join(drawableDir, 'ic_stat_eye.xml'), `<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="24dp" android:height="24dp" android:viewportWidth="24" android:viewportHeight="24">
    <path android:fillColor="#FFFFFFFF"
        android:pathData="M12,4.5C7,4.5 2.73,7.61 1,12c1.73,4.39 6,7.5 11,7.5s9.27,-3.11 11,-7.5c-1.73,-4.39 -6,-7.5 -11,-7.5zM12,17c-2.76,0 -5,-2.24 -5,-5s2.24,-5 5,-5 5,2.24 5,5 -2.24,5 -5,5zM12,9c-1.66,0 -3,1.34 -3,3s1.34,3 3,3 3,-1.34 3,-3 -1.34,-3 -3,-3z" />
</vector>
`);
console.log('✔ Значок уведомлений ic_stat_eye');

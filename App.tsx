import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  PermissionsAndroid,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as SecureStore from 'expo-secure-store';

type QueuedImage = {
  id: string;
  base64: string;
  mimeType: string;
};

const KEY_BACKEND = 'picture_to_sms_backend_url';
const KEY_BEARER = 'picture_to_sms_bearer';
const KEY_PHONE = 'picture_to_sms_phone';

const DEFAULT_PROMPT =
  'Describe what you see in this image clearly and concisely. The reply will be sent by SMS, so be direct and avoid markdown.';
const QCM_PROMPT = `You are reading a multiple-choice exam (QCM) from the attached image. Your job is to OCR and reason accurately.

How to read the image:
- Read top-to-bottom, left-to-right.
- **Question numbers (critical):** Use the **number printed on the exam next to each question** as JSON field **q** and in the compact SMS string. Example: if the sheet shows questions **37**, **38**, **39**, then use **q** values 37, 38, 39 and compact like **37A-38B-39S**—do **not** renumber them as 1, 2, 3. Only if a question has **no visible printed number**, assign **q** in order starting at 1 for those items only.
- **Image quality:** The photo may be blurry, too dark, too bright, glare, motion blur, low resolution, or cropped so text is hard to read. When **the image itself** does not let you read a question or its options reliably for that item, treat it as not clear enough—**do not guess A–E**; use **S** (skip) for that question number.
- Transcribe each question stem exactly as printed (fix obvious OCR typos only if meaning is clear).
- For each question, identify every answer choice. If the sheet uses numbers (1)(2)(3)(4), bullets, or symbols instead of letters, map them in order to labels A, B, C, D (and E only if a fifth option is clearly present). Always output choices with letter labels A, B, C, D in that order for the first four options.
- Copy each choice’s text faithfully under the correct letter.

How to choose the answer field a:
- Pick exactly one letter per question: the best answer or the one you would mark on the form. Use only A, B, C, D, or E (E only when a fifth option exists).
- If you **cannot read** the stem or choices well enough because of **bad image quality** (blur, lighting, resolution, crop, glare, etc.), or the wording is **ambiguous or cut off**, **do not guess**. Use **S** (skipped) for that question: in JSON set field **a** to **S** (skip). In the compact SMS string that is **printedQuestionNumber + S** (e.g. sheet question **37** unclear → **37S**). Never output a random A–E when you are not confident.

Compact answer key (required meaning of your choices):
- For each question, options are A, B, C, D (and E if applicable), or **S** when skipped. Sort by **printed q** ascending, then join each pair **questionNumber + letter** with '-' and no spaces (e.g. **37A-38B-39S**).
- Example with printed numbers: **37A-38B-39S** means sheet Q37→A, Q38→B, Q39 skipped. Example when sheet uses 1,2,3: **1B-2D-3A** means Q1→B, Q2→D, Q3→A.
- Your JSON must match this encoding: sort "answers" by **q** ascending, then joining each **q + a** pair with '-' produces the compact string (multi-digit **q** is allowed).

Output rules:
- Return a single JSON object only. No markdown, no code fences, no commentary before or after.
- Use this schema (all keys lowercase); **q** is the **printed** question number when visible (example 37), otherwise 1-based order among unnumbered items:
{"total_questions":NUMBER,"answers":[{"q":37,"question":"STEM","choices":[{"label":"A","text":"..."},{"label":"B","text":"..."},{"label":"C","text":"..."},{"label":"D","text":"..."}],"a":"A"}, ...]}
- Include a choices array for every question when options are legible; each item must have label (A–D or A–E) and text (the option wording). If the question is skipped (a equals S), choices may be an empty array [] or best-effort partial text—do not invent fake options.
- "total_questions" must equal the length of "answers". Each **q** must be a **positive integer** matching the sheet when possible; **no duplicate q**. **a** must be one of A/B/C/D/E (matching an existing label when not skipped) or **S** when skipped.`;

function getBackendCandidates(raw: string): string[] {
  const base = raw.trim().replace(/\/+$/, '');
  if (!base) return [];
  if (base.startsWith('http://') || base.startsWith('https://')) {
    return [base];
  }
  return [`https://${base}`, `http://${base}`];
}

async function callBackendAnalyze(
  backendBaseUrl: string,
  bearerToken: string | null,
  toPhoneNumber: string,
  base64: string,
  mimeType: string,
  userPrompt: string,
  qcmMode: boolean
): Promise<{ text: string; smsBody?: string }> {
  const candidates = getBackendCandidates(backendBaseUrl);
  if (!candidates.length) {
    throw new Error('Backend URL is empty.');
  }
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (bearerToken?.trim()) {
    headers.Authorization = `Bearer ${bearerToken.trim()}`;
  }
  let lastNetworkError: string | null = null;

  for (const candidate of candidates) {
    const url = `${candidate}/v1/analyze`;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          toPhoneNumber,
          imageBase64: base64,
          mimeType,
          prompt: userPrompt.trim() || DEFAULT_PROMPT,
          qcmMode,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg =
          (json as { error?: string })?.error ||
          `Backend request failed (${res.status})`;
        throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
      }
      const text = (json as { text?: string })?.text;
      const smsBody = (json as { smsBody?: string })?.smsBody;
      if (!text || typeof text !== 'string') {
        throw new Error('Invalid response from backend.');
      }
      return { text: text.trim(), smsBody };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        message.includes('Network request failed') ||
        message.includes('Failed to fetch')
      ) {
        lastNetworkError = message;
        continue;
      }
      throw error;
    }
  }

  throw new Error(
    `Could not reach backend. Tried: ${candidates.join(
      ', '
    )}. Make sure URL is public and reachable from phone. ${lastNetworkError ?? ''}`.trim()
  );
}

function sendDirectSmsAndroid(to: string, body: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const SmsAndroid = require('react-native-sms-android');
    SmsAndroid.sms(
      to,
      body,
      'sendDirect',
      (err: unknown, message: string) => {
        if (err) {
          reject(new Error(typeof err === 'string' ? err : 'Failed to send SMS'));
          return;
        }
        if (typeof message === 'string' && message.toLowerCase().includes('cancel')) {
          reject(new Error('SMS sending was cancelled'));
          return;
        }
        resolve();
      }
    );
  });
}

function newImageId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export default function App() {
  const [backendUrl, setBackendUrl] = useState('');
  const [bearerToken, setBearerToken] = useState('');
  const [phone, setPhone] = useState('');
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [qcmMode, setQcmMode] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [imageQueue, setImageQueue] = useState<QueuedImage[]>([]);
  const [lastSmsResults, setLastSmsResults] = useState<string[]>([]);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const cameraRef = useRef<CameraView | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const [b, t, p] = await Promise.all([
          SecureStore.getItemAsync(KEY_BACKEND),
          SecureStore.getItemAsync(KEY_BEARER),
          SecureStore.getItemAsync(KEY_PHONE),
        ]);
        if (b) setBackendUrl(b);
        if (t) setBearerToken(t);
        if (p) setPhone(p);
      } catch {
        // SecureStore can fail on web / simulators
      }
    })();
  }, []);

  const persistSettings = useCallback(async () => {
    try {
      if (backendUrl.trim()) await SecureStore.setItemAsync(KEY_BACKEND, backendUrl.trim());
      await SecureStore.setItemAsync(KEY_BEARER, bearerToken.trim());
      if (phone.trim()) await SecureStore.setItemAsync(KEY_PHONE, phone.trim());
    } catch {
      Alert.alert('Storage', 'Could not save settings on this device.');
    }
  }, [backendUrl, bearerToken, phone]);

  const requireAndroidAndSettings = useCallback(() => {
    if (!backendUrl.trim()) {
      Alert.alert('Backend URL', 'Enter your deployed API URL (see server folder).');
      return null;
    }
    const digits = phone.replace(/\D/g, '');
    if (digits.length < 8) {
      Alert.alert('Phone number', 'Enter a valid phone number including country code.');
      return null;
    }
    if (Platform.OS !== 'android') {
      Alert.alert('Android only', 'Direct automatic SMS is supported only on Android.');
      return null;
    }
    return phone.trim();
  }, [backendUrl, phone]);

  const openMultiCaptureCamera = useCallback(async () => {
    const normalized = requireAndroidAndSettings();
    if (!normalized) return;

    const granted = cameraPermission?.granted
      ? true
      : (await requestCameraPermission()).granted;
    if (!granted) {
      Alert.alert('Camera', 'Camera permission is required to take pictures.');
      return;
    }

    setStatus('Camera ready. Tap Capture repeatedly, then Done.');
    setCameraOpen(true);
  }, [requireAndroidAndSettings, cameraPermission?.granted, requestCameraPermission]);

  const captureInCamera = useCallback(async () => {
    if (!cameraRef.current) return;
    try {
      const shot = await cameraRef.current.takePictureAsync({
        base64: true,
        quality: 0.75,
      });
      const b64 = shot.base64;
      if (!b64) {
        throw new Error('Could not read image data. Try again.');
      }

      const mime = 'image/jpeg';
      const item: QueuedImage = { id: newImageId(), base64: b64, mimeType: mime };
      setImageQueue((q) => [...q, item]);
      setStatus('Captured. Keep tapping Capture for next pages, then Done.');
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setStatus(`Error: ${message}`);
      Alert.alert('Capture failed', message);
    }
  }, []);

  const closeCamera = useCallback(() => {
    setCameraOpen(false);
    if (imageQueue.length > 0) {
      setStatus(`Captured ${imageQueue.length} photo(s). Press Send all.`);
    } else {
      setStatus('No photo captured.');
    }
  }, [imageQueue.length]);

  const clearQueue = useCallback(() => {
    setImageQueue([]);
    setStatus('Queue cleared.');
    setLastSmsResults([]);
  }, []);

  const sendAllFromQueue = useCallback(async () => {
    const normalized = requireAndroidAndSettings();
    if (!normalized) return;

    let pending = [...imageQueue];
    if (pending.length === 0) {
      Alert.alert('No photos', 'Take one or more photos before pressing Send all.');
      return;
    }

    const totalPlanned = pending.length;
    setBusy(true);
    setLastSmsResults([]);
    await persistSettings();

    const effectivePrompt = qcmMode ? QCM_PROMPT : prompt;
    const sentBodies: string[] = [];

    try {
      const granted = await PermissionsAndroid.request(
        PermissionsAndroid.PERMISSIONS.SEND_SMS
      );
      if (granted !== PermissionsAndroid.RESULTS.GRANTED) {
        throw new Error('SEND_SMS permission denied.');
      }

      while (pending.length > 0) {
        const [current, ...rest] = pending;
        const idx = sentBodies.length + 1;
        setStatus(`Analyzing photo ${idx} of ${totalPlanned}…`);

        const backendResult = await callBackendAnalyze(
          backendUrl,
          bearerToken || null,
          normalized,
          current.base64,
          current.mimeType,
          effectivePrompt,
          qcmMode
        );

        const smsBody = (backendResult.smsBody || backendResult.text)?.trim();
        if (!smsBody) {
          throw new Error(`Backend returned no SMS content for photo ${idx}.`);
        }

        setStatus(`Sending SMS ${idx} of ${totalPlanned}…`);
        await sendDirectSmsAndroid(normalized, smsBody);
        sentBodies.push(smsBody);

        pending = rest;
        setImageQueue(pending);
      }

      setLastSmsResults(sentBodies);
      setStatus(`Done. Sent ${sentBodies.length} SMS (one per photo).`);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setImageQueue(pending);
      setLastSmsResults(sentBodies);
      if (sentBodies.length > 0) {
        setStatus(`Error after ${sentBodies.length} of ${totalPlanned} SMS: ${message}`);
      } else {
        setStatus(`Error: ${message}`);
      }
      Alert.alert('Something went wrong', message);
    } finally {
      setBusy(false);
    }
  }, [
    requireAndroidAndSettings,
    imageQueue,
    backendUrl,
    bearerToken,
    prompt,
    qcmMode,
    persistSettings,
  ]);

  if (cameraOpen) {
    return (
      <View style={styles.cameraRoot}>
        <CameraView ref={cameraRef} style={styles.cameraView} facing="back" />
        <View style={styles.cameraOverlay}>
          <Text style={styles.cameraHint}>
            {imageQueue.length} photo(s) captured. Tap Capture again for next page, then Done.
          </Text>
          <View style={styles.row}>
            <Pressable style={styles.secondaryBtn} onPress={closeCamera}>
              <Text style={styles.secondaryBtnText}>Done</Text>
            </Pressable>
            <Pressable style={[styles.button, styles.secondaryBtnRight]} onPress={captureInCamera}>
              <Text style={styles.buttonText}>Capture</Text>
            </Pressable>
          </View>
        </View>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        contentContainerStyle={styles.scroll}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={styles.title}>Picture → OpenRouter → SMS</Text>
        <Text style={styles.sub}>
          Take several photos (each opens the camera), then tap Send all. Your server analyzes each image; you
          receive one SMS per photo.
        </Text>

        <Text style={styles.label}>Backend API URL</Text>
        <TextInput
          style={styles.input}
          value={backendUrl}
          onChangeText={setBackendUrl}
          placeholder="https://your-app.up.railway.app"
          placeholderTextColor="#94a3b8"
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
        />

        <Text style={styles.label}>App secret</Text>
        <TextInput
          style={styles.input}
          value={bearerToken}
          onChangeText={setBearerToken}
          placeholder="Leave blank if server has no CLIENT_BEARER_TOKEN"
          placeholderTextColor="#94a3b8"
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry
        />
        <Text style={styles.hint}>
          If Vercel/Railway has CLIENT_BEARER_TOKEN set, enter the exact same value here (required). If the
          variable is unset or empty on the server, leave this blank.
        </Text>

        <Text style={styles.label}>SMS recipient (include country code)</Text>
        <TextInput
          style={styles.input}
          value={phone}
          onChangeText={setPhone}
          placeholder="+1 555 123 4567"
          placeholderTextColor="#94a3b8"
          keyboardType="phone-pad"
        />

        <Text style={styles.label}>Prompt for the model</Text>
        <TextInput
          style={[styles.input, styles.prompt]}
          value={prompt}
          onChangeText={setPrompt}
          multiline
          editable={!qcmMode}
        />
        <Pressable
          style={({ pressed }) => [
            styles.qcmButton,
            qcmMode && styles.qcmButtonActive,
            pressed && styles.buttonPressed,
          ]}
          onPress={() => setQcmMode((v) => !v)}
        >
          <Text style={styles.qcmButtonText}>QCM {qcmMode ? 'ON' : 'OFF'}</Text>
        </Pressable>

        <Text style={styles.label}>Photo queue</Text>
        <Text style={styles.queueHint}>
          {imageQueue.length === 0
            ? 'No photos yet. Open camera, capture pages continuously, then tap Done.'
            : `${imageQueue.length} photo(s) ready — tap Send all when finished.`}
        </Text>

        <View style={styles.row}>
          <Pressable
            style={({ pressed }) => [
              styles.secondaryBtn,
              pressed && styles.buttonPressed,
              busy && styles.buttonDisabled,
            ]}
            onPress={openMultiCaptureCamera}
            disabled={busy}
          >
            <Text style={styles.secondaryBtnText}>Open camera</Text>
          </Pressable>
          <Pressable
            style={({ pressed }) => [
              styles.secondaryBtn,
              styles.secondaryBtnRight,
              pressed && styles.buttonPressed,
              (busy || imageQueue.length === 0) && styles.buttonDisabled,
            ]}
            onPress={clearQueue}
            disabled={busy || imageQueue.length === 0}
          >
            <Text style={styles.secondaryBtnText}>Clear queue</Text>
          </Pressable>
        </View>

        <Pressable
          style={({ pressed }) => [
            styles.button,
            pressed && styles.buttonPressed,
            (busy || imageQueue.length === 0) && styles.buttonDisabled,
          ]}
          onPress={sendAllFromQueue}
          disabled={busy || imageQueue.length === 0}
        >
          {busy ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.buttonText}>
              Send all{imageQueue.length > 0 ? ` (${imageQueue.length})` : ''}
            </Text>
          )}
        </Pressable>

        {status ? <Text style={styles.status}>{status}</Text> : null}
        {lastSmsResults.length > 0 ? (
          <View style={styles.answerBox}>
            <Text style={styles.answerLabel}>Last batch (one SMS per photo)</Text>
            {lastSmsResults.map((body, i) => (
              <Text key={`sms-result-${i}`} style={styles.answerLine}>
                {i + 1}. {body}
              </Text>
            ))}
          </View>
        ) : null}

        <Text style={styles.note}>
          Deploy the backend with OPENROUTER_API_KEY plus optional OPENROUTER_API_KEY_2, OPENROUTER_API_KEY_3,
          OPENROUTER_API_KEY_4, then GEMINI_API_KEY with optional GEMINI_API_KEY_2, GEMINI_API_KEY_3,
          GEMINI_API_KEY_4 (tried in order). On Android,
          each photo triggers one analyze request and one SMS.
        </Text>
      </ScrollView>
      <StatusBar style="light" />
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  cameraRoot: {
    flex: 1,
    backgroundColor: '#000',
  },
  cameraView: {
    flex: 1,
  },
  cameraOverlay: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    padding: 16,
    backgroundColor: 'rgba(15,23,42,0.88)',
  },
  cameraHint: {
    color: '#e2e8f0',
    fontSize: 14,
    lineHeight: 20,
    marginBottom: 10,
  },
  root: {
    flex: 1,
    backgroundColor: '#0f172a',
  },
  scroll: {
    padding: 20,
    paddingTop: 56,
    paddingBottom: 32,
  },
  title: {
    fontSize: 22,
    fontWeight: '700',
    color: '#f8fafc',
    marginBottom: 8,
  },
  sub: {
    fontSize: 15,
    color: '#94a3b8',
    marginBottom: 24,
    lineHeight: 22,
  },
  label: {
    fontSize: 13,
    fontWeight: '600',
    color: '#cbd5e1',
    marginBottom: 6,
    marginTop: 12,
  },
  hint: {
    fontSize: 12,
    color: '#64748b',
    lineHeight: 18,
    marginTop: 6,
    marginBottom: 4,
  },
  input: {
    backgroundColor: '#1e293b',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
    color: '#f1f5f9',
    borderWidth: 1,
    borderColor: '#334155',
  },
  prompt: {
    minHeight: 100,
    textAlignVertical: 'top',
  },
  row: {
    flexDirection: 'row',
    marginTop: 12,
  },
  secondaryBtn: {
    flex: 1,
    backgroundColor: '#334155',
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#475569',
  },
  secondaryBtnRight: {
    marginLeft: 10,
  },
  secondaryBtnText: {
    color: '#f1f5f9',
    fontSize: 15,
    fontWeight: '600',
  },
  queueHint: {
    fontSize: 13,
    color: '#94a3b8',
    lineHeight: 20,
    marginTop: 4,
  },
  button: {
    marginTop: 28,
    backgroundColor: '#2563eb',
    paddingVertical: 16,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  qcmButton: {
    marginTop: 12,
    backgroundColor: '#334155',
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  qcmButtonActive: {
    backgroundColor: '#0ea5e9',
  },
  qcmButtonText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
  },
  buttonPressed: {
    opacity: 0.9,
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  buttonText: {
    color: '#fff',
    fontSize: 17,
    fontWeight: '600',
  },
  status: {
    marginTop: 20,
    fontSize: 15,
    color: '#e2e8f0',
    lineHeight: 22,
  },
  note: {
    marginTop: 28,
    fontSize: 12,
    color: '#64748b',
    lineHeight: 18,
  },
  answerBox: {
    marginTop: 16,
    backgroundColor: '#0b1220',
    borderColor: '#334155',
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
  },
  answerLabel: {
    color: '#94a3b8',
    fontSize: 12,
    marginBottom: 6,
  },
  answerText: {
    color: '#f8fafc',
    fontSize: 22,
    fontWeight: '700',
    letterSpacing: 1,
  },
  answerLine: {
    color: '#f8fafc',
    fontSize: 17,
    fontWeight: '600',
    marginTop: 8,
    lineHeight: 24,
  },
});

import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useState } from 'react';
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
import * as ImagePicker from 'expo-image-picker';
import * as SecureStore from 'expo-secure-store';

const KEY_BACKEND = 'picture_to_sms_backend_url';
const KEY_BEARER = 'picture_to_sms_bearer';
const KEY_PHONE = 'picture_to_sms_phone';

const DEFAULT_PROMPT =
  'Describe what you see in this image clearly and concisely. The reply will be sent by SMS, so be direct and avoid markdown.';
const QCM_PROMPT = `You are reading a multiple-choice exam (QCM) from the attached image. Your job is to OCR and reason accurately.

How to read the image:
- Read top-to-bottom, left-to-right. Follow the numbering printed on the sheet (1, 2, 3…). If numbers are missing, number questions in visible order starting at 1.
- Transcribe each question stem exactly as printed (fix obvious OCR typos only if meaning is clear).
- For each question, identify every answer choice. If the sheet uses numbers (1)(2)(3)(4), bullets, or symbols instead of letters, map them in order to labels A, B, C, D (and E only if a fifth option is clearly present). Always output choices with letter labels A, B, C, D in that order for the first four options.
- Copy each choice’s text faithfully under the correct letter.

How to choose "a":
- Pick exactly one letter per question: the best answer or the one you would mark on the form. Use only A, B, C, D, or E (E only when a fifth option exists).

Compact answer key (required meaning of your choices):
- Number questions 1, 2, 3, 4, … in order. For each question, options are A, B, C, D (and E if applicable).
- The full solution must be expressible as one continuous string: each question contributes its number immediately followed by its chosen letter, with no spaces or separators between questions.
- Example: 1B2D3A means question 1 → answer B, question 2 → answer D, question 3 → answer A. Another example: 1A2A3C4B for four questions.
- Your JSON must match this encoding: if you list "answers" sorted by "q" ascending (1, then 2, then 3, …), then concatenating each pair q+a (as digits + single letter) must produce exactly that compact string.

Output rules:
- Return a single JSON object only. No markdown, no code fences, no commentary before or after.
- Use this schema (all keys lowercase):
{"total_questions":<number>,"answers":[{"q":1,"question":"<stem text>","choices":[{"label":"A","text":"<option A>"},{"label":"B","text":"<option B>"},{"label":"C","text":"<option C>"},{"label":"D","text":"<option D>"}],"a":"A"}, ...]}
- Include a "choices" array for every question; each item must have "label" (A–D or A–E) and "text" (the option wording). Labels must be uppercase letters.
- "total_questions" must equal the length of "answers". "q" must run 1,2,3… with no gaps. "a" must be one of A/B/C/D/E matching an existing label for that question.`;

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

export default function App() {
  const [backendUrl, setBackendUrl] = useState('');
  const [bearerToken, setBearerToken] = useState('');
  const [phone, setPhone] = useState('');
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [qcmMode, setQcmMode] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [lastSmsBody, setLastSmsBody] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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

  const runFlow = useCallback(async () => {
    if (!backendUrl.trim()) {
      Alert.alert('Backend URL', 'Enter your deployed API URL (see server folder).');
      return;
    }
    const digits = phone.replace(/\D/g, '');
    if (digits.length < 8) {
      Alert.alert('Phone number', 'Enter a valid phone number including country code.');
      return;
    }
    const normalized = phone.trim();
    if (Platform.OS !== 'android') {
      Alert.alert('Android only', 'Direct automatic SMS is supported only on Android.');
      return;
    }

    setBusy(true);
    setLastSmsBody(null);
    setStatus('Opening camera…');
    try {
      const cam = await ImagePicker.requestCameraPermissionsAsync();
      if (!cam.granted) {
        Alert.alert('Camera', 'Camera permission is required to take a picture.');
        setStatus(null);
        return;
      }

      const picked = await ImagePicker.launchCameraAsync({
        mediaTypes: ['images'],
        allowsEditing: false,
        quality: 0.75,
        base64: true,
      });

      if (picked.canceled || !picked.assets?.[0]) {
        setStatus('Cancelled.');
        return;
      }

      const asset = picked.assets[0];
      const b64 = asset.base64;
      if (!b64) {
        throw new Error('Could not read image data. Try again or lower quality in code.');
      }

      const mime = asset.mimeType || 'image/jpeg';
      await persistSettings();

      setStatus('Sending image to your backend…');
      const effectivePrompt = qcmMode ? QCM_PROMPT : prompt;
      const backendResult = await callBackendAnalyze(
        backendUrl,
        bearerToken || null,
        normalized,
        b64,
        mime,
        effectivePrompt,
        qcmMode
      );

      const smsBody = backendResult.smsBody || backendResult.text;
      if (!smsBody?.trim()) {
        throw new Error('Backend returned no SMS content.');
      }
      const normalizedSmsBody = smsBody.trim();
      setLastSmsBody(normalizedSmsBody);

      const granted = await PermissionsAndroid.request(
        PermissionsAndroid.PERMISSIONS.SEND_SMS
      );
      if (granted !== PermissionsAndroid.RESULTS.GRANTED) {
        throw new Error('SEND_SMS permission denied.');
      }

      setStatus(`Answer ready: ${normalizedSmsBody}\nSending SMS automatically on Android…`);
      await sendDirectSmsAndroid(normalized, normalizedSmsBody);
      setStatus('Done. SMS sent automatically.');
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setStatus(`Error: ${message}`);
      Alert.alert('Something went wrong', message);
    } finally {
      setBusy(false);
    }
  }, [backendUrl, bearerToken, phone, prompt, qcmMode, persistSettings]);

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
          Photo is analyzed on your server (OpenRouter key stays there). Result is sent by SMS.
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

        <Pressable
          style={({ pressed }) => [styles.button, pressed && styles.buttonPressed, busy && styles.buttonDisabled]}
          onPress={runFlow}
          disabled={busy}
        >
          {busy ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.buttonText}>Take picture & run</Text>
          )}
        </Pressable>

        {status ? <Text style={styles.status}>{status}</Text> : null}
        {lastSmsBody ? (
          <View style={styles.answerBox}>
            <Text style={styles.answerLabel}>Answer to send</Text>
            <Text style={styles.answerText}>{lastSmsBody}</Text>
          </View>
        ) : null}

        <Text style={styles.note}>
          Deploy the backend with OPENROUTER_API_KEY plus optional OPENROUTER_API_KEY_2, OPENROUTER_API_KEY_3,
          OPENROUTER_API_KEY_4, then GEMINI_API_KEY with optional GEMINI_API_KEY_2, GEMINI_API_KEY_3,
          GEMINI_API_KEY_4 (tried in order). On Android,
          this app sends SMS directly after image analysis using SEND_SMS permission.
        </Text>
      </ScrollView>
      <StatusBar style="light" />
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
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
});

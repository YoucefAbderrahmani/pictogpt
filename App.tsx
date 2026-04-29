import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
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
import * as SMS from 'expo-sms';

const KEY_BACKEND = 'picture_to_sms_backend_url';
const KEY_BEARER = 'picture_to_sms_bearer';
const KEY_PHONE = 'picture_to_sms_phone';

const DEFAULT_PROMPT =
  'Describe what you see in this image clearly and concisely. The reply will be sent by SMS, so be direct and avoid markdown.';

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
  base64: string,
  mimeType: string,
  userPrompt: string
): Promise<string> {
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
          imageBase64: base64,
          mimeType,
          prompt: userPrompt.trim() || DEFAULT_PROMPT,
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
      if (!text || typeof text !== 'string') {
        throw new Error('Invalid response from backend.');
      }
      return text.trim();
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

export default function App() {
  const [backendUrl, setBackendUrl] = useState('');
  const [bearerToken, setBearerToken] = useState('');
  const [phone, setPhone] = useState('');
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [status, setStatus] = useState<string | null>(null);
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

    const smsOk = await SMS.isAvailableAsync();
    if (!smsOk) {
      Alert.alert(
        'SMS not available',
        'This device cannot send SMS (common on simulators or some tablets). Try a physical phone.'
      );
      return;
    }

    setBusy(true);
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
      const answer = await callBackendAnalyze(backendUrl, bearerToken || null, b64, mime, prompt);

      setStatus('Sending SMS…');
      const smsResult = await SMS.sendSMSAsync([normalized], answer);
      if (smsResult.result === 'sent') {
        setStatus('Done. Message sent.');
      } else {
        setStatus('SMS was not sent (cancelled or failed).');
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setStatus(`Error: ${message}`);
      Alert.alert('Something went wrong', message);
    } finally {
      setBusy(false);
    }
  }, [backendUrl, bearerToken, phone, prompt, persistSettings]);

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

        <Text style={styles.label}>App secret (optional, must match server)</Text>
        <TextInput
          style={styles.input}
          value={bearerToken}
          onChangeText={setBearerToken}
          placeholder="Same as CLIENT_BEARER_TOKEN on server"
          placeholderTextColor="#94a3b8"
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry
        />

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
        />

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

        <Text style={styles.note}>
          Deploy the server in the server folder, set OPENROUTER_API_KEY (and optional CLIENT_BEARER_TOKEN),
          then paste the public URL here. Settings are stored on this device only. Use a real phone for
          camera and SMS.
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
});

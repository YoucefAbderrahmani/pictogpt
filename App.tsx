import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  AppState,
  BackHandler,
  InteractionManager,
  KeyboardAvoidingView,
  Linking,
  Modal,
  PermissionsAndroid,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Camera, CameraView, useCameraPermissions } from 'expo-camera';
import Constants from 'expo-constants';
import * as ImageManipulator from 'expo-image-manipulator';
import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  presentAnswerNotification,
  requestAnswerNotificationPermission,
} from './lib/answerNotifications';
import { mergeQcmSmsBodyWithTailFromModel, MIN_QCM_PAIRS_ACCEPT } from './lib/qcmSmsFormat.js';

type QueuedImage = {
  id: string;
  mimeType: string;
  /** 1-based capture order (stable for outbound payload prefix). */
  photoSlot: number;
  /** Set when the image is already encoded for the API (rare direct path). */
  base64?: string;
  /** In-app camera temp file — compressed at Send all or when you tap Done. */
  pendingCamera?: { uri: string; width: number; height: number };
};

const KEY_BACKEND = 'picture_to_sms_backend_url';
const KEY_BEARER = 'picture_to_sms_bearer';
const KEY_PHONES = 'picture_to_sms_phones_v1';
const KEY_PHONE_LEGACY = 'picture_to_sms_phone';
const KEY_DEVICE_TAG = 'picture_to_sms_device_tag';
const KEY_TEAM_FEED_UNLOCKED = 'picture_to_sms_team_feed_unlocked';
/** Persisted after a successful admin login — device stays admin until cleared from SecureStore. */
const KEY_ADMIN_PASSWORD = 'picture_to_sms_admin_password_v1';
const KEY_LOBBY_RESET_ACK_NONCE = 'picture_to_sms_lobby_reset_ack_nonce_v1';
const KEY_NOTIFY_ONBOARDING = 'picture_to_sms_notify_onboarded_v1';
const SHARED_LOBBY_POLL_MS = 8000;
/** Shared lobby unlock: same threshold as server `MIN_QCM_PAIRS_ACCEPT` in lib/qcmSmsFormat.js. */
/** Legacy QCM lines: newline before a quoted tail after the compact key. */
const QCM_TAIL_GAP = '\n';
/** Compact QCM key only, e.g. `1A-2B-3S` or `37A-38B`. */
const COMPACT_QCM_BODY = /^(\d{1,6}[ABCDES])(-\d{1,6}[ABCDES])*$/i;

/** Extract compact key from SMS body (`q)stem …\\ncompact`, optional legacy `q)___…`, quoted tails, or plain compact). */
function extractQcmCompactFromSmsBody(smsBody: string): string | null {
  const t = String(smsBody || '').trim();
  const stemBlock = /^(\d{1,6}\)[^\r\n]*)\r?\n(((?:\d{1,6}[ABCDES])(?:-\d{1,6}[ABCDES])*))\s*$/i.exec(t);
  if (stemBlock) {
    const c = stemBlock[2].replace(/\s+/g, '');
    return COMPACT_QCM_BODY.test(c) ? c : null;
  }
  const legacy = /^"[^"]*"\s*__+\s*(.+)$/i.exec(t);
  if (legacy) {
    const c = legacy[1].trim().replace(/\s+/g, '');
    return COMPACT_QCM_BODY.test(c) ? c : null;
  }
  const collapsed = t.replace(/\s+/g, '');
  const neu = /^"[^"]*"\s*((\d{1,6}[ABCDES])(-\d{1,6}[ABCDES])*)$/i.exec(collapsed);
  if (neu) {
    const c = neu[1];
    return COMPACT_QCM_BODY.test(c) ? c : null;
  }
  let idx = t.search(/\r?\n\s*"/);
  if (idx < 0) idx = t.search(/\s{3,}"/);
  if (idx >= 0) {
    const head = t.slice(0, idx).trim().replace(/\s+/g, '');
    return COMPACT_QCM_BODY.test(head) ? head : null;
  }
  const plain = t.replace(/\s+/g, '');
  return COMPACT_QCM_BODY.test(plain) ? plain : null;
}

function looksLikeValidatedQcmCompact(smsBody: string): boolean {
  const compact = extractQcmCompactFromSmsBody(smsBody);
  if (!compact) return false;
  const parts = compact
    .split('-')
    .map((p) => p.trim().toUpperCase())
    .filter(Boolean);
  if (parts.length < MIN_QCM_PAIRS_ACCEPT) return false;
  const segment = /^\d{1,6}[ABCDES]$/;
  return parts.every((p) => segment.test(p));
}

/** First skipped analyze line in status bar (OpenRouter errors can be long). */
const FIRST_SKIP_STATUS_SNIP_LEN = 2000;

const KEY_RELAY_ENABLED = 'picture_to_sms_relay_enabled';
const KEY_RELAY_TO = 'picture_to_sms_relay_sms_to';
const AS_RELAY_SIGNATURES = 'picture_to_sms_relay_signatures_v1';
const DEFAULT_BACKEND_URL = 'https://pictogpt.vercel.app';
const RELAY_SIG_CAP = 400;
/** Bottom strip reserved for admin gesture; ScrollView uses marginBottom so touches reach this zone. */
const KNOCK_ZONE_HEIGHT = 80;
const SECRET_KNOCK_RESET_MS = 3500;
const SECRET_KNOCK_REQUIRED_TAPS = 15;

function newDeviceTag(): string {
  return `d_${Date.now()}_${Math.random().toString(36).slice(2, 14)}`;
}

function parsePhonesJson(raw: string | null): string[] {
  if (!raw?.trim()) return ['', '', '', ''];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return ['', '', '', ''];
    const four = ['', '', '', ''];
    for (let i = 0; i < 4; i += 1) {
      four[i] = typeof parsed[i] === 'string' ? (parsed[i] as string) : '';
    }
    return four;
  } catch {
    return ['', '', '', ''];
  }
}

function phoneSlotsHaveAnyValid(slots: string[]): boolean {
  return slots.some((p) => p.replace(/\D/g, '').length >= 8);
}

/** All filled destination slots (1–4), in order — each outbound page uses every entry. */
function allValidDestinations(slots: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < 4; i += 1) {
    const t = (slots[i] ?? '').trim();
    if (t.replace(/\D/g, '').length >= 8) out.push(t);
  }
  return out;
}

const DEFAULT_PROMPT =
  'Describe what you see in this image clearly and concisely. Keep the reply short and plain text (no markdown).';
const QCM_PROMPT = `You are reading a multiple-choice exam (QCM) from the attached image. Your job is to OCR, **detect each question and its answer options**, and output **one unified JSON format** so the compact key is always like **1A-2B-3C** (question number + letter, sorted by question number).

How to find questions and assign **q** (question number):
- Read top-to-bottom, left-to-right (or follow clear columns). Each **question** is a stem plus the set of choices that belong to it (same visual group: spacing, indentation, box, or column).
- **If the sheet prints a question number** next to or in the heading for that item (e.g. 37, Q5, “Question 12”), use that integer as **q**. Keep multi-page logic: do **not** renumber real printed numbers (e.g. 37, 38, 39 stay 37, 38, 39).
- **If a question has no printed number**, assign **q** from **reading order on this page/image only**: the first question you identify is **q=1**, the next is **q=2**, then **3**, and so on. When printed numbers resume later, switch back to printed values for those items.
- Stems may appear **above or below** the options, or options may be listed first (“reversed” layout). Use layout and grouping to decide which options belong to which stem—do not split one question across two **q** values.

How to find answers and normalize to **A B C D** (and **E** if needed):
- In JSON, every choice must use **label** A, B, C, D (and E only if a fifth option clearly exists on the sheet).
- **If the sheet already labels options A/B/C/D** (or a/b/c/d), keep that mapping: label A = first letter option, etc.
- **If options are not lettered** (numbered lines like 1- / 2-, (1) (2), bullets *, dashes -, roman numerals, etc.), **enumerate in reading order** within that question: **1st option → A**, **2nd → B**, **3rd → C**, **4th → D**, **5th → E**. Do **not** treat option prefixes (1-, 2-, *) as question numbers—those are almost always **choices** under the current stem.
- Store each choice **text** as the real wording (you may strip leading markers like “1-” or “*” from the stored text unless they are clearly part of the printed sentence).

Choosing **a** (the selected answer) and compact key:
- For each question pick exactly one of A/B/C/D/E that you would mark, or **S** if you must skip (illegible or ambiguous—do not guess A–E). Skipped items use **q** plus **S** in the compact string (e.g. **37S**).
- **Compact key (required):** sort **answers** by **q** ascending, then concatenate **q** immediately followed by **a** for each row, joined by **-** with no spaces. Examples: **1A-2B-3C**, **37A-38B-39S**. This is the only compact encoding.

Image quality:
- If blur, crop, glare, or resolution prevents reading a question or its options reliably, use **S** for that **q** instead of inventing letters.

Output rules:
- Return a single JSON object only. No markdown, no code fences, no commentary before or after.
- Each answer object must include **question** (stem as printed). The server builds a two-line SMS (no ASCII double quotes): line 1 = **q** + **)** + first **11** characters of the **lowest-q** question stem + space + three dots; line 2 = the compact key only.
- For every non-skipped answer, each **choices** item needs accurate **text** (full wording as printed).
- Schema (keys lowercase):
{"total_questions":NUMBER,"answers":[{"q":37,"question":"STEM","choices":[{"label":"A","text":"..."},{"label":"B","text":"..."},{"label":"C","text":"..."},{"label":"D","text":"..."}],"a":"A"}, ...]}
- Include **choices** when legible; skipped questions may use [] or partial choices. **total_questions** equals **answers** length. **q** positive integers, no duplicates. **a** is A/B/C/D/E or **S**.`;

function getBackendCandidates(raw: string): string[] {
  const base = raw.trim().replace(/\/+$/, '');
  if (!base) return [];
  if (base.startsWith('http://') || base.startsWith('https://')) {
    return [base];
  }
  return [`https://${base}`, `http://${base}`];
}

type ImagePreparation = 'google_document_ai' | 'server_enhanced' | 'original';

function normalizeImagePreparation(raw: unknown): ImagePreparation {
  if (raw === 'google_document_ai' || raw === 'server_enhanced' || raw === 'original') {
    return raw;
  }
  return 'original';
}

function describeImagePreparation(slot: number, prep: ImagePreparation): string {
  switch (prep) {
    case 'google_document_ai':
      return `Photo ${slot}: Google Document AI — deskewed/normalized page image used before the AI model.`;
    case 'server_enhanced':
      return `Photo ${slot}: Server-only sharpen/normalize. Document AI did not return a page image (processor type, config, or credentials).`;
    default:
      return `Photo ${slot}: Your JPEG as sent — no Document AI page image (and OCR server prep off, skipped, or failed).`;
  }
}

type SharedTeamLogRow = {
  at?: string;
  body?: string;
  slot?: number | null;
  qcmMode?: boolean;
  phoneTail?: string | null;
  clientTag?: string | null;
  answerModel?: string | null;
};

function sharedTeamLogDedupeKey(row: SharedTeamLogRow): string {
  const at = row.at ?? '';
  const body = typeof row.body === 'string' ? row.body : '';
  const tag = row.clientTag != null ? String(row.clientTag).trim() : '';
  return `${at}\u0000${tag}\u0000${body.slice(0, 500)}`;
}

type LastBatchRow = { line: string; answerModel?: string | null };

function compactQcmPayloadSansSlotPrefix(s: string): string | null {
  const t = String(s || '').trim();
  if (!t) return null;
  return extractQcmCompactFromSmsBody(t) ? t : null;
}

/** Payload after `N)__`: `q)stem …\\ncompact`, legacy quoted tails, legacy quoted-stem formats, or plain compact. */
function parseAnswerKeyRest(rest: string): { display: string } | null {
  const restTrim = rest.trim();
  if (!restTrim || /\bskipped\b/i.test(restTrim)) return null;
  const collapsed = restTrim.replace(/\s+/g, '');

  const stemFirst = /^((\d{1,6})\)[^\r\n]*)\r?\n(((?:\d{1,6}[ABCDES])(?:-\d{1,6}[ABCDES])*))\s*$/i.exec(restTrim);
  if (stemFirst) {
    const compact = stemFirst[3].replace(/\s+/g, '');
    if (!COMPACT_QCM_BODY.test(compact)) return null;
    return { display: `${stemFirst[1]}\n${compact}` };
  }

  const legacy = /^"([^"]*)"\s*__+\s*(.+)$/i.exec(restTrim);
  if (legacy) {
    const compact = legacy[2].trim().replace(/\s+/g, '');
    if (!COMPACT_QCM_BODY.test(compact)) return null;
    return { display: compact };
  }

  const neu = /^"([^"]*)"\s*((?:\d{1,6}[ABCDES])(?:-\d{1,6}[ABCDES])*)$/i.exec(collapsed);
  if (neu) {
    const compact = neu[2];
    if (!COMPACT_QCM_BODY.test(compact)) return null;
    return { display: compact };
  }

  const withTailNl = /^((?:\d{1,6}[ABCDES])(?:-\d{1,6}[ABCDES])*)\s*\r?\n\s*("[^"]*")\s*$/i.exec(restTrim);
  if (withTailNl) {
    return { display: `${withTailNl[1]}${QCM_TAIL_GAP}${withTailNl[2]}` };
  }
  const withTail = /^((?:\d{1,6}[ABCDES])(?:-\d{1,6}[ABCDES])*)\s{3,}("[^"]*")\s*$/i.exec(restTrim);
  if (withTail) {
    return { display: `${withTail[1]}${QCM_TAIL_GAP}${withTail[2]}` };
  }

  if (COMPACT_QCM_BODY.test(collapsed)) {
    return { display: collapsed };
  }
  return null;
}

/** Normalize to `N)__…` for UI (payload may span multiple lines), or null to hide the row. */
function displayAnswerKeyLineFromStored(raw: string): string | null {
  const s = String(raw || '').trim().replace(/^×\d+\s+/, '');
  if (!s) return null;
  const m = s.match(/^(\d{1,6})\)__([\s\S]+)$/);
  if (!m) return null;
  const parsed = parseAnswerKeyRest(m[2]);
  if (!parsed) return null;
  return `${m[1]})__${parsed.display}`;
}

function displaySharedLobbyAnswerKey(row: SharedTeamLogRow): string | null {
  const body = typeof row.body === 'string' ? row.body.trim() : '';
  if (!body) return null;
  const prefixed = displayAnswerKeyLineFromStored(body);
  if (prefixed) return prefixed;
  const slot = row.slot;
  if (typeof slot !== 'number' || !Number.isFinite(slot) || slot < 1) return null;
  const parsed = parseAnswerKeyRest(body);
  if (parsed) return `${slot})__${parsed.display}`;
  const compact = compactQcmPayloadSansSlotPrefix(body);
  if (!compact) return null;
  return `${slot})__${compact}`;
}

function normalizeAnswerModel(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  return raw.trim().toLowerCase().slice(0, 120);
}

async function callBackendAnalyze(
  backendBaseUrl: string,
  bearerToken: string | null,
  toPhoneNumber: string,
  base64: string,
  mimeType: string,
  userPrompt: string,
  qcmMode: boolean,
  photoSlot?: number | null,
  clientTag?: string | null
): Promise<{ text: string; smsBody?: string; imagePreparation: ImagePreparation; answerModel?: string }> {
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
          ...(typeof photoSlot === 'number' && Number.isFinite(photoSlot) ? { photoSlot } : {}),
          ...(clientTag && String(clientTag).trim() ? { clientTag: String(clientTag).trim().slice(0, 80) } : {}),
        }),
      });
      const rawText = await res.text();
      let json: Record<string, unknown> = {};
      try {
        json = rawText ? (JSON.parse(rawText) as Record<string, unknown>) : {};
      } catch {
        json = {};
      }
      if (!res.ok) {
        const errObj = json as { error?: string; message?: string; suspended?: boolean };
        if (res.status === 503) {
          const msg =
            (typeof errObj.error === 'string' && errObj.error) ||
            'API is temporarily suspended by the administrator.';
          throw new Error(msg);
        }
        const msg =
          (typeof errObj.error === 'string' && errObj.error) ||
          (typeof errObj.message === 'string' && errObj.message) ||
          (rawText && rawText.length < 400 ? rawText : null) ||
          `Backend request failed (${res.status})`;
        throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
      }
      const text = (json as { text?: string })?.text;
      const smsBody = (json as { smsBody?: string })?.smsBody;
      const imagePreparation = normalizeImagePreparation(
        (json as { imagePreparation?: unknown })?.imagePreparation
      );
      if (!text || typeof text !== 'string') {
        throw new Error('Invalid response from backend.');
      }
      const answerModelRaw = (json as { answerModel?: unknown }).answerModel;
      const answerModel =
        typeof answerModelRaw === 'string' && answerModelRaw.trim()
          ? answerModelRaw.trim().toLowerCase()
          : undefined;
      return { text: text.trim(), smsBody, imagePreparation, answerModel };
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

async function callBackendSharedLogs(
  backendBaseUrl: string,
  bearerToken: string | null,
  limit = 200
): Promise<{ logs: SharedTeamLogRow[]; kvConfigured?: boolean }> {
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
    const url = `${candidate}/v1/shared-logs`;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ limit }),
      });
      const rawText = await res.text();
      let json: Record<string, unknown> = {};
      try {
        json = rawText ? (JSON.parse(rawText) as Record<string, unknown>) : {};
      } catch {
        json = {};
      }
      if (!res.ok) {
        const errObj = json as { error?: string; message?: string };
        const msg =
          (typeof errObj.error === 'string' && errObj.error) ||
          (typeof errObj.message === 'string' && errObj.message) ||
          `Backend request failed (${res.status})`;
        throw new Error(msg);
      }
      const logs = (json as { logs?: unknown }).logs;
      const arr = Array.isArray(logs) ? (logs as SharedTeamLogRow[]) : [];
      return {
        logs: arr,
        kvConfigured: (json as { kvConfigured?: boolean }).kvConfigured,
      };
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
    `Could not reach backend for shared logs. ${lastNetworkError ?? ''}`.trim()
  );
}

type ServerNetworkSettings = {
  backendUrl?: string;
  bearerToken?: string;
  phones?: unknown[];
  smsSendingEnabled?: boolean;
  updatedAt?: string;
};

type LocalNetworkSnapshot = {
  backendUrl: string;
  bearerToken: string;
  phones: string[];
  smsSendingEnabled: boolean;
};

function mergeNetworkFromServer(
  local: LocalNetworkSnapshot,
  server: ServerNetworkSettings | null | undefined
): LocalNetworkSnapshot {
  if (!server || typeof server !== 'object') return local;
  const rawPhones = Array.isArray(server.phones) ? server.phones : [];
  const four = ['', '', '', ''];
  for (let i = 0; i < 4; i += 1) {
    four[i] = typeof rawPhones[i] === 'string' ? String(rawPhones[i]).trim().slice(0, 32) : '';
  }
  const hasServerPhones = phoneSlotsHaveAnyValid(four);
  const nextPhones = hasServerPhones ? four : local.phones;
  const nextBackend =
    typeof server.backendUrl === 'string' && server.backendUrl.trim()
      ? server.backendUrl.trim().replace(/\/+$/, '')
      : local.backendUrl;
  let nextBearer = local.bearerToken;
  if (typeof server.bearerToken === 'string') {
    nextBearer = server.bearerToken;
  }
  let nextSms = local.smsSendingEnabled;
  if ('smsSendingEnabled' in server) {
    nextSms = server.smsSendingEnabled !== false;
  }
  return { backendUrl: nextBackend, bearerToken: nextBearer, phones: nextPhones, smsSendingEnabled: nextSms };
}

async function callBackendNetworkConfig(
  backendBaseUrl: string,
  bearerToken: string | null
): Promise<{ settings: ServerNetworkSettings | null; kvConfigured?: boolean; lobbyResetNonce?: number }> {
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
    const url = `${candidate}/v1/network-config`;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({}),
      });
      const rawText = await res.text();
      let json: Record<string, unknown> = {};
      try {
        json = rawText ? (JSON.parse(rawText) as Record<string, unknown>) : {};
      } catch {
        json = {};
      }
      if (!res.ok) {
        const errObj = json as { error?: string; message?: string };
        const msg =
          (typeof errObj.error === 'string' && errObj.error) ||
          (typeof errObj.message === 'string' && errObj.message) ||
          `Backend request failed (${res.status})`;
        throw new Error(msg);
      }
      const settings = (json as { settings?: ServerNetworkSettings | null }).settings;
      return {
        settings: settings && typeof settings === 'object' ? settings : null,
        kvConfigured: (json as { kvConfigured?: boolean }).kvConfigured,
        lobbyResetNonce: Number((json as { lobbyResetNonce?: unknown }).lobbyResetNonce) || 0,
      };
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
    `Could not reach backend for network settings. ${lastNetworkError ?? ''}`.trim()
  );
}

async function callBackendAdmin(
  backendBaseUrl: string,
  bearerToken: string | null,
  adminPassword: string,
  action: string,
  extra?: {
    limit?: number;
    network?: { backendUrl: string; bearerToken: string; phones: string[]; smsSendingEnabled?: boolean };
  }
): Promise<Record<string, unknown>> {
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
  const payload: Record<string, unknown> = {
    adminPassword,
    action,
  };
  if (extra?.limit != null) payload.limit = extra.limit;
  if (extra?.network) {
    payload.network = {
      backendUrl: extra.network.backendUrl,
      bearerToken: extra.network.bearerToken,
      phones: extra.network.phones,
    };
  }
  let lastNetworkError: string | null = null;
  for (const candidate of candidates) {
    const url = `${candidate}/v1/admin`;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      });
      const rawText = await res.text();
      let json: Record<string, unknown> = {};
      try {
        json = rawText ? (JSON.parse(rawText) as Record<string, unknown>) : {};
      } catch {
        json = {};
      }
      if (!res.ok) {
        const errObj = json as { error?: string; message?: string };
        const msg =
          (typeof errObj.error === 'string' && errObj.error) ||
          (typeof errObj.message === 'string' && errObj.message) ||
          `Admin request failed (${res.status})`;
        throw new Error(msg);
      }
      return json;
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
  throw new Error(`Could not reach backend for admin. ${lastNetworkError ?? ''}`.trim());
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
          reject(new Error(typeof err === 'string' ? err : 'Failed to send'));
          return;
        }
        if (typeof message === 'string' && message.toLowerCase().includes('cancel')) {
          reject(new Error('Sending was cancelled'));
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

const ANSWER_HISTORY_KEY = 'picture_to_sms_answer_history_v1';
const MAX_ANSWER_HISTORY = 320;

type AnswerHistoryEntry = {
  id: string;
  at: string;
  slot: number;
  kind: 'sent' | 'skipped_duplicate';
  /** Model payload text (same as outbound body without the `slot)__` prefix). */
  body: string;
};

function normalizeAnswerForDedupe(body: string): string {
  const c = extractQcmCompactFromSmsBody(body);
  return (c ?? body.trim()).replace(/\s+/g, ' ').toUpperCase();
}

async function readAnswerHistory(): Promise<AnswerHistoryEntry[]> {
  try {
    const raw = await AsyncStorage.getItem(ANSWER_HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (x): x is AnswerHistoryEntry =>
        x != null &&
        typeof (x as AnswerHistoryEntry).id === 'string' &&
        typeof (x as AnswerHistoryEntry).body === 'string' &&
        typeof (x as AnswerHistoryEntry).slot === 'number'
    );
  } catch {
    return [];
  }
}

async function writeAnswerHistory(entries: AnswerHistoryEntry[]): Promise<void> {
  await AsyncStorage.setItem(ANSWER_HISTORY_KEY, JSON.stringify(entries));
}

async function appendAnswerHistoryRow(
  row: Omit<AnswerHistoryEntry, 'id' | 'at'>
): Promise<AnswerHistoryEntry[]> {
  const full: AnswerHistoryEntry = {
    id: newImageId(),
    at: new Date().toISOString(),
    slot: row.slot,
    kind: row.kind,
    body: row.body,
  };
  const prev = await readAnswerHistory();
  const next = [full, ...prev].slice(0, MAX_ANSWER_HISTORY);
  await writeAnswerHistory(next);
  return next;
}

/**
 * Burst / camera pipeline: slightly higher resolution + JPEG quality for OCR than old defaults,
 * with gentle upscaling when the photo is small (helps text legibility before the model sees it).
 * Still bounded to keep JSON payloads reasonable for typical backends.
 */
const MAX_UPLOAD_WIDTH = 1600;
const MAX_UPLOAD_HEIGHT = 2240;
const UPLOAD_JPEG_QUALITY = 0.84;
const OCR_MIN_SHORT_EDGE = 920;

async function preparePhotoForQueue(uri: string, width: number, height: number) {
  let w0 = width > 0 ? width : 3000;
  let h0 = height > 0 ? height : 4000;
  const actions: ImageManipulator.Action[] = [];
  const short = Math.min(w0, h0);
  if (short > 0 && short < OCR_MIN_SHORT_EDGE) {
    const factor = Math.min(1.55, (OCR_MIN_SHORT_EDGE + 48) / short);
    const w1 = Math.max(1, Math.round(w0 * factor));
    const h1 = Math.max(1, Math.round(h0 * factor));
    actions.push({ resize: { width: w1, height: h1 } });
    w0 = w1;
    h0 = h1;
  }
  const scale = Math.min(MAX_UPLOAD_WIDTH / w0, MAX_UPLOAD_HEIGHT / h0, 1);
  if (scale < 1 - 1e-6) {
    actions.push({
      resize: {
        width: Math.max(1, Math.round(w0 * scale)),
        height: Math.max(1, Math.round(h0 * scale)),
      },
    });
  }
  const sharpenActions: ImageManipulator.Action[] = [...actions];
  if (sharpenActions.length > 0) {
    const last = sharpenActions[sharpenActions.length - 1];
    if ('resize' in last) {
      const rw = last.resize.width;
      const rh = last.resize.height;
      if (rw != null && rh != null && rw > 0 && rh > 0) {
        sharpenActions.push({
          resize: {
            width: Math.max(1, Math.round(rw * 1.035)),
            height: Math.max(1, Math.round(rh * 1.035)),
          },
        });
        sharpenActions.push({
          resize: {
            width: Math.max(1, Math.round(rw)),
            height: Math.max(1, Math.round(rh)),
          },
        });
      }
    }
  }
  const pipeline = sharpenActions.length > actions.length ? sharpenActions : actions;
  const result = await ImageManipulator.manipulateAsync(uri, pipeline, {
    compress: UPLOAD_JPEG_QUALITY,
    format: ImageManipulator.SaveFormat.JPEG,
    base64: true,
  });
  const b64 = result.base64;
  if (!b64) {
    throw new Error('Could not compress image for upload.');
  }
  return { base64: b64, mimeType: 'image/jpeg' as const };
}

async function resolveQueuedPayload(item: QueuedImage): Promise<{ base64: string; mimeType: string }> {
  if (item.pendingCamera) {
    const { uri, width, height } = item.pendingCamera;
    return preparePhotoForQueue(uri, width, height);
  }
  if (item.base64) {
    return { base64: item.base64, mimeType: item.mimeType };
  }
  throw new Error('Invalid queue item (no image data).');
}

export default function App() {
  const [backendUrl, setBackendUrl] = useState('');
  const [bearerToken, setBearerToken] = useState('');
  const [phoneSlots, setPhoneSlots] = useState<string[]>(['', '', '', '']);
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [qcmMode, setQcmMode] = useState(true);
  const [status, setStatus] = useState<string | null>(null);
  const [imageQueue, setImageQueue] = useState<QueuedImage[]>([]);
  const imageQueueRef = useRef<QueuedImage[]>([]);
  const [lastSmsResults, setLastSmsResults] = useState<LastBatchRow[]>([]);
  const [lastImagePrepLines, setLastImagePrepLines] = useState<string[]>([]);
  const [adminPassword, setAdminPassword] = useState('');
  const [adminLoginVisible, setAdminLoginVisible] = useState(false);
  const [adminPanelVisible, setAdminPanelVisible] = useState(false);
  const [loginPasswordDraft, setLoginPasswordDraft] = useState('');
  const [deviceTag, setDeviceTag] = useState('');
  const [relayEnabled, setRelayEnabled] = useState(false);
  const [relayTo, setRelayTo] = useState('');
  /** Pulled from server KV; when false, analysis runs but SMS is not sent. */
  const [smsSendingEnabled, setSmsSendingEnabled] = useState(true);
  const [adminBusy, setAdminBusy] = useState(false);
  const [adminServerLine, setAdminServerLine] = useState<string | null>(null);
  const [teamFeedUnlocked, setTeamFeedUnlocked] = useState(false);
  const [lobbyResetNonce, setLobbyResetNonce] = useState(0);
  const isAdminLoggedIn = adminPassword.trim().length > 0;
  const lobbyAccessible = teamFeedUnlocked || isAdminLoggedIn;
  const [teamSharedLogs, setTeamSharedLogs] = useState<SharedTeamLogRow[]>([]);
  const [teamLogsKvNotice, setTeamLogsKvNotice] = useState<string | null>(null);
  const [sharedLogsBusy, setSharedLogsBusy] = useState(false);
  const sharedLogsBusyRef = useRef(false);
  const [notifyNudgeVisible, setNotifyNudgeVisible] = useState(false);
  const knownSharedLogKeysRef = useRef<Set<string>>(new Set());
  const sharedFeedBootstrapDoneRef = useRef(false);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const cameraRef = useRef<CameraView | null>(null);
  const nextPhotoSlotRef = useRef(1);
  const secretKnockCountRef = useRef(0);
  const secretKnockResetRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const netSnapRef = useRef<LocalNetworkSnapshot>({
    backendUrl: '',
    bearerToken: '',
    phones: ['', '', '', ''],
    smsSendingEnabled: true,
  });
  const lobbyResetAckRef = useRef(0);
  /** Same as `adminPassword` state; updated synchronously on boot so `pullNetworkSettings` never mis-detects admin. */
  const adminPasswordRef = useRef('');
  /** Android: camera permission is required for this app flow. */
  const [essentialPermsOk, setEssentialPermsOk] = useState(Platform.OS !== 'android');
  const [essentialPermsBusy, setEssentialPermsBusy] = useState(Platform.OS === 'android');

  const syncEssentialPermissions = useCallback(async () => {
    if (Platform.OS !== 'android') {
      setEssentialPermsOk(true);
      return true;
    }
    try {
      const cam = await Camera.getCameraPermissionsAsync();
      const ok = cam.granted === true;
      setEssentialPermsOk(ok);
      return ok;
    } catch {
      setEssentialPermsOk(false);
      return false;
    }
  }, []);

  const requestEssentialPermissions = useCallback(async () => {
    if (Platform.OS !== 'android') return;
    setEssentialPermsBusy(true);
    try {
      await Camera.requestCameraPermissionsAsync();
      await syncEssentialPermissions();
    } finally {
      setEssentialPermsBusy(false);
    }
  }, [syncEssentialPermissions]);

  useEffect(() => {
    if (Platform.OS !== 'android') return;
    let cancelled = false;
    void (async () => {
      setEssentialPermsBusy(true);
      try {
        await syncEssentialPermissions();
      } finally {
        if (!cancelled) setEssentialPermsBusy(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [syncEssentialPermissions]);

  useEffect(() => {
    imageQueueRef.current = imageQueue;
  }, [imageQueue]);

  useEffect(() => {
    netSnapRef.current = { backendUrl, bearerToken, phones: phoneSlots, smsSendingEnabled };
  }, [backendUrl, bearerToken, phoneSlots, smsSendingEnabled]);

  useEffect(() => {
    adminPasswordRef.current = adminPassword;
  }, [adminPassword]);

  useEffect(() => {
    sharedLogsBusyRef.current = sharedLogsBusy;
  }, [sharedLogsBusy]);

  const dismissNotifyNudge = useCallback(async (requestPerm: boolean) => {
    try {
      await AsyncStorage.setItem(KEY_NOTIFY_ONBOARDING, '1');
    } catch {
      // ignore
    }
    if (requestPerm) await requestAnswerNotificationPermission();
    setNotifyNudgeVisible(false);
  }, []);

  useEffect(() => {
    if (Platform.OS === 'web' || !essentialPermsOk) return;
    let cancelled = false;
    void (async () => {
      try {
        const v = await AsyncStorage.getItem(KEY_NOTIFY_ONBOARDING);
        if (!cancelled && v !== '1') setNotifyNudgeVisible(true);
      } catch {
        // ignore
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [essentialPermsOk]);

  useEffect(() => {
    knownSharedLogKeysRef.current.clear();
    sharedFeedBootstrapDoneRef.current = false;
  }, [backendUrl]);

  const refreshTeamSharedLogs = useCallback(
    async (force?: boolean) => {
      if (!force && !lobbyAccessible) {
        setTeamSharedLogs([]);
        setTeamLogsKvNotice(null);
        return;
      }
      if (!backendUrl.trim()) {
        setTeamSharedLogs([]);
        setTeamLogsKvNotice(null);
        return;
      }
      setSharedLogsBusy(true);
      try {
        const { logs, kvConfigured } = await callBackendSharedLogs(backendUrl, bearerToken || null, 200);
        setTeamLogsKvNotice(
          kvConfigured === false ? 'Shared lobby needs Redis/KV on the API (shared feed off).' : null
        );

        if (kvConfigured !== false) {
          const tagMine = deviceTag.trim();
          if (!sharedFeedBootstrapDoneRef.current) {
            logs.forEach((row) => {
              knownSharedLogKeysRef.current.add(sharedTeamLogDedupeKey(row));
            });
            sharedFeedBootstrapDoneRef.current = true;
          } else {
            const newRows: SharedTeamLogRow[] = [];
            for (const row of logs) {
              const k = sharedTeamLogDedupeKey(row);
              if (!knownSharedLogKeysRef.current.has(k)) {
                knownSharedLogKeysRef.current.add(k);
                newRows.push(row);
              }
            }
            for (let i = newRows.length - 1; i >= 0; i -= 1) {
              const row = newRows[i];
              const rTag = row.clientTag != null ? String(row.clientTag).trim() : '';
              if (rTag && rTag === tagMine) continue;
              const b = typeof row.body === 'string' ? row.body.trim() : '';
              if (b) void presentAnswerNotification(b, row.slot ?? null);
            }
          }
        }

        setTeamSharedLogs(logs);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        setTeamLogsKvNotice(message);
        setTeamSharedLogs([]);
      } finally {
        setSharedLogsBusy(false);
      }
    },
    [backendUrl, bearerToken, lobbyAccessible, deviceTag]
  );

  useEffect(() => {
    if (!lobbyAccessible) {
      setTeamSharedLogs([]);
      setTeamLogsKvNotice(null);
      knownSharedLogKeysRef.current.clear();
      sharedFeedBootstrapDoneRef.current = false;
      return;
    }
    void refreshTeamSharedLogs(false);
  }, [lobbyAccessible, refreshTeamSharedLogs]);

  useEffect(() => {
    if (!lobbyAccessible || !backendUrl.trim()) return undefined;
    const id = setInterval(() => {
      if (sharedLogsBusyRef.current) return;
      void refreshTeamSharedLogs(true);
    }, SHARED_LOBBY_POLL_MS);
    return () => clearInterval(id);
  }, [lobbyAccessible, backendUrl, refreshTeamSharedLogs]);

  const persistSettings = useCallback(
    async (override?: { backendUrl: string; bearerToken: string; phones: string[] }) => {
      const b = override?.backendUrl ?? backendUrl;
      const t = override?.bearerToken ?? bearerToken;
      const p = override?.phones ?? phoneSlots;
      try {
        if (b.trim()) await SecureStore.setItemAsync(KEY_BACKEND, b.trim());
        await SecureStore.setItemAsync(KEY_BEARER, t.trim());
        await SecureStore.setItemAsync(KEY_PHONES, JSON.stringify(p.map((s) => s.trim())));
        await SecureStore.setItemAsync(KEY_RELAY_ENABLED, relayEnabled ? '1' : '0');
        await SecureStore.setItemAsync(KEY_RELAY_TO, relayTo.trim());
      } catch {
        Alert.alert('Storage', 'Could not save settings on this device.');
      }
    },
    [backendUrl, bearerToken, phoneSlots, relayEnabled, relayTo]
  );

  const pullNetworkSettings = useCallback(async (): Promise<LocalNetworkSnapshot> => {
    const snap = netSnapRef.current;
    const base = snap.backendUrl.trim() || DEFAULT_BACKEND_URL;
    try {
      const remote = await callBackendNetworkConfig(base, snap.bearerToken || null);
      const merged = mergeNetworkFromServer(snap, remote.settings);
      setSmsSendingEnabled(merged.smsSendingEnabled);
      const remoteLobbyNonce = Number(remote.lobbyResetNonce) || 0;
      setLobbyResetNonce(remoteLobbyNonce);
      if (!adminPasswordRef.current.trim() && remoteLobbyNonce > lobbyResetAckRef.current) {
        setTeamFeedUnlocked(false);
        setTeamSharedLogs([]);
        setTeamLogsKvNotice(null);
        knownSharedLogKeysRef.current.clear();
        sharedFeedBootstrapDoneRef.current = false;
        try {
          await SecureStore.setItemAsync(KEY_TEAM_FEED_UNLOCKED, '0');
        } catch {
          // ignore
        }
      }
      setBackendUrl(merged.backendUrl);
      setBearerToken(merged.bearerToken);
      setPhoneSlots(merged.phones);
      netSnapRef.current = merged;
      return merged;
    } catch {
      return snap;
    }
  }, []);

  /** So non-admin phones pick up admin panel saves (phones, URL, secret) without leaving the app. */
  useEffect(() => {
    const base = (backendUrl.trim() || DEFAULT_BACKEND_URL).trim();
    if (!base) return undefined;
    const id = setInterval(() => {
      void pullNetworkSettings();
    }, 90000);
    return () => clearInterval(id);
  }, [backendUrl, pullNetworkSettings]);

  useEffect(() => {
    (async () => {
      try {
        const [b, t, phonesJson, legacyPhone, teamOk, tag, relayOn, relayNum, lobbyAckRaw, savedAdminPwd] =
          await Promise.all([
            SecureStore.getItemAsync(KEY_BACKEND),
            SecureStore.getItemAsync(KEY_BEARER),
            SecureStore.getItemAsync(KEY_PHONES),
            SecureStore.getItemAsync(KEY_PHONE_LEGACY),
            SecureStore.getItemAsync(KEY_TEAM_FEED_UNLOCKED),
            SecureStore.getItemAsync(KEY_DEVICE_TAG),
            SecureStore.getItemAsync(KEY_RELAY_ENABLED),
            SecureStore.getItemAsync(KEY_RELAY_TO),
            AsyncStorage.getItem(KEY_LOBBY_RESET_ACK_NONCE),
            SecureStore.getItemAsync(KEY_ADMIN_PASSWORD),
          ]);
        const resolvedBackend = b?.trim() ? b.trim() : DEFAULT_BACKEND_URL;
        setBackendUrl(resolvedBackend);
        if (t) setBearerToken(t);
        let slots = parsePhonesJson(phonesJson);
        if (!phonesJson?.trim() && legacyPhone?.trim()) {
          slots = [legacyPhone.trim(), '', '', ''];
        }
        setPhoneSlots(slots);
        setTeamFeedUnlocked(teamOk === '1');
        const savedAdmin = savedAdminPwd?.trim() ?? '';
        adminPasswordRef.current = savedAdmin;
        if (savedAdmin) {
          setAdminPassword(savedAdmin);
        }
        let deviceId = tag?.trim() || '';
        if (!deviceId) {
          deviceId = newDeviceTag();
          await SecureStore.setItemAsync(KEY_DEVICE_TAG, deviceId);
        }
        setDeviceTag(deviceId);
        setRelayEnabled(relayOn === '1');
        if (relayNum) setRelayTo(relayNum);
        const ack = Number(lobbyAckRaw || '0');
        lobbyResetAckRef.current = Number.isFinite(ack) && ack >= 0 ? Math.floor(ack) : 0;
        netSnapRef.current = {
          backendUrl: resolvedBackend,
          bearerToken: t || '',
          phones: slots,
          smsSendingEnabled: true,
        };
        void pullNetworkSettings();
      } catch {
        // SecureStore can fail on web / simulators
      }
    })();
  }, [pullNetworkSettings]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if (next !== 'active') return;
      if (Platform.OS === 'android') void syncEssentialPermissions();
      void pullNetworkSettings();
      if (lobbyAccessible && backendUrl.trim()) void refreshTeamSharedLogs(true);
    });
    return () => sub.remove();
  }, [syncEssentialPermissions, lobbyAccessible, backendUrl, refreshTeamSharedLogs, pullNetworkSettings]);

  const onSecretAreaPress = useCallback(() => {
    if (secretKnockResetRef.current) clearTimeout(secretKnockResetRef.current);
    secretKnockCountRef.current += 1;
    secretKnockResetRef.current = setTimeout(() => {
      secretKnockCountRef.current = 0;
    }, SECRET_KNOCK_RESET_MS);
    if (secretKnockCountRef.current >= SECRET_KNOCK_REQUIRED_TAPS) {
      secretKnockCountRef.current = 0;
      if (secretKnockResetRef.current) clearTimeout(secretKnockResetRef.current);
      setLoginPasswordDraft('');
      if (adminPasswordRef.current.trim().length > 0) {
        setAdminPanelVisible(true);
      } else {
        setAdminLoginVisible(true);
      }
    }
  }, []);

  const tryUnlockAdminPanel = useCallback(async () => {
    const pwd = loginPasswordDraft.trim();
    if (!pwd) {
      Alert.alert('Admin', 'Enter the server admin password.');
      return;
    }
    const apiBase = backendUrl.trim() || DEFAULT_BACKEND_URL;
    if (!backendUrl.trim()) {
      setBackendUrl(apiBase);
    }
    setAdminBusy(true);
    try {
      const j = await callBackendAdmin(apiBase, bearerToken || null, pwd, 'status');
      adminPasswordRef.current = pwd;
      setAdminPassword(pwd);
      try {
        await SecureStore.setItemAsync(KEY_ADMIN_PASSWORD, pwd);
      } catch {
        // ignore — admin session works this launch only
      }
      setAdminLoginVisible(false);
      setAdminPanelVisible(true);
      setLoginPasswordDraft('');
      const suspended = Boolean(j.suspended);
      const kv = Boolean(j.kvConfigured);
      setAdminServerLine(
        `${suspended ? 'Analyze is SUSPENDED (no model calls).' : 'Analyze is ACTIVE.'} KV/Redis: ${
          kv ? 'OK' : 'not configured'
        }.`
      );
    } catch (e) {
      Alert.alert('Unlock failed', e instanceof Error ? e.message : String(e));
    } finally {
      setAdminBusy(false);
    }
  }, [loginPasswordDraft, backendUrl, bearerToken]);

  const closeAdminPanel = useCallback(() => {
    setAdminPanelVisible(false);
    setAdminServerLine(null);
  }, []);

  const refreshAdminStatusLine = useCallback(async (passwordOverride?: string) => {
    if (!backendUrl.trim()) {
      setAdminServerLine('Set backend URL in this panel first.');
      return;
    }
    const pwd = (passwordOverride ?? adminPassword).trim();
    if (!pwd) {
      setAdminServerLine(
        `Unlock admin again with your server password (close panel, ${SECRET_KNOCK_REQUIRED_TAPS} taps at bottom, log in).`
      );
      return;
    }
    setAdminBusy(true);
    try {
      const j = await callBackendAdmin(backendUrl, bearerToken || null, pwd, 'status');
      const suspended = Boolean(j.suspended);
      const kv = Boolean(j.kvConfigured);
      setAdminServerLine(
        `${suspended ? 'Analyze is SUSPENDED (no model calls).' : 'Analyze is ACTIVE.'} KV/Redis: ${
          kv ? 'OK' : 'not configured — link KV on Vercel/Railway for live suspend + team log'
        }.`
      );
    } catch (e) {
      setAdminServerLine(e instanceof Error ? e.message : String(e));
    } finally {
      setAdminBusy(false);
    }
  }, [adminPassword, backendUrl, bearerToken]);

  const adminSuspend = useCallback(async () => {
    if (!adminPassword.trim()) {
      Alert.alert('Admin', 'Close this screen and unlock again with your server password.');
      return;
    }
    setAdminBusy(true);
    try {
      await callBackendAdmin(backendUrl, bearerToken || null, adminPassword.trim(), 'suspend');
      await refreshAdminStatusLine();
    } catch (e) {
      Alert.alert('Suspend', e instanceof Error ? e.message : String(e));
    } finally {
      setAdminBusy(false);
    }
  }, [adminPassword, backendUrl, bearerToken, refreshAdminStatusLine]);

  const adminResume = useCallback(async () => {
    if (!adminPassword.trim()) {
      Alert.alert('Admin', 'Close this screen and unlock again with your server password.');
      return;
    }
    setAdminBusy(true);
    try {
      await callBackendAdmin(backendUrl, bearerToken || null, adminPassword.trim(), 'resume');
      await refreshAdminStatusLine();
    } catch (e) {
      Alert.alert('Resume', e instanceof Error ? e.message : String(e));
    } finally {
      setAdminBusy(false);
    }
  }, [adminPassword, backendUrl, bearerToken, refreshAdminStatusLine]);

  const pushServerSmsPolicy = useCallback(
    async (enabled: boolean) => {
      const pwd = adminPassword.trim();
      if (!pwd) {
        Alert.alert('Admin', 'Unlock the panel again with your server password.');
        return;
      }
      setAdminBusy(true);
      try {
        await callBackendAdmin(backendUrl.trim() || DEFAULT_BACKEND_URL, bearerToken || null, pwd, 'save_network_settings', {
          network: {
            backendUrl: backendUrl.trim(),
            bearerToken: bearerToken.trim(),
            phones: phoneSlots.map((s) => s.trim()),
            smsSendingEnabled: enabled,
          },
        });
        await pullNetworkSettings();
        Alert.alert(
          'SMS policy',
          enabled
            ? 'Outbound SMS is enabled for all devices (after they pull settings).'
            : 'Outbound SMS is disabled for all devices. Analysis still runs; phones stop auto-sending until you enable again.'
        );
      } catch (e) {
        Alert.alert('SMS policy', e instanceof Error ? e.message : String(e));
      } finally {
        setAdminBusy(false);
      }
    },
    [adminPassword, backendUrl, bearerToken, phoneSlots, pullNetworkSettings]
  );

  const adminResetLobby = useCallback(async () => {
    if (!adminPassword.trim()) {
      Alert.alert('Admin', 'Close this screen and unlock again with your server password.');
      return;
    }
    setAdminBusy(true);
    try {
      const j = await callBackendAdmin(backendUrl, bearerToken || null, adminPassword.trim(), 'reset_lobby');
      const nextNonce = Number((j as { lobbyResetNonce?: unknown }).lobbyResetNonce) || 0;
      setLobbyResetNonce(nextNonce);
      setTeamSharedLogs([]);
      setTeamLogsKvNotice(null);
      knownSharedLogKeysRef.current.clear();
      sharedFeedBootstrapDoneRef.current = false;
      Alert.alert(
        'Lobby reset',
        'Shared lobby was cleared. Normal users must send a new valid QCM image to unlock again.'
      );
      await refreshAdminStatusLine();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/unknown action/i.test(msg)) {
        try {
          await callBackendAdmin(backendUrl, bearerToken || null, adminPassword.trim(), 'clear_shared_logs');
          setTeamSharedLogs([]);
          setTeamLogsKvNotice(null);
          knownSharedLogKeysRef.current.clear();
          sharedFeedBootstrapDoneRef.current = false;
          Alert.alert(
            'Lobby cleared (legacy API)',
            'Shared logs were removed on the server. Redeploy the latest backend to Vercel so this button can also bump the global lobby lock (reset_lobby) for all devices.'
          );
          await refreshAdminStatusLine();
        } catch (e2) {
          Alert.alert('Reset lobby', e2 instanceof Error ? e2.message : String(e2));
        }
      } else {
        Alert.alert('Reset lobby', msg);
      }
    } finally {
      setAdminBusy(false);
    }
  }, [adminPassword, backendUrl, bearerToken, refreshAdminStatusLine]);

  const processRelayForNewSharedLogs = useCallback(async () => {
    if (Platform.OS !== 'android') return;
    if (!relayEnabled || !relayTo.trim()) return;
    if (relayTo.replace(/\D/g, '').length < 8) return;
    if (!backendUrl.trim() || !deviceTag.trim()) return;
    try {
      const check = await PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.SEND_SMS);
      if (!check) return;
    } catch {
      return;
    }
    try {
      const { logs } = await callBackendSharedLogs(backendUrl, bearerToken || null, 200);
      const myTag = deviceTag.trim();
      const raw = await AsyncStorage.getItem(AS_RELAY_SIGNATURES);
      let sigs: string[] = [];
      try {
        const parsed = raw ? (JSON.parse(raw) as unknown) : [];
        sigs = Array.isArray(parsed) ? (parsed as string[]) : [];
      } catch {
        sigs = [];
      }
      const sigSet = new Set(sigs);
      const ordered = [...logs].reverse();
      const appended: string[] = [];
      for (const row of ordered) {
        if (!row?.body || typeof row.body !== 'string') continue;
        const c = row.clientTag;
        if (c == null || String(c).trim() === '' || String(c).trim() === myTag) continue;
        const sig = `${row.at ?? ''}|${row.slot ?? ''}|${String(row.body).slice(0, 160)}`;
        if (sigSet.has(sig)) continue;
        const body = `[Team] P${row.slot ?? '?'}: ${String(row.body).slice(0, 1200)}`;
        try {
          await sendDirectSmsAndroid(relayTo.trim(), body);
          sigSet.add(sig);
          appended.push(sig);
        } catch {
          break;
        }
      }
      if (appended.length > 0) {
        const merged = [...sigs, ...appended].slice(-RELAY_SIG_CAP);
        await AsyncStorage.setItem(AS_RELAY_SIGNATURES, JSON.stringify(merged));
      }
    } catch {
      // ignore relay errors
    }
  }, [relayEnabled, relayTo, backendUrl, bearerToken, deviceTag]);

  useEffect(() => {
    if (Platform.OS !== 'android' || !relayEnabled) return undefined;
    const id = setInterval(() => {
      void processRelayForNewSharedLogs();
    }, 22000);
    return () => clearInterval(id);
  }, [relayEnabled, processRelayForNewSharedLogs]);

  const requireAndroidReadyForSend = useCallback((apiUrl: string): boolean => {
    if (!apiUrl.trim()) {
      Alert.alert(
        'Backend URL',
        'The API address is missing. Your admin should save it in the admin panel (applies to all devices), or try again after the app refreshes settings.'
      );
      return false;
    }
    if (Platform.OS !== 'android') {
      Alert.alert('Android only', 'Sending from this screen is supported only on Android.');
      return false;
    }
    return true;
  }, []);

  /** Camera / scanner: backend URL required (pulled from server when configured). */
  const requireBackendForCapture = useCallback((apiUrl?: string): boolean => {
    const u = (apiUrl ?? backendUrl).trim();
    if (!u) {
      Alert.alert(
        'Backend URL',
        'The API address is missing. Your admin should save it in the admin panel (applies to all devices), or try again in a moment.'
      );
      return false;
    }
    if (Platform.OS !== 'android') {
      Alert.alert('Android only', 'This capture flow is supported only on Android.');
      return false;
    }
    return true;
  }, [backendUrl]);

  const openMultiCaptureCamera = useCallback(async () => {
    const merged = await pullNetworkSettings();
    if (!requireBackendForCapture(merged.backendUrl)) return;

    const granted = cameraPermission?.granted
      ? true
      : (await requestCameraPermission()).granted;
    if (!granted) {
      Alert.alert('Camera', 'Camera permission is required to take pictures.');
      return;
    }

    setStatus('Camera ready. Burst-capture pages, then Done to compress and analyze automatically.');
    setCameraOpen(true);
  }, [requireBackendForCapture, cameraPermission?.granted, requestCameraPermission, pullNetworkSettings]);

  const captureInCamera = useCallback(async () => {
    if (!cameraRef.current) return;
    try {
      const shot = await cameraRef.current.takePictureAsync({
        base64: false,
        quality: 1,
        skipProcessing: false,
        shutterSound: false,
      });
      if (!shot.uri) {
        throw new Error('Could not read image file. Try again.');
      }
      const photoSlot = nextPhotoSlotRef.current;
      nextPhotoSlotRef.current += 1;
      const item: QueuedImage = {
        id: newImageId(),
        mimeType: 'image/jpeg',
        photoSlot,
        pendingCamera: {
          uri: shot.uri,
          width: shot.width,
          height: shot.height,
        },
      };
      setImageQueue((q) => [...q, item]);
      setStatus(
        'Captured. Tap Capture quickly for more pages, then Done to analyze (burst photos are enhanced for OCR on-device).'
      );
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setStatus(`Error: ${message}`);
      Alert.alert('Capture failed', message);
    }
  }, []);

  const clearQueue = useCallback(() => {
    nextPhotoSlotRef.current = 1;
    setImageQueue([]);
    setStatus('Queue cleared.');
    setLastSmsResults([]);
    setLastImagePrepLines([]);
  }, []);

  const sendAllFromQueue = useCallback(async (queueOverride?: QueuedImage[]) => {
    const source = queueOverride ?? imageQueue;
    let pending = [...source];
    if (pending.length === 0) {
      Alert.alert('No pages', 'Scan or capture one or more pages before pressing Send all.');
      return;
    }

    const totalPlanned = pending.length;
    setBusy(true);
    setLastSmsResults([]);
    setLastImagePrepLines([]);
    const merged = await pullNetworkSettings();
    if (!requireAndroidReadyForSend(merged.backendUrl)) {
      setBusy(false);
      return;
    }
    await persistSettings({
      backendUrl: merged.backendUrl,
      bearerToken: merged.bearerToken,
      phones: merged.phones,
    });

    const effectivePrompt = qcmMode ? QCM_PROMPT : prompt;
    const sentBodies: string[] = [];
    const skipped: string[] = [];
    const batchDisplayRows: LastBatchRow[] = [];
    const imagePrepLines: string[] = [];
    const seenAnswerNorm = new Set<string>();
    let analyzeFailureAlerted = false;
    let duplicateSkips = 0;
    let totalOutboundDispatches = 0;
    const recipients = allValidDestinations(merged.phones);
    const smsDispatchAllowed = merged.smsSendingEnabled !== false;
    let canSendSms = smsDispatchAllowed && recipients.length > 0;

    try {
      if (recipients.length > 0 && smsDispatchAllowed) {
        const granted = await PermissionsAndroid.request(
          PermissionsAndroid.PERMISSIONS.SEND_SMS
        );
        if (granted !== PermissionsAndroid.RESULTS.GRANTED) {
          canSendSms = false;
          setStatus('SMS permission denied. Analysis still runs, but SMS dispatch is skipped.');
        }
      } else if (recipients.length > 0 && !smsDispatchAllowed) {
        setStatus('SMS sending is disabled in admin (server). Analysis still runs; outbound SMS skipped.');
      }

      while (pending.length > 0) {
        const [current, ...rest] = pending;
        const slot = current.photoSlot;
        try {
          const analyzeContact = recipients[0] || '+00000000';
          setStatus(`Preparing & analyzing page ${slot} of ${totalPlanned}…`);
          const { base64, mimeType } = await resolveQueuedPayload(current);
          const backendResult = await callBackendAnalyze(
            merged.backendUrl,
            merged.bearerToken || null,
            analyzeContact,
            base64,
            mimeType,
            effectivePrompt,
            qcmMode,
            slot,
            deviceTag.trim() || null
          );

          const rawCore =
            typeof backendResult.smsBody === 'string' && backendResult.smsBody.trim() !== ''
              ? backendResult.smsBody.trim()
              : (backendResult.text ?? '').trim();
          if (!rawCore) {
            throw new Error('No parseable content returned from model');
          }
          const smsBody = qcmMode
            ? mergeQcmSmsBodyWithTailFromModel(rawCore, backendResult.text ?? '')
            : rawCore;
          const answerModel = normalizeAnswerModel(backendResult.answerModel);

          imagePrepLines.push(
            describeImagePreparation(slot, backendResult.imagePreparation)
          );

          const answerKey = normalizeAnswerForDedupe(smsBody);
          if (seenAnswerNorm.has(answerKey)) {
            duplicateSkips += 1;
            imagePrepLines.push(
              `Photo ${slot}: duplicate of earlier page in this send — model output matched; ignored.`
            );
          } else {
            seenAnswerNorm.add(answerKey);
            const smsPayload = `${slot})__${smsBody}`;
            if (canSendSms && recipients.length > 0) {
              setStatus(
                `Sending page ${slot} of ${totalPlanned} (${recipients.length} destination(s), same text)…`
              );
              for (const recipient of recipients) {
                await sendDirectSmsAndroid(recipient, smsPayload);
                totalOutboundDispatches += 1;
              }
            }
            const sentLine =
              canSendSms && recipients.length > 0 ? `×${recipients.length} ${smsPayload}` : smsPayload;
            sentBodies.push(sentLine);
            batchDisplayRows.push({ line: smsPayload, answerModel });
            if (!teamFeedUnlocked && qcmMode && looksLikeValidatedQcmCompact(smsBody)) {
              try {
                await SecureStore.setItemAsync(KEY_TEAM_FEED_UNLOCKED, '1');
                lobbyResetAckRef.current = lobbyResetNonce;
                await AsyncStorage.setItem(KEY_LOBBY_RESET_ACK_NONCE, String(lobbyResetNonce));
              } catch {
                // ignore
              }
              setTeamFeedUnlocked(true);
            }
            await appendAnswerHistoryRow({
              slot,
              kind: 'sent',
              body: smsBody,
            });
            void presentAnswerNotification(smsBody, slot);
          }
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          const errLine = `${slot})__ skipped (${message})`;
          skipped.push(errLine);
          if (
            !analyzeFailureAlerted &&
            (message.includes('All OpenRouter keys failed') ||
              message.includes('All API keys failed') ||
              message.includes('OpenRouter') ||
              message.length > 500)
          ) {
            analyzeFailureAlerted = true;
            Alert.alert(`Page ${slot} failed`, message.slice(0, 4000));
          }
        } finally {
          pending = rest;
          setImageQueue(pending);
        }
      }

      nextPhotoSlotRef.current = 1;
      setLastSmsResults(batchDisplayRows);
      setLastImagePrepLines(imagePrepLines);
      if (skipped.length > 0) {
        const dupPart =
          duplicateSkips > 0
            ? ` ${duplicateSkips} duplicate answer(s) (extra shots of the same sheet).`
            : '';
        const other = skipped.length - duplicateSkips;
        const otherPart = other > 0 ? ` ${other} other issue(s).` : '';
        const rc = canSendSms ? recipients.length : 0;
        const firstSkip = skipped[0]
          ? ` — ${String(skipped[0]).replace(/\s+/g, ' ').slice(0, FIRST_SKIP_STATUS_SNIP_LEN)}${skipped[0].length > FIRST_SKIP_STATUS_SNIP_LEN ? '…' : ''}`
          : '';
        setStatus(
          `Done. ${totalOutboundDispatches} identical outbound(s) (${sentBodies.length} page(s) × ${rc} destination(s)). Skipped ${skipped.length}.${dupPart}${otherPart}${firstSkip}`
        );
      } else {
        const rc = canSendSms ? recipients.length : 0;
        setStatus(
          `Done. ${totalOutboundDispatches} identical outbound(s) (${sentBodies.length} page(s) × ${rc} destination(s)).`
        );
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setImageQueue(pending);
      setLastSmsResults(batchDisplayRows);
      setLastImagePrepLines(imagePrepLines);
      if (sentBodies.length > 0) {
        setStatus(
          `Error after ${totalOutboundDispatches} outbound(s), ${sentBodies.length} page(s) of ${totalPlanned}: ${message}`
        );
      } else {
        setStatus(`Error: ${message}`);
      }
      Alert.alert('Something went wrong', message);
    } finally {
      setBusy(false);
      void refreshTeamSharedLogs(true);
    }
  }, [
    pullNetworkSettings,
    requireAndroidReadyForSend,
    imageQueue,
    prompt,
    qcmMode,
    persistSettings,
    deviceTag,
    lobbyResetNonce,
    teamFeedUnlocked,
    smsSendingEnabled,
    refreshTeamSharedLogs,
  ]);

  const finishCamera = useCallback(
    (sendAfterClose: boolean) => {
      setCameraOpen(false);
      const q = [...imageQueueRef.current];
      if (sendAfterClose && q.length > 0) {
        setStatus('Compressing and analyzing…');
        InteractionManager.runAfterInteractions(() => {
          void sendAllFromQueue(q);
        });
        return;
      }
      if (q.length > 0) {
        setStatus(`${q.length} page(s) in queue. Tap Send all on the main screen when ready.`);
      } else {
        setStatus('No photo captured.');
      }
    },
    [sendAllFromQueue]
  );

  useEffect(() => {
    if (!cameraOpen) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      finishCamera(false);
      return true;
    });
    return () => sub.remove();
  }, [cameraOpen, finishCamera]);

  if (Platform.OS === 'android' && !essentialPermsOk) {
    return (
      <View style={[styles.permGateRoot, { paddingTop: (Constants.statusBarHeight ?? 0) + 12 }]}>
        <StatusBar style="light" />
        <ScrollView
          contentContainerStyle={styles.permGateInner}
          keyboardShouldPersistTaps="handled"
        >
          <Text style={styles.permGateTitle}>Permissions required</Text>
          <Text style={styles.permGateBody}>
            This app needs camera access to work. SMS numbers are optional and can be added later from Admin.
          </Text>
          <Text style={styles.permGateBody}>
            On Android, do not choose <Text style={styles.permGateEm}>&quot;Only this time&quot;</Text> for camera. That
            grant expires when you leave the app.
          </Text>
          {essentialPermsBusy ? (
            <ActivityIndicator color="#93c5fd" style={styles.permGateSpinner} />
          ) : null}
          <Pressable
            style={({ pressed }) => [
              styles.button,
              styles.permGatePrimaryBtn,
              pressed && styles.buttonPressed,
              essentialPermsBusy && styles.buttonDisabled,
            ]}
            onPress={() => void requestEssentialPermissions()}
            disabled={essentialPermsBusy}
          >
            <Text style={styles.buttonText}>Allow camera</Text>
          </Pressable>
          <Pressable
            style={({ pressed }) => [
              styles.secondaryBtn,
              styles.permGateSecondaryBtn,
              pressed && styles.buttonPressed,
            ]}
            onPress={() => void Linking.openSettings()}
          >
            <Text style={styles.secondaryBtnText}>Open system settings</Text>
          </Pressable>
          <Text style={styles.permGateFoot}>
            After changing settings, return here — permissions are checked again automatically.
          </Text>
        </ScrollView>
      </View>
    );
  }

  if (cameraOpen) {
    return (
      <View style={styles.cameraRoot}>
        <CameraView
          ref={cameraRef}
          style={styles.cameraView}
          facing="back"
          autofocus="on"
          zoom={0}
          ratio="4:3"
          flash="off"
          enableTorch={false}
          animateShutter={false}
        />
        <View style={styles.cameraOverlay}>
          <Pressable
            style={({ pressed }) => [styles.cameraLaterBtn, pressed && styles.buttonPressed]}
            onPress={() => finishCamera(false)}
          >
            <Text style={styles.cameraLaterBtnText}>Later</Text>
          </Pressable>
          <Text style={styles.cameraHint}>
            {imageQueue.length} in queue — burst capture (no review). Done = enhance for OCR and analyze automatically.
            Later / Back = leave without sending.
          </Text>
          <View style={styles.cameraRow}>
            <Pressable style={styles.secondaryBtn} onPress={() => finishCamera(true)}>
              <Text style={styles.secondaryBtnText}>Done</Text>
            </Pressable>
            <Pressable style={[styles.cameraCaptureBtn, styles.secondaryBtnRight]} onPress={captureInCamera}>
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
      <View style={styles.mainWithKnockSlot}>
        <ScrollView
          style={styles.mainScroll}
          contentContainerStyle={styles.scroll}
          keyboardShouldPersistTaps="handled"
          nestedScrollEnabled
        >
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
          <Text style={[styles.qcmButtonText, qcmMode && styles.qcmButtonTextActive]}>QCM</Text>
        </Pressable>

        <Text style={styles.label}>Photo queue</Text>
        <Text style={styles.queueHint}>
          {imageQueue.length === 0
            ? 'No pages yet. Use Open camera (burst), then Send all.'
            : `${imageQueue.length} page(s) queued — tap Send all to prepare and analyze each page.`}
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
          onPress={() => void sendAllFromQueue()}
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
        {lastSmsResults.some((row) => displayAnswerKeyLineFromStored(row.line)) ? (
          <View style={styles.answerBox}>
            <Text style={styles.answerLabel}>Answers (this batch)</Text>
            {lastSmsResults
              .map((row, i) => ({ row, i, line: displayAnswerKeyLineFromStored(row.line) }))
              .filter((x): x is { row: LastBatchRow; i: number; line: string } => x.line != null)
              .map((x, j) => (
                <View key={`sms-result-${x.i}`} style={j > 0 ? styles.answerLineBlockSpacing : undefined}>
                  <Text style={styles.answerKeyLine} selectable>
                    {x.line}
                  </Text>
                </View>
              ))}
          </View>
        ) : null}

        <View style={styles.teamBox}>
          <View style={styles.teamLobbyHeaderRow}>
            <Text style={styles.teamLobbyTitle}>Lobby answers</Text>
            <Pressable
              style={({ pressed }) => [styles.historyClearBtn, pressed && styles.buttonPressed]}
              onPress={() => void refreshTeamSharedLogs(true)}
              disabled={sharedLogsBusy || !backendUrl.trim() || !lobbyAccessible}
            >
              <Text style={styles.historyClearBtnText}>{sharedLogsBusy ? '…' : 'Refresh'}</Text>
            </Pressable>
          </View>
          <View style={styles.teamLobbyFeedArea}>
            {teamLogsKvNotice ? <Text style={styles.teamNotice}>{teamLogsKvNotice}</Text> : null}
            {!teamLogsKvNotice && teamSharedLogs.length === 0 ? (
              <Text style={styles.teamLobbyEmptyHint}>
                {isAdminLoggedIn
                  ? 'Admin bypass active: shared lobby is accessible without sending a QCM photo first.'
                  : `QCM is on by default (glowing QCM). Photograph a real QCM sheet, then Send all. The lobby unlocks only when the model returns a valid compact key (at least ${MIN_QCM_PAIRS_ACCEPT} questions). Random photos will not qualify.`}
              </Text>
            ) : null}
            {lobbyAccessible && teamSharedLogs.length > 0 ? (
              <ScrollView style={styles.historyScroll} nestedScrollEnabled keyboardShouldPersistTaps="handled">
                {teamSharedLogs.map((row, idx) => {
                  const line = displaySharedLobbyAnswerKey(row);
                  const adminFallbackBody = isAdminLoggedIn
                    ? (typeof row.body === 'string' ? row.body.trim() : '')
                    : '';
                  const toShow = line || adminFallbackBody;
                  if (!toShow) return null;
                  return (
                    <View key={`team-${row.at ?? idx}-${idx}`} style={styles.historyRow}>
                      <Text style={line ? styles.answerKeyLine : styles.historyBody} selectable>
                        {toShow}
                      </Text>
                    </View>
                  );
                })}
              </ScrollView>
            ) : null}
          </View>
        </View>

        {lastImagePrepLines.length > 0 ? (
          <View style={[styles.prepBox, styles.prepBoxBottom]}>
            <Text style={styles.prepLabel}>Image quality / Google prep (this batch)</Text>
            {lastImagePrepLines.map((line, i) => (
              <Text key={`prep-${i}`} style={styles.prepLine}>
                {line}
              </Text>
            ))}
          </View>
        ) : null}
        {isAdminLoggedIn ? <Text style={styles.adminLoggedInBanner}>logged in as admin</Text> : null}
        </ScrollView>

        <Pressable
          style={styles.secretKnockZone}
          onPressIn={onSecretAreaPress}
          collapsable={false}
          accessibilityLabel="Admin access gesture zone"
          accessibilityRole="button"
          hitSlop={{ top: 10, bottom: 12 }}
          android_disableSound
        />
      </View>

      <Modal
        visible={adminLoginVisible}
        animationType="fade"
        transparent
        onRequestClose={() => {
          setAdminLoginVisible(false);
          setLoginPasswordDraft('');
        }}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Admin login</Text>
            <Text style={styles.modalHint}>Enter the same password as ADMIN_PANEL_PASSWORD on the server.</Text>
            <TextInput
              style={styles.input}
              value={loginPasswordDraft}
              onChangeText={setLoginPasswordDraft}
              placeholder="Admin password"
              placeholderTextColor="#94a3b8"
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry
            />
            {adminBusy ? <ActivityIndicator style={styles.modalSpinner} color="#38bdf8" /> : null}
            <View style={styles.modalRow}>
              <Pressable
                style={({ pressed }) => [styles.secondaryBtn, pressed && styles.buttonPressed]}
                onPress={() => {
                  setAdminLoginVisible(false);
                  setLoginPasswordDraft('');
                }}
              >
                <Text style={styles.secondaryBtnText}>Cancel</Text>
              </Pressable>
              <Pressable
                style={({ pressed }) => [
                  styles.modalOkBtn,
                  pressed && styles.buttonPressed,
                  adminBusy && styles.buttonDisabled,
                ]}
                onPress={() => void tryUnlockAdminPanel()}
                disabled={adminBusy}
              >
                <Text style={styles.modalBtnText}>Unlock</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      <Modal
        visible={adminPanelVisible}
        animationType="fade"
        transparent
        onRequestClose={closeAdminPanel}
      >
        <View style={styles.modalBackdrop}>
          <ScrollView
            style={styles.modalScroll}
            contentContainerStyle={styles.modalScrollInner}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            <View style={styles.modalCard}>
              <Text style={styles.modalTitle}>Admin</Text>
              <Text style={styles.modalHint}>
                After a successful admin login, your password is saved in SecureStore on this device so you stay
                signed in as admin (lobby access + history). Suspend / status / reset use that saved password.
                Save settings writes API URL, app secret, and SMS numbers to the server (Redis/KV); every device pulls
                those values when they return to the app, before sending, and about every 90 seconds in the background.
              </Text>
              {adminServerLine ? <Text style={styles.modalStatus}>{adminServerLine}</Text> : null}
              {adminBusy ? <ActivityIndicator style={styles.modalSpinner} color="#38bdf8" /> : null}

              <Text style={styles.modalSectionTitle}>Backend API URL</Text>
              <TextInput
                style={styles.modalPhoneInput}
                value={backendUrl}
                onChangeText={setBackendUrl}
                placeholder={DEFAULT_BACKEND_URL}
                placeholderTextColor="#64748b"
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
              />

              <Text style={styles.modalSectionTitle}>App secret</Text>
              <TextInput
                style={styles.modalPhoneInput}
                value={bearerToken}
                onChangeText={setBearerToken}
                placeholder="CLIENT_BEARER_TOKEN (optional)"
                placeholderTextColor="#64748b"
                autoCapitalize="none"
                autoCorrect={false}
                secureTextEntry
              />

              <Text style={styles.modalSectionTitle}>SMS numbers (up to 4)</Text>
              <Text style={styles.modalHint}>
                Country code required. Each page is sent to every filled slot with the same text.
              </Text>
              {[0, 1, 2, 3].map((i) => (
                <View key={`dest-${i}`} style={styles.modalPhoneRow}>
                  <Text style={styles.modalPhoneLabel}>{i + 1}</Text>
                  <TextInput
                    style={styles.modalPhoneInput}
                    value={phoneSlots[i] ?? ''}
                    onChangeText={(t) =>
                      setPhoneSlots((prev) => {
                        const next = [...prev];
                        next[i] = t;
                        return next;
                      })
                    }
                    placeholder="+…"
                    placeholderTextColor="#64748b"
                    keyboardType="phone-pad"
                    autoCapitalize="none"
                  />
                </View>
              ))}

              <Text style={styles.modalSectionTitle}>SMS sending (all devices)</Text>
              <Text style={styles.modalHint}>
                When disabled, every phone still analyzes images but does not send outbound SMS until you enable again.
                Requires Redis/KV on the API (same as Save settings).
              </Text>
              <View style={styles.modalRow}>
                <Pressable
                  style={({ pressed }) => [
                    styles.modalOkBtn,
                    pressed && styles.buttonPressed,
                    adminBusy && styles.buttonDisabled,
                  ]}
                  onPress={() => void pushServerSmsPolicy(true)}
                  disabled={adminBusy}
                >
                  <Text style={styles.modalBtnText}>SMS ON</Text>
                </Pressable>
                <Pressable
                  style={({ pressed }) => [
                    styles.modalDangerBtn,
                    pressed && styles.buttonPressed,
                    adminBusy && styles.buttonDisabled,
                  ]}
                  onPress={() => void pushServerSmsPolicy(false)}
                  disabled={adminBusy}
                >
                  <Text style={styles.modalBtnText}>SMS OFF</Text>
                </Pressable>
              </View>

              <Pressable
                style={({ pressed }) => [styles.button, pressed && styles.buttonPressed, adminBusy && styles.buttonDisabled]}
                onPress={() => {
                  void (async () => {
                    const pwd = adminPassword.trim();
                    if (!pwd) {
                      Alert.alert('Admin', 'Unlock the panel again with your server password, then save.');
                      return;
                    }
                    setAdminBusy(true);
                    try {
                      await persistSettings();
                      await callBackendAdmin(
                        backendUrl.trim() || DEFAULT_BACKEND_URL,
                        bearerToken || null,
                        pwd,
                        'save_network_settings',
                        {
                          network: {
                            backendUrl: backendUrl.trim(),
                            bearerToken: bearerToken.trim(),
                            phones: phoneSlots.map((s) => s.trim()),
                            smsSendingEnabled,
                          },
                        }
                      );
                      await pullNetworkSettings();
                      Alert.alert('Saved', 'Settings saved on this device and pushed to the server for all users.');
                    } catch (e) {
                      Alert.alert('Save on server', e instanceof Error ? e.message : String(e));
                    } finally {
                      setAdminBusy(false);
                    }
                  })();
                }}
                disabled={adminBusy}
              >
                <Text style={styles.buttonText}>Save settings</Text>
              </Pressable>

              <View style={styles.modalRow}>
                <Pressable
                  style={({ pressed }) => [
                    styles.modalDangerBtn,
                    pressed && styles.buttonPressed,
                    adminBusy && styles.buttonDisabled,
                  ]}
                  onPress={() => void adminSuspend()}
                  disabled={adminBusy}
                >
                  <Text style={styles.modalBtnText}>Suspend service</Text>
                </Pressable>
                <Pressable
                  style={({ pressed }) => [
                    styles.modalOkBtn,
                    pressed && styles.buttonPressed,
                    adminBusy && styles.buttonDisabled,
                  ]}
                  onPress={() => void adminResume()}
                  disabled={adminBusy}
                >
                  <Text style={styles.modalBtnText}>Activate service</Text>
                </Pressable>
              </View>
              <Pressable
                style={({ pressed }) => [
                  styles.modalDangerBtn,
                  styles.modalSingleDangerBtn,
                  pressed && styles.buttonPressed,
                  adminBusy && styles.buttonDisabled,
                ]}
                onPress={() => {
                  Alert.alert(
                    'Reset shared lobby?',
                    'This clears all shared lobby messages and relocks lobby access for normal users until they send a new valid QCM image.',
                    [
                      { text: 'Cancel', style: 'cancel' },
                      { text: 'Reset', style: 'destructive', onPress: () => void adminResetLobby() },
                    ]
                  );
                }}
                disabled={adminBusy}
              >
                <Text style={styles.modalBtnText}>Reset shared lobby</Text>
              </Pressable>
              <Pressable
                style={({ pressed }) => [
                  styles.secondaryBtn,
                  pressed && styles.buttonPressed,
                  adminBusy && styles.buttonDisabled,
                ]}
                onPress={() => void refreshAdminStatusLine()}
                disabled={adminBusy}
              >
                <Text style={styles.secondaryBtnText}>Refresh status</Text>
              </Pressable>
              <Pressable
                style={({ pressed }) => [styles.modalCloseBtn, pressed && styles.buttonPressed]}
                onPress={closeAdminPanel}
              >
                <Text style={styles.modalCloseBtnText}>Close</Text>
              </Pressable>
            </View>
          </ScrollView>
        </View>
      </Modal>

      <Modal
        visible={notifyNudgeVisible}
        transparent
        animationType="fade"
        onRequestClose={() => {
          void dismissNotifyNudge(false);
        }}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Notifications</Text>
            <Text style={styles.modalHint}>
              Turn on notifications to get a heads-up when you finish an analysis and when someone else posts a new
              answer in the shared lobby. You can change this anytime in system settings — the app works either way.
            </Text>
            <View style={styles.modalRow}>
              <Pressable
                style={({ pressed }) => [styles.secondaryBtn, pressed && styles.buttonPressed]}
                onPress={() => void dismissNotifyNudge(false)}
              >
                <Text style={styles.secondaryBtnText}>Not now</Text>
              </Pressable>
              <Pressable
                style={({ pressed }) => [styles.modalOkBtn, pressed && styles.buttonPressed]}
                onPress={() => void dismissNotifyNudge(true)}
              >
                <Text style={styles.modalBtnText}>Turn on alerts</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

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
    bottom: 112,
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 14,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    backgroundColor: 'rgba(15,23,42,0.92)',
  },
  cameraLaterBtn: {
    position: 'absolute',
    top: 10,
    right: 12,
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 8,
    backgroundColor: 'rgba(51,65,85,0.95)',
    borderWidth: 1,
    borderColor: '#475569',
    zIndex: 2,
  },
  cameraLaterBtnText: {
    color: '#e2e8f0',
    fontSize: 13,
    fontWeight: '600',
  },
  cameraHint: {
    color: '#e2e8f0',
    fontSize: 14,
    lineHeight: 20,
    marginBottom: 10,
    paddingRight: 88,
  },
  cameraRow: {
    flexDirection: 'row',
    marginTop: 6,
  },
  cameraCaptureBtn: {
    flex: 1,
    backgroundColor: '#2563eb',
    paddingVertical: 16,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  root: {
    flex: 1,
    backgroundColor: '#0f172a',
  },
  mainWithKnockSlot: {
    flex: 1,
    position: 'relative',
  },
  mainScroll: {
    flex: 1,
    marginBottom: KNOCK_ZONE_HEIGHT,
  },
  permGateRoot: {
    flex: 1,
    backgroundColor: '#0f172a',
  },
  permGateInner: {
    paddingHorizontal: 20,
    paddingBottom: 32,
  },
  permGateTitle: {
    fontSize: 22,
    fontWeight: '700',
    color: '#f8fafc',
    marginBottom: 14,
  },
  permGateBody: {
    fontSize: 15,
    color: '#94a3b8',
    lineHeight: 22,
    marginBottom: 14,
  },
  permGateEm: {
    fontWeight: '700',
    color: '#e2e8f0',
  },
  permGateSpinner: {
    marginVertical: 16,
  },
  permGatePrimaryBtn: {
    marginTop: 8,
  },
  permGateSecondaryBtn: {
    marginTop: 12,
  },
  permGateFoot: {
    marginTop: 22,
    fontSize: 12,
    color: '#64748b',
    lineHeight: 18,
  },
  googleScanBtn: {
    marginTop: 12,
    alignSelf: 'stretch',
  },
  scroll: {
    padding: 20,
    paddingTop: 44,
    paddingBottom: 28,
  },
  secretKnockZone: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: KNOCK_ZONE_HEIGHT,
    zIndex: 50,
    elevation: 24,
    backgroundColor: 'rgba(15,23,42,0.04)',
  },
  adminLoggedInBanner: {
    marginTop: 20,
    marginBottom: 8,
    color: '#ef4444',
    fontSize: 14,
    fontWeight: '700',
    textAlign: 'center',
  },
  relayRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 10,
    marginTop: 4,
  },
  relayLabel: {
    color: '#cbd5e1',
    fontSize: 14,
    fontWeight: '600',
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
    backgroundColor: '#1e293b',
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#334155',
  },
  qcmButtonActive: {
    backgroundColor: '#0369a1',
    borderColor: '#7dd3fc',
    shadowColor: '#38bdf8',
    shadowOpacity: 0.85,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 0 },
    elevation: 12,
  },
  qcmButtonText: {
    color: '#94a3b8',
    fontSize: 15,
    fontWeight: '700',
    letterSpacing: 1.2,
  },
  qcmButtonTextActive: {
    color: '#f0f9ff',
    textShadowColor: 'rgba(56, 189, 248, 0.9)',
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 8,
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
  prepBox: {
    marginTop: 14,
    backgroundColor: '#0f172a',
    borderColor: '#1e3a5f',
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
  },
  prepBoxBottom: {
    marginTop: 22,
    marginBottom: 4,
  },
  prepLabel: {
    color: '#7dd3fc',
    fontSize: 12,
    fontWeight: '600',
    marginBottom: 8,
  },
  prepLine: {
    color: '#cbd5e1',
    fontSize: 13,
    lineHeight: 20,
    marginTop: 6,
  },
  note: {
    marginTop: 28,
    fontSize: 12,
    color: '#64748b',
    lineHeight: 18,
  },
  answerBox: {
    marginTop: 18,
    backgroundColor: '#0b1220',
    borderColor: '#22c55e',
    borderWidth: 1,
    borderRadius: 16,
    padding: 16,
    shadowColor: '#000',
    shadowOpacity: 0.22,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 5,
  },
  answerLabel: {
    color: '#22c55e',
    fontSize: 13,
    fontWeight: '700',
    marginBottom: 8,
    letterSpacing: 0.2,
  },
  answerText: {
    color: '#f8fafc',
    fontSize: 22,
    fontWeight: '700',
    letterSpacing: 1,
  },
  answerLineBlockSpacing: {
    marginTop: 10,
  },
  answerLine: {
    color: '#f8fafc',
    fontSize: 19,
    fontWeight: '600',
    lineHeight: 28,
  },
  answerKeyLine: {
    color: '#e2e8f0',
    fontSize: 19,
    fontWeight: '600',
    lineHeight: 28,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    letterSpacing: 0.3,
  },
  answerModelFoot: {
    marginTop: 4,
    fontSize: 12,
    color: '#64748b',
    textTransform: 'lowercase',
  },
  historyClearBtn: {
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 8,
    backgroundColor: '#334155',
  },
  historyClearBtnText: {
    color: '#e2e8f0',
    fontSize: 12,
    fontWeight: '600',
  },
  historyScroll: {
    maxHeight: 240,
  },
  historyRow: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#334155',
    paddingTop: 10,
    paddingBottom: 4,
  },
  historyMeta: {
    color: '#94a3b8',
    fontSize: 11,
    marginBottom: 4,
  },
  historyBody: {
    color: '#e2e8f0',
    fontSize: 19,
    fontWeight: '600',
    lineHeight: 28,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    letterSpacing: 0.3,
  },
  historyModelFoot: {
    marginTop: 4,
    fontSize: 12,
    color: '#64748b',
    textTransform: 'lowercase',
  },
  teamBox: {
    marginTop: 20,
    backgroundColor: '#0b1220',
    borderColor: '#22c55e',
    borderWidth: 1,
    borderRadius: 16,
    padding: 16,
    maxHeight: 380,
    shadowColor: '#000',
    shadowOpacity: 0.24,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 5,
  },
  teamLobbyHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 10,
  },
  teamLobbyTitle: {
    color: '#22c55e',
    fontSize: 18,
    fontWeight: '700',
    letterSpacing: 0.2,
  },
  teamLobbyFeedArea: {
    minHeight: 200,
  },
  teamLobbyEmptyHint: {
    marginTop: 8,
    fontSize: 12,
    color: '#64748b',
    lineHeight: 18,
    textAlign: 'center',
    paddingHorizontal: 8,
  },
  teamNotice: {
    color: '#fbbf24',
    fontSize: 12,
    lineHeight: 18,
    marginBottom: 8,
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.65)',
    justifyContent: 'center',
    padding: 16,
  },
  modalScroll: {
    maxHeight: '92%',
  },
  modalScrollInner: {
    flexGrow: 1,
    justifyContent: 'center',
    paddingBottom: 20,
  },
  modalCard: {
    backgroundColor: '#0f172a',
    borderRadius: 14,
    padding: 18,
    borderWidth: 1,
    borderColor: '#334155',
  },
  modalTitle: {
    color: '#f8fafc',
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 10,
  },
  modalSectionTitle: {
    color: '#94a3b8',
    fontSize: 13,
    fontWeight: '700',
    marginTop: 14,
    marginBottom: 6,
  },
  modalHint: {
    color: '#64748b',
    fontSize: 12,
    lineHeight: 17,
    marginBottom: 10,
  },
  modalPhoneRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 8,
  },
  modalPhoneLabel: {
    width: 22,
    color: '#94a3b8',
    fontSize: 14,
    fontWeight: '600',
  },
  modalPhoneInput: {
    flex: 1,
    backgroundColor: '#1e293b',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    color: '#f1f5f9',
    borderWidth: 1,
    borderColor: '#334155',
  },
  modalStatus: {
    color: '#cbd5e1',
    fontSize: 14,
    lineHeight: 20,
    marginBottom: 12,
  },
  modalSpinner: {
    marginBottom: 10,
  },
  modalRow: {
    flexDirection: 'row',
    marginBottom: 10,
  },
  modalDangerBtn: {
    flex: 1,
    backgroundColor: '#7f1d1d',
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#991b1b',
  },
  modalSingleDangerBtn: {
    flex: 0,
    width: '100%',
    marginBottom: 10,
  },
  modalOkBtn: {
    flex: 1,
    marginLeft: 10,
    backgroundColor: '#14532d',
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#166534',
  },
  modalFullWidth: {
    flex: 0,
    width: '100%',
    marginTop: 10,
  },
  modalBtnText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
  modalCloseBtn: {
    marginTop: 14,
    paddingVertical: 12,
    alignItems: 'center',
  },
  modalCloseBtnText: {
    color: '#94a3b8',
    fontSize: 15,
    fontWeight: '600',
  },
});


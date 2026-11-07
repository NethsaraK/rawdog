import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  View,
  Text,
  TextInput,
  Modal,
  ScrollView,
  StyleSheet,
  PanResponder,
  KeyboardAvoidingView,
  Platform,
  Alert,
  StatusBar,
  Animated,
  Easing,
  Pressable,
  LayoutAnimation,
  UIManager,
  Linking,
  useWindowDimensions,
} from "react-native";
import { SafeAreaView, SafeAreaProvider } from "react-native-safe-area-context";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SystemUI from "expo-system-ui";
import * as Haptics from "expo-haptics";
import { useAudioPlayer, setAudioModeAsync } from "expo-audio";
import * as Notifications from "expo-notifications";
import * as Updates from "expo-updates";
import Constants from "expo-constants";
import { File, Directory, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import * as Print from "expo-print";
import * as DocumentPicker from "expo-document-picker";
import { BlurView } from "expo-blur";

// (no-op, and logs a warning, on the New Architecture, so only call it on the old one)
if (Platform.OS === "android" && UIManager.setLayoutAnimationEnabledExperimental && !global.nativeFabricUIManager) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const STORAGE_KEY = "gym-tracker-v1";
const KG_TO_LBS = 2.20462262185;

// ---------- animation speed (changed from Settings) ----------
// 1 = normal, 2 = twice as fast, 0.5 = half speed. Read each time an animation starts.
let animSpeed = 1;
const D = (ms) => ms / animSpeed;
const springTo = (value, toValue, { friction = 7, tension = 90, useNativeDriver = true } = {}) =>
  Animated.spring(value, {
    toValue,
    friction: friction * animSpeed,
    tension: tension * animSpeed * animSpeed,
    useNativeDriver,
  });
const pressTo = (value, toValue, bounciness) =>
  Animated.spring(value, { toValue, speed: 30 * animSpeed, bounciness, useNativeDriver: true });

// Expo Go can't bundle a custom notification sound, so it falls back to the default one there
const IN_EXPO_GO = Constants.executionEnvironment === "storeClient";
const CHANNEL_ID = IN_EXPO_GO ? "break-timer-default" : "break-timer";

// while the app is open the in-app alarm handles things, so stay quiet
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: false,
    shouldShowBanner: false,
    shouldShowList: false,
    shouldPlaySound: false,
    shouldSetBadge: false,
  }),
});

const C = {
  bg: "#0E1114",
  card: "#181C20",
  raised: "#20252A",
  ink: "#F1F3F5",
  mute: "#8A939B",
  line: "#2B3138",
  accent: "#5B7CFF",
  accentText: "#FFFFFF",
  danger: "#FF6B5E",
};

// ---------- accent color (hue slider) ----------
const DEFAULT_HUE = 228;
const HUE_STOPS = Array.from({ length: 60 }, (_, i) => i * 6);

function hslToRgb(h, sat, l) {
  sat /= 100;
  l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = sat * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0), f(8), f(4)];
}

function hslToHex(h, sat, l) {
  const hex = (x) => Math.round(255 * x).toString(16).padStart(2, "0");
  const [r, g, b] = hslToRgb(h, sat, l);
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

// updates the accent and rebuilds the styles; callers re-render afterwards
function applyAccent(hue) {
  C.accent = hslToHex(hue, 100, 68);
  const [r, g, b] = hslToRgb(hue, 100, 68);
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  C.accentText = lum > 0.62 ? "#0E1114" : "#FFFFFF"; // dark text on yellow/green
  s = makeStyles();
}

// ---------- helpers ----------
const pad = (n) => String(n).padStart(2, "0");
const toKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

// Date (in the current week, Mon-based) for a given day index 0..5
function dateForDayIndex(idx) {
  const now = new Date();
  const sinceMonday = (now.getDay() + 6) % 7; // Mon=0 ... Sun=6
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - sinceMonday + idx);
}

function prettyDate(key) {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function initialDayIndex() {
  const js = new Date().getDay(); // Sun=0
  return js === 0 ? 6 : js - 1; // Monday=0 ... Sunday=6
}

// next day (dir = 1) or previous day (dir = -1) that is switched on in Settings
function nextEnabled(from, enabled, dir) {
  for (let i = 1; i <= DAYS.length; i++) {
    const idx = (from + dir * i + DAYS.length * 2) % DAYS.length;
    if (enabled[idx]) return idx;
  }
  return from;
}

// date key for today shifted by `offset` days (0 = today, -1 = yesterday)
const dayKeyOffset = (offset) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return toKey(d);
};

// the most recently logged intensity, or null if nothing has been logged
const latestLogged = (history) => {
  let best = null;
  for (const l of history) if (l && l.intensity && (!best || l.date > best.date)) best = l;
  return best ? best.intensity : null;
};

// ---------- same-name workouts are ONE workout ----------
// Every workout carries a `logId`. Workouts with the same name (any day, any capitalisation)
// share one logId, so their logged intensities live in one shared history: logs[logId].
const normName = (n) => String(n || "").trim().toLowerCase().replace(/\s+/g, " ");
const logIdOf = (w) => (w && (w.logId || w.id)) || "";

// merge two history lists; on the same date the entry in `base` wins
const mergeHistory = (base, extra) => {
  const dates = new Set(base.map((l) => l.date));
  return [...base, ...extra.filter((l) => !dates.has(l.date))];
};

// gives same-name workouts one shared logId (and one spelling) and merges their histories
function mergeSameName(workouts, logs) {
  const seen = new Map(); // normalized name -> { logId, name }
  const outLogs = { ...(logs || {}) };
  const out = workouts.map((w) => {
    const own = logIdOf(w);
    const key = normName(w.name);
    const first = seen.get(key);
    if (!first) {
      seen.set(key, { logId: own, name: w.name });
      return { ...w, logId: own };
    }
    if (first.logId !== own && outLogs[own]) {
      outLogs[first.logId] = mergeHistory(outLogs[first.logId] || [], outLogs[own]);
      delete outLogs[own];
    }
    return { ...w, name: first.name, logId: first.logId };
  });
  return { workouts: out, logs: outLogs };
}

const metaLine = (w) => (w.intensity ? `${w.setsReps}  ·  ${w.intensity}` : w.setsReps);

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

const animateLayout = () =>
  LayoutAnimation.configureNext({
    duration: D(220),
    create: { type: "easeInEaseOut", property: "opacity" },
    update: { type: "easeInEaseOut" },
    delete: { type: "easeInEaseOut", property: "opacity" },
  });

// keep digits and a single dot (commas count as dots)
function sanitizeNumber(text) {
  let out = "";
  let hasDot = false;
  for (const ch of text.replace(/,/g, ".")) {
    if (ch >= "0" && ch <= "9") out += ch;
    else if (ch === "." && !hasDot) {
      out += ".";
      hasDot = true;
    }
  }
  return out;
}

const clockText = (ms) => {
  const total = Math.ceil(Math.max(ms, 0) / 1000);
  return `${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
};

const formatConverted = (n) => String(parseFloat(n.toFixed(2)));

// ---------- .rwdg routine files ----------
// A .rwdg file is plain JSON: the workouts (day, name, sets x reps, starting intensity)
// plus optional day titles. Each workout can also carry its logged intensities ("logs"),
// but only when "Include my progress" was ticked while exporting.
// Files without dayTitles or logs import fine.
const ROUTINE_TYPE = "rwdg-routine";

const cleanFileName = (raw) => {
  const name = String(raw || "")
    .replace(/\.(rwdg|json|pdf)$/i, "")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "")
    .replace(/^[.\s]+|[.\s]+$/g, "")
    .slice(0, 60);
  return name || "routine";
};

const LOG_DATE = /^\d{4}-\d{2}-\d{2}$/;

const countLogEntries = (workouts, logs) => {
  const ids = new Set(workouts.map(logIdOf)); // shared histories are counted once
  let n = 0;
  for (const id of ids) n += ((logs && logs[id]) || []).length;
  return n;
};

// ---- documentation written into every exported file, so a person (or an AI) can understand it ----
const ROUTINE_DOCS = {
  purpose:
    'This file stores a weekly gym routine for the "Rawdog" workout tracker app. It exists so a routine can be backed up, shared with someone else, or written by hand / by an AI, and then imported back into the app. Importing it sets up the workouts for each weekday (and the logged progress, if the file contains any).',
  fields: [
    ["type", 'Always the text "rwdg-routine". The app uses it to recognise this kind of file. Do not change it.'],
    ["version", "Version of the file format (a number). Currently 1."],
    ["name", "Name of this routine (text). Usually the file name without its extension."],
    ["exportedAt", "When the file was created, as an ISO 8601 date-time text, e.g. \"2026-11-03T09:30:00.000Z\"."],
    [
      "includesProgress",
      'true or false. true means the logged intensities (progress history) were exported into each workout\'s "logs" list. false means the logs lists are empty because progress was not exported.',
    ],
    [
      "dayTitles",
      'Optional short label for each weekday, shown on the home screen next to the day name (for example "Wednesday: Back"). Keys are the day numbers "0" to "6" (0 = Monday, 1 = Tuesday, 2 = Wednesday, 3 = Thursday, 4 = Friday, 5 = Saturday, 6 = Sunday). Values are short text (max 24 characters). Use "" for no title.',
    ],
    [
      "workouts",
      "The list of workouts in the routine, one object per exercise. It is an empty list [] when no workouts have been added yet. A day can have any number of workouts and they are shown in list order.",
    ],
  ],
  workoutFields: [
    ["day", 'Which weekday the workout belongs to: a number from 0 to 6 (0 = Monday, 1 = Tuesday, 2 = Wednesday, 3 = Thursday, 4 = Friday, 5 = Saturday, 6 = Sunday). Day names such as "Monday" are also accepted when importing. Required.'],
    ["name", 'Name of the exercise, e.g. "Bench press". Text, max 100 characters. Required.'],
    ["setsReps", 'Reps and sets written as REPSxSETS, e.g. "10x3" means 10 reps for 3 sets. Free text, max 40 characters.'],
    ["intensity", 'The starting (planned) intensity, i.e. the weight used. Free text that includes its unit, e.g. "11kg" or "25lbs". Use "" if there is none. Max 40 characters.'],
    ["logs", 'The progress history of this workout: a list of {date, intensity} objects, oldest first. It is an empty list [] when progress was not exported or nothing has been logged yet.'],
  ],
  logFields: [
    ["date", 'The day the intensity was logged, as YYYY-MM-DD, e.g. "2026-11-03". Only one entry per date.'],
    ["intensity", 'The intensity (weight) used that day. Free text that includes its unit, e.g. "12kg" or "30lbs".'],
  ],
  howTo: [
    'To create or edit a routine by hand (or with an AI): keep every key, add one object per exercise to the "workouts" list, and fill in any day titles you want. Leave unused values as empty text ("") or an empty list ([]).',
    "To import: in the Rawdog app open Settings, then Routine, then Import, and pick this file (or open the file on a phone that has the app installed).",
    "If the app already has workouts, it asks whether to add the imported ones to them or replace them. Day titles and logged progress in the file come along, and every day that has workouts in the file is switched on automatically.",
    "Only the keys described here are read. A workout without a name or with an invalid day is skipped.",
  ],
};

const EXAMPLE_ROUTINE = {
  type: ROUTINE_TYPE,
  version: 1,
  name: "push-pull-legs",
  exportedAt: "2026-11-03T09:30:00.000Z",
  includesProgress: true,
  dayTitles: { 0: "Push", 1: "Pull", 2: "Legs", 3: "", 4: "", 5: "", 6: "" },
  workouts: [
    {
      day: 0,
      name: "Bench press",
      setsReps: "10x3",
      intensity: "40kg",
      logs: [
        { date: "2026-10-27", intensity: "40kg" },
        { date: "2026-11-03", intensity: "42.5kg" },
      ],
    },
    { day: 2, name: "Squat", setsReps: "8x4", intensity: "60kg", logs: [] },
  ],
};

const wrapText = (text, width = 84) => {
  const lines = [];
  let line = "";
  for (const word of String(text).split(/\s+/)) {
    if (line && (line + " " + word).length > width) {
      lines.push(line);
      line = word;
    } else {
      line = line ? line + " " + word : word;
    }
  }
  if (line) lines.push(line);
  return lines;
};

const commentLines = (text, indent = "", prefix = "// ") =>
  wrapText(text).map((l) => indent + prefix + l);

// "- item" bullet; wrapped lines are indented under the text instead of repeating the dash
const bulletLines = (text, indent = "") =>
  wrapText(text).map((l, i) => indent + (i === 0 ? "//   - " : "//     ") + l);

const jsonLines = (value, indent, prefix) =>
  JSON.stringify(value, null, 2)
    .split("\n")
    .map((l) => indent + prefix + l);

// every key is always present, even in an empty routine
function buildRoutineData(name, workouts, dayTitles, logs) {
  const titles = {};
  for (let i = 0; i < DAYS.length; i++) titles[String(i)] = String((dayTitles && dayTitles[i]) || "").trim();
  const list = [...workouts]
    .sort((a, b) => a.day - b.day)
    .map(({ id, logId, day, name: n, setsReps, intensity }) => {
      const history = logs
        ? (logs[logId || id] || [])
            .filter((l) => l && LOG_DATE.test(l.date) && l.intensity)
            .map((l) => ({ date: l.date, intensity: String(l.intensity) }))
            .sort((a, b) => (a.date < b.date ? -1 : 1))
        : [];
      return { day, name: n, setsReps: setsReps || "", intensity: intensity || "", logs: history };
    });
  return {
    type: ROUTINE_TYPE,
    version: 1,
    name,
    exportedAt: new Date().toISOString(),
    includesProgress: !!logs,
    dayTitles: titles,
    workouts: list,
  };
}

// .rwdg: JSON with // comments explaining every part of the file
function buildRwdgText(data) {
  const I = "  ";
  const bar = "// " + "=".repeat(70);
  const out = [
    bar,
    "// RAWDOG WORKOUT ROUTINE FILE (.rwdg)",
    bar,
    "//",
    ...commentLines("PURPOSE: " + ROUTINE_DOCS.purpose),
    "//",
    ...commentLines(
      'FORMAT: JSON with "//" line comments (like this text). The app ignores the comments when it reads the file, so they can be kept or deleted. A .json export of the same routine is plain JSON and keeps this explanation in a "_readme" key instead. Every key below is always present, even when its value is empty.'
    ),
    "//",
    "// HOW TO USE THIS FILE:",
    ...ROUTINE_DOCS.howTo.flatMap((t) => bulletLines(t)),
    "//",
    "// EXAMPLE OF A FILLED-IN FILE (the real data starts below the example):",
    ...jsonLines(EXAMPLE_ROUTINE, "", "//   "),
    bar,
    "",
    "{",
  ];

  const keys = Object.keys(data);
  keys.forEach((key, idx) => {
    const doc = ROUTINE_DOCS.fields.find(([k]) => k === key);
    out.push(...commentLines(`"${key}": ${doc ? doc[1] : ""}`, I));
    if (key === "workouts") {
      out.push(I + "//", I + "// Each workout object has these keys (all always present):");
      for (const [k, d] of ROUTINE_DOCS.workoutFields) out.push(...bulletLines(`"${k}": ${d}`, I));
      out.push(I + "//", I + '// Each object inside a workout\'s "logs" list has these keys:');
      for (const [k, d] of ROUTINE_DOCS.logFields) out.push(...bulletLines(`"${k}": ${d}`, I));
      out.push(I + "//", I + "// Example of one workout object:");
      out.push(...jsonLines(EXAMPLE_ROUTINE.workouts[0], I, "//   "));
    }
    const json = JSON.stringify(data[key], null, 2).split("\n").join("\n" + I);
    out.push(`${I}"${key}": ${json}${idx === keys.length - 1 ? "" : ","}`);
    if (idx !== keys.length - 1) out.push("");
  });
  out.push("}", "");
  return out.join("\n");
}

// .json: strict JSON (no comments allowed), so the explanation lives in a "_readme" key
function buildJsonText(data) {
  const fields = {};
  for (const [k, d] of ROUTINE_DOCS.fields) fields[k] = d;
  const workoutFields = {};
  for (const [k, d] of ROUTINE_DOCS.workoutFields) workoutFields[k] = d;
  const logFields = {};
  for (const [k, d] of ROUTINE_DOCS.logFields) logFields[k] = d;
  const readme = {
    purpose: ROUTINE_DOCS.purpose,
    format:
      'Plain JSON. Keys that start with an underscore (like this "_readme") are documentation only and are ignored by the app when importing. Every key is always present, even when its value is empty.',
    howToUse: ROUTINE_DOCS.howTo,
    fields,
    "fields_of_each_item_in_workouts": workoutFields,
    "fields_of_each_item_in_a_workouts_logs_list": logFields,
    example: EXAMPLE_ROUTINE,
  };
  return JSON.stringify({ _readme: readme, ...data }, null, 2);
}

// pass `logs` to include progress, or null/undefined to leave it out. format: "rwdg" | "json"
function buildRoutineText(name, workouts, dayTitles, logs, format = "rwdg") {
  const data = buildRoutineData(name, workouts, dayTitles, logs);
  return format === "json" ? buildJsonText(data) : buildRwdgText(data);
}

const FORMAT_INFO = {
  rwdg: { mime: "application/octet-stream", uti: "public.data" },
  json: { mime: "application/json", uti: "public.json" },
  pdf: { mime: "application/pdf", uti: "com.adobe.pdf" },
};

function writeRoutineFile(fileName, workouts, dayTitles, logs, format = "rwdg") {
  const name = cleanFileName(fileName);
  const file = new File(Paths.cache, `${name}.${format}`);
  if (file.exists) file.delete();
  file.create();
  file.write(buildRoutineText(name, workouts, dayTitles, logs, format));
  return { file, name };
}

// ---------- PDF chart of the routine ----------
const escapeHtml = (t) =>
  String(t).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const hexToRgba = (hex, alpha) => {
  const n = parseInt(String(hex).replace("#", ""), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
};

// Dark, rounded "chart" of every workout, one card per day, in the app's current accent color.
function buildPdfHtml(workouts, dayTitles, logs) {
  const accent = C.accent;
  const accentSoft = hexToRgba(accent, 0.15); // tinted pill background (works on older WebViews too)
  const byDay = DAYS.map((_, i) => workouts.filter((w) => w.day === i));
  const maxCount = Math.max(1, ...byDay.map((l) => l.length));
  const usedDays = byDay.filter((l) => l.length > 0).length;
  const dateText = new Date().toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });
  // same rule as the homepage: the latest logged intensity, else the one entered when adding
  const intensityOf = (w) => latestLogged((logs && logs[logIdOf(w)]) || []) || w.intensity || "";

  const bars = DAYS.map(
    (d, i) => `
      <div class="bar-row">
        <div class="bar-label">${d.slice(0, 3)}</div>
        <div class="bar-track"><div class="bar-fill" style="width:${(byDay[i].length / maxCount) * 100}%"></div></div>
        <div class="bar-count">${byDay[i].length}</div>
      </div>`
  ).join("");

  const cards = byDay
    .map((list, i) => {
      if (list.length === 0) return "";
      const title = ((dayTitles && dayTitles[i]) || "").trim();
      const rows = list
        .map((w) => {
          const inten = intensityOf(w);
          return `
          <div class="row">
            <div class="c-name">${escapeHtml(w.name)}</div>
            <div class="c-reps">${w.setsReps ? `<span class="tag">${escapeHtml(w.setsReps)}</span>` : '<span class="none">&mdash;</span>'}</div>
            <div class="c-int">${inten ? escapeHtml(inten) : '<span class="none">&mdash;</span>'}</div>
          </div>`;
        })
        .join("");
      return `
      <section class="card">
        <div class="card-head">
          <div class="day">${DAYS[i]}</div>
          ${title ? `<div class="pill">${escapeHtml(title)}</div>` : ""}
          <div class="count">${list.length} exercise${list.length === 1 ? "" : "s"}</div>
        </div>
        <div class="row head">
          <div class="c-name">Exercise</div>
          <div class="c-reps">Reps &times; sets</div>
          <div class="c-int">Intensity</div>
        </div>
        ${rows}
      </section>`;
    })
    .join("");

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  @page { margin: 0; }
  * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  html, body { margin: 0; padding: 0; background: #0E1114; }
  body {
    color: #F1F3F5;
    font-family: -apple-system, "Helvetica Neue", Roboto, "Segoe UI", Arial, sans-serif;
    padding: 36px;
  }
  h1 { font-size: 30px; font-weight: 800; letter-spacing: -0.6px; margin: 0; }
  .sub { color: #8A939B; font-size: 12px; margin-top: 6px; }
  .panel, .card {
    background: #181C20;
    border: 1px solid #2B3138;
    border-radius: 18px;
    padding: 16px 20px;
    margin-top: 18px;
    page-break-inside: avoid;
    break-inside: avoid;
  }
  .panel-title { font-size: 12px; font-weight: 700; color: #8A939B; margin-bottom: 10px; }
  .bar-row { display: flex; align-items: center; margin: 7px 0; }
  .bar-label { width: 38px; font-size: 12px; font-weight: 700; color: #8A939B; }
  .bar-track { flex: 1; height: 10px; border-radius: 5px; background: #0E1114; overflow: hidden; }
  .bar-fill { height: 10px; border-radius: 5px; background: ${accent}; }
  .bar-count { width: 26px; text-align: right; font-size: 12px; font-weight: 700; }
  .card-head { display: flex; align-items: center; margin-bottom: 10px; }
  .day { font-size: 20px; font-weight: 800; letter-spacing: -0.4px; }
  .pill {
    margin-left: 10px;
    padding: 3px 11px;
    border-radius: 999px;
    background: ${accentSoft};
    color: ${accent};
    font-size: 12px;
    font-weight: 700;
  }
  .count { margin-left: auto; font-size: 12px; color: #8A939B; }
  .row { display: flex; align-items: center; padding: 9px 0; border-top: 1px solid #2B3138; font-size: 13px; }
  .row.head { border-top: none; padding: 2px 0 7px; font-size: 11px; font-weight: 700; color: #8A939B; }
  .c-name { flex: 1; font-weight: 700; padding-right: 10px; }
  .row.head .c-name { font-weight: 700; }
  .c-reps { width: 110px; }
  .c-int { width: 120px; text-align: right; font-weight: 800; color: ${accent}; }
  .row.head .c-int { color: #8A939B; font-weight: 700; }
  .tag { display: inline-block; padding: 3px 10px; border-radius: 8px; background: #0E1114; border: 1px solid #2B3138; font-weight: 700; }
  .none { color: #8A939B; font-weight: 400; }
  .footer { margin-top: 28px; text-align: right; font-size: 12px; color: #8A939B; }
  .footer b { color: ${accent}; font-weight: 800; }
</style>
</head>
<body>
  <h1>Workout routine</h1>
  <div class="sub">${workouts.length} exercise${workouts.length === 1 ? "" : "s"} across ${usedDays} day${usedDays === 1 ? "" : "s"} &middot; ${escapeHtml(dateText)}</div>

  <div class="panel">
    <div class="panel-title">Exercises per day</div>
    ${bars}
  </div>

  ${cards}

  <div class="footer">Chart produced by <b>Rawdog</b></div>
</body>
</html>`;
}

// base64 text -> bytes (so the PDF can be written without reading expo-print's temp file back)
function base64ToBytes(b64) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const lookup = new Uint8Array(256);
  for (let i = 0; i < chars.length; i++) lookup[chars.charCodeAt(i)] = i;
  const clean = String(b64).replace(/[^A-Za-z0-9+/]/g, "");
  const len = clean.length;
  const bytes = new Uint8Array(Math.floor((len * 3) / 4));
  let p = 0;
  for (let i = 0; i < len; i += 4) {
    const a = lookup[clean.charCodeAt(i)];
    const b = lookup[clean.charCodeAt(i + 1)];
    const c = lookup[clean.charCodeAt(i + 2)];
    const d = lookup[clean.charCodeAt(i + 3)];
    bytes[p++] = (a << 2) | (b >> 4);
    if (i + 2 < len) bytes[p++] = ((b & 15) << 4) | (c >> 2);
    if (i + 3 < len) bytes[p++] = ((c & 3) << 6) | d;
  }
  return bytes;
}

// Makes the PDF (never for an empty routine) as a file named <name>.pdf in the app's cache.
// expo-print hands back the PDF as base64, so we write our own copy instead of copying its temp
// file (copying it fails with "Missing READ permission" on some devices).
async function writePdfFile(fileName, workouts, dayTitles, logs) {
  if (!workouts || workouts.length === 0) throw new Error("NO_WORKOUTS");
  const name = cleanFileName(fileName);
  const printed = await Print.printToFileAsync({
    html: buildPdfHtml(workouts, dayTitles, logs),
    width: 595,
    height: 842,
    base64: true,
  });
  const bytes = base64ToBytes(printed.base64);
  const file = new File(Paths.cache, `${name}.pdf`);
  if (file.exists) await file.delete();
  await file.create();
  await file.write(bytes);
  return { file, name, bytes };
}

// removes // and /* */ comments (outside of quoted text) so commented .rwdg files can be parsed
function stripJsonComments(text) {
  const src = String(text).replace(/^\uFEFF/, "");
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const next = src[i + 1];
    if (inString) {
      out += c;
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
    } else if (c === "/" && next === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && next === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i++;
    } else {
      out += c;
    }
  }
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DOWNLOAD_DIR_KEY = "rwdg-download-dir";
const isCancelError = (e) =>
  /cancel|dismiss|abort|denied by user/i.test(`${(e && e.code) || ""} ${(e && e.message) || ""}`);
const folderLabel = (uri) => {
  try {
    return decodeURIComponent(String(uri)).split(/[:/]/).filter(Boolean).pop() || "the folder";
  } catch (e) {
    return "the folder";
  }
};

async function readTextFromUri(uri) {
  try {
    return await new File(uri).text();
  } catch (e) {
    const res = await fetch(uri);
    return await res.text();
  }
}

// day number 0-6 or a day name ("Monday" / "mon"); -1 if it isn't a day
function parseDay(v) {
  const t = String(v == null ? "" : v).trim().toLowerCase();
  if (/^\d+$/.test(t)) {
    const n = Number(t);
    return n >= 0 && n < DAYS.length ? n : -1;
  }
  return DAYS.findIndex((d) => d.toLowerCase() === t || d.toLowerCase().slice(0, 3) === t);
}

// throws if the file isn't a valid routine
function parseRoutine(text) {
  const data = JSON.parse(stripJsonComments(text));
  if (!data || data.type !== ROUTINE_TYPE || !Array.isArray(data.workouts)) {
    throw new Error("Not a routine file");
  }
  const workouts = [];
  for (const w of data.workouts.slice(0, 500)) {
    if (!w || typeof w.name !== "string" || !w.name.trim()) continue;
    const day = parseDay(w.day);
    if (day < 0) continue;
    const logs = [];
    if (Array.isArray(w.logs)) {
      const seen = new Set();
      for (const l of w.logs.slice(0, 2000)) {
        if (!l || typeof l.date !== "string" || !LOG_DATE.test(l.date) || seen.has(l.date)) continue;
        const val = String(l.intensity == null ? "" : l.intensity).trim().slice(0, 40);
        if (!val) continue;
        seen.add(l.date);
        logs.push({ date: l.date, intensity: val });
      }
    }
    workouts.push({
      day,
      name: w.name.trim().slice(0, 100),
      setsReps: String(w.setsReps == null ? "" : w.setsReps).trim().slice(0, 40),
      intensity: String(w.intensity == null ? "" : w.intensity).trim().slice(0, 40),
      logs,
    });
  }
  if (workouts.length === 0) throw new Error("EMPTY_ROUTINE");
  const dayTitles = {};
  if (data.dayTitles && typeof data.dayTitles === "object") {
    for (let i = 0; i < DAYS.length; i++) {
      const t = data.dayTitles[i];
      if (typeof t === "string" && t.trim()) dayTitles[i] = t.trim().slice(0, 24);
    }
  }
  return {
    name: typeof data.name === "string" ? data.name.slice(0, 60) : "",
    workouts,
    dayTitles,
    hasLogs: workouts.some((w) => w.logs.length > 0),
  };
}

// ---------- animation building blocks ----------

// Fade + slide up on mount
function Enter({ delay = 0, distance = 18, style, children }) {
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(v, {
      toValue: 1,
      duration: D(320),
      delay: D(delay),
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, []);
  return (
    <Animated.View
      style={[
        style,
        {
          opacity: v,
          transform: [{ translateY: v.interpolate({ inputRange: [0, 1], outputRange: [distance, 0] }) }],
        },
      ]}
    >
      {children}
    </Animated.View>
  );
}

// Scale + fade on mount (for the popup)
function PopIn({ style, children }) {
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    springTo(v, 1).start();
  }, []);
  return (
    <Animated.View
      style={[
        style,
        {
          opacity: v.interpolate({ inputRange: [0, 1], outputRange: [0, 1], extrapolate: "clamp" }),
          transform: [{ scale: v.interpolate({ inputRange: [0, 1], outputRange: [0.9, 1] }) }],
        },
      ]}
    >
      {children}
    </Animated.View>
  );
}

// Pressable that springs down while held
function Press({ style, outerStyle, onPress, scaleTo = 0.96, children, ...rest }) {
  const scale = useRef(new Animated.Value(1)).current;
  const to = (value, bounciness) => pressTo(scale, value, bounciness).start();
  return (
    <Animated.View style={[outerStyle, { transform: [{ scale }] }]}>
      <Pressable
        onPressIn={() => to(scaleTo, 0)}
        onPressOut={() => to(1, 10)}
        onPress={onPress}
        style={style}
        {...rest}
      >
        {children}
      </Pressable>
    </Animated.View>
  );
}

// Day indicator dot that stretches when active
function Dot({ active }) {
  const v = useRef(new Animated.Value(active ? 1 : 0)).current;
  useEffect(() => {
    springTo(v, active ? 1 : 0, { useNativeDriver: false }).start();
  }, [active]);
  return (
    <Animated.View
      style={{
        height: 8,
        borderRadius: 4,
        width: v.interpolate({ inputRange: [0, 1], outputRange: [8, 24] }),
        backgroundColor: v.interpolate({ inputRange: [0, 1], outputRange: [C.line, C.accent] }),
      }}
    />
  );
}

// ---------- workout card ----------
function WorkoutCard({ workout, index, history, onPress }) {
  const enter = useRef(new Animated.Value(0)).current;
  const scale = useRef(new Animated.Value(1)).current;
  const pop = useRef(new Animated.Value(1)).current;
  // The accent-colored value stays for the whole current week (Monday to Sunday).
  // When a new week starts (Monday) it disappears, so intensities can be logged fresh.
  const weekStart = toKey(dateForDayIndex(0));
  const weekEnd = toKey(dateForDayIndex(6));
  let weekEntry = null;
  for (const l of history) {
    if (l && l.intensity && l.date >= weekStart && l.date <= weekEnd && (!weekEntry || l.date > weekEntry.date)) {
      weekEntry = l;
    }
  }
  const labelFor = (date) => {
    if (date === dayKeyOffset(0)) return "Today";
    if (date === dayKeyOffset(-1)) return "Yesterday";
    const [y, m, d] = date.split("-").map(Number);
    return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: "short" });
  };
  const recent = weekEntry ? { label: labelFor(weekEntry.date), intensity: weekEntry.intensity } : null;
  // next to the reps: the latest logged intensity (falls back to the one entered when adding the workout)
  const latest = latestLogged(history) || workout.intensity;
  const lastValue = useRef(recent ? recent.intensity : null);

  useEffect(() => {
    Animated.timing(enter, {
      toValue: 1,
      duration: D(340),
      delay: D(index * 70),
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, []);

  // bounce the logged value when it changes
  const current = recent ? recent.intensity : null;
  useEffect(() => {
    if (current !== lastValue.current && current) {
      pop.setValue(1.35);
      springTo(pop, 1, { friction: 4, tension: 120 }).start();
    }
    lastValue.current = current;
  }, [current]);

  const to = (value, bounciness) => pressTo(scale, value, bounciness).start();

  return (
    <Animated.View
      style={{
        opacity: enter,
        transform: [
          { translateY: enter.interpolate({ inputRange: [0, 1], outputRange: [20, 0] }) },
          { scale },
        ],
      }}
    >
      <Pressable
        style={s.card}
        onPressIn={() => to(0.97, 0)}
        onPressOut={() => to(1, 10)}
        onPress={onPress}
      >
        <View style={{ flex: 1 }}>
          <Text style={s.cardName}>{workout.name}</Text>
          <Text style={s.cardMeta}>{metaLine({ setsReps: workout.setsReps, intensity: latest })}</Text>
        </View>
        {recent ? (
          <View style={s.logged}>
            <Text style={s.loggedLabel}>{recent.label}</Text>
            <Animated.Text style={[s.loggedValue, { transform: [{ scale: pop }] }]}>
              {recent.intensity}
            </Animated.Text>
          </View>
        ) : null}
      </Pressable>
    </Animated.View>
  );
}

// ---------- lbs <-> kg converter ----------
// The card on the homepage shows the values; tapping either field opens a blurred popup to edit them.
function Converter() {
  const [kg, setKg] = useState("");
  const [lbs, setLbs] = useState("");
  const [open, setOpen] = useState(null); // null | "kg" | "lbs"

  const onKg = (text) => {
    const clean = sanitizeNumber(text);
    setKg(clean);
    const n = parseFloat(clean);
    setLbs(Number.isFinite(n) ? formatConverted(n * KG_TO_LBS) : "");
  };

  const onLbs = (text) => {
    const clean = sanitizeNumber(text);
    setLbs(clean);
    const n = parseFloat(clean);
    setKg(Number.isFinite(n) ? formatConverted(n / KG_TO_LBS) : "");
  };

  const clear = () => {
    setKg("");
    setLbs("");
  };

  const close = () => setOpen(null);

  return (
    <View style={s.converter}>
      <View style={s.converterHeader}>
        <Text style={s.converterTitle}>Weight converter</Text>
        {(kg !== "" || lbs !== "") && (
          <Pressable onPress={clear} hitSlop={10}>
            <Text style={s.link}>Clear</Text>
          </Pressable>
        )}
      </View>

      <View style={s.converterRow}>
        <View style={s.converterField}>
          <Text style={s.converterLabel}>kg</Text>
          <Pressable style={s.converterInput} onPress={() => setOpen("kg")}>
            <Text style={[s.converterValue, kg === "" && { color: C.mute }]}>{kg === "" ? "0" : kg}</Text>
          </Pressable>
        </View>
        <Text style={s.converterArrow}>⇄</Text>
        <View style={s.converterField}>
          <Text style={s.converterLabel}>lbs</Text>
          <Pressable style={s.converterInput} onPress={() => setOpen("lbs")}>
            <Text style={[s.converterValue, lbs === "" && { color: C.mute }]}>{lbs === "" ? "0" : lbs}</Text>
          </Pressable>
        </View>
      </View>

      <Modal visible={open !== null} transparent animationType="fade" onRequestClose={close}>
        <KeyboardAvoidingView
          style={s.blurWrap}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
          <BlurView
            intensity={45}
            tint="dark"
            experimentalBlurMethod="dimezisBlurView"
            style={StyleSheet.absoluteFill}
          />
          <View style={[StyleSheet.absoluteFill, { backgroundColor: "rgba(0,0,0,0.35)" }]} />
          <Pressable style={StyleSheet.absoluteFill} onPress={close} />

          {open !== null && (
            <PopIn style={s.sheet}>
              <View style={s.sheetHeader}>
                <Text style={s.sheetTitle}>Weight converter</Text>
                <Pressable onPress={close} hitSlop={10} style={s.closeBtn} accessibilityLabel="Close">
                  <Text style={s.closeText}>✕</Text>
                </Pressable>
              </View>

              <View style={s.convModalField}>
                <Text style={s.convModalLabel}>Kilograms</Text>
                <View style={s.convModalInputRow}>
                  <TextInput
                    style={s.convModalInput}
                    value={kg}
                    onChangeText={onKg}
                    placeholder="0"
                    placeholderTextColor={C.mute}
                    keyboardType="decimal-pad"
                    keyboardAppearance="dark"
                    autoFocus={open === "kg"}
                    selectTextOnFocus
                  />
                  <Text style={s.convModalUnit}>kg</Text>
                </View>
              </View>

              <Text style={s.convModalSwap}>⇅</Text>

              <View style={s.convModalField}>
                <Text style={s.convModalLabel}>Pounds</Text>
                <View style={s.convModalInputRow}>
                  <TextInput
                    style={s.convModalInput}
                    value={lbs}
                    onChangeText={onLbs}
                    placeholder="0"
                    placeholderTextColor={C.mute}
                    keyboardType="decimal-pad"
                    keyboardAppearance="dark"
                    autoFocus={open === "lbs"}
                    selectTextOnFocus
                  />
                  <Text style={s.convModalUnit}>lbs</Text>
                </View>
              </View>

              <View style={[s.sheetButtons, { marginTop: 28 }]}>
                <Press onPress={clear} style={s.secondaryBtn}>
                  <Text style={s.secondaryBtnText}>Clear</Text>
                </Press>
                <Press outerStyle={{ flex: 1 }} onPress={close} style={[s.primaryBtn, { marginTop: 0 }]}>
                  <Text style={s.primaryBtnText}>Done</Text>
                </Press>
              </View>
            </PopIn>
          )}
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

// ---------- app ----------
function Main() {
  const [workouts, setWorkouts] = useState([]); // {id, day, name, setsReps, intensity}
  const [logs, setLogs] = useState({}); // { [workoutId]: [{date, intensity}] }
  const [loaded, setLoaded] = useState(false);

  const [dayIdx, setDayIdx] = useState(initialDayIndex());
  const [enabledDays, setEnabledDays] = useState(DAYS.map(() => true));
  const [dayTitles, setDayTitles] = useState({}); // { [dayIndex]: "Back" }
  const setDayTitle = (i, text) => setDayTitles((prev) => ({ ...prev, [i]: text }));
  const enabledRef = useRef(enabledDays);
  enabledRef.current = enabledDays;

  // if the day on screen gets switched off (or isn't enabled at start), jump to the next one that is on
  useEffect(() => {
    if (!enabledDays[dayIdx]) setDayIdx(nextEnabled(dayIdx, enabledDays, 1));
  }, [enabledDays]);

  const toggleDay = (i) =>
    setEnabledDays((prev) => {
      if (prev[i] && prev.filter(Boolean).length === 1) return prev; // keep at least one day on
      const next = [...prev];
      next[i] = !next[i];
      return next;
    });
  const [showEditor, setShowEditor] = useState(false);
  const [activeWorkout, setActiveWorkout] = useState(null);
  const [speed, setSpeed] = useState(1);
  const [showSettings, setShowSettings] = useState(false);

  const changeSpeed = (v) => {
    animSpeed = v;
    setSpeed(v);
  };

  // accent color (hue 0..360)
  const [hue, setHue] = useState(DEFAULT_HUE);
  const changeHue = (h) => {
    applyAccent(h);
    setHue(h);
  };

  // ----- break timer -----
  const [showTimer, setShowTimer] = useState(false);
  const [timerStatus, setTimerStatus] = useState("idle"); // idle | running | paused | done
  const [timerMinutes, setTimerMinutes] = useState(1);
  const [timerSeconds, setTimerSeconds] = useState(30);
  const [timerTotal, setTimerTotal] = useState(0); // seconds
  const [remainingMs, setRemainingMs] = useState(0);
  const endAtRef = useRef(0);
  const player = useAudioPlayer(require("./assets/timer.mp3"));
  const holdPlayer = useAudioPlayer(require("./assets/timer2.mp3"));

  useEffect(() => {
    setAudioModeAsync({ playsInSilentMode: true }).catch(() => {});
  }, []);

  // keeps ringing: after each play ends, wait 2 seconds and play again until stopped
  const ringingRef = useRef(false);
  const ringTimeout = useRef(null);

  useEffect(() => {
    const sub = player.addListener("playbackStatusUpdate", (status) => {
      if (status.didJustFinish && ringingRef.current) {
        clearTimeout(ringTimeout.current);
        ringTimeout.current = setTimeout(() => {
          if (!ringingRef.current) return;
          try {
            player.seekTo(0);
            player.play();
          } catch (e) {}
        }, 2000);
      }
    });
    return () => {
      sub.remove();
      clearTimeout(ringTimeout.current);
    };
  }, [player]);

  const ringSound = () => {
    ringingRef.current = true;
    try {
      player.seekTo(0);
      player.play();
    } catch (e) {}
  };
  const stopSound = () => {
    ringingRef.current = false;
    clearTimeout(ringTimeout.current);
    try {
      player.pause();
      player.seekTo(0);
    } catch (e) {}
  };

  useEffect(() => {
    if (timerStatus !== "running") return;
    const id = setInterval(() => {
      const left = endAtRef.current - Date.now();
      if (left <= 0) {
        clearInterval(id);
        setRemainingMs(0);
        setTimerStatus("done");
        cancelTimerNotification();
        Notifications.dismissAllNotificationsAsync().catch(() => {});
        ringSound();
        try {
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        } catch (e) {}
        setShowTimer(true);
      } else {
        setRemainingMs(left);
      }
    }, 200);
    return () => clearInterval(id);
  }, [timerStatus]);

  // ----- background notification (rings when the app isn't open) -----
  const notifIdRef = useRef(null);
  const notifToken = useRef(0);

  useEffect(() => {
    if (Platform.OS !== "android") return;
    Notifications.setNotificationChannelAsync(CHANNEL_ID, {
      name: "Break timer",
      importance: Notifications.AndroidImportance.MAX,
      sound: IN_EXPO_GO ? "default" : "timer.mp3",
      vibrationPattern: [0, 400, 200, 400],
    }).catch(() => {});
  }, []);

  const cancelTimerNotification = async () => {
    notifToken.current += 1;
    const id = notifIdRef.current;
    notifIdRef.current = null;
    if (!id) return;
    try {
      await Notifications.cancelScheduledNotificationAsync(id);
    } catch (e) {}
  };

  const scheduleTimerNotification = async (endAtMs) => {
    try {
      await cancelTimerNotification();
      const mine = ++notifToken.current;
      let perm = await Notifications.getPermissionsAsync();
      if (!perm.granted) perm = await Notifications.requestPermissionsAsync();
      if (!perm.granted || endAtMs <= Date.now()) return;
      const date = new Date(endAtMs);
      const T = Notifications.SchedulableTriggerInputTypes;
      const id = await Notifications.scheduleNotificationAsync({
        content: {
          title: "Break's over!",
          body: "Back to the next set 💪",
          sound: IN_EXPO_GO ? true : "timer.mp3",
        },
        trigger: T
          ? { type: T.DATE, date, channelId: CHANNEL_ID }
          : { date, channelId: CHANNEL_ID },
      });
      if (notifToken.current !== mine) {
        // timer was paused/cancelled while we were scheduling
        Notifications.cancelScheduledNotificationAsync(id).catch(() => {});
      } else {
        notifIdRef.current = id;
      }
    } catch (e) {
      console.warn("Could not schedule timer notification", e);
    }
  };

  const stepMinutes = (d) => setTimerMinutes((m) => (m + d + 60) % 60);
  const stepSeconds = (d) => setTimerSeconds((v) => (v + d + 60) % 60);

  const startTimer = () => {
    const total = timerMinutes * 60 + timerSeconds;
    if (total === 0) return;
    stopSound();
    endAtRef.current = Date.now() + total * 1000;
    setTimerTotal(total);
    setRemainingMs(total * 1000);
    setTimerStatus("running");
    scheduleTimerNotification(endAtRef.current);
  };
  const pauseTimer = () => {
    setRemainingMs(Math.max(endAtRef.current - Date.now(), 0));
    setTimerStatus("paused");
    cancelTimerNotification();
  };
  const resumeTimer = () => {
    endAtRef.current = Date.now() + remainingMs;
    setTimerStatus("running");
    scheduleTimerNotification(endAtRef.current);
  };
  const cancelTimer = () => {
    stopSound();
    setTimerStatus("idle");
    cancelTimerNotification();
    Notifications.dismissAllNotificationsAsync().catch(() => {});
  };

  // press and hold the timer button:
  //  - timer running or paused -> cancel it
  //  - otherwise -> buzz, play timer2.mp3 once, and start with the time set last
  const quickRestartTimer = () => {
    if (timerStatus === "running" || timerStatus === "paused") {
      try {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      } catch (e) {}
      cancelTimer();
      return;
    }
    if (timerMinutes * 60 + timerSeconds === 0) {
      setShowTimer(true);
      return;
    }
    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
    } catch (e) {}
    try {
      holdPlayer.seekTo(0);
      holdPlayer.play();
    } catch (e) {}
    startTimer();
  };

  // title slide animation
  const dirRef = useRef(0);
  const titleX = useRef(new Animated.Value(0)).current;
  const titleOpacity = useRef(new Animated.Value(1)).current;
  const firstRender = useRef(true);

  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    titleX.setValue(dirRef.current * 60);
    titleOpacity.setValue(0);
    Animated.parallel([
      springTo(titleX, 0, { friction: 8, tension: 80 }),
      Animated.timing(titleOpacity, { toValue: 1, duration: D(220), useNativeDriver: true }),
    ]).start();
  }, [dayIdx]);

  // load + save
  useEffect(() => {
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(STORAGE_KEY);
        if (raw) {
          const data = JSON.parse(raw);
          // older saves may hold the same workout several times: fold them into one
          const merged = mergeSameName(data.workouts || [], data.logs || {});
          setWorkouts(merged.workouts);
          setLogs(merged.logs);
          setDayTitles(data.dayTitles || {});
          const saved = data.settings && data.settings.speed;
          if (saved) {
            animSpeed = saved;
            setSpeed(saved);
          }
          const st = data.settings || {};
          if (Number.isFinite(st.hue)) {
            applyAccent(st.hue);
            setHue(st.hue);
          }
          if (Number.isInteger(st.timerMinutes)) setTimerMinutes(st.timerMinutes);
          if (Number.isInteger(st.timerSeconds)) setTimerSeconds(st.timerSeconds);
          if (
            Array.isArray(st.enabledDays) &&
            st.enabledDays.length === DAYS.length &&
            st.enabledDays.some(Boolean)
          ) {
            setEnabledDays(st.enabledDays);
          }
        }
      } catch (e) {
        console.warn("Load failed", e);
      }
      setLoaded(true);
    })();
  }, []);

  useEffect(() => {
    if (!loaded) return;
    AsyncStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        workouts,
        logs,
        dayTitles,
        settings: { speed, timerMinutes, timerSeconds, enabledDays, hue },
      })
    ).catch((e) => console.warn("Save failed", e));
  }, [workouts, logs, dayTitles, speed, timerMinutes, timerSeconds, enabledDays, hue, loaded]);

  // swipe anywhere: right = previous visible day, left = next visible day
  const swipe = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponderCapture: (_, g) =>
        Math.abs(g.dx) > 12 && Math.abs(g.dx) > Math.abs(g.dy),
      onPanResponderRelease: (_, g) => {
        if (g.dx > 40) {
          dirRef.current = -1;
          setDayIdx((d) => nextEnabled(d, enabledRef.current, -1));
        } else if (g.dx < -40) {
          dirRef.current = 1;
          setDayIdx((d) => nextEnabled(d, enabledRef.current, 1));
        }
      },
    })
  ).current;

  const todaysWorkouts = useMemo(
    () => workouts.filter((w) => w.day === dayIdx),
    [workouts, dayIdx]
  );

  const dateKey = toKey(dateForDayIndex(dayIdx));

  // adding a workout whose name already exists links it to that workout (shared history)
  const addWorkout = (w) =>
    setWorkouts((prev) => {
      const match = prev.find((x) => normName(x.name) === normName(w.name));
      const id = uid();
      return [
        ...prev,
        {
          ...w,
          name: match ? match.name : w.name,
          id,
          logId: match ? logIdOf(match) : id,
          createdAt: toKey(new Date()),
        },
      ];
    });

  // sets/reps and planned intensity belong to this day; the name belongs to the whole workout
  const updateWorkout = (id, fields) => {
    const prev = workoutsRef.current;
    const cur = prev.find((w) => w.id === id);
    if (!cur) return;
    const { name, ...rest } = fields;
    const myLog = logIdOf(cur);
    let next = prev.map((w) => (w.id === id ? { ...w, ...rest } : w));
    if (name !== undefined && name !== cur.name) {
      // renaming into another existing workout joins that workout; otherwise rename them all
      const target = prev.find((x) => logIdOf(x) !== myLog && normName(x.name) === normName(name));
      if (target) {
        const targetLog = logIdOf(target);
        next = next.map((w) => (logIdOf(w) === myLog ? { ...w, name: target.name, logId: targetLog } : w));
        setLogs((l) => {
          if (!l[myLog]) return l;
          const out = { ...l, [targetLog]: mergeHistory(l[targetLog] || [], l[myLog]) };
          delete out[myLog];
          return out;
        });
      } else {
        next = next.map((w) => (logIdOf(w) === myLog ? { ...w, name } : w));
      }
    }
    setWorkouts(next);
  };

  // history is only deleted together with the last day that still uses the workout
  const removeWorkout = (id) => {
    const cur = workoutsRef.current.find((w) => w.id === id);
    if (!cur) return;
    const myLog = logIdOf(cur);
    const stillUsed = workoutsRef.current.some((w) => w.id !== id && logIdOf(w) === myLog);
    setWorkouts((prev) => prev.filter((w) => w.id !== id));
    if (!stillUsed) {
      setLogs((prev) => {
        const next = { ...prev };
        delete next[myLog];
        return next;
      });
    }
  };

  // ----- importing a .rwdg routine -----
  const workoutsRef = useRef(workouts);
  workoutsRef.current = workouts;
  const logsRef = useRef(logs);
  logsRef.current = logs;

  const applyRoutine = (routine, mode) => {
    const today = toKey(new Date());
    // logs only come along when the file has them; otherwise nothing about logs changes
    const incomingLogs = {};
    let logCount = 0;
    const incoming = routine.workouts.map(({ logs: fileLogs, ...w }) => {
      const id = uid();
      if (fileLogs && fileLogs.length) {
        incomingLogs[id] = fileLogs;
        logCount += fileLogs.length;
      }
      return { ...w, id, createdAt: today };
    });
    // same-name workouts (in the file, or already in the app) end up as one workout
    const base = mode === "replace" ? { w: [], l: {} } : { w: workoutsRef.current, l: logsRef.current };
    const merged = mergeSameName([...base.w, ...incoming], { ...base.l, ...incomingLogs });
    setWorkouts(merged.workouts);
    setLogs(merged.logs);
    const incomingTitles = routine.dayTitles || {};
    setDayTitles((prev) => {
      if (mode === "replace") return { ...incomingTitles };
      const merged = { ...prev }; // keep titles you already have
      for (const k of Object.keys(incomingTitles)) {
        if (!(merged[k] && merged[k].trim())) merged[k] = incomingTitles[k];
      }
      return merged;
    });
    // make sure every day used by the routine is visible
    const used = new Set(routine.workouts.map((w) => w.day));
    setEnabledDays((prev) => prev.map((on, i) => on || used.has(i)));
    setShowSettings(false);
    Alert.alert(
      "Routine imported",
      `${incoming.length} workout${incoming.length === 1 ? "" : "s"} ${mode === "replace" ? "set up" : "added"}` +
        (logCount > 0 ? ` with ${logCount} logged intensit${logCount === 1 ? "y" : "ies"}.` : ".")
    );
  };

  const handleIncomingFile = async (uri) => {
    let routine;
    try {
      routine = parseRoutine(await readTextFromUri(uri));
    } catch (e) {
      if (e && e.message === "EMPTY_ROUTINE") {
        Alert.alert("Nothing to import", "This routine file is valid, but it has no workouts in it yet.");
      } else {
        Alert.alert("Couldn't open file", "This doesn't look like a valid workout routine file (.rwdg or .json).");
      }
      return;
    }
    // nothing to lose: just set it up
    if (workoutsRef.current.length === 0) {
      applyRoutine(routine, "replace");
      return;
    }
    const count = routine.workouts.length;
    Alert.alert(
      routine.name ? `Import “${routine.name}”?` : "Import routine?",
      `${count} workout${count === 1 ? "" : "s"} found${routine.hasLogs ? ", including logged progress" : ""}. Replacing removes your current workouts and their logged intensities.`,
      [
        { text: "Cancel", style: "cancel" },
        { text: "Add to mine", onPress: () => applyRoutine(routine, "add") },
        { text: "Replace mine", style: "destructive", onPress: () => applyRoutine(routine, "replace") },
      ]
    );
  };
  const incomingRef = useRef(handleIncomingFile);
  incomingRef.current = handleIncomingFile;

  // manual import from the Settings panel (also works in Expo Go)
  const pickImport = async () => {
    setShowSettings(false);
    await new Promise((r) => setTimeout(r, 350));
    try {
      const res = await DocumentPicker.getDocumentAsync({
        type: "*/*",
        copyToCacheDirectory: true,
        multiple: false,
      });
      if (res.canceled || !res.assets || !res.assets[0]) return;
      const asset = res.assets[0];
      if (asset.name && !/\.(rwdg|json)$/i.test(asset.name)) {
        Alert.alert("Wrong file type", "Pick a file that ends in .rwdg or .json");
        return;
      }
      await handleIncomingFile(asset.uri);
    } catch (e) {
      Alert.alert("Couldn't open file", "Something went wrong while opening that file.");
    }
  };

  // tapping a .rwdg file on the phone opens the app with its address (real builds only)
  useEffect(() => {
    if (!loaded) return;
    const isFile = (url) => typeof url === "string" && /^(content|file):/i.test(url);
    Linking.getInitialURL()
      .then((url) => {
        if (isFile(url)) incomingRef.current(url);
      })
      .catch(() => {});
    const sub = Linking.addEventListener("url", ({ url }) => {
      if (isFile(url)) incomingRef.current(url);
    });
    return () => sub.remove();
  }, [loaded]);

  const logIntensity = (workoutId, date, intensity) => {
    setLogs((prev) => {
      const list = (prev[workoutId] || []).filter((l) => l.date !== date);
      return { ...prev, [workoutId]: [...list, { date, intensity }] };
    });
  };

  // "Wednesday" or, when the day has a title, "Wednesday: Back" in a smaller size that fits one row
  const { width: screenWidth } = useWindowDimensions();
  const dayLabel = (dayTitles[dayIdx] || "").trim();
  const headerText = dayLabel ? `${DAYS[dayIdx]}: ${dayLabel}` : DAYS[dayIdx];
  const headerSize = dayLabel
    ? Math.max(22, Math.min(40, (screenWidth - 40) / (headerText.length * 0.58)))
    : 52;

  return (
    <SafeAreaView style={s.safe}>
      <StatusBar hidden translucent backgroundColor={C.bg} />

      <View style={{ flex: 1 }} {...swipe.panHandlers}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <Enter distance={-14} style={s.topBar}>
          <Press
            outerStyle={{ flex: 1 }}
            style={s.addBtn}
            onPress={() => setShowEditor(true)}
            scaleTo={0.97}
          >
            <Text style={s.addBtnText}>Add/ Edit workouts</Text>
          </Press>
          <Press
            style={[s.settingsBtn, timerStatus !== "idle" && s.timerActive]}
            onPress={() => setShowTimer(true)}
            onLongPress={quickRestartTimer}
            delayLongPress={450}
            scaleTo={0.9}
            accessibilityLabel="Break timer"
          >
            <TimerIcon active={timerStatus !== "idle"} />
          </Press>
          <Press
            style={s.settingsBtn}
            onPress={() => setShowSettings(true)}
            scaleTo={0.9}
            accessibilityLabel="Settings"
          >
            <SlidersIcon />
          </Press>
        </Enter>

        <View style={s.header}>
          <Animated.Text
            numberOfLines={1}
            adjustsFontSizeToFit
            minimumFontScale={0.6}
            style={[
              s.dayTitle,
              { fontSize: headerSize, letterSpacing: -headerSize * 0.03 },
              { opacity: titleOpacity, transform: [{ translateX: titleX }] },
            ]}
          >
            {DAYS[dayIdx]}
            {dayLabel ? (
              <>
                <Text>:</Text>
                <Text style={{ fontWeight: "400" }}>{` ${dayLabel}`}</Text>
              </>
            ) : null}
          </Animated.Text>
          <View style={s.dots}>
            {DAYS.map((_, i) => i)
              .filter((i) => enabledDays[i])
              .map((i) => (
                <Dot key={i} active={i === dayIdx} />
              ))}
          </View>
          <Text style={s.hint}>Swipe anywhere to change day</Text>
        </View>

        <ScrollView
          contentContainerStyle={s.list}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {todaysWorkouts.length === 0 ? (
            <Enter key={`empty-${dayIdx}`} style={s.empty}>
              <Text style={s.emptyTitle}>Nothing planned for {DAYS[dayIdx]}</Text>
              <Text style={s.emptyBody}>Tap “Add/ Edit workouts” to build this day.</Text>
            </Enter>
          ) : (
            todaysWorkouts.map((w, i) => (
              <WorkoutCard
                key={w.id}
                workout={w}
                index={i}
                history={logs[logIdOf(w)] || []}
                onPress={() => setActiveWorkout(w)}
              />
            ))
          )}

          <Enter delay={250}>
            <Converter />
          </Enter>
        </ScrollView>
      </KeyboardAvoidingView>
      </View>

      <EditorModal
        visible={showEditor}
        onClose={() => setShowEditor(false)}
        workouts={workouts}
        logs={logs}
        onAdd={addWorkout}
        onEdit={updateWorkout}
        dayTitles={dayTitles}
        onChangeDayTitle={setDayTitle}
        onRemove={removeWorkout}
        initialDay={dayIdx}
        enabledDays={enabledDays}
      />

      <IntensityModal
        workout={activeWorkout}
        history={activeWorkout ? logs[logIdOf(activeWorkout)] || [] : []}
        dateKey={dateKey}
        onClose={() => setActiveWorkout(null)}
        onSave={(value) => {
          logIntensity(logIdOf(activeWorkout), dateKey, value);
          setActiveWorkout(null);
        }}
      />
      <TimerModal
        visible={showTimer}
        onClose={() => setShowTimer(false)}
        status={timerStatus}
        remainingMs={remainingMs}
        total={timerTotal}
        minutes={timerMinutes}
        seconds={timerSeconds}
        onStepMinutes={stepMinutes}
        onStepSeconds={stepSeconds}
        onStart={startTimer}
        onPause={pauseTimer}
        onResume={resumeTimer}
        onCancel={cancelTimer}
      />

      <SettingsModal
        visible={showSettings}
        speed={speed}
        onChange={changeSpeed}
        hue={hue}
        onChangeHue={changeHue}
        enabledDays={enabledDays}
        onToggleDay={toggleDay}
        workouts={workouts}
        logs={logs}
        dayTitles={dayTitles}
        onPickImport={pickImport}
        onClose={() => setShowSettings(false)}
      />
    </SafeAreaView>
  );
}

// ---------- add / edit workouts ----------
function EditorModal({
  visible,
  onClose,
  workouts,
  logs,
  onAdd,
  onEdit,
  onRemove,
  initialDay,
  enabledDays,
  dayTitles,
  onChangeDayTitle,
}) {
  const [day, setDay] = useState(initialDay);
  const [name, setName] = useState("");
  const [setsReps, setSetsReps] = useState("");
  const [intensity, setIntensity] = useState("");
  const [editingId, setEditingId] = useState(null); // id of the workout being edited, if any
  const [picked, setPicked] = useState(""); // normalized name of a suggestion that was just chosen
  const scrollRef = useRef(null);

  const clearForm = () => {
    setPicked("");
    setName("");
    setSetsReps("");
    setIntensity("");
    setEditingId(null);
  };

  useEffect(() => {
    if (visible) setDay(initialDay);
    else clearForm();
  }, [visible]);

  const dayWorkouts = workouts.filter((w) => w.day === day);

  // one entry per existing workout (same name = same workout), matching what is being typed
  const suggestions = useMemo(() => {
    const q = normName(name);
    if (editingId || !q || q === picked) return [];
    const byLog = new Map();
    for (const w of workouts) byLog.set(logIdOf(w), w); // latest entry represents the workout
    const out = [];
    for (const [lid, w] of byLog) {
      const n = normName(w.name);
      if (!(n.includes(q) || (n.length >= 3 && q.includes(n)))) continue;
      out.push({
        name: w.name,
        setsReps: w.setsReps,
        intensity: latestLogged(logs[lid] || []) || w.intensity || "",
        onThisDay: dayWorkouts.some((d) => logIdOf(d) === lid),
        exact: n === q,
      });
    }
    out.sort((a, b) => Number(b.exact) - Number(a.exact) || a.name.localeCompare(b.name));
    return out.slice(0, 5);
  }, [name, workouts, logs, day, editingId, picked]);

  const pickSuggestion = (sg) => {
    setName(sg.name);
    setSetsReps(sg.setsReps || "");
    setIntensity(sg.intensity || "");
    setPicked(normName(sg.name));
  };

  // tap a workout: load its details into the form (tap it again to stop editing)
  const startEdit = (w) => {
    if (editingId === w.id) {
      clearForm();
      return;
    }
    setEditingId(w.id);
    setName(w.name);
    setSetsReps(w.setsReps);
    setIntensity(w.intensity || "");
    if (scrollRef.current) scrollRef.current.scrollTo({ y: 0, animated: true });
  };

  const submit = () => {
    if (!name.trim() || !setsReps.trim()) {
      Alert.alert("Missing info", "Fill in the workout name and reps x sets.");
      return;
    }
    const clash = dayWorkouts.find((w) => w.id !== editingId && normName(w.name) === normName(name));
    if (clash) {
      Alert.alert("Already added", `${clash.name} is already on ${DAYS[day]}. Tap it below to edit it.`);
      return;
    }
    animateLayout();
    const fields = { name: name.trim(), setsReps: setsReps.trim(), intensity: intensity.trim() };
    if (editingId) onEdit(editingId, fields);
    else onAdd({ day, ...fields });
    clearForm();
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={s.safe}>
        <StatusBar hidden translucent backgroundColor={C.bg} />
        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
          <View style={s.editorHeader}>
            <Text style={s.editorTitle}>Add/ Edit workouts</Text>
            <Pressable onPress={onClose} hitSlop={10}>
              <Text style={s.link}>Done</Text>
            </Pressable>
          </View>

          <View style={s.chipsWrap}>
            {DAYS.map((d, i) => !enabledDays[i] ? null : (
              <Press
                key={d}
                outerStyle={{ flex: 1 }}
                onPress={() => {
                  if (i === day) return;
                  animateLayout();
                  clearForm();
                  setDay(i);
                }}
                style={[s.chip, i === day && s.chipActive]}
                scaleTo={0.92}
              >
                <Text style={[s.chipText, i === day && s.chipTextActive]}>{d.slice(0, 3)}</Text>
              </Press>
            ))}
          </View>

          <ScrollView
            ref={scrollRef}
            contentContainerStyle={{ padding: 20, paddingBottom: 40 }}
            keyboardShouldPersistTaps="handled"
          >
            {/* form on top */}
            <View style={s.formHeader}>
              <Text style={[s.sectionTitle, { marginBottom: 0 }]}>
                {editingId ? "Edit workout" : "New workout"}
              </Text>
              {editingId ? (
                <Pressable onPress={clearForm} hitSlop={10}>
                  <Text style={s.link}>Cancel</Text>
                </Pressable>
              ) : null}
            </View>
            <TextInput
              style={s.input}
              placeholder="Workout name"
              placeholderTextColor={C.mute}
              keyboardAppearance="dark"
              value={name}
              onChangeText={setName}
            />
            {suggestions.length > 0 ? (
              <View style={s.suggestBox}>
                <Text style={s.suggestHead}>Already in your workouts</Text>
                {suggestions.map((sg) => (
                  <Pressable
                    key={sg.name}
                    disabled={sg.onThisDay}
                    onPress={() => pickSuggestion(sg)}
                    style={[s.suggestRow, sg.onThisDay && { opacity: 0.45 }]}
                  >
                    <Text style={s.suggestName}>{sg.name}</Text>
                    <Text style={s.suggestMeta}>
                      {sg.onThisDay ? `Already on ${DAYS[day]}` : metaLine(sg)}
                    </Text>
                  </Pressable>
                ))}
              </View>
            ) : null}
            <TextInput
              style={s.input}
              placeholder="Reps x sets, e.g. 10x3"
              placeholderTextColor={C.mute}
              keyboardAppearance="dark"
              value={setsReps}
              onChangeText={setSetsReps}
              autoCapitalize="none"
            />
            <TextInput
              style={s.input}
              placeholder="Intensity (optional), e.g. 11kg or 25lbs"
              placeholderTextColor={C.mute}
              keyboardAppearance="dark"
              value={intensity}
              onChangeText={setIntensity}
              autoCapitalize="none"
            />
            <Press style={s.primaryBtn} onPress={submit}>
              <Text style={s.primaryBtnText}>{editingId ? "Edit" : `Add to ${DAYS[day]}`}</Text>
            </Press>

            {/* workouts below */}
            <View style={s.dayHeadRow}>
              <Text style={s.dayHeadName}>{DAYS[day]}</Text>
              <TextInput
                style={s.dayTitleInput}
                placeholder="Title, e.g. Back"
                placeholderTextColor={C.mute}
                keyboardAppearance="dark"
                value={dayTitles[day] || ""}
                onChangeText={(t) => onChangeDayTitle(day, t)}
                maxLength={24}
              />
            </View>

            {dayWorkouts.length === 0 ? (
              <Text style={s.mutedText}>No workouts yet for this day.</Text>
            ) : (
              <Text style={[s.mutedText, { marginBottom: 10 }]}>Tap a workout to edit it.</Text>
            )}
            {dayWorkouts.map((w) => (
              <Press
                key={w.id}
                scaleTo={0.98}
                onPress={() => startEdit(w)}
                style={[s.editRow, w.id === editingId && s.editRowActive]}
              >
                <View style={{ flex: 1 }}>
                  <Text style={s.cardName}>{w.name}</Text>
                  <Text style={s.cardMeta}>{metaLine(w)}</Text>
                </View>
                <Pressable
                  hitSlop={10}
                  onPress={() =>
                    Alert.alert(
                      "Delete workout?",
                      workouts.some((o) => o.id !== w.id && logIdOf(o) === logIdOf(w))
                        ? `${w.name} will be removed from ${DAYS[day]}. Its logged history is kept because it's on other days too.`
                        : `${w.name} and its logged history will be removed.`,
                      [
                      { text: "Cancel", style: "cancel" },
                      {
                        text: "Delete",
                        style: "destructive",
                        onPress: () => {
                          animateLayout();
                          if (w.id === editingId) clearForm();
                          onRemove(w.id);
                        },
                      },
                    ])
                  }
                >
                  <Text style={[s.link, { color: C.danger }]}>Delete</Text>
                </Pressable>
              </Press>
            ))}
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
}

// ---------- intensity popup ----------
function IntensityModal({ workout, history, dateKey, onClose, onSave }) {
  const [value, setValue] = useState("");

  useEffect(() => {
    if (workout) {
      const existing = history.find((h) => h.date === dateKey);
      setValue(existing ? existing.intensity : "");
    }
  }, [workout]);

  const sorted = [...history].sort((a, b) => (a.date < b.date ? 1 : -1));

  return (
    <Modal visible={!!workout} transparent animationType="fade" onRequestClose={onClose}>
      <KeyboardAvoidingView
        style={s.backdrop}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
        {workout && (
          <PopIn style={s.sheet}>
            <Text style={s.sheetTitle}>{workout.name}</Text>
            <Text style={s.cardMeta}>
              {workout.intensity
                ? `${workout.setsReps}  ·  planned ${workout.intensity}`
                : workout.setsReps}
            </Text>

            <Text style={[s.sectionTitle, { marginTop: 18 }]}>Previous intensities</Text>
            <View style={s.historyBox}>
              <ScrollView nestedScrollEnabled snapToInterval={52} decelerationRate="fast">
                {sorted.length === 0 && !workout.intensity ? (
                  <Text style={[s.mutedText, { padding: 12 }]}>Nothing logged yet.</Text>
                ) : (
                  <>
                    {sorted.map((h) => (
                      <View key={h.date} style={s.historyRow}>
                        <Text style={s.historyDate}>{prettyDate(h.date)}</Text>
                        <Text style={s.historyValue}>{h.intensity}</Text>
                      </View>
                    ))}
                    {workout.intensity ? (
                      <View style={s.historyRow}>
                        <View>
                          <Text style={s.historyDate}>Starting intensity</Text>
                          {workout.createdAt ? (
                            <Text style={s.historyNote}>Added {prettyDate(workout.createdAt)}</Text>
                          ) : null}
                        </View>
                        <Text style={s.historyValue}>{workout.intensity}</Text>
                      </View>
                    ) : null}
                  </>
                )}
              </ScrollView>
            </View>

            <Text style={[s.sectionTitle, { marginTop: 18 }]}>Intensity for {prettyDate(dateKey)}</Text>
            <TextInput
              style={s.input}
              placeholder="e.g. 12kg or 30lbs"
              placeholderTextColor={C.mute}
              keyboardAppearance="dark"
              value={value}
              onChangeText={setValue}
              autoCapitalize="none"
            />

            <View style={s.sheetButtons}>
              <Press onPress={onClose} style={s.secondaryBtn}>
                <Text style={s.secondaryBtnText}>Cancel</Text>
              </Press>
              <Press
                outerStyle={{ flex: 1 }}
                onPress={() => value.trim() && onSave(value.trim())}
                style={[s.primaryBtn, { marginTop: 0 }]}
              >
                <Text style={s.primaryBtnText}>Save intensity</Text>
              </Press>
            </View>
          </PopIn>
        )}
      </KeyboardAvoidingView>
    </Modal>
  );
}

// ---------- break-length commentary ----------
// min = total seconds at which the message kicks in
const VERDICTS = [
  { min: 0, level: 0, text: "Pick a time, any time." },
  { min: 1, level: 0, text: "Adequate." },
  { min: 361, level: 1, text: "Are you serious?" },
  { min: 600, level: 6, text: "That's it. I'm calling your mother. 📞" },
  { min: 900, level: 7, text: "Your gym membership has quietly become a timeshare." },
  { min: 1200, level: 8, text: "Historians will remember this as The Great Nap. 💀" },
  { min: 1800, level: 9, text: "Blink twice if you've set up a hammock." },
  { min: 2700, level: 10, text: "Go home. We love you. The weights will wait. Probably. 🕯️" },
];

const verdictIndex = (total) => {
  let idx = 0;
  for (let i = 0; i < VERDICTS.length; i++) if (total >= VERDICTS[i].min) idx = i;
  return idx;
};

const verdictColor = (level) => {
  if (level === 0) return C.mute;
  if (level === 1) return "#F5A524";
  if (level <= 3) return "#FF8A3D";
  return C.danger;
};

function BreakVerdict({ total }) {
  const idx = verdictIndex(total);
  const v = VERDICTS[idx];
  const pop = useRef(new Animated.Value(1)).current;
  const wob = useRef(new Animated.Value(0)).current;
  const prevIdx = useRef(idx);

  // pop each time the message changes
  useEffect(() => {
    if (idx === prevIdx.current) return;
    prevIdx.current = idx;
    pop.setValue(0.8);
    springTo(pop, 1, { friction: 5, tension: 140 }).start();
  }, [idx]);

  // the further past 6 minutes, the more the text trembles
  const amp = v.level >= 3 ? Math.min(0.7 * (v.level - 2), 4) : 0;
  useEffect(() => {
    if (amp === 0) {
      wob.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(wob, { toValue: 1, duration: D(90), easing: Easing.linear, useNativeDriver: true }),
        Animated.timing(wob, { toValue: -1, duration: D(180), easing: Easing.linear, useNativeDriver: true }),
        Animated.timing(wob, { toValue: 0, duration: D(90), easing: Easing.linear, useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [amp]);

  return (
    <View style={s.verdictBox}>
      <Animated.Text
        style={[
          s.verdict,
          v.level >= 6 && { fontSize: 18 },
          {
            color: verdictColor(v.level),
            transform: [
              { scale: pop },
              {
                rotate: wob.interpolate({
                  inputRange: [-1, 1],
                  outputRange: [`-${amp}deg`, `${amp}deg`],
                }),
              },
            ],
          },
        ]}
      >
        {v.text}
      </Animated.Text>
    </View>
  );
}

// ---------- break timer ----------
// `active` = the button is filled with the accent color, so use the accent's readable text color
// (dark on light accents like yellow/green, white on dark ones)
function TimerIcon({ active }) {
  const ink = active ? C.accentText : C.ink;
  return (
    <View style={{ width: 24, height: 28, alignItems: "center" }}>
      <View style={{ width: 8, height: 3, borderRadius: 1, backgroundColor: ink, marginBottom: 1 }} />
      <View
        style={{
          width: 22,
          height: 22,
          borderRadius: 11,
          borderWidth: 2.5,
          borderColor: ink,
          alignItems: "center",
        }}
      >
        <View style={{ width: 2, height: 7, borderRadius: 1, backgroundColor: ink, marginTop: 2 }} />
      </View>
    </View>
  );
}

const STEP_PX = 30;
const tick = () => {
  try {
    Haptics.selectionAsync();
  } catch (e) {}
};

// A card you swipe up/down on; the number flips in each time it changes
function FlipCard({ value, label, onStep }) {
  const flip = useRef(new Animated.Value(0)).current;
  const prev = useRef(value);
  const acc = useRef(0);
  const lastDy = useRef(0);
  const stepRef = useRef(onStep);
  stepRef.current = onStep;

  useEffect(() => {
    if (prev.current === value) return;
    let diff = value - prev.current;
    if (diff > 30) diff -= 60;
    if (diff < -30) diff += 60;
    prev.current = value;
    flip.setValue(diff > 0 ? 1 : -1);
    Animated.timing(flip, {
      toValue: 0,
      duration: D(160),
      easing: Easing.out(Easing.quad),
      useNativeDriver: true,
    }).start();
  }, [value]);

  const fire = (d) => {
    tick();
    stepRef.current(d);
  };

  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: () => {
        acc.current = 0;
        lastDy.current = 0;
      },
      onPanResponderMove: (_, g) => {
        acc.current += g.dy - lastDy.current;
        lastDy.current = g.dy;
        while (acc.current <= -STEP_PX) {
          acc.current += STEP_PX;
          fire(1); // swipe up = higher
        }
        while (acc.current >= STEP_PX) {
          acc.current -= STEP_PX;
          fire(-1); // swipe down = lower
        }
      },
    })
  ).current;

  return (
    <View style={s.flipWrap}>
      <View style={s.flipCard} {...pan.panHandlers}>
        <Animated.Text
          style={[
            s.flipDigits,
            {
              opacity: flip.interpolate({ inputRange: [-1, 0, 1], outputRange: [0.15, 1, 0.15] }),
              transform: [
                { perspective: 500 },
                {
                  rotateX: flip.interpolate({
                    inputRange: [-1, 0, 1],
                    outputRange: ["-80deg", "0deg", "80deg"],
                  }),
                },
              ],
            },
          ]}
        >
          {pad(value)}
        </Animated.Text>
        <View pointerEvents="none" style={s.flipSeam} />
        <Text pointerEvents="none" style={[s.flipArrow, { top: 8 }]}>▲</Text>
        <Text pointerEvents="none" style={[s.flipArrow, { bottom: 8 }]}>▼</Text>
      </View>
      <Text style={s.flipLabel}>{label}</Text>
    </View>
  );
}

function TimerModal({
  visible,
  onClose,
  status,
  remainingMs,
  total,
  minutes,
  seconds,
  onStepMinutes,
  onStepSeconds,
  onStart,
  onPause,
  onResume,
  onCancel,
}) {
  const canStart = minutes * 60 + seconds > 0;
  const fraction = total > 0 ? Math.min(1, Math.max(0, remainingMs / (total * 1000))) : 0;

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={s.backdrop}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
        {visible && (
          <PopIn style={s.sheet}>
            <View style={s.sheetHeader}>
              <Text style={s.sheetTitle}>Break timer</Text>
              <Pressable onPress={onClose} hitSlop={10} style={s.closeBtn} accessibilityLabel="Close">
                <Text style={s.closeText}>✕</Text>
              </Pressable>
            </View>

            {status === "idle" ? (
              <>
                <Text style={s.timerHint}>Swipe the cards up or down to set the time</Text>
                <View style={s.flipRow}>
                  <FlipCard value={minutes} label="minutes" onStep={onStepMinutes} />
                  <Text style={s.flipColon}>:</Text>
                  <FlipCard value={seconds} label="seconds" onStep={onStepSeconds} />
                </View>
                <BreakVerdict total={minutes * 60 + seconds} />
                <Press
                  onPress={onStart}
                  disabled={!canStart}
                  style={[s.primaryBtn, { marginTop: 0 }, !canStart && { opacity: 0.4 }]}
                >
                  <Text style={s.primaryBtnText}>Start</Text>
                </Press>
              </>
            ) : status === "done" ? (
              <>
                <Text style={s.breakTitle}>Time's up!</Text>
                <Text style={s.breakClock}>00:00</Text>
                <Text style={s.breakSub}>Back to the next set</Text>
                <Press onPress={onCancel} style={[s.primaryBtn, { marginTop: 24 }]}>
                  <Text style={s.primaryBtnText}>Done</Text>
                </Press>
              </>
            ) : (
              <>
                <Text style={s.breakTitle}>On a break!</Text>
                <Text style={s.breakClock}>{clockText(remainingMs)}</Text>
                <Text style={s.breakSub}>{status === "paused" ? "Paused" : " "}</Text>
                <View style={s.progressTrack}>
                  <View style={[s.progressFill, { width: `${fraction * 100}%` }]} />
                </View>
                <View style={s.sheetButtons}>
                  <Press outerStyle={{ flex: 1 }} onPress={status === "paused" ? onResume : onPause} style={[s.primaryBtn, { marginTop: 0 }]}>
                    <Text style={s.primaryBtnText}>{status === "paused" ? "Resume" : "Pause"}</Text>
                  </Press>
                  <Press outerStyle={{ flex: 1 }} onPress={onCancel} style={[s.secondaryBtn, { backgroundColor: C.card }]}>
                    <Text style={s.secondaryBtnText}>Cancel</Text>
                  </Press>
                </View>
              </>
            )}
          </PopIn>
        )}
      </View>
    </Modal>
  );
}

// ---------- settings ----------
function SlidersIcon() {
  return (
    <View style={{ width: 24, height: 28, justifyContent: "space-between" }}>
      {[0.15, 0.65, 0.35].map((p, i) => (
        <View key={i} style={{ height: 8, justifyContent: "center" }}>
          <View style={{ height: 2, borderRadius: 1, backgroundColor: C.ink }} />
          <View
            style={{
              position: "absolute",
              left: p * 16,
              width: 8,
              height: 8,
              borderRadius: 4,
              backgroundColor: C.card,
              borderWidth: 2,
              borderColor: C.ink,
            }}
          />
        </View>
      ))}
    </View>
  );
}

const THUMB = 28;

// Simple draggable slider (no extra packages needed). `rainbow` draws a hue gradient instead of a fill.
function Slider({ value, min, max, step, onChange, onRelease, rainbow }) {
  const [width, setWidth] = useState(0);
  const widthRef = useRef(0);
  const startX = useRef(0);
  const cb = useRef({});
  cb.current = { onChange, onRelease, min, max, step };

  const setFromX = (x) => {
    const { onChange: change, min: lo, max: hi, step: st } = cb.current;
    const usable = Math.max(widthRef.current - THUMB, 1);
    const ratio = Math.min(1, Math.max(0, (x - THUMB / 2) / usable));
    const stepped = Math.round((ratio * (hi - lo)) / st) * st + lo;
    change(Math.min(hi, Math.max(lo, Math.round(stepped * 100) / 100)));
  };

  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: (e) => {
        startX.current = e.nativeEvent.locationX;
        setFromX(startX.current);
      },
      onPanResponderMove: (_, g) => setFromX(startX.current + g.dx),
      onPanResponderRelease: () => cb.current.onRelease && cb.current.onRelease(),
    })
  ).current;

  const ratio = (value - min) / (max - min);
  const thumbLeft = ratio * Math.max(width - THUMB, 0);

  return (
    <View
      style={s.sliderTouch}
      onLayout={(e) => {
        widthRef.current = e.nativeEvent.layout.width;
        setWidth(e.nativeEvent.layout.width);
      }}
      {...pan.panHandlers}
    >
      <View pointerEvents="none" style={StyleSheet.absoluteFill}>
        {rainbow ? (
          <View style={s.hueTrack}>
            {HUE_STOPS.map((h) => (
              <View key={h} style={{ flex: 1, backgroundColor: hslToHex(h, 100, 60) }} />
            ))}
          </View>
        ) : (
          <>
            <View style={s.sliderTrack} />
            <View style={[s.sliderFill, { width: thumbLeft + THUMB / 2 }]} />
          </>
        )}
        <View
          style={[
            s.sliderThumb,
            { left: thumbLeft },
            rainbow && { backgroundColor: hslToHex(value, 100, 68), borderWidth: 3, borderColor: C.ink },
          ]}
        />
      </View>
    </View>
  );
}

function SettingsModal({
  visible,
  speed,
  onChange,
  hue,
  onChangeHue,
  onClose,
  enabledDays,
  onToggleDay,
  workouts,
  logs,
  dayTitles,
  onPickImport,
}) {
  const demo = useRef(new Animated.Value(0)).current;
  const [demoWidth, setDemoWidth] = useState(0);
  const [view, setView] = useState("main"); // main | export
  const [fileName, setFileName] = useState("my-routine");
  const [busy, setBusy] = useState(false);
  const [includeLogs, setIncludeLogs] = useState(false);
  const [format, setFormat] = useState("rwdg"); // rwdg | json
  const logCount = countLogEntries(workouts, logs);
  const [updateState, setUpdateState] = useState("idle"); // idle | checking | downloading | current | error

  // over-the-air update: checks for a newer published version, downloads it and offers a restart
  const checkForUpdate = async () => {
    if (updateState === "checking" || updateState === "downloading") return;
    if (!Updates.isEnabled) {
      Alert.alert(
        "Updates unavailable here",
        "Over-the-air updates only work in an installed build of the app (not in Expo Go or a dev build)."
      );
      return;
    }
    setUpdateState("checking");
    try {
      const check = await Updates.checkForUpdateAsync();
      if (!check.isAvailable) {
        setUpdateState("current");
        return;
      }
      setUpdateState("downloading");
      await Updates.fetchUpdateAsync();
      setUpdateState("idle");
      Alert.alert("Update ready", "The new version is downloaded. Restart the app to use it?", [
        { text: "Later", style: "cancel" },
        { text: "Restart now", onPress: () => Updates.reloadAsync().catch(() => {}) },
      ]);
    } catch (e) {
      setUpdateState("error");
      Alert.alert("Update failed", "Couldn't check for updates. Check your internet connection and try again.");
    }
  };
  const updateLabel = {
    idle: "Check for updates",
    checking: "Checking...",
    downloading: "Downloading update...",
    current: "You're up to date",
    error: "Try again",
  }[updateState];
  const installedText =
    Updates.isEnabled && Updates.createdAt
      ? `Current version published ${Updates.createdAt.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}.`
      : "Running the version built into the app.";

  useEffect(() => {
    if (!visible) {
      setUpdateState("idle");
      setView("main");
      setIncludeLogs(false);
    }
  }, [visible]);

  const exportLogs = includeLogs && logCount > 0 ? logs : null;

  const mimeInfo = FORMAT_INFO[format];

  // writes a temporary file and opens the share sheet
  const shareNow = async () => {
    const { file, name } =
      format === "pdf"
        ? await writePdfFile(fileName, workouts, dayTitles, logs)
        : writeRoutineFile(fileName, workouts, dayTitles, exportLogs, format);
    if (!(await Sharing.isAvailableAsync())) {
      Alert.alert("Sharing not available", "This device can't share files from the app.");
      return;
    }
    await Sharing.shareAsync(file.uri, {
      mimeType: mimeInfo.mime,
      UTI: mimeInfo.uti,
      dialogTitle: `Share ${name}.${format}`,
    });
  };

  // a PDF is only made when there is at least one workout
  const blockedPdf = () => {
    if (format === "pdf" && workouts.length === 0) {
      Alert.alert("No workouts yet", "Add at least one workout to make a PDF.");
      return true;
    }
    return false;
  };

  // "Send": share sheet
  const doSend = async () => {
    if (busy || blockedPdf()) return;
    setBusy(true);
    try {
      onClose();
      await sleep(350);
      await shareNow();
    } catch (e) {
      Alert.alert("Couldn't export", "Something went wrong while creating the file.");
    } finally {
      setBusy(false);
    }
  };

  // "Download": save the file into a folder on the phone (Downloads or any folder you pick).
  // Android doesn't let apps write into Downloads silently, so a folder picker opens the first
  // time; the folder is remembered for next time.
  const doDownload = async () => {
    if (busy || blockedPdf()) return;
    setBusy(true);
    try {
      const name = cleanFileName(fileName);
      const fileLabel = `${name}.${format}`;
      // text for .rwdg/.json, raw bytes for the PDF
      const content =
        format === "pdf"
          ? (await writePdfFile(fileName, workouts, dayTitles, logs)).bytes
          : buildRoutineText(name, workouts, dayTitles, exportLogs, format);
      const saveInto = (dir) => {
        const target = dir.createFile(fileLabel, mimeInfo.mime);
        target.write(content);
      };
      const offerShare = (reason) =>
        Alert.alert(
          "Couldn't save to a folder",
          `${reason}\n\nYou can share the file instead and save it from the share sheet.`,
          [
            { text: "Cancel", style: "cancel" },
            { text: "Share instead", onPress: () => shareNow().catch(() => {}) },
          ]
        );

      onClose();
      await sleep(350);

      // 1) the folder used last time
      let savedDir = null;
      let remembered = null;
      try {
        remembered = await AsyncStorage.getItem(DOWNLOAD_DIR_KEY);
      } catch (e) {}
      if (remembered) {
        try {
          const dir = new Directory(remembered);
          saveInto(dir);
          savedDir = dir;
        } catch (e) {
          savedDir = null; // permission gone, ask again below
        }
      }

      // 2) otherwise let the user pick a folder
      if (!savedDir) {
        let picked;
        try {
          const hint =
            Platform.OS === "android" && Platform.Version >= 26
              ? "content://com.android.externalstorage.documents/tree/primary%3ADownload"
              : undefined;
          picked = await Directory.pickDirectoryAsync(hint);
        } catch (e) {
          if (isCancelError(e)) return;
          offerShare(`The folder picker failed (${(e && e.message) || "unknown error"}).`);
          return;
        }
        if (!picked) return; // cancelled
        try {
          saveInto(picked);
        } catch (e) {
          offerShare(`The file couldn't be written there (${(e && e.message) || "unknown error"}).`);
          return;
        }
        savedDir = picked;
        AsyncStorage.setItem(DOWNLOAD_DIR_KEY, picked.uri).catch(() => {});
      }

      Alert.alert("Saved", `${fileLabel} was saved to “${folderLabel(savedDir.uri)}”.`, [
        { text: "OK" },
        {
          text: "Use another folder next time",
          onPress: () => AsyncStorage.removeItem(DOWNLOAD_DIR_KEY).catch(() => {}),
        },
      ]);
    } catch (e) {
      Alert.alert("Couldn't download", `Something went wrong while saving the file (${(e && e.message) || "unknown error"}).`);
    } finally {
      setBusy(false);
    }
  };

  // small preview so you can feel the new speed
  const play = () => {
    demo.setValue(0);
    Animated.sequence([
      Animated.timing(demo, {
        toValue: 1,
        duration: D(600),
        easing: Easing.inOut(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(demo, {
        toValue: 0,
        duration: D(600),
        easing: Easing.inOut(Easing.cubic),
        useNativeDriver: true,
      }),
    ]).start();
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <KeyboardAvoidingView
        style={s.backdrop}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
        {visible && (
          <PopIn style={[s.sheet, { maxHeight: "92%" }]}>
            <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
            {view === "export" ? (
              <>
                <View style={s.sheetHeader}>
                  <Text style={s.sheetTitle}>Export routine</Text>
                  <Pressable onPress={() => setView("main")} hitSlop={10}>
                    <Text style={s.link}>Back</Text>
                  </Pressable>
                </View>
                <Text style={s.timerHint}>
                  {workouts.length === 0
                    ? "No workouts yet - you'll get an empty routine file with notes that explain its format."
                    : `${workouts.length} workout${workouts.length === 1 ? "" : "s"} will be exported.`}
                </Text>

                <Text style={[s.sectionTitle, { marginTop: 18 }]}>Format</Text>
                <View style={s.formatRow}>
                  {["rwdg", "json", "pdf"].map((f) => (
                    <Press
                      key={f}
                      outerStyle={{ flex: 1 }}
                      scaleTo={0.95}
                      onPress={() => {
                        if (f === "pdf" && workouts.length === 0) {
                          Alert.alert("No workouts yet", "Add at least one workout to make a PDF.");
                          return;
                        }
                        tick();
                        setFormat(f);
                      }}
                      style={[
                        s.routineBtn,
                        format === f && s.formatBtnOn,
                        f === "pdf" && workouts.length === 0 && { opacity: 0.4 },
                      ]}
                    >
                      <Text style={[s.routineBtnText, format === f && s.formatBtnTextOn]}>.{f}</Text>
                    </Press>
                  ))}
                </View>

                <Text style={s.sectionTitle}>File name</Text>
                <View style={s.fileRow}>
                  <TextInput
                    style={s.fileInput}
                    value={fileName}
                    onChangeText={setFileName}
                    placeholder="my-routine"
                    placeholderTextColor={C.mute}
                    keyboardAppearance="dark"
                    autoCapitalize="none"
                    autoCorrect={false}
                    maxLength={60}
                  />
                  <Text style={s.fileExt}>.{format}</Text>
                </View>
                <Text style={[s.mutedText, { marginTop: 8, marginBottom: 16 }]}>
                  {format === "pdf"
                    ? "A clean dark chart of your routine: one card per day with each exercise, its reps and sets, and its latest intensity."
                    : "Includes each workout's day, name, sets and reps, and starting intensity, plus any day titles. The file also contains notes explaining what each part is for."}
                </Text>

                {format !== "pdf" && (
                <Pressable
                  style={[s.checkRow, logCount === 0 && { opacity: 0.4 }]}
                  disabled={logCount === 0}
                  onPress={() => {
                    tick();
                    setIncludeLogs((v) => !v);
                  }}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: includeLogs, disabled: logCount === 0 }}
                >
                  <View style={[s.checkBox, includeLogs && logCount > 0 && s.checkBoxOn]}>
                    {includeLogs && logCount > 0 ? <Text style={s.checkMark}>✓</Text> : null}
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={s.checkTitle}>Include my progress</Text>
                    <Text style={s.checkSub}>
                      {logCount === 0
                        ? "No logged intensities yet."
                        : `${logCount} logged intensit${logCount === 1 ? "y" : "ies"} will be exported too.`}
                    </Text>
                  </View>
                </Pressable>
                )}

                <Press
                  onPress={doSend}
                  disabled={busy}
                  style={[s.primaryBtn, { marginTop: 0 }, busy && { opacity: 0.5 }]}
                >
                  <Text style={s.primaryBtnText}>Send</Text>
                </Press>
                <Press
                  outerStyle={{ marginTop: 10 }}
                  onPress={doDownload}
                  disabled={busy}
                  style={[s.routineBtn, busy && { opacity: 0.5 }]}
                >
                  <Text style={s.routineBtnText}>Download</Text>
                </Press>
                <Text style={[s.mutedText, { marginTop: 10 }]}>
                  {Platform.OS === "android"
                    ? "Download opens a folder picker: choose Downloads (or any folder) and tap “Use this folder”. If your Android version won't let you pick Downloads itself, pick or create a folder inside it."
                    : "Download lets you choose a folder to save the file in."}
                </Text>
              </>
            ) : (
              <>
            <Text style={s.sheetTitle}>Settings</Text>

            <View style={s.settingRow}>
              <Text style={[s.sectionTitle, { marginBottom: 0 }]}>Animation speed</Text>
              <Text style={s.speedValue}>{speed}x</Text>
            </View>

            <Slider value={speed} min={0.25} max={3} step={0.25} onChange={onChange} onRelease={play} />
            <View style={s.sliderLabels}>
              <Text style={s.mutedText}>Slower</Text>
              <Text style={s.mutedText}>Faster</Text>
            </View>

            <View style={s.demoTrack} onLayout={(e) => setDemoWidth(e.nativeEvent.layout.width)}>
              <Animated.View
                style={[
                  s.demoDot,
                  {
                    transform: [
                      {
                        translateX: demo.interpolate({
                          inputRange: [0, 1],
                          outputRange: [0, Math.max(demoWidth - 18, 0)],
                        }),
                      },
                    ],
                  },
                ]}
              />
            </View>

            <Text style={[s.sectionTitle, { marginBottom: 0 }]}>Accent color</Text>
            <Slider value={hue} min={0} max={360} step={1} onChange={onChangeHue} rainbow />
            <View style={{ height: 14 }} />

            <Text style={[s.sectionTitle, { marginBottom: 8 }]}>Days shown</Text>
            <View style={s.daysRow}>
              {DAYS.map((d, i) => (
                <Press
                  key={d}
                  outerStyle={{ flex: 1 }}
                  scaleTo={0.9}
                  onPress={() => {
                    tick();
                    onToggleDay(i);
                  }}
                  style={[s.dayBox, enabledDays[i] && s.dayBoxOn]}
                >
                  <Text style={[s.dayBoxText, enabledDays[i] && s.dayBoxTextOn]}>{d.slice(0, 3)}</Text>
                </Press>
              ))}
            </View>
            <Text style={[s.mutedText, { marginTop: 8, marginBottom: 18 }]}>
              Tap a day to hide or show it. At least one stays on.
            </Text>

            <Text style={[s.sectionTitle, { marginBottom: 8 }]}>Routine</Text>
            <View style={s.routineRow}>
              <Press outerStyle={{ flex: 1 }} onPress={() => setView("export")} style={s.routineBtn}>
                <Text style={s.routineBtnText}>Export</Text>
              </Press>
              <Press outerStyle={{ flex: 1 }} onPress={onPickImport} style={s.routineBtn}>
                <Text style={s.routineBtnText}>Import</Text>
              </Press>
            </View>
            <Text style={[s.mutedText, { marginTop: 8, marginBottom: 18 }]}>
              Export or import your routine as a .rwdg or .json file.
            </Text>

            <Text style={[s.sectionTitle, { marginBottom: 8 }]}>App updates</Text>
            <Press onPress={checkForUpdate} style={s.routineBtn}>
              <Text style={s.routineBtnText}>{updateLabel}</Text>
            </Press>
            <Text style={[s.mutedText, { marginTop: 8, marginBottom: 18 }]}>{installedText}</Text>

            <View style={s.sheetButtons}>
              <Press
                onPress={() => {
                  onChange(1);
                  onChangeHue(DEFAULT_HUE);
                  play();
                }}
                style={s.secondaryBtn}
              >
                <Text style={s.secondaryBtnText}>Reset</Text>
              </Press>
              <Press outerStyle={{ flex: 1 }} onPress={onClose} style={[s.primaryBtn, { marginTop: 0 }]}>
                <Text style={s.primaryBtnText}>Done</Text>
              </Press>
            </View>
              </>
            )}
            </ScrollView>
          </PopIn>
        )}
      </KeyboardAvoidingView>
    </Modal>
  );
}

export default function App() {
  // paint the window behind the app dark, so no black strip shows where the status bar was
  useEffect(() => {
    SystemUI.setBackgroundColorAsync(C.bg).catch(() => {});
  }, []);

  return (
    <SafeAreaProvider style={{ flex: 1, backgroundColor: C.bg }}>
      <Main />
    </SafeAreaProvider>
  );
}

// ---------- styles ----------
// A function so the styles can be rebuilt whenever the accent color changes.
const makeStyles = () =>
  StyleSheet.create({
    safe: { flex: 1, backgroundColor: C.bg },

    topBar: { paddingHorizontal: 20, paddingTop: 8, flexDirection: "row", gap: 10 },
    addBtn: {
      backgroundColor: C.accent,
      borderRadius: 12,
      height: 50,
      justifyContent: "center",
      alignItems: "center",
    },
    timerActive: { backgroundColor: C.accent, borderColor: C.accent },
    settingsBtn: {
      width: 50,
      height: 50,
      borderRadius: 12,
      backgroundColor: C.card,
      borderWidth: 1,
      borderColor: C.line,
      alignItems: "center",
      justifyContent: "center",
    },
    addBtnText: { color: C.accentText, fontSize: 16, fontWeight: "700" },

    header: { paddingHorizontal: 20, paddingTop: 28, paddingBottom: 18 },
    dayTitle: { fontSize: 52, fontWeight: "800", color: C.ink, letterSpacing: -1.5 },
    dots: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 10 },
    hint: { marginTop: 10, color: C.mute, fontSize: 13 },

    list: { paddingHorizontal: 20, paddingBottom: 40, gap: 12 },
    card: {
      backgroundColor: C.card,
      borderRadius: 14,
      padding: 16,
      flexDirection: "row",
      alignItems: "center",
      borderWidth: 1,
      borderColor: C.line,
    },
    cardName: { fontSize: 18, fontWeight: "700", color: C.ink },
    cardMeta: { fontSize: 14, color: C.mute, marginTop: 4 },
    logged: { alignItems: "flex-end", marginLeft: 12 },
    loggedLabel: { fontSize: 12, color: C.mute },
    loggedValue: { fontSize: 16, fontWeight: "700", color: C.accent, marginTop: 2 },

    empty: { paddingVertical: 28 },
    emptyTitle: { fontSize: 18, fontWeight: "700", color: C.ink },
    emptyBody: { fontSize: 14, color: C.mute, marginTop: 6 },

    // converter
    converter: {
      marginTop: 16,
      backgroundColor: C.card,
      borderRadius: 14,
      padding: 16,
      borderWidth: 1,
      borderColor: C.line,
    },
    converterHeader: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      marginBottom: 12,
    },
    converterTitle: { fontSize: 16, fontWeight: "700", color: C.ink },
    converterRow: { flexDirection: "row", alignItems: "flex-end", gap: 10 },
    converterField: { flex: 1 },
    converterLabel: { color: C.mute, fontSize: 13, marginBottom: 6 },
    converterInput: {
      backgroundColor: C.bg,
      borderWidth: 1,
      borderColor: C.line,
      borderRadius: 12,
      paddingHorizontal: 14,
      paddingVertical: 12,
      fontSize: 20,
      fontWeight: "700",
      color: C.ink,
    },
    converterValue: { fontSize: 20, fontWeight: "700", color: C.ink },
    converterArrow: { color: C.mute, fontSize: 22, paddingBottom: 12 },

    // converter popup
    blurWrap: { flex: 1, justifyContent: "center", padding: 20 },
    convModalField: { marginTop: 26 },
    convModalLabel: { color: C.mute, fontSize: 13, marginBottom: 8 },
    convModalInputRow: {
      flexDirection: "row",
      alignItems: "center",
      backgroundColor: C.card,
      borderWidth: 1,
      borderColor: C.line,
      borderRadius: 14,
      paddingHorizontal: 16,
    },
    convModalInput: {
      flex: 1,
      paddingVertical: 18,
      fontSize: 32,
      fontWeight: "800",
      color: C.ink,
    },
    convModalUnit: { fontSize: 18, fontWeight: "700", color: C.mute, marginLeft: 8 },
    convModalSwap: { textAlign: "center", color: C.mute, fontSize: 22, marginTop: 16, marginBottom: -10 },

    // editor
    editorHeader: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      paddingHorizontal: 20,
      paddingTop: 12,
    },
    editorTitle: { fontSize: 28, fontWeight: "800", color: C.ink, letterSpacing: -0.5 },
    link: { fontSize: 16, fontWeight: "700", color: C.accent },
    chipsWrap: { flexDirection: "row", gap: 8, paddingHorizontal: 20, paddingVertical: 16 },
    chip: {
      paddingVertical: 10,
      borderRadius: 10,
      alignItems: "center",
      backgroundColor: C.card,
      borderWidth: 1,
      borderColor: C.line,
    },
    chipActive: { backgroundColor: C.accent, borderColor: C.accent },
    chipText: { fontWeight: "700", color: C.ink },
    chipTextActive: { color: C.accentText },
    sectionTitle: { fontSize: 16, fontWeight: "700", color: C.ink, marginBottom: 10 },
    mutedText: { color: C.mute, fontSize: 14 },
    editRow: {
      flexDirection: "row",
      alignItems: "center",
      backgroundColor: C.card,
      borderRadius: 12,
      padding: 14,
      marginBottom: 10,
      borderWidth: 1,
      borderColor: C.line,
    },
    dayHeadRow: { flexDirection: "row", alignItems: "center", gap: 12, marginTop: 28, marginBottom: 10 },
    dayHeadName: { fontSize: 28, fontWeight: "800", color: C.ink, letterSpacing: -0.5 },
    dayTitleInput: {
      flex: 1,
      backgroundColor: C.card,
      borderWidth: 1,
      borderColor: C.line,
      borderRadius: 10,
      paddingHorizontal: 12,
      paddingVertical: 9,
      fontSize: 16,
      color: C.ink,
    },
    formHeader: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      marginBottom: 10,
    },
    editRowActive: { borderColor: C.accent },
    suggestBox: {
      backgroundColor: C.card,
      borderWidth: 1,
      borderColor: C.accent,
      borderRadius: 12,
      marginTop: -2,
      marginBottom: 10,
      overflow: "hidden",
    },
    suggestHead: { color: C.mute, fontSize: 12, fontWeight: "700", paddingHorizontal: 14, paddingTop: 10, paddingBottom: 4 },
    suggestRow: {
      paddingHorizontal: 14,
      paddingVertical: 11,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: C.line,
    },
    suggestName: { color: C.ink, fontSize: 16, fontWeight: "700" },
    suggestMeta: { color: C.mute, fontSize: 13, marginTop: 2 },
    input: {
      backgroundColor: C.card,
      borderWidth: 1,
      borderColor: C.line,
      borderRadius: 12,
      paddingHorizontal: 14,
      paddingVertical: 13,
      fontSize: 16,
      color: C.ink,
      marginBottom: 10,
    },
    primaryBtn: {
      backgroundColor: C.accent,
      borderRadius: 12,
      paddingVertical: 14,
      alignItems: "center",
      marginTop: 6,
    },
    primaryBtnText: { color: C.accentText, fontWeight: "700", fontSize: 16 },
    secondaryBtn: {
      paddingVertical: 14,
      paddingHorizontal: 18,
      borderRadius: 12,
      backgroundColor: C.bg,
      alignItems: "center",
    },
    secondaryBtnText: { color: C.ink, fontWeight: "700", fontSize: 16 },

    // intensity popup
    backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.7)", justifyContent: "center", padding: 20 },
    sheet: { backgroundColor: C.raised, borderRadius: 18, padding: 20, borderWidth: 1, borderColor: C.line },
    sheetTitle: { fontSize: 24, fontWeight: "800", color: C.ink, letterSpacing: -0.5 },
    historyBox: {
      maxHeight: 158, // fits exactly 3 rows (3 x 52 + border)
      backgroundColor: C.card,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: C.line,
    },
    historyRow: {
      flexDirection: "row",
      justifyContent: "space-between",
      paddingHorizontal: 14,
      height: 52,
      alignItems: "center",
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: C.line,
    },
    historyNote: { color: C.mute, fontSize: 12, marginTop: 2 },
    historyDate: { color: C.mute, fontSize: 14 },
    historyValue: { color: C.ink, fontWeight: "700", fontSize: 15 },
    sheetButtons: { flexDirection: "row", gap: 10, marginTop: 6 },

    // timer
    sheetHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
    closeBtn: {
      width: 34,
      height: 34,
      borderRadius: 17,
      backgroundColor: C.card,
      borderWidth: 1,
      borderColor: C.line,
      alignItems: "center",
      justifyContent: "center",
    },
    closeText: { color: C.ink, fontSize: 15, fontWeight: "700" },
    timerHint: { color: C.mute, fontSize: 14, marginTop: 6 },
    flipRow: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 22, marginBottom: 6 },
    verdictBox: { minHeight: 64, justifyContent: "center", marginBottom: 10 },
    verdict: { fontSize: 16, fontWeight: "700", textAlign: "center" },
    flipWrap: { flex: 1 },
    flipCard: {
      height: 150,
      borderRadius: 18,
      backgroundColor: C.card,
      borderWidth: 1,
      borderColor: C.line,
      alignItems: "center",
      justifyContent: "center",
      overflow: "hidden",
    },
    flipDigits: { fontSize: 76, fontWeight: "800", color: C.ink, fontVariant: ["tabular-nums"] },
    flipSeam: { position: "absolute", left: 0, right: 0, top: 74, height: 2, backgroundColor: C.raised },
    flipArrow: { position: "absolute", color: C.mute, fontSize: 10 },
    flipLabel: { textAlign: "center", color: C.mute, fontSize: 13, marginTop: 8 },
    flipColon: { fontSize: 48, fontWeight: "800", color: C.mute, marginBottom: 24 },
    breakTitle: { fontSize: 40, fontWeight: "800", color: C.ink, textAlign: "center", letterSpacing: -1, marginTop: 24 },
    breakClock: {
      fontSize: 76,
      fontWeight: "800",
      color: C.accent,
      textAlign: "center",
      marginTop: 8,
      fontVariant: ["tabular-nums"],
    },
    breakSub: { color: C.mute, textAlign: "center", fontSize: 15, marginTop: 2 },
    progressTrack: {
      height: 6,
      borderRadius: 3,
      backgroundColor: C.card,
      marginTop: 18,
      marginBottom: 22,
      overflow: "hidden",
    },
    progressFill: { height: 6, backgroundColor: C.accent },

    // routine export / import
    fileRow: {
      flexDirection: "row",
      alignItems: "center",
      backgroundColor: C.card,
      borderWidth: 1,
      borderColor: C.line,
      borderRadius: 12,
    },
    fileInput: { flex: 1, paddingHorizontal: 14, paddingVertical: 13, fontSize: 16, color: C.ink },
    fileExt: { paddingRight: 14, fontSize: 16, fontWeight: "700", color: C.mute },
    formatRow: { flexDirection: "row", gap: 10, marginBottom: 14 },
    formatBtnOn: { backgroundColor: C.accent, borderColor: C.accent },
    formatBtnTextOn: { color: C.accentText },
    routineRow: { flexDirection: "row", gap: 10 },
    routineBtn: {
      paddingVertical: 13,
      borderRadius: 12,
      alignItems: "center",
      backgroundColor: C.card,
      borderWidth: 1,
      borderColor: C.line,
    },
    routineBtnText: { color: C.ink, fontWeight: "700", fontSize: 15 },

    // export checkbox
    checkRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      backgroundColor: C.card,
      borderWidth: 1,
      borderColor: C.line,
      borderRadius: 12,
      padding: 14,
      marginBottom: 14,
    },
    checkBox: {
      width: 24,
      height: 24,
      borderRadius: 7,
      borderWidth: 2,
      borderColor: C.mute,
      alignItems: "center",
      justifyContent: "center",
    },
    checkBoxOn: { backgroundColor: C.accent, borderColor: C.accent },
    checkMark: { color: C.accentText, fontSize: 15, fontWeight: "800", marginTop: -1 },
    checkTitle: { color: C.ink, fontSize: 16, fontWeight: "700" },
    checkSub: { color: C.mute, fontSize: 13, marginTop: 2 },

    // days picker
    daysRow: { flexDirection: "row", gap: 6 },
    dayBox: {
      paddingVertical: 12,
      borderRadius: 10,
      alignItems: "center",
      backgroundColor: C.card,
      borderWidth: 1,
      borderColor: C.line,
    },
    dayBoxOn: { backgroundColor: C.accent, borderColor: C.accent },
    dayBoxText: { fontSize: 12, fontWeight: "700", color: C.mute, textDecorationLine: "line-through" },
    dayBoxTextOn: { color: C.accentText, textDecorationLine: "none" },

    // settings
    settingRow: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      marginTop: 20,
      marginBottom: 6,
    },
    speedValue: { color: C.accent, fontSize: 18, fontWeight: "800" },
    sliderTouch: { height: 44, justifyContent: "center" },
    sliderTrack: {
      position: "absolute",
      left: 0,
      right: 0,
      top: 20,
      height: 4,
      borderRadius: 2,
      backgroundColor: C.line,
    },
    sliderFill: {
      position: "absolute",
      left: 0,
      top: 20,
      height: 4,
      borderRadius: 2,
      backgroundColor: C.accent,
    },
    sliderThumb: {
      position: "absolute",
      top: 8,
      width: THUMB,
      height: THUMB,
      borderRadius: THUMB / 2,
      backgroundColor: C.ink,
    },
    hueTrack: {
      position: "absolute",
      left: 0,
      right: 0,
      top: 18,
      height: 8,
      borderRadius: 4,
      overflow: "hidden",
      flexDirection: "row",
    },
    sliderLabels: { flexDirection: "row", justifyContent: "space-between", marginBottom: 18 },
    demoTrack: {
      height: 18,
      marginBottom: 20,
      borderRadius: 9,
      backgroundColor: C.card,
      borderWidth: 1,
      borderColor: C.line,
      justifyContent: "center",
    },
    demoDot: { width: 18, height: 18, borderRadius: 9, backgroundColor: C.accent, marginTop: -1 },
  });

let s = makeStyles();

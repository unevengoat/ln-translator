// Profiles: Netflix-style user profiles on a shared library.
// - the library (stories, chapters, translations, terms) is shared with everyone
// - each profile keeps its OWN reading progress, My List, look preferences and PIN
// - PINs are stored as scrypt hashes with a per-profile salt; sessions are random
//   tokens kept server-side, so nothing sensitive lives in the browser
import { scryptSync, randomBytes, timingSafeEqual } from "node:crypto";
import { uid } from "./store.js";

const AVATARS = ["🦊", "🐼", "🐯", "🦉", "🐙", "🦄", "🐧", "🐨", "🐸", "🦁", "🐺", "🐳", "🦋", "🐲", "👾", "🤖"];
const COLORS = ["#e50914", "#2563eb", "#16a34a", "#d97706", "#7c3aed", "#db2777", "#0891b2", "#65a30d"];

export const PROFILE_FILE = "profiles.json";
export const stateFile = (id) => `profiles/${id}.json`;

export function hashPin(pin, salt = randomBytes(16).toString("hex")) {
  return { salt, hash: scryptSync(String(pin), salt, 32).toString("hex") };
}

export function verifyPin(pin, salt, hash) {
  if (!salt || !hash) return true; // no PIN set → open profile
  try {
    const candidate = Buffer.from(scryptSync(String(pin), salt, 32).toString("hex"));
    const expected = Buffer.from(String(hash));
    return candidate.length === expected.length && timingSafeEqual(candidate, expected);
  } catch {
    return false;
  }
}

export function publicProfile(p) {
  return { id: p.id, name: p.name, avatar: p.avatar, color: p.color, hasPin: !!p.hash, createdAt: p.createdAt, lastActive: p.lastActive || 0 };
}

export function pickAvatar(i) { return AVATARS[i % AVATARS.length]; }
export function pickColor(i) { return COLORS[i % COLORS.length]; }

async function load(store) {
  const raw = await store.readRaw(PROFILE_FILE).catch(() => null);
  const db = raw ? JSON.parse(raw) : { profiles: [], tokens: {} };
  db.profiles = db.profiles || [];
  db.tokens = db.tokens || {};
  return db;
}

async function save(store, db) {
  store.writeRaw(PROFILE_FILE, db);
  return db;
}

export async function listProfiles(store) {
  const db = await load(store);
  return db.profiles.map(publicProfile).sort((a, b) => (b.lastActive || 0) - (a.lastActive || 0));
}

export async function createProfile(store, { name, avatar, color, pin } = {}) {
  const clean = String(name || "").trim().slice(0, 24);
  if (!clean) throw new Error("A profile name is required.");
  const db = await load(store);
  if (db.profiles.length >= 12) throw new Error("That's the maximum number of profiles (12).");
  const i = db.profiles.length;
  const { salt, hash } = pin ? hashPin(pin) : { salt: "", hash: "" };
  const profile = {
    id: uid("p"), name: clean, avatar: avatar || pickAvatar(i), color: color || pickColor(i),
    salt, hash, createdAt: Date.now(), lastActive: Date.now(),
  };
  db.profiles.push(profile);
  await save(store, db);
  await store.flush();
  return publicProfile(profile);
}

export async function loginProfile(store, id, pin) {
  const db = await load(store);
  const profile = db.profiles.find((p) => p.id === id);
  if (!profile) throw new Error("Unknown profile.");
  if (!verifyPin(pin, profile.salt, profile.hash)) throw new Error("Wrong PIN.");
  const token = randomBytes(24).toString("hex");
  db.tokens[token] = { profileId: profile.id, at: Date.now() };
  // prune old tokens
  const cutoff = Date.now() - 1000 * 60 * 60 * 24 * 30;
  for (const [t, v] of Object.entries(db.tokens)) if (v.at < cutoff) delete db.tokens[t];
  profile.lastActive = Date.now();
  await save(store, db);
  await store.flush();
  return { token, profile: publicProfile(profile) };
}

export async function authProfile(store, token) {
  if (!token) return null;
  const db = await load(store);
  const entry = db.tokens[token];
  if (!entry) return null;
  const profile = db.profiles.find((p) => p.id === entry.profileId);
  return profile ? publicProfile(profile) : null;
}

export async function requireProfile(store, id, token) {
  const me = await authProfile(store, token);
  if (!me || me.id !== id) {
    const err = new Error("This profile is locked — sign in with its PIN first.");
    err.status = 401;
    throw err;
  }
  return me;
}

export async function updateProfile(store, id, { name, avatar, color, pin } = {}) {
  const db = await load(store);
  const profile = db.profiles.find((p) => p.id === id);
  if (!profile) throw new Error("Unknown profile.");
  if (name !== undefined) profile.name = String(name).trim().slice(0, 24) || profile.name;
  if (avatar !== undefined) profile.avatar = avatar;
  if (color !== undefined) profile.color = color;
  if (pin !== undefined) {
    if (pin === "" || pin === null) { profile.salt = ""; profile.hash = ""; }
    else { const { salt, hash } = hashPin(pin); profile.salt = salt; profile.hash = hash; }
    // PIN changed → drop that profile's sessions
    for (const [t, v] of Object.entries(db.tokens)) if (v.profileId === id) delete db.tokens[t];
  }
  await save(store, db);
  await store.flush();
  return publicProfile(profile);
}

export async function deleteProfile(store, id) {
  const db = await load(store);
  const i = db.profiles.findIndex((p) => p.id === id);
  if (i < 0) throw new Error("Unknown profile.");
  const [removed] = db.profiles.splice(i, 1);
  for (const [t, v] of Object.entries(db.tokens)) if (v.profileId === id) delete db.tokens[t];
  await save(store, db);
  store.writeRaw(stateFile(id), { progress: {}, myList: [], look: null, deleted: Date.now() });
  await store.flush();
  return publicProfile(removed);
}

export async function logoutProfile(store, token) {
  const db = await load(store);
  if (db.tokens[token]) { delete db.tokens[token]; await save(store, db); await store.flush(); }
  return true;
}

/* --------------------------------------------------------------- per-profile state */

const emptyState = () => ({ progress: {}, myList: [], look: null, updatedAt: 0 });

export async function getState(store, id) {
  const raw = await store.readRaw(stateFile(id)).catch(() => null);
  return raw ? { ...emptyState(), ...JSON.parse(raw) } : emptyState();
}

/** Merge a patch into a profile's private state (progress / myList / look). */
export async function patchState(store, id, patch = {}) {
  const state = await getState(store, id);
  if (patch.progress) {
    for (const [key, entry] of Object.entries(patch.progress)) {
      if (entry === null) delete state.progress[key];
      else state.progress[key] = { ...(state.progress[key] || {}), ...entry, at: Date.now() };
    }
    // keep the newest 200 entries
    const entries = Object.entries(state.progress).sort((a, b) => (b[1].at || 0) - (a[1].at || 0)).slice(0, 200);
    state.progress = Object.fromEntries(entries);
  }
  if (patch.myList) {
    const list = new Set(state.myList);
    for (const w of patch.myList.add || []) list.add(w);
    for (const w of patch.myList.remove || []) list.delete(w);
    state.myList = [...list];
  }
  if (patch.look !== undefined) state.look = patch.look;
  if (patch.level !== undefined) state.level = patch.level;
  state.updatedAt = Date.now();
  store.writeRaw(stateFile(id), state);
  await store.flush();
  return state;
}

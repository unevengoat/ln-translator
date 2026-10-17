// Shared language table. `google` = code for the free Google gtx endpoint.
// `mymemory` = code for the MyMemory fallback.
export const LANGUAGES = [
  { code: "auto", name: "Auto-detect", google: "auto", mymemory: "autodetect" },
  { code: "en", name: "English", google: "en", mymemory: "en" },
  { code: "ja", name: "Japanese", google: "ja", mymemory: "ja" },
  { code: "zh-CN", name: "Chinese (Simplified)", google: "zh-CN", mymemory: "zh-CN" },
  { code: "zh-TW", name: "Chinese (Traditional)", google: "zh-TW", mymemory: "zh-TW" },
  { code: "ko", name: "Korean", google: "ko", mymemory: "ko" },
  { code: "es", name: "Spanish", google: "es", mymemory: "es" },
  { code: "fr", name: "French", google: "fr", mymemory: "fr" },
  { code: "de", name: "German", google: "de", mymemory: "de" },
  { code: "id", name: "Indonesian", google: "id", mymemory: "id" },
  { code: "th", name: "Thai", google: "th", mymemory: "th" },
  { code: "vi", name: "Vietnamese", google: "vi", mymemory: "vi" },
  { code: "ms", name: "Malay", google: "ms", mymemory: "ms" },
  { code: "tl", name: "Filipino", google: "tl", mymemory: "tl" },
  { code: "pt", name: "Portuguese", google: "pt", mymemory: "pt" },
  { code: "ru", name: "Russian", google: "ru", mymemory: "ru" },
  { code: "ar", name: "Arabic", google: "ar", mymemory: "ar" },
  { code: "hi", name: "Hindi", google: "hi", mymemory: "hi" },
  { code: "it", name: "Italian", google: "it", mymemory: "it" },
  { code: "nl", name: "Dutch", google: "nl", mymemory: "nl" },
  { code: "pl", name: "Polish", google: "pl", mymemory: "pl" },
  { code: "tr", name: "Turkish", google: "tr", mymemory: "tr" },
  { code: "uk", name: "Ukrainian", google: "uk", mymemory: "uk" },
  { code: "el", name: "Greek", google: "el", mymemory: "el" },
  { code: "he", name: "Hebrew", google: "he", mymemory: "he" },
  { code: "bn", name: "Bengali", google: "bn", mymemory: "bn" },
  { code: "ta", name: "Tamil", google: "ta", mymemory: "ta" },
  { code: "my", name: "Burmese", google: "my", mymemory: "my" },
  { code: "hu", name: "Hungarian", google: "hu", mymemory: "hu" },
  { code: "ro", name: "Romanian", google: "ro", mymemory: "ro" },
  { code: "sv", name: "Swedish", google: "sv", mymemory: "sv" },
];

export function normalizeCode(code) {
  if (!code) return "auto";
  const c = String(code).trim();
  const found = LANGUAGES.find(
    (l) => l.code.toLowerCase() === c.toLowerCase() || l.google.toLowerCase() === c.toLowerCase()
  );
  return found ? found.code : c;
}

export function googleCode(code) {
  const found = LANGUAGES.find((l) => l.code === normalizeCode(code));
  return found ? found.google : code;
}

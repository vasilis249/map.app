import i18n from "i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import { initReactI18next } from "react-i18next";
import el from "./el";
import en from "./en";

// Greek first; English when the device asks for it. The choice is remembered in localStorage.
void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: { el: { translation: el }, en: { translation: en } },
    fallbackLng: "el",
    supportedLngs: ["el", "en"],
    nonExplicitSupportedLngs: true,
    load: "languageOnly",
    interpolation: { escapeValue: false },
    detection: { order: ["localStorage", "navigator"], caches: ["localStorage"], lookupLocalStorage: "lang" },
    returnNull: false,
  });

export default i18n;

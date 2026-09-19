/**
 * Vocalis — déchiffrement des URLs audio YouTube (signatureCipher)
 *
 * YouTube ne donne plus d'URL en clair au lecteur web : chaque format a un
 * champ `signatureCipher` (url + s + sp) et un paramètre `n` à « résoudre »,
 * sans quoi le téléchargement est bridé. Les deux transformations vivent
 * dans le JS du lecteur (base.js). Ce module extrait ces fonctions et leurs
 * dépendances, les évalue, et reconstruit l'URL finale.
 *
 * Méthode : « mini-bundler » — on part de la fonction racine, on collecte
 * récursivement les définitions de niveau supérieur qu'elle référence
 * (fonctions et objets), puis on évalue le tout dans un closure. C'est le
 * code public de Google lui-même, exécuté tel quel.
 */

self.VocalisCipher = (() => {
  "use strict";

  const BUILTINS = new Set((
    "Math String Number Array Object JSON parseInt parseFloat undefined NaN Infinity isNaN " +
    "encodeURIComponent decodeURIComponent encodeURI decodeURI console TypeError Error RangeError " +
    "RegExp Map Set WeakMap WeakSet Promise Symbol Boolean Date Uint8Array Int8Array Uint16Array " +
    "Int16Array Uint32Array Int32Array Float32Array Float64Array ArrayBuffer SharedArrayBuffer " +
    "DataView Function Object globalThis self window document navigator true false null this " +
    "typeof in of new return var let const if else for while do switch case break continue throw " +
    "try catch finally delete void yield await async function class extends super default " +
    "instanceof with get set static constructor arguments eval"
  ).split(/\s+/));

  function extractBraces(src, openIdx) {
    if (src[openIdx] !== "{") return null;
    let depth = 0;
    for (let i = openIdx; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}" && --depth === 0) return src.slice(openIdx, i + 1);
    }
    return null;
  }

  function getFnDef(src, name) {
    const esc = name.replace(/[$.*+?^${}()|[\]\\]/g, "\\$&");
    const res = [
      new RegExp("(?:^|[^$\\w])" + esc + "\\s*=\\s*function\\s*\\("),
      new RegExp("(?:^|[^$\\w])function\\s+" + esc + "\\s*\\("),
    ];
    for (const re of res) {
      const m = re.exec(src);
      if (!m) continue;
      const pOpen = src.indexOf("(", m.index + m[0].length - 1);
      const pClose = src.indexOf(")", pOpen);
      const bOpen = src.indexOf("{", pClose);
      const body = extractBraces(src, bOpen);
      if (!body) continue;
      return {
        params: src.slice(pOpen + 1, pClose),
        body,
        text: "var " + name + "=function(" + src.slice(pOpen + 1, pClose) + ")" + body,
      };
    }
    return null;
  }

  function getObjDef(src, name) {
    const esc = name.replace(/[$.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp("(?:^|[^$\\w])" + esc + "\\s*=\\s*\\{");
    const m = re.exec(src);
    if (!m) return null;
    const open = m.index + m[0].length - 1;
    const body = extractBraces(src, open);
    if (!body) return null;
    return "var " + name + "=" + body + ";";
  }

  function localNames(code) {
    const out = new Set();
    const decl = /(?:var|let|const)\s+([\w$]+(?:\s*,\s*[\w$]+)*)/g;
    let m;
    while ((m = decl.exec(code))) {
      for (const v of m[1].split(",")) out.add(v.trim());
    }
    return out;
  }

  /** Rassemble la définition de `rootName` + toutes ses dépendances, puis évalue. */
  function bundle(src, rootName) {
    const root = getFnDef(src, rootName);
    if (!root) return null;
    let code = root.text + ";\n";
    const done = new Set([rootName]);
    let frontier = [root.body];
    let guard = 0;
    while (frontier.length && guard++ < 60) {
      const chunk = frontier.join("\n");
      frontier = [];
      const locals = localNames(chunk);
      const ids = new Set();
      const re = /([$\w]+)\s*[({,;]/g;
      let m;
      while ((m = re.exec(chunk))) ids.add(m[1]);
      const plain = /([a-zA-Z_$][\w$]*)/g;
      while ((m = plain.exec(chunk))) ids.add(m[1]);
      for (const id of ids) {
        if (done.has(id) || BUILTINS.has(id) || locals.has(id)) continue;
        if (!/^[a-zA-Z_$][\w$]*$/.test(id) || id.length > 12) continue;
        const def = getFnDef(src, id) || getObjDef(src, id);
        done.add(id);
        if (def) {
          code += def + "\n";
          frontier.push(def);
        }
      }
      if (code.length > 400_000) return null;
    }
    try {
      // eslint-disable-next-line no-new-func
      return new Function(code + "\nreturn " + rootName + ";")();
    } catch {
      return null;
    }
  }

  /**
   * Filet de sécurité 2026 : si les motifs de sites d'appel ne trouvent
   * rien, on balaie toutes les fonctions « X=function(a){…a.split("")…
   * a.join("")…} » du lecteur — la forme de la fonction signature depuis
   * dix ans, quel que soit son nom ou l'endroit où elle est appelée.
   */
  function findSigCandidates(src) {
    const out = [];
    const res = [
      /(?:^|[^$\w])([$\w]{1,12})\s*=\s*function\s*\(\s*a\s*\)\s*\{/g,
      /(?:^|[^$\w])function\s+([$\w]{1,12})\s*\(\s*a\s*\)\s*\{/g,
    ];
    for (const re of res) {
      let m;
      while ((m = re.exec(src)) && out.length < 8) {
        const name = m[1];
        if (out.includes(name)) continue;
        const bOpen = src.indexOf("{", re.lastIndex - 1);
        const body = extractBraces(src, bOpen);
        if (!body) continue;
        // corps typique : a=a.split(""); … O.meth(a,n) … ; return a.join("")
        if (body.indexOf('.split("")') === -1 || body.indexOf('.join("")') === -1) continue;
        if (!/[$\w]+\.[\w$]+\(\s*a\s*,/.test(body)) continue;
        out.push(name);
      }
    }
    return out;
  }

  function findSigFnName(src) {
    const patterns = [
      /(?:^|[^$\w])([$\w]+)\s*=\s*function\(\s*a\s*\)\s*{\s*a\s*=\s*a\.split\(\s*""\s*\)/,
      /\.set\(\s*"(?:signature|sig)"\s*,\s*(?:encodeURIComponent\(\s*)?([$\w]+)\(/,
      /\bc\s*&&\s*[$\w]+\.set\([^,]+,\s*encodeURIComponent\(\s*([$\w]+)\(/,
      /(?:^|[^$\w])([$\w]+)\s*=\s*function\(\s*a\s*\)\s*{\s*a\s*=\s*a\.split\(""\)/,
    ];
    for (const p of patterns) {
      const m = p.exec(src);
      if (m) return m[1];
    }
    return null;
  }

  function findNFnName(src) {
    const patterns = [
      /(?:^|[^$\w])([$\w]+)\s*=\s*function\(\s*a\s*\)\s*{\s*var\s+b\s*=\s*a\.split\(\s*""\s*\)/,
      /\b([$\w]+)\s*\(\s*a\.get\("n"\)\s*\)/,
      /get\("n"\)[\s\S]{0,200}?\|\|\s*([$\w]+)\(/,
      /(?:^|[^$\w])([$\w]+)\s*=\s*function\(\s*a\s*\)\s*{\s*a\s*=\s*a\.split\(\s*""\s*\);\s*[$\w]+\.[\w$]+\(/,
    ];
    for (const p of patterns) {
      const m = p.exec(src);
      if (m) return m[1];
    }
    return null;
  }

  /**
   * Résout un format signatureCipher.
   * Retourne { url } ou null.
   */
  function solve(baseJs, signatureCipher) {
    try {
      const sc = new URLSearchParams(signatureCipher);
      const baseUrl = sc.get("url");
      const s = sc.get("s");
      const sp = sc.get("sp") || "signature";
      if (!baseUrl || !s) return null;

      // Motifs de sites d'appel d'abord, puis balayage des candidats ;
      // chaque candidat est validé par sa sortie (longueur + alphabet).
      const names = [];
      const pat = findSigFnName(baseJs);
      if (pat) names.push(pat);
      for (const c of findSigCandidates(baseJs)) if (!names.includes(c)) names.push(c);
      let sig = null;
      for (const nm of names) {
        const fn = bundle(baseJs, nm);
        if (typeof fn !== "function") continue;
        try {
          const out = fn(s);
          if (
            typeof out === "string" &&
            out.length >= 40 &&
            out.length <= 200 &&
            /^[A-Za-z0-9._-]+$/.test(out)
          ) {
            sig = out;
            break;
          }
        } catch {
          /* candidat suivant */
        }
      }
      if (!sig) return null;

      const u = new URL(baseUrl);
      const nParam = u.searchParams.get("n");
      if (nParam) {
        const nName = findNFnName(baseJs);
        const nFn = nName && bundle(baseJs, nName);
        if (typeof nFn === "function") {
          try {
            u.searchParams.set("n", nFn(nParam));
          } catch {
            /* n non résolu : téléchargement possiblement bridé, on tente quand même */
          }
        }
      }
      u.searchParams.set(sp, sig);
      return { url: u.toString() };
    } catch {
      return null;
    }
  }

  return { solve };
})();

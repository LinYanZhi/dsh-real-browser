/**
 * Captcha detection for a REAL browser page.
 *
 * RPA shop logins are where captchas bite hardest: the AI should KNOW a
 * captcha is present (and which kind) so it can stop and hand the page to the
 * human instead of flailing. This runs an in-page scan for the common captcha
 * families:
 *
 *   - reCAPTCHA v2/v3   (google.com/recaptcha iframes, .g-recaptcha, [data-sitekey], .grecaptcha-badge)
 *   - hCaptcha          (hcaptcha.com iframes, .h-captcha)
 *   - Cloudflare Turnstile (challenges.cloudflare.com iframes, .cf-turnstile)
 *   - Geetest           (.geetest_panel / .geetest_slide_icon / .gt_slider)
 *   - NetEase Yidun     (.yidun* / .nc-container)
 *   - Aliyun noCaptcha  (.nc_wrapper / .nc_scale, aliyun captcha iframes)
 *   - generic iframe / image captcha heuristics (lower confidence)
 *
 * Detection is passive (read-only DOM scan) and CONFIDENCE-labelled: a
 * `data-sitekey` div is a strong signal for recaptcha/hcaptcha; an iframe
 * whose src merely contains "captcha" is weaker (0.5). The verdict is
 * 'detected' whenever any hit exists — the AI should then pause and let the
 * user solve it.
 */

import { evaluateJs } from './cdp.js';

/** In-page detection battery. Returns { url, hits: [{type, detail, confidence}] }. */
const COLLECT_SCRIPT = `(() => {
  const hits = [];
  const push = (type, detail, confidence) => hits.push({ type, detail, confidence });

  // Cross-origin captcha widgets are almost always iframes — we cannot read
  // their content, but their src tells us the family.
  for (const f of document.querySelectorAll('iframe')) {
    const src = (f.src || '').toLowerCase();
    if (!src) continue;
    if (src.includes('recaptcha')) push('recaptcha', 'iframe: ' + f.src, 0.95);
    else if (src.includes('hcaptcha') || src.includes('newassets.hcaptcha.com')) push('hcaptcha', 'iframe: ' + f.src, 0.95);
    else if (src.includes('challenges.cloudflare.com') || src.includes('turnstile')) push('turnstile', 'iframe: ' + f.src, 0.95);
    else if (src.includes('aliyun.com/captcha') || src.includes('alicdn.com/nocaptcha') || src.includes('/nocaptcha')) push('aliyun-nocaptcha', 'iframe: ' + f.src, 0.6);
    else if (src.includes('captcha') || src.includes('/challenge') || src.includes('/verify') || src.includes('security-check')) push('generic-captcha-iframe', 'iframe: ' + f.src, 0.5);
  }

  // DOM-based widgets.
  if (document.querySelector('.g-recaptcha, .grecaptcha-badge, [data-sitekey]')) push('recaptcha', 'dom: .g-recaptcha / [data-sitekey]', 0.8);
  if (document.querySelector('.h-captcha, .hcaptcha-container, .hcaptcha_iframe')) push('hcaptcha', 'dom: .h-captcha', 0.8);
  if (document.querySelector('.cf-turnstile, [data-callback]')) push('turnstile', 'dom: .cf-turnstile', 0.7);
  if (document.querySelector('.geetest_panel, .geetest_slide_icon, .gt_slider, .geetest_popup')) push('geetest', 'dom: .geetest*', 0.8);
  if (document.querySelector('.yidun, .yidun_panel, .yidun_slider, .nc-container, .nc_scale')) push('yidun-or-nocaptcha', 'dom: .yidun* / .nc-container', 0.8);
  if (document.querySelector('.nc_wrapper, .nc-container, .nc_scale_text')) push('aliyun-nocaptcha', 'dom: .nc_wrapper', 0.6);

  // Image captcha heuristic (img carrying captcha-ish alt/src).
  for (const img of document.querySelectorAll('img')) {
    const a = ((img.alt || '') + ' ' + (img.src || '')).toLowerCase();
    if (a.includes('captcha') || a.includes('verifycode') || a.includes('checkcode') || a.includes('seccode')) {
      push('image-captcha', 'img: ' + (img.src || img.alt || '').slice(0, 120), 0.6);
      break;
    }
  }

  // Dedupe by type, keep the highest confidence detail.
  const byType = new Map();
  for (const h of hits) {
    const prev = byType.get(h.type);
    if (!prev || h.confidence > prev.confidence) byType.set(h.type, h);
  }
  return JSON.stringify({ url: location.href, hits: [...byType.values()].sort((a, b) => b.confidence - a.confidence) });
})()`;

/**
 * Detect captcha widgets on the picked page.
 * @returns {Promise<{url: string, detected: Array<{type,detail,confidence}>, verdict: 'none'|'detected'}>}
 */
export async function detectCaptcha(port, opts = {}) {
  const r = await evaluateJs(port, COLLECT_SCRIPT, { urlSubstring: opts.urlSubstring });
  if (r.__exception) throw new Error(`captcha scan JS error: ${r.text} ${r.description}`.trim());
  let parsed;
  try {
    parsed = JSON.parse(r.value ?? '{}');
  } catch {
    throw new Error('captcha scan returned unparseable data');
  }
  const detected = Array.isArray(parsed.hits) ? parsed.hits : [];
  return { url: parsed.url ?? '', detected, verdict: detected.length ? 'detected' : 'none' };
}

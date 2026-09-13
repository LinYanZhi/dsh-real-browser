/**
 * real-browser tool registration — page interaction domain:
 * real_page_list/dom/eval/navigate + snapshot/click/fill/type/typeSecret/keys/
 * select/check/hover/scroll/wait/find/tabs/network/upload/console/downloads/captcha.
 * Register via registerPageTools(ctx, tools) from tools.js.
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { listTargets, evaluateJs, readPageDom, navigatePage } from './cdp.js';
import { snapshotInteractive } from './snapshot.js';
import { listDownloads, stopDownloadTracking } from './downloads.js';
import { stopNetworkTracking } from './network.js';
import { detectCaptcha } from './captcha.js';
import {
  clickElement, hoverElement, fillElement, typeElement, typeSecret, pressKey, selectOption, checkElement,
  scrollPage, waitFor, findElements,
} from './interact.js';
import { listTabs, newTab, switchTab, closeTab, networkRequests, uploadFiles, readConsole } from './interact-aux.js';
import { text, assertUrlPolicy, currentPageUrl } from './tools-common.js';

export function registerPageTools(ctx, tools) {
  // Target model: ref ("e3", from real_page_snapshot) | CSS selector | x/y.
  // Each call site already wraps its options in defineTool(), so register() must
  // not wrap again: feeding a compiled ToolDefinition back into defineTool makes
  // its compiled `parameters` ({ type: 'object', properties, required }) be read
  // as a property map and fails schema compilation ("parameters.type ...").
  const register = (t) => tools.register(t);
  const TARGET = {
    ref: { type: 'string', description: 'Element ref from real_page_snapshot, e.g. "e3".' },
    selector: { type: 'string', description: 'CSS selector matching an element.' },
  };
  const FRAME = {
    frame: {
      type: 'string',
      description:
        'Same-origin iframe path from real_page_snapshot, e.g. "0" (first iframe in the top document) or "0/1" (first iframe inside that one). Omit for the top frame. A ref from a snapshot inside an iframe carries its frame automatically. Cross-origin iframes cannot be reached and are listed separately in the snapshot.',
    },
  };
  const PORT = { port: { type: 'number', required: true, description: 'CDP debug port of the real browser.' } };
  const URLSUB = { urlSubstring: { type: 'string', description: 'Pick the tab whose url/title contains this; default = preferred page.' } };
  const urlOpts = (args) => ({ urlSubstring: args.urlSubstring });

    tools.register(
      defineTool({
        name: 'real_page_list',
        description:
          'List the open pages (tabs) of a real browser attached via its CDP debug port. Use to see what the user has open and pick which page to inspect with real_page_dom / real_page_eval.',
        parameters: {
          port: { type: 'number', required: true, description: 'CDP debug port of the real browser (from real_browser_list).' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              pages: { type: 'array', items: { type: 'object', additionalProperties: true } },
            },
          },
          render: (_args, value) =>
            text(
              value.pages.length === 0
                ? 'No open pages on this browser.'
                : value.pages.map((p, i) => `${i + 1}. ${p.title || '(no title)'} — ${p.url}`).join('\n'),
            ),
        },
        timeoutMs: 20000,
        isConcurrencySafe: () => true,
        async execute(args) {
          const targets = await listTargets(args.port);
          const pages = targets
            .filter((t) => t.type === 'page')
            .map((t) => ({ id: t.id, title: t.title ?? '', url: t.url ?? '' }));
          return { pages };
        },
      }),
    );

    tools.register(
      defineTool({
        name: 'real_page_dom',
        description:
          'View the DOM of a page in a real browser (the page the user is looking at, with its real login state). Returns the full document HTML capped at maxChars, or one element matched by a CSS selector. Use to inspect real page structure when debugging selectors / scraping logic.',
        parameters: {
          port: { type: 'number', required: true, description: 'CDP debug port of the real browser.' },
          urlSubstring: { type: 'string', description: 'Pick the tab whose url or title contains this substring; default = first page.' },
          selector: { type: 'string', description: 'CSS selector; returns the first matching element\'s outerHTML instead of the whole document.' },
          maxChars: { type: 'number', description: 'Cap on returned HTML length (default 100000).' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: true,
            properties: {
              url: { oneOf: [{ type: 'string' }, { type: 'null' }] },
              title: { oneOf: [{ type: 'string' }, { type: 'null' }] },
              html: { oneOf: [{ type: 'string' }, { type: 'null' }] },
              found: { oneOf: [{ type: 'number' }, { type: 'null' }] },
              truncated: { oneOf: [{ type: 'boolean' }, { type: 'null' }] },
              __exception: { oneOf: [{ type: 'boolean' }, { type: 'null' }] },
            },
          },
          render: (args, value) => {
            if (value.__exception) return text(`JS error: ${value.text} ${value.description}`.trim());
            const head = value.selector
              ? `Selector "${args.selector}" matched ${value.found} element(s):`
              : `Page ${value.url ?? ''}${value.title ? ` — ${value.title}` : ''}:`;
            return text(`${head}\n${value.html ?? '(no html)'}`);
          },
        },
        timeoutMs: 20000,
        isConcurrencySafe: () => true,
        async execute(args) {
          return readPageDom(args.port, {
            urlSubstring: args.urlSubstring,
            selector: args.selector,
            maxChars: args.maxChars,
          });
        },
      }),
    );

    tools.register(
      defineTool({
        name: 'real_page_eval',
        description:
          'Execute JavaScript in a page of a real browser (the page the user is looking at). The expression runs in the page\'s main world, so DOM and app globals are reachable. Returns the serialized value (use JSON.stringify for objects), or the exception details. This is the primary probing tool for debugging: inspect state, click elements (element.click()), read fields, fill inputs, etc.',
        parameters: {
          port: { type: 'number', required: true, description: 'CDP debug port of the real browser.' },
          expression: { type: 'string', required: true, description: 'JavaScript expression to evaluate in the page.' },
          urlSubstring: { type: 'string', description: 'Pick the tab whose url or title contains this substring; default = first page.' },
          awaitPromise: { type: 'boolean', description: 'Await promises returned by the expression (default false).' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: true,
            properties: {
              value: { oneOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }, { type: 'object', additionalProperties: true }, { type: 'null' }] },
              type: { oneOf: [{ type: 'string' }, { type: 'null' }] },
              subtype: { oneOf: [{ type: 'string' }, { type: 'null' }] },
              __exception: { oneOf: [{ type: 'boolean' }, { type: 'null' }] },
              text: { oneOf: [{ type: 'string' }, { type: 'null' }] },
              description: { oneOf: [{ type: 'string' }, { type: 'null' }] },
            },
          },
          render: (_args, value) => {
            if (value.__exception) {
              return text(`JS exception: ${value.text} ${value.description}`.trim());
            }
            const v = typeof value.value === 'string' ? value.value : JSON.stringify(value.value);
            return text(`=> ${v ?? '(undefined)'}`);
          },
        },
        timeoutMs: 20000,
        isConcurrencySafe: () => true,
        async execute(args, exec) {
          const cur = await currentPageUrl(args.port, args.urlSubstring);
          if (cur) await assertUrlPolicy(ctx, exec, cur, '在页面执行 JS');
          return evaluateJs(args.port, args.expression, {
            urlSubstring: args.urlSubstring,
            awaitPromise: args.awaitPromise,
          });
        },
      }),
    );

    tools.register(
      defineTool({
        name: 'real_page_navigate',
        description:
          'Navigate a page in a real browser to a URL (CDP Page.navigate). Use to move the driven browser to a specific page. The AI decides which URL is appropriate; be mindful this changes the real browser the human may be using.',
        parameters: {
          port: { type: 'number', required: true, description: 'CDP debug port of the real browser.' },
          url: { type: 'string', required: true, description: 'The URL to navigate to.' },
          urlSubstring: { type: 'string', description: 'Pick the tab whose url or title contains this substring; default = first page.' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean' },
              url: { type: 'string' },
              errorText: { oneOf: [{ type: 'string' }, { type: 'null' }] },
              frameId: { oneOf: [{ type: 'string' }, { type: 'null' }] },
            },
          },
          render: (_args, value) =>
            text(value.ok ? `Navigated to ${value.url}.` : `Navigation failed: ${value.errorText ?? 'unknown error'}`),
        },
        timeoutMs: 20000,
        isConcurrencySafe: () => true,
        async execute(args, exec) {
          await assertUrlPolicy(ctx, exec, args.url, '导航到');
          return navigatePage(args.port, args.url, { urlSubstring: args.urlSubstring });
        },
      }),
    );

    register(defineTool({
      name: 'real_page_snapshot',
      description:
        'Take an interactive-element snapshot of a page in a real browser. Every clickable/typeable element is numbered with a ref like "e3" plus its role, name, value, center x/y, and a CSS selector. Elements inside SAME-ORIGIN iframes are included and carry a "frame" field (e.g. "0", "0/1"); use that value as the frame argument of interaction tools, or just use the ref (it carries the frame). Cross-origin iframes cannot be reached and are listed in crossOriginFrames. Use this BEFORE interacting — other tools accept ref ("e3") or selector. Refs are per-snapshot: after the DOM changes, re-snapshot. This is the foundation for reliable interaction (agent-browser style).',
      parameters: { ...PORT, ...URLSUB, maxElements: { type: 'number', description: 'Cap on returned elements (default 120).' } },
      output: {
        schema: { type: 'object', additionalProperties: true, properties: { origin: { type: 'string' }, url: { type: 'string' }, elements: { type: 'array', items: { type: 'object', additionalProperties: true } }, crossOriginFrames: { type: 'array', items: { type: 'object', additionalProperties: true } }, truncated: { type: 'boolean' } } },
        render: (args, value) => {
          const lines = [`Page ${value.url || ''} (${value.origin || ''}) — ${value.elements.length} interactive element(s)${value.truncated ? ' (truncated)' : ''}:`];
          for (const el of value.elements) {
            lines.push(`  [${el.ref}]${el.frame ? ` frame=${el.frame}` : ''} <${el.tag}>${el.role ? ` role=${el.role}` : ''}${el.type ? ` type=${el.type}` : ''} ${el.visible ? '' : '(hidden) '}(${el.x},${el.y}) ${el.name ? JSON.stringify(el.name) : ''}${el.value !== undefined ? ` value=${JSON.stringify(String(el.value).slice(0, 40))}` : ''}`);
          }
          for (const f of value.crossOriginFrames || []) {
            lines.push(`  [cross-origin iframe frame=${f.frame} — not reachable from parent context] src=${f.src || '(inline)'}`);
          }
          return text(lines.join('\n'));
        },
      },
      timeoutMs: 20000,
      isConcurrencySafe: () => true,
      async execute(args) {
        return snapshotInteractive(args.port, { urlSubstring: args.urlSubstring, maxElements: args.maxElements });
      },
    }));

    register(defineTool({
      name: 'real_page_click',
      description: 'Click (or double-click) an element in a real browser, by ref ("e3"), CSS selector, or viewport x/y coordinates. Uses real CDP mouse events at the element center.',
      parameters: { ...PORT, ...TARGET, ...FRAME, ...URLSUB, x: { type: 'number', description: 'Viewport x (with y, instead of ref/selector).' }, y: { type: 'number', description: 'Viewport y (with x).' }, doubleClick: { type: 'boolean', description: 'Double click (default false).' } },
      output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => text(`Clicked at (${v.x},${v.y})${v.clickCount > 1 ? ' (double)' : ''}.`) },
      timeoutMs: 20000,
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        const cur = await currentPageUrl(args.port, args.urlSubstring);
        if (cur) await assertUrlPolicy(ctx, exec, cur, '点击页面元素');
        return clickElement(args.port, args);
      },
    }));

    register(defineTool({
      name: 'real_page_fill',
      description: 'Fill an input/textarea/contenteditable in a real browser with a value (native setter + input/change events, React/Vue-safe). clear=true replaces the value; false appends.',
      parameters: { ...PORT, ...TARGET, ...FRAME, ...URLSUB, value: { type: 'string', required: true, description: 'Value to set.' }, clear: { type: 'boolean', description: 'Clear first (default true).' } },
      output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => text(`Filled => ${JSON.stringify(v.value)}`) },
      timeoutMs: 20000,
      isConcurrencySafe: () => false,
      async execute(args) { return fillElement(args.port, args); },
    }));

    register(defineTool({
      name: 'real_page_type',
      description: 'Type text into a focused element in a real browser (focuses the target, then inserts text via CDP Input.insertText — keystroke-like). Use for inputs that react to keydown.',
      parameters: { ...PORT, ...TARGET, ...FRAME, ...URLSUB, text: { type: 'string', required: true, description: 'Text to type.' } },
      output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => text(`Typed ${JSON.stringify(v.typed)}`) },
      timeoutMs: 20000,
      isConcurrencySafe: () => false,
      async execute(args) { return typeElement(args.port, args); },
    }));

    register(defineTool({
      name: 'real_page_type_secret',
      description:
        'Type a VAULT secret into a field of a real browser WITHOUT the secret ever entering the tool arguments or the model context: pass only the vault key (set earlier with real_browser_vault action=set); the value is decrypted host-side (DPAPI) and typed via CDP Input.insertText. Returns only a key marker — the secret is never echoed. Use for login/password entry where the credential must stay invisible to the AI. Errors if the vault key does not exist.',
      parameters: { ...PORT, ...TARGET, ...FRAME, ...URLSUB, vaultKey: { type: 'string', required: true, description: 'Vault key whose secret should be typed (see real_browser_vault).' } },
      output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => text(`Typed ${v.typed}.`) },
      timeoutMs: 20000,
      isConcurrencySafe: () => false,
      async execute(args) { return typeSecret(args.port, args); },
    }));

    register(defineTool({
      name: 'real_page_press_key',
      description: 'Press a key or combination in a real browser, e.g. "Enter", "Tab", "Escape", "ArrowDown", "Control+a".',
      parameters: { ...PORT, ...URLSUB, key: { type: 'string', required: true, description: 'Key name or combination like "Enter" or "Control+a".' } },
      output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => text(`Pressed ${v.key}.`) },
      timeoutMs: 20000,
      isConcurrencySafe: () => false,
      async execute(args) { return pressKey(args.port, args); },
    }));

    register(defineTool({
      name: 'real_page_select',
      description: 'Select an option in a <select> in a real browser, by option value or visible text.',
      parameters: { ...PORT, ...TARGET, ...FRAME, ...URLSUB, value: { type: 'string', description: 'Option value to select.' }, text: { type: 'string', description: 'Option text to select (substring).' } },
      output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => text(`Selected value=${JSON.stringify(v.value)}`) },
      timeoutMs: 20000,
      isConcurrencySafe: () => false,
      async execute(args) { return selectOption(args.port, args); },
    }));

    register(defineTool({
      name: 'real_page_check',
      description: 'Check or uncheck a checkbox/radio in a real browser (native setter + change event).',
      parameters: { ...PORT, ...TARGET, ...FRAME, ...URLSUB, checked: { type: 'boolean', description: 'Desired state (default true).' } },
      output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => text(`checked=${v.checked}`) },
      timeoutMs: 20000,
      isConcurrencySafe: () => false,
      async execute(args) { return checkElement(args.port, args); },
    }));

    register(defineTool({
      name: 'real_page_hover',
      description: 'Move the mouse over an element in a real browser (by ref/selector/x,y). Useful to trigger hover menus/tooltips.',
      parameters: { ...PORT, ...TARGET, ...FRAME, ...URLSUB, x: { type: 'number' }, y: { type: 'number' } },
      output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => text(`Hovered at (${v.x},${v.y}).`) },
      timeoutMs: 20000,
      isConcurrencySafe: () => false,
      async execute(args) { return hoverElement(args.port, args); },
    }));

    register(defineTool({
      name: 'real_page_scroll',
      description: 'Scroll a real browser page: pass a ref/selector to scroll that element into view, or pass direction (up/down/left/right) + pixels to scroll the window.',
      parameters: { ...PORT, ...TARGET, ...FRAME, ...URLSUB, direction: { type: 'string', enum: ['up', 'down', 'left', 'right'], description: 'Scroll direction (with pixels).' }, pixels: { type: 'number', description: 'Scroll distance (default 400).' } },
      output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => text(`Scrolled: ${v.scrolled}`) },
      timeoutMs: 20000,
      isConcurrencySafe: () => true,
      async execute(args) { return scrollPage(args.port, args); },
    }));

    register(defineTool({
      name: 'real_page_wait',
      description: 'Wait for a condition in a real browser: element (visible), text, URL substring, JS expression, or a fixed delay. Returns satisfied=true when met, or satisfied=false + timedOut=true (does NOT throw on timeout).',
      parameters: { ...PORT, ...URLSUB, ...FRAME, selector: { type: 'string', description: 'Wait for this element to be visible.' }, text: { type: 'string', description: 'Wait for this text (substring).' }, url: { type: 'string', description: 'Wait for URL containing this.' }, jsCondition: { type: 'string', description: 'JS expression to wait for, e.g. "window.ready === true" (runs in the given frame\'s document when frame is provided).' }, timeMs: { type: 'number', description: 'Fixed delay in ms.' }, timeoutMs: { type: 'number', description: 'Max wait (default 15000).' } },
      output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => text(v.satisfied ? `Condition satisfied after ${v.ms}ms.` : `Timed out after ${v.ms}ms.`) },
      timeoutMs: 30000,
      isConcurrencySafe: () => true,
      async execute(args) { return waitFor(args.port, args); },
    }));

    register(defineTool({
      name: 'real_page_find',
      description: 'Find elements matching a CSS selector in a real browser and return their tag/id/text/href/value/visibility. For inspecting what a selector matches before interacting.',
      parameters: { ...PORT, ...URLSUB, ...FRAME, selector: { type: 'string', required: true, description: 'CSS selector.' }, max: { type: 'number', description: 'Max results (default 20).' } },
      output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => text(`Found ${v.count} element(s) for "${v.selector}".`) },
      timeoutMs: 20000,
      isConcurrencySafe: () => true,
      async execute(args) { return findElements(args.port, args); },
    }));

    register(defineTool({
      name: 'real_page_tabs',
      description: 'Manage tabs of a real browser over CDP: action list | new | switch | close. list returns tabs with ids ("t1"..). switch/close take a target id; new opens a URL (default about:blank).',
      parameters: { ...PORT, action: { type: 'string', enum: ['list', 'new', 'switch', 'close'], default: 'list' }, target: { type: 'string', description: 'Tab id (t1) for switch/close.' }, url: { type: 'string', description: 'URL for action=new.' } },
      output: { schema: { type: 'object', additionalProperties: true }, render: (args, v) => {
        if (args.action === 'list' || args.action === undefined) return text(v.tabs ? v.tabs.map((t, i) => `${i + 1}. [${t.tab}] ${t.title || '(no title)'} — ${t.url}`).join('\n') || '(none)' : 'done');
        return text(`tabs ${args.action}: done`);
      } },
      timeoutMs: 20000,
      isConcurrencySafe: () => false,
      async execute(args) {
        const action = args.action ?? 'list';
        if (action === 'list') return { tabs: await listTabs(args.port) };
        if (action === 'new') return newTab(args.port, args.url);
        if (action === 'switch') return switchTab(args.port, args.target);
        if (action === 'close') return closeTab(args.port, args.target);
        throw new Error(`unknown tabs action: ${action}`);
      },
    }));

    register(defineTool({
      name: 'real_page_network',
      description:
        'List network requests observed for a page in a real browser. The FIRST call activates live CDP Network capture on the picked tab (persistent listener, like downloads tracking) and returns the page\'s resource-timing history for immediate value; later calls return the live captures. Live capture carries the real HTTP method/status/resource type — resource timing does not, so a `method` filter only matches once live capture is active (re-call after the request). Filters: URL substring, initiator/resource type (e.g. xhr, fetch, script, image), HTTP method, response status prefix (e.g. "2", "4").',
      parameters: { ...PORT, ...URLSUB, filter: { type: 'string', description: 'URL substring filter.' }, initiatorType: { type: 'string', description: 'e.g. xhr, fetch, script, image (live: resource type like XHR/Fetch/Script).' }, method: { type: 'string', description: 'HTTP method (live capture only).' }, status: { type: 'string', description: 'Status prefix, e.g. "2", "4".' }, max: { type: 'number', description: 'Max results (default 100).' } },
      output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => text(`${v.count} request(s)${v.live ? ' [live capture]' : ''}:\n` + (v.requests || []).map((r) => `  ${r.responseStatus ?? r.status ?? '—'} ${r.method ?? ''} ${r.initiatorType ?? r.type ?? ''} ${Math.round(r.duration)}ms ${r.url}`).join('\n') + (v.note ? `\n  note: ${v.note}` : '')) },
      timeoutMs: 20000,
      isConcurrencySafe: () => true,
      async execute(args) { return networkRequests(args.port, args); },
    }));

    register(defineTool({
      name: 'real_page_upload',
      description: 'Set the files of a file <input> in a real browser via CDP DOM.setFileInputFiles (real file selection, works with upload forms).',
      parameters: { ...PORT, ...TARGET, ...URLSUB, files: { type: 'array', items: { type: 'string' }, required: true, description: 'Absolute file paths.' } },
      output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => text(`Uploaded ${v.uploaded.length} file(s).`) },
      timeoutMs: 20000,
      isConcurrencySafe: () => false,
      async execute(args) { return uploadFiles(args.port, args); },
    }));

    register(defineTool({
      name: 'real_page_console',
      description: 'Read console messages captured by a real browser page (log/info/warn/error), optionally clearing the buffer. Capture starts when this tool first runs (injects a console hook).',
      parameters: { ...PORT, ...URLSUB, clear: { type: 'boolean', description: 'Clear after reading (default true).' } },
      output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => text(v.entries.map((e) => `[${e.level}] ${e.text}`).join('\n') || `No console messages (count=${v.count}).`) },
      timeoutMs: 20000,
      isConcurrencySafe: () => true,
      async execute(args) { return readConsole(args.port, { clear: args.clear, urlSubstring: args.urlSubstring }); },
    }));

    register(defineTool({
      name: 'real_page_captcha',
      description:
        'Scan the page in a real browser for captcha widgets: reCAPTCHA v2/v3, hCaptcha, Cloudflare Turnstile, Geetest, NetEase Yidun, Aliyun noCaptcha, and generic iframe/image captcha heuristics. Each hit carries a confidence (iframe-family matches ~0.95, DOM widgets ~0.7-0.8, generic ~0.5). Passive read-only scan. When verdict=detected, the AI should STOP automated steps and let the user solve the captcha in the browser window — this is the high-frequency RPA shop-login pain point.',
      parameters: {
        port: { type: 'number', required: true, description: 'CDP debug port of the real browser.' },
        urlSubstring: { type: 'string', description: 'Pick the tab whose url/title contains this; default = preferred page.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            url: { oneOf: [{ type: 'string' }, { type: 'null' }] },
            verdict: { type: 'string', enum: ['none', 'detected'] },
            detected: { type: 'array', items: { type: 'object', additionalProperties: true } },
          },
        },
        render: (_args, value) => {
          if (value.verdict === 'none') return text(`No captcha detected on ${value.url || '(page)'}.`);
          const lines = [`Captcha DETECTED on ${value.url || '(page)'} — stop automated steps and let the user solve it:`];
          for (const h of value.detected) lines.push(`  - ${h.type} (confidence ${h.confidence}): ${h.detail}`);
          return text(lines.join('\n'));
        },
      },
      timeoutMs: 20000,
      isConcurrencySafe: () => true,
      async execute(args) {
        return detectCaptcha(args.port, { urlSubstring: args.urlSubstring });
      },
    }));

    register(defineTool({
      name: 'real_page_downloads',
      description:
        'List downloads tracked for a real browser over CDP (from when tracking was first activated on this port): suggested filename, URL, byte progress, and state (inProgress/completed/canceled). Tracking activates on the first call, keeps a persistent listener, and redirects downloads for that browser to `downloadDir` (default: the user\'s Downloads folder, so files keep landing where expected). Downloads that happened BEFORE the first call are not recorded. Use after triggering a download in the page to verify it started/finished. clear=true empties the tracked list after reading. Returns tracking:false when the browser is unreachable.',
      parameters: {
        port: { type: 'number', required: true, description: 'CDP debug port of the real browser.' },
        downloadDir: { type: 'string', description: 'Where downloaded files land while tracking is active (default: the user\'s Downloads folder).' },
        clear: { type: 'boolean', description: 'Clear the tracked list after reading (default false).' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            tracking: { type: 'boolean' },
            downloads: { type: 'array', items: { type: 'object', additionalProperties: true } },
          },
        },
        render: (_args, v) => {
          if (!v.tracking) return text('Download tracking is not active — the browser on this port is unreachable.');
          if (v.downloads.length === 0) return text('No downloads tracked yet (tracking is active; downloads trigger when the page saves a file).');
          return text(
            `Download tracking active — ${v.downloads.length} download(s):\n` +
              v.downloads
                .map((d) => `  [${d.state}] ${d.suggestedFilename ?? '(unnamed)'} — ${d.receivedBytes}/${d.totalBytes} bytes — ${d.url}`)
                .join('\n'),
          );
        },
      },
      timeoutMs: 20000,
      isConcurrencySafe: () => true,
      async execute(args) { return listDownloads(args.port, { clear: args.clear, downloadDir: args.downloadDir }); },
    }));
}
